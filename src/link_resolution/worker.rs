use super::delivery::{ProviderPolicy, load_provider};
use super::*;
use crate::cloud_drive::{Drive, ShareInput};

async fn check(
    state: &AppState,
    id: Uuid,
    link: &Link,
    lease: (i64, Uuid),
) -> Result<(), ApiError> {
    let input = ShareInput {
        url: link.url.clone(),
        provider: None,
        password: link.password.clone(),
    };
    let reference = match input.parse() {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    // Background checks cannot consume the quota reserved for interactive delivery.
    let policy = load_provider(state, reference.provider).await?;
    if !allow_check(state, reference.provider, &policy, false).await? {
        let mut tx = state.pool.begin().await?;
        if !lock_check_lease(&mut tx, lease).await? {
            tx.rollback().await?;
            return Ok(());
        }
        sqlx::query("UPDATE link_catalog SET next_check_at=now()+interval '5 minutes' WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(());
    }
    let drive = Drive::load(state, reference.provider).await?;
    let value = tokio::time::timeout(Duration::from_secs(20), drive.check(&reference))
        .await
        .unwrap_or_else(|_| json!({"status":"unknown","errorKind":"upstream"}));
    record_with_lease(state, id, &value, &policy, Some(lease)).await
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
        sqlx::query("UPDATE link_catalog SET validity=$2,checked_at=now(),valid_until=now()+make_interval(secs=>$3),last_attempt_at=now(),next_check_at=now()+make_interval(secs=>$3),failure_count=0,last_error_code=$4,updated_at=now() WHERE id=$1")
            .bind(id).bind(validity).bind(seconds as f64).bind(if validity == 0 {Some(reason)}else{None}).execute(&mut *tx).await?;
    } else {
        sqlx::query("UPDATE link_catalog SET validity=-1,valid_until=NULL,last_attempt_at=now(),next_check_at=now()+make_interval(secs=>CASE failure_count WHEN 0 THEN 300 WHEN 1 THEN 1800 WHEN 2 THEN 7200 ELSE 21600 END + floor(random()*60)),failure_count=failure_count+1,last_error_code=$2,updated_at=now() WHERE id=$1")
            .bind(id).bind(reason).execute(&mut *tx).await?;
    }
    // Persist the observation first; Redis failure must never leave an old 0/1 behind.
    tx.commit().await?;
    if let Err(error) = refresh_pending_aggregates(state).await {
        // The fact is already committed; an unavailable projection must not
        // turn a successful check into an unknown observation on retry.
        tracing::warn!(%error, "aggregate refresh deferred to durable queue");
    }
    if validity == -1 && matches!(reason, "account_unavailable" | "rate_limited") {
        let provider: String = sqlx::query_scalar("SELECT provider FROM link_catalog WHERE id=$1")
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
    let due: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_catalog WHERE validity IN(0,1) AND valid_until IS NOT NULL AND valid_until<=now())")
        .fetch_one(&state.pool).await?;
    if !due {
        return Ok(0);
    }
    let mut tx = state.pool.begin().await?;
    let expired: Vec<Uuid> = sqlx::query_scalar("WITH candidates AS MATERIALIZED (SELECT id FROM link_catalog WHERE validity IN(0,1) AND valid_until IS NOT NULL AND valid_until<=now() ORDER BY valid_until,id LIMIT 100), locked AS MATERIALIZED (SELECT c.id FROM link_catalog c JOIN candidates d ON d.id=c.id ORDER BY c.input_fingerprint FOR UPDATE OF c SKIP LOCKED) UPDATE link_catalog SET validity=-1,valid_until=NULL,updated_at=now() WHERE id IN(SELECT id FROM locked) AND validity IN(0,1) AND valid_until<=now() RETURNING id")
        .fetch_all(&mut *tx).await?;
    tx.commit().await?;
    refresh_pending_aggregates(state).await?;
    Ok(expired.len())
}

/// The outbox is locked while its snapshot is bound, so concurrent edits cannot be lost.
async fn sync_batch(state: &AppState) -> Result<usize, ApiError> {
    // Bound batch duration for pause responsiveness; busy lanes immediately continue.
    let started = std::time::Instant::now();
    let mut processed = 0;
    for _ in 0..50 {
        if state.shutdown.is_cancelled() || started.elapsed() >= Duration::from_millis(200) {
            break;
        }
        let mut tx = state.pool.begin().await?;
        let Some(id)=sqlx::query_scalar::<_,String>("SELECT r.id FROM managed_resources r JOIN link_sync_queue q ON q.resource_id=r.id ORDER BY q.updated_at,r.id FOR NO KEY UPDATE OF r SKIP LOCKED LIMIT 1").fetch_optional(&mut *tx).await? else {break};
        sqlx::query("SELECT resource_id FROM link_sync_queue WHERE resource_id=$1 FOR UPDATE")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
        let row =
            sqlx::query("SELECT links_json,links_revision FROM managed_resources WHERE id=$1")
                .bind(&id)
                .fetch_one(&mut *tx)
                .await?;
        let revision: i64 = row.get("links_revision");
        let mut scopes = vec![("managed".to_string(), row.get::<Value, _>("links_json"))];
        for r in sqlx::query("SELECT channel_id,message_id,result_json FROM resource_occurrences WHERE resource_id=$1").bind(&id).fetch_all(&mut *tx).await? {
            scopes.push((format!("occurrence:{}:{}",r.get::<String,_>("channel_id"),r.get::<i64,_>("message_id")),r.get::<Value,_>("result_json")["links"].clone()));
        }
        let mut existing = HashMap::new();
        for row in sqlx::query("SELECT scope_key,link_key,link_id,links_revision FROM resource_link_bindings WHERE resource_id=$1")
            .bind(&id).fetch_all(&mut *tx).await? {
            existing.insert((row.get::<String,_>("scope_key"), row.get::<String,_>("link_key")), (row.get::<Uuid,_>("link_id"),row.get::<i64,_>("links_revision")));
        }
        // Existing bindings already carry the immutable fingerprint -> catalog ID mapping.
        // Replayed occurrence updates need no catalog registration or job insertion.
        let mut catalog: HashMap<String, Uuid> = existing
            .iter()
            .map(|((_, key), (link_id, _))| (key.clone(), *link_id))
            .collect();
        let mut seen = std::collections::HashSet::new();
        let mut changed_scopes = Vec::new();
        let mut changed_keys = Vec::new();
        let mut changed_catalog = Vec::new();
        // Catalog inserts can contend across resources. Acquire fingerprint
        // conflicts in one order even when source links arrived in reverse order.
        let mut scoped_links: Vec<_> = scopes
            .into_iter()
            .flat_map(|(scope, links)| {
                serde_json::from_value::<Vec<Link>>(links)
                    .unwrap_or_default()
                    .into_iter()
                    .map(move |link| (scope.clone(), link))
            })
            .collect();
        scoped_links.sort_by_cached_key(|(_, link)| fingerprint(link));
        for (scope, link) in scoped_links {
            let key = fingerprint(&link);
            if !seen.insert((scope.clone(), key.clone())) {
                continue;
            }
            let link_id = if let Some(link_id) = catalog.get(&key) {
                *link_id
            } else {
                // Repeated occurrences of a share must not generate repeated catalog writes.
                let inserted: Option<Uuid> = sqlx::query_scalar("INSERT INTO link_catalog(id,provider,identity,original_url,original_password,input_fingerprint,next_check_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(input_fingerprint) DO NOTHING RETURNING id")
                        .bind(Uuid::new_v4()).bind(&link.r#type).bind(resource_clean::link_identity(&link.url)).bind(&link.url).bind(&link.password).bind(&key).fetch_optional(&mut *tx).await?;
                let link_id = match inserted {
                    Some(link_id) => link_id,
                    None => {
                        sqlx::query_scalar("SELECT id FROM link_catalog WHERE input_fingerprint=$1")
                            .bind(&key)
                            .fetch_one(&mut *tx)
                            .await?
                    }
                };
                if crate::cloud_drive::Provider::from_name(&link.r#type).is_ok() {
                    // Disabled checks should not create an ever-growing dormant queue.
                    // The bounded catalog sweep compensates when checks are enabled later.
                    sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,priority) SELECT c.id,c.input_version,'original',1 FROM link_catalog c WHERE c.id=$1 AND EXISTS(SELECT 1 FROM policy_settings WHERE key='link-check' AND value_json->>'enabled'='true') ON CONFLICT DO NOTHING").bind(link_id).execute(&mut *tx).await?;
                }
                catalog.insert(key.clone(), link_id);
                link_id
            };
            // Serialize a new binding with observations of its catalog row.
            // Otherwise a check could miss an uncommitted binding and its
            // outbox notification while sync reads the older observation.
            sqlx::query("SELECT id FROM link_catalog WHERE id=$1 FOR SHARE")
                .bind(link_id)
                .fetch_one(&mut *tx)
                .await?;
            if existing.remove(&(scope.clone(), key.clone())) != Some((link_id, revision)) {
                changed_scopes.push(scope);
                changed_keys.push(key);
                changed_catalog.push(link_id);
            }
        }
        if !changed_scopes.is_empty() {
            sqlx::query("INSERT INTO resource_link_bindings(resource_id,scope_key,link_key,link_id,links_revision) SELECT $1,b.scope,b.key,b.link_id,$5 FROM unnest($2::text[],$3::text[],$4::uuid[]) AS b(scope,key,link_id) ON CONFLICT(resource_id,scope_key,link_key) DO UPDATE SET link_id=excluded.link_id,links_revision=excluded.links_revision,updated_at=now()")
                .bind(&id).bind(changed_scopes).bind(changed_keys).bind(changed_catalog).bind(revision)
                .execute(&mut *tx).await?;
        }
        if !existing.is_empty() {
            let (scopes, keys): (Vec<_>, Vec<_>) = existing.into_keys().unzip();
            sqlx::query("DELETE FROM resource_link_bindings b USING unnest($2::text[],$3::text[]) AS stale(scope,key) WHERE b.resource_id=$1 AND b.scope_key=stale.scope AND b.link_key=stale.key")
                .bind(&id).bind(scopes).bind(keys).execute(&mut *tx).await?;
        }
        // New bindings can point at an already-checked link; refresh in this same transaction.
        sqlx::query(include_str!("refresh_resources.sql"))
            .bind(vec![id.clone()])
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM link_sync_queue WHERE resource_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        processed += 1;
    }
    Ok(processed + refresh_pending_aggregates(state).await?)
}
async fn check_tick(state: &AppState) -> Result<usize, ApiError> {
    let enabled:bool=sqlx::query_scalar("SELECT COALESCE((value_json->>'enabled')::boolean,false) FROM policy_settings WHERE key='link-check'").fetch_one(&state.pool).await?;
    if !enabled {
        return Ok(0);
    }
    let providers: Vec<String> = sqlx::query_scalar("SELECT provider FROM cloud_account_settings WHERE provider IN('baidu','quark','aliyun','xunlei','guangya') AND (length(trim(credential))>0 OR credential_cipher IS NOT NULL) AND auth_status NOT IN('reauthorization_required','disconnected') ORDER BY provider")
        .fetch_all(&state.pool).await?;
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
    // One concurrent job per provider; the Redis gate continues to enforce the
    // cluster-wide provider rate/budget. Do not claim work while a gate is closed.
    use futures::{StreamExt, stream};
    let completed: Vec<Result<usize, ApiError>> =
        stream::iter(providers.into_iter().map(|provider| async move {
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
            check_provider(state, provider).await
        }))
        .buffer_unordered(5)
        .collect()
        .await;
    // Wait for every claimed check. A sibling error must not drop another
    // provider's in-flight observation and leave its job running until recovery.
    completed
        .into_iter()
        .try_fold(0, |total, result| result.map(|n| total + n))
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
        let c=sqlx::query("SELECT provider,original_url,original_password FROM link_catalog WHERE id=$1 AND input_version=$2 AND next_check_at<=now()").bind(id).bind(row.get::<i64,_>("input_version")).fetch_optional(&state.pool).await?;
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
            if checked.is_err() {
                record_with_lease(
                    state,
                    id,
                    &json!({"status":"unknown","errorKind":"upstream"}),
                    &ProviderPolicy::default(),
                    Some((row.get("id"), token)),
                )
                .await?;
            }
        }
        sqlx::query("UPDATE link_check_jobs SET status='completed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$2").bind(row.get::<i64,_>("id")).bind(token).execute(&state.pool).await?;
        return Ok(1);
    }
    Ok(0)
}

async fn housekeeping(state: &AppState) -> Result<usize, ApiError> {
    let rows = sqlx::query("SELECT r.id,r.subject_key,r.request_key,r.authorization_json,to_jsonb(c) AS catalog FROM link_resolve_requests r LEFT JOIN link_catalog c ON c.id=r.link_id WHERE r.status IN('queued','running') AND r.deadline_at<=now() ORDER BY r.deadline_at,r.id LIMIT 100")
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
    sqlx::query(include_str!("cleanup_checks.sql"))
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
        let expired = refresh_aggregates(state).await?;
        let resolved = housekeeping(state).await?;
        processed += expired + resolved;
        if expired < 100 && resolved < 100 {
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
    let sync = Heartbeat::start(state.clone(), WorkerKind::LinkSync);
    let check = Heartbeat::start(state.clone(), WorkerKind::LinkCheck);
    let cleanup = Heartbeat::start(state.clone(), WorkerKind::Links);
    let upkeep = Heartbeat::start(state.clone(), WorkerKind::LinkMaintenance);
    tokio::join!(
        crate::runtime::settings_listener(&state),
        lane(
            &state,
            WorkerKind::LinkSync,
            WorkerKind::LinkSync.name(),
            2,
            || sync_batch(&state)
        ),
        lane(
            &state,
            WorkerKind::LinkCheck,
            WorkerKind::LinkCheck.name(),
            2,
            || check_tick(&state)
        ),
        lane(
            &state,
            WorkerKind::Links,
            WorkerKind::Links.name(),
            2,
            || delivery::cleanup_tick(&state)
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
        sync.finish(),
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
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
    async fn incremental_sync_and_expiry_preserve_facts_without_rewriting_bindings() {
        let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(
            url::Url::parse(&database)
                .unwrap()
                .path()
                .ends_with("_test")
        );
        let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
        let redis_path = url::Url::parse(&redis_url).unwrap().path().to_owned();
        assert!(redis_path != "/0" && !redis_path.is_empty() && redis_path != "/");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .connect(&database)
            .await
            .unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let state = AppState::new(
            pool.clone(),
            crate::redis_store::RedisStore::connect(&redis_url)
                .await
                .unwrap(),
        );
        let first = Link {
            r#type: "quark".into(),
            url: format!("https://pan.quark.cn/s/perf{}", Uuid::new_v4().simple()),
            password: None,
        };
        let second = Link {
            url: format!("https://pan.quark.cn/s/perf{}", Uuid::new_v4().simple()),
            ..first.clone()
        };
        let first_id = register(&state, &first).await.unwrap();
        let second_id = register(&state, &second).await.unwrap();
        let single = format!("perf-single-{}", Uuid::new_v4());
        let multiple = format!("perf-multiple-{}", Uuid::new_v4());
        for (id, links) in [
            (&single, json!([first.clone(), first.clone()])),
            (&multiple, json!([first.clone(), second.clone()])),
        ] {
            sqlx::query("INSERT INTO managed_resources(id,name,links_json) VALUES($1,'worker performance fixture',$2)").bind(id).bind(links).execute(&pool).await.unwrap();
        }
        // Existing observations must propagate when a resource is first associated.
        record(
            &state,
            first_id,
            &json!({"status":"invalid"}),
            &ProviderPolicy::default(),
        )
        .await
        .unwrap();
        record(
            &state,
            second_id,
            &json!({"status":"valid"}),
            &ProviderPolicy::default(),
        )
        .await
        .unwrap();
        sync_batch(&state).await.unwrap();
        let validity = async |id: &str| {
            sqlx::query_scalar::<_, i16>("SELECT link_validity FROM managed_resources WHERE id=$1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        assert_eq!(validity(&single).await, 0);
        assert_eq!(validity(&multiple).await, 1);
        let before: Vec<String> = sqlx::query_scalar("SELECT scope_key||link_key||xmin::text FROM resource_link_bindings WHERE resource_id=ANY($1) ORDER BY resource_id,scope_key,link_key")
            .bind(vec![single.clone(),multiple.clone()]).fetch_all(&pool).await.unwrap();
        assert_eq!(
            before.len(),
            3,
            "duplicate shares in one scope are stored once"
        );
        let catalog_xmin: String =
            sqlx::query_scalar("SELECT xmin::text FROM link_catalog WHERE id=$1")
                .bind(first_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        for id in [&single, &multiple] {
            sqlx::query("INSERT INTO link_sync_queue(resource_id) VALUES($1) ON CONFLICT(resource_id) DO UPDATE SET updated_at=now()")
                .bind(id).execute(&pool).await.unwrap();
        }
        sync_batch(&state).await.unwrap();
        let after: Vec<String> = sqlx::query_scalar("SELECT scope_key||link_key||xmin::text FROM resource_link_bindings WHERE resource_id=ANY($1) ORDER BY resource_id,scope_key,link_key")
            .bind(vec![single.clone(),multiple.clone()]).fetch_all(&pool).await.unwrap();
        assert_eq!(
            before, after,
            "unchanged associations must not be rewritten"
        );
        assert_eq!(
            catalog_xmin,
            sqlx::query_scalar::<_, String>("SELECT xmin::text FROM link_catalog WHERE id=$1")
                .bind(first_id)
                .fetch_one(&pool)
                .await
                .unwrap()
        );
        sqlx::query("UPDATE link_catalog SET valid_until=now()-interval '1 second' WHERE id=$1")
            .bind(first_id)
            .execute(&pool)
            .await
            .unwrap();
        refresh_aggregates(&state).await.unwrap();
        assert_eq!(
            validity(&single).await,
            -1,
            "expired invalid does not remain invalid"
        );
        assert_eq!(
            validity(&multiple).await,
            1,
            "another valid link keeps the resource valid"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i16>("SELECT validity FROM link_catalog WHERE id=$1")
                .bind(first_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            -1
        );
        // A second maintenance pass is a read-only no-op, not another all-resource update.
        let resource_xmin: String =
            sqlx::query_scalar("SELECT xmin::text FROM managed_resources WHERE id=$1")
                .bind(&multiple)
                .fetch_one(&pool)
                .await
                .unwrap();
        refresh_aggregates(&state).await.unwrap();
        assert_eq!(
            resource_xmin,
            sqlx::query_scalar::<_, String>("SELECT xmin::text FROM managed_resources WHERE id=$1")
                .bind(&multiple)
                .fetch_one(&pool)
                .await
                .unwrap()
        );
        // Detection failures still overwrite both catalog and resource validity with -1.
        record(
            &state,
            second_id,
            &json!({"status":"unknown","errorKind":"upstream"}),
            &ProviderPolicy::default(),
        )
        .await
        .unwrap();
        assert_eq!(validity(&multiple).await, -1);
        let valid = json!({"status":"valid"});
        let unknown = json!({"status":"unknown","errorKind":"upstream"});
        let policy = ProviderPolicy::default();
        let (a, b) = tokio::join!(
            record(&state, first_id, &valid, &policy),
            record(&state, first_id, &unknown, &policy)
        );
        a.unwrap();
        b.unwrap();
        let final_fact: i16 = sqlx::query_scalar("SELECT validity FROM link_catalog WHERE id=$1")
            .bind(first_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            validity(&single).await,
            final_fact,
            "concurrent observations and aggregation are atomic"
        );
        assert_eq!(validity(&multiple).await, final_fact);
        sqlx::query("UPDATE managed_resources SET links_json='[]' WHERE id=$1")
            .bind(&multiple)
            .execute(&pool)
            .await
            .unwrap();
        sync_batch(&state).await.unwrap();
        assert_eq!(
            validity(&multiple).await,
            -1,
            "empty resources must not become invalid"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM resource_link_bindings WHERE resource_id=$1"
            )
            .bind(&multiple)
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM link_sync_queue WHERE resource_id=ANY($1)"
            )
            .bind(vec![single.clone(), multiple.clone()])
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        sqlx::query("DELETE FROM managed_resources WHERE id=ANY($1)")
            .bind(vec![single, multiple])
            .execute(&pool)
            .await
            .unwrap();
    }
}

#[cfg(test)]
#[path = "concurrency_tests.rs"]
mod concurrency_tests;
