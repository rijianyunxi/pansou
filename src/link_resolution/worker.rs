use super::delivery::{ProviderPolicy, load_provider};
use super::*;
use crate::cloud_drive::{Drive, ShareInput};

async fn check(
    state: &AppState,
    id: Uuid,
    link: &Link,
    lease: (i64, Uuid),
) -> Result<(bool, Option<ApiError>), ApiError> {
    let input = ShareInput {
        url: link.url.clone(),
        provider: None,
        password: link.password.clone(),
    };
    let reference = match input.parse() {
        Ok(r) => r,
        Err(_) => return Err(ApiError::BadRequest("分享链接格式无效".into())),
    };
    // Background checks cannot consume the quota reserved for interactive delivery.
    let policy = load_provider(state, reference.provider).await?;
    if !allow_check(state, reference.provider, &policy, false).await? {
        let mut tx = state.pool.begin().await?;
        if !lock_check_lease(&mut tx, lease).await? {
            tx.rollback().await?;
            return Ok((false, None));
        }
        sqlx::query(
            "UPDATE resource_links SET next_check_at=now()+interval '5 minutes' WHERE id=$1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok((false, None));
    }
    let drive = Drive::load(state, reference.provider).await?;
    let value = tokio::time::timeout(Duration::from_secs(20), drive.check(&reference))
        .await
        .unwrap_or_else(|_| json!({"status":"unknown","errorKind":"upstream"}));
    record_with_lease(state, id, &value, &policy, Some(lease)).await?;
    Ok((
        value["status"] == "valid" || value["status"] == "invalid",
        if value["status"] == "unknown" {
            Some(match value["errorKind"].as_str() {
                Some("login") => ApiError::CloudAuthRequired("检测账号不可用".into()),
                Some("rateLimit") => ApiError::TooManyRequests("检测被平台限流".into()),
                _ => ApiError::Upstream("分享检测未获得确定结果".into()),
            })
        } else {
            None
        },
    ))
}

pub(super) async fn allow_check(
    state: &AppState,
    provider: crate::cloud_drive::Provider,
    policy: &ProviderPolicy,
    foreground: bool,
) -> Result<bool, ApiError> {
    let budget = (policy.check_daily_budget as i64).clamp(1, 100000);
    let interval = (policy.check_interval_seconds as i64).clamp(2, 3600);
    let mut conn = state.redis.connection()?;
    let gate: i64=redis::Script::new("if redis.call('GET',KEYS[1]) or redis.call('GET',KEYS[3]) then return 0 end; local n=tonumber(redis.call('GET',KEYS[2]) or '0'); local b=tonumber(redis.call('GET',KEYS[4]) or '0'); if n>=tonumber(ARGV[1]) or (ARGV[3]=='0' and b>=tonumber(ARGV[4])) then return 0 end; redis.call('SET',KEYS[1],'1','EX',ARGV[2]); redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); if ARGV[3]=='0' then redis.call('INCR',KEYS[4]); redis.call('EXPIRE',KEYS[4],86400) end; return 1")
        .key(format!("pansou:link-check:gate:{}",provider.name())).key(format!("pansou:link-check:budget:{}:{}",provider.name(),Utc::now().date_naive())).key(format!("pansou:link-check:breaker:{}",provider.name())).key(format!("pansou:link-check:background:{}:{}",provider.name(),Utc::now().date_naive())).arg(budget).arg(interval).arg(if foreground {1}else{0}).arg(budget * 4 / 5).invoke_async(&mut conn).await.map_err(|_|ApiError::Unavailable("检测调度暂不可用".into()))?;
    Ok(gate == 1)
}
pub(super) async fn record(
    state: &AppState,
    id: Uuid,
    value: &Value,
    policy: &ProviderPolicy,
) -> Result<(), ApiError> {
    record_with_lease(state, id, value, policy, None).await
}

async fn lock_check_lease(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    (job, token): (i64, Uuid),
) -> Result<bool, ApiError> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT id FROM link_check_jobs WHERE id=$1 AND kind='original' AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE")
        .bind(job).bind(token).fetch_optional(&mut **tx).await?.is_some())
}

async fn record_with_lease(
    state: &AppState,
    id: Uuid,
    value: &Value,
    policy: &ProviderPolicy,
    lease: Option<(i64, Uuid)>,
) -> Result<(), ApiError> {
    let validity = match value["status"].as_str() {
        Some("valid") => 1i16,
        Some("invalid") => 0,
        _ => -1,
    };
    let reason = match value["errorKind"].as_str() {
        Some("login") => "account_unavailable",
        Some("password") => "password_invalid",
        Some("rateLimit") => "rate_limited",
        _ if value["reasonCode"] == "resource_missing" => "resource_missing",
        _ if validity == 0 => "original_invalid",
        _ => "check_failed",
    };
    let seconds = if validity == 1 {
        policy.check_valid_seconds as i64
    } else {
        policy.check_invalid_seconds as i64
    }
    .clamp(60, 2592000);
    // Observations atomically enqueue aggregate refreshes. Cloud checks never
    // acquire the crawl index lock; the durable outbox survives any interruption.
    let mut tx = state.pool.begin().await?;
    // Fence observations as well as completion: an old worker returning after
    // lease recovery must not overwrite the current owner's validity/backoff.
    if let Some(lease) = lease
        && !lock_check_lease(&mut tx, lease).await?
    {
        tx.rollback().await?;
        return Ok(());
    }
    if validity >= 0 {
        sqlx::query("UPDATE resource_links SET validity=$2,checked_at=now(),valid_until=now()+make_interval(secs=>$3),last_attempt_at=now(),next_check_at=now()+make_interval(secs=>$3),failure_count=0,last_error_code=$4,updated_at=now() WHERE id=$1")
            .bind(id).bind(validity).bind(seconds as f64).bind(if validity == 0 {Some(reason)}else{None}).execute(&mut *tx).await?;
    } else {
        sqlx::query("UPDATE resource_links SET validity=-1,valid_until=NULL,last_attempt_at=now(),next_check_at=now()+make_interval(secs=>CASE failure_count WHEN 0 THEN 300 WHEN 1 THEN 1800 WHEN 2 THEN 7200 ELSE 21600 END + floor(random()*60)),failure_count=failure_count+1,last_error_code=$2,updated_at=now() WHERE id=$1")
            .bind(id).bind(reason).execute(&mut *tx).await?;
    }
    // Persist the observation first; Redis failure must never leave an old 0/1 behind.
    tx.commit().await?;
    if lease.is_none()
        && let Err(error) = refresh_pending_aggregates(state).await
    {
        // The fact is already committed; an unavailable projection must not
        // turn a successful check into an unknown observation on retry.
        tracing::warn!(%error, "aggregate refresh deferred to durable queue");
    }
    if validity == -1 && matches!(reason, "account_unavailable" | "rate_limited") {
        let provider: String =
            sqlx::query_scalar("SELECT provider FROM resource_links WHERE id=$1")
                .bind(id)
                .fetch_one(&state.pool)
                .await?;
        if let Ok(mut conn) = state.redis.connection() {
            let result: redis::RedisResult<()> = conn
                .set_ex(
                    format!("pansou:link-check:breaker:{provider}"),
                    "1",
                    if reason == "account_unavailable" {
                        900
                    } else {
                        300
                    },
                )
                .await;
            if result.is_err() {
                tracing::warn!("check breaker unavailable; unknown validity already persisted");
            }
        }
    }
    Ok(())
}

async fn refresh_pending_aggregates(state: &AppState) -> Result<usize, ApiError> {
    let mut tx = state.pool.begin().await?;
    // Lock resources before queue rows (ingestion uses the same order). SKIP
    // LOCKED keeps unrelated resources moving while a crawl page commits.
    let ids: Vec<String> = sqlx::query_scalar("SELECT r.id FROM managed_resources r JOIN link_aggregate_queue q ON q.resource_id=r.id ORDER BY r.id FOR NO KEY UPDATE OF r SKIP LOCKED LIMIT 100")
        .fetch_all(&mut *tx).await?;
    if ids.is_empty() {
        return Ok(0);
    }
    sqlx::query("SELECT resource_id FROM link_aggregate_queue WHERE resource_id=ANY($1) ORDER BY resource_id FOR UPDATE")
        .bind(&ids).fetch_all(&mut *tx).await?;
    // Read facts after obtaining queue locks: a concurrent observation either
    // precedes this snapshot or enqueues another refresh after this commit.
    sqlx::query(include_str!("refresh_resources.sql"))
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM link_aggregate_queue WHERE resource_id=ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ids.len())
}

async fn refresh_aggregates(state: &AppState) -> Result<usize, ApiError> {
    // Fast indexed no-op when checks are disabled or every observation is unknown.
    let due: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM resource_links WHERE validity IN(0,1) AND valid_until IS NOT NULL AND valid_until<=now())")
        .fetch_one(&state.pool).await?;
    if !due {
        return Ok(0);
    }
    let mut tx = state.pool.begin().await?;
    let expired: Vec<Uuid> = sqlx::query_scalar("WITH candidates AS MATERIALIZED (SELECT id FROM resource_links WHERE validity IN(0,1) AND valid_until IS NOT NULL AND valid_until<=now() ORDER BY valid_until,id LIMIT 100), locked AS MATERIALIZED (SELECT c.id FROM resource_links c JOIN candidates d ON d.id=c.id ORDER BY c.input_fingerprint FOR UPDATE OF c SKIP LOCKED) UPDATE resource_links SET validity=-1,valid_until=NULL,updated_at=now() WHERE id IN(SELECT id FROM locked) AND validity IN(0,1) AND valid_until<=now() RETURNING id")
        .fetch_all(&mut *tx).await?;
    tx.commit().await?;
    refresh_pending_aggregates(state).await?;
    Ok(expired.len())
}

async fn check_schedule_tick(state: &AppState) -> Result<usize, ApiError> {
    let (enabled, providers) = check_settings(state).await?;
    if !enabled {
        return Ok(0);
    }
    if providers.is_empty() {
        return Ok(0);
    }
    if crate::runtime::schedule_slot(state, "check-enqueue", 30).await? {
        for _ in 0..20 {
            let recovered = sqlx::query(include_str!("recover_checks.sql"))
                .execute(&state.pool)
                .await?
                .rows_affected();
            if recovered < 100 || state.shutdown.is_cancelled() {
                break;
            }
        }
        for provider in &providers {
            sqlx::query(include_str!("enqueue_checks.sql"))
                .bind(provider)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(0)
}

// Configuration reads are shared by all five provider loops, with a short TTL
// as fallback when LISTEN is unavailable.
async fn check_settings(state: &AppState) -> Result<(bool, Vec<String>), ApiError> {
    let mut cache = state.link_check_settings.lock().await;
    if cache
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() >= Duration::from_secs(5))
    {
        let enabled: bool = sqlx::query_scalar("SELECT COALESCE((value_json->>'enabled')::boolean,false) FROM policy_settings WHERE key='link-check'")
            .fetch_optional(&state.pool).await?.unwrap_or(false);
        let providers = sqlx::query_scalar("SELECT provider FROM cloud_account_settings WHERE provider IN('baidu','quark','aliyun','xunlei','guangya') AND length(trim(credential))>0 AND auth_status NOT IN('reauthorization_required','disconnected') ORDER BY provider")
            .fetch_all(&state.pool).await?;
        *cache = Some((std::time::Instant::now(), (enabled, providers)));
    }
    Ok(cache.as_ref().unwrap().1.clone())
}

async fn provider_tick(state: &AppState, provider: &str) -> Result<usize, ApiError> {
    let (enabled, providers) = check_settings(state).await?;
    if !enabled || !providers.iter().any(|p| p == provider) {
        return Ok(0);
    }
    let mut redis = state.redis.connection()?;
    let busy: i64 = redis::cmd("EXISTS")
        .arg(format!("pansou:link-check:gate:{provider}"))
        .arg(format!("pansou:link-check:breaker:{provider}"))
        .query_async(&mut redis)
        .await
        .map_err(|_| ApiError::Unavailable("检测调度暂不可用".into()))?;
    if busy > 0 {
        return Ok(0);
    }
    check_provider(state, provider.to_owned()).await
}

async fn check_lanes(state: &AppState) {
    provider_lanes(state, |provider| provider_tick(state, provider)).await;
}

async fn provider_lanes<F, Fut>(state: &AppState, tick: F)
where
    F: Fn(&'static str) -> Fut,
    Fut: std::future::Future<Output = Result<usize, ApiError>>,
{
    use crate::runtime::{WorkerKind, lane};
    let providers = ["baidu", "quark", "aliyun", "xunlei", "guangya"];
    let loops = providers.into_iter().map(|provider| {
        let tick = &tick;
        async move {
            let name = format!("link-check:{provider}");
            lane(state, WorkerKind::LinkCheck, &name, 2, || tick(provider)).await;
        }
    });
    // Each future owns its own retry/cadence. A slow provider cannot delay siblings.
    tokio::join!(
        lane(
            state,
            WorkerKind::LinkCheck,
            "link-check-enqueue",
            2,
            || check_schedule_tick(state)
        ),
        futures::future::join_all(loops),
    );
}

fn check_error_value(error: &ApiError) -> Option<Value> {
    let kind = match error {
        ApiError::CloudAuthRequired(_) | ApiError::Unauthorized(_) | ApiError::Forbidden(_) => {
            "login"
        }
        ApiError::TooManyRequests(_) => "rateLimit",
        ApiError::Upstream(_) => "upstream",
        ApiError::BadRequest(_) => "input",
        // DB/Redis/configuration failures are not observations of the share.
        _ => return None,
    };
    Some(json!({"status":"unknown","errorKind":kind}))
}

async fn check_provider(state: &AppState, provider: String) -> Result<usize, ApiError> {
    let providers = vec![provider];
    let token = Uuid::new_v4();
    let row = sqlx::query(include_str!("claim_check.sql"))
        .bind(&providers)
        .bind(token)
        .fetch_optional(&state.pool)
        .await?;
    if let Some(row) = row {
        let id: Uuid = row.get("link_id");
        // Revalidate after claiming: a concurrent foreground check may have postponed
        // the catalog between enqueue's snapshot and the job INSERT.
        let c=sqlx::query("SELECT provider,original_url,original_password FROM resource_links WHERE id=$1 AND input_version=$2 AND next_check_at<=now()").bind(id).bind(row.get::<i64,_>("input_version")).fetch_optional(&state.pool).await?;
        let mut failure = None;
        let mut processed = 0;
        if let Some(c) = c {
            let checked = check(
                state,
                id,
                &Link {
                    r#type: c.get("provider"),
                    url: c.get("original_url"),
                    password: c.get("original_password"),
                },
                (row.get("id"), token),
            )
            .await;
            failure = match checked {
                Ok((checked, failure)) => {
                    processed = usize::from(checked);
                    failure
                }
                Err(error) => {
                    if let Some(value) = check_error_value(&error) {
                        let policy = load_provider(
                            state,
                            crate::cloud_drive::Provider::from_name(&providers[0])?,
                        )
                        .await?;
                        record_with_lease(state, id, &value, &policy, Some((row.get("id"), token)))
                            .await?;
                    } else {
                        let mut tx = state.pool.begin().await?;
                        // The historical prepare trigger resets run_after when status
                        // becomes queued. Apply the infrastructure backoff afterwards,
                        // while holding the same row lock so another worker cannot claim it.
                        let requeued = sqlx::query("UPDATE link_check_jobs SET status='queued',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()")
                            .bind(row.get::<i64,_>("id")).bind(token).execute(&mut *tx).await?;
                        if requeued.rows_affected() == 1 {
                            sqlx::query("UPDATE link_check_jobs SET run_after=GREATEST(run_after,now()+interval '30 seconds') WHERE id=$1")
                                .bind(row.get::<i64,_>("id")).execute(&mut *tx).await?;
                        }
                        tx.commit().await?;
                        return Err(error);
                    }
                    Some(error)
                }
            };
        }
        sqlx::query("UPDATE link_check_jobs SET status='completed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()").bind(row.get::<i64,_>("id")).bind(token).execute(&state.pool).await?;
        return failure.map_or(Ok(processed), Err);
    }
    Ok(0)
}

async fn housekeeping(state: &AppState) -> Result<usize, ApiError> {
    let rows = sqlx::query("SELECT r.id,r.subject_key,r.request_key,r.authorization_json,to_jsonb(c) AS catalog FROM link_resolve_requests r LEFT JOIN resource_links c ON c.id=r.link_id WHERE r.status IN('queued','running') AND r.deadline_at<=now() ORDER BY r.deadline_at,r.id LIMIT 100")
        .fetch_all(&state.pool).await?;
    let count = rows.len();
    let mut ids = Vec::with_capacity(count);
    let mut responses = Vec::with_capacity(count);
    for row in rows {
        let key: Uuid = row.get("request_key");
        ids.push(row.get::<Uuid, _>("id"));
        let auth: Value = row.get("authorization_json");
        let link: Option<Link> = auth["linkRef"]
            .as_str()
            .and_then(|r| serde_json::from_value(auth["snapshot"]["links"][r].clone()).ok());
        let fact: Option<Fact> = row
            .get::<Option<Value>, _>("catalog")
            .and_then(|v| serde_json::from_value(v).ok());
        let value = match (link, fact) {
            (Some(link), Some(fact)) => fallback(key, &link, &fact, "deadline_exceeded"),
            // A malformed snapshot must not pin the first recovery page forever.
            _ => {
                json!({"requestKey":key,"status":"unavailable","delivery":null,"validity":-1,"reasonCode":"authorization_unavailable"})
            }
        };
        responses
            .push(json!({"subject":row.get::<String,_>("subject_key"),"key":key,"result":value}));
    }
    if !responses.is_empty() {
        let mut tx = state.pool.begin().await?;
        sqlx::query(include_str!("finalize_expired_resolves.sql"))
            .bind(json!(responses))
            .execute(&mut *tx)
            .await?;
        // Persist completion and accelerate owned-artifact cleanup together.
        // The per-link cloud lock keeps cleanup from racing an acknowledgement.
        sqlx::query(include_str!("retire_expired_resolves.sql"))
            .bind(ids)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    sqlx::query(include_str!("cleanup_resolves.sql"))
        .execute(&state.pool)
        .await?;
    sqlx::query(include_str!("discard_disabled_checks.sql"))
        .execute(&state.pool)
        .await?;
    sqlx::query(include_str!("cleanup_checks.sql"))
        .execute(&state.pool)
        .await?;
    sqlx::query(include_str!("cleanup_detached_links.sql"))
        .execute(&state.pool)
        .await?;
    Ok(count)
}

async fn maintenance(state: &AppState) -> Result<usize, ApiError> {
    if !crate::runtime::schedule_slot(state, "link-maintenance", 30).await? {
        return Ok(0);
    }
    let mut processed = 0;
    for _ in 0..20 {
        if state.shutdown.is_cancelled() {
            break;
        }
        let aggregates = refresh_pending_aggregates(state).await?;
        let expired = refresh_aggregates(state).await?;
        let resolved = housekeeping(state).await?;
        processed += aggregates + expired + resolved;
        if aggregates < 100 && expired < 100 && resolved < 100 {
            return Ok(processed);
        }
    }
    // A bounded pass releases its reservation early when the backlog continues.
    sqlx::query("UPDATE worker_schedule_slots SET next_run_at=now() WHERE task='link-maintenance'")
        .execute(&state.pool)
        .await?;
    Ok(processed)
}

pub async fn run(state: Arc<AppState>) -> Result<(), ApiError> {
    use crate::runtime::{Heartbeat, WorkerKind, lane};
    let heartbeat = Heartbeat::start(state.clone(), WorkerKind::LinkSchedule);
    let check = Heartbeat::start(state.clone(), WorkerKind::LinkCheck);
    let cleanup = Heartbeat::start(state.clone(), WorkerKind::Links);
    let upkeep = Heartbeat::start(state.clone(), WorkerKind::LinkMaintenance);
    tokio::join!(
        crate::runtime::settings_listener(&state),
        check_lanes(&state),
        lane(
            &state,
            WorkerKind::Links,
            WorkerKind::Links.name(),
            2,
            || delivery::cleanup_batch(&state)
        ),
        lane(
            &state,
            WorkerKind::LinkMaintenance,
            WorkerKind::LinkMaintenance.name(),
            30,
            || maintenance(&state)
        ),
    );
    tokio::join!(
        check.finish(),
        cleanup.finish(),
        upkeep.finish(),
        heartbeat.finish()
    );
    Ok(())
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod queue_tests;

#[cfg(test)]
#[path = "concurrency_tests.rs"]
mod concurrency_tests;
