use super::*;
use crate::cloud_drive::{Drive, ShareInput};

async fn check(state: &AppState, id: Uuid, link: &Link, lease: (i64, Uuid)) -> Result<(), ApiError> {
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
    let policy: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='link-check'")
            .fetch_one(&state.pool)
            .await?;
    if !allow_check(state, reference.provider, &policy, false).await? {
        let mut tx = state.pool.begin().await?;
        crate::crawl::lock_index(&mut tx).await?;
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
    let value = drive.check(&reference).await;
    record_with_lease(state, id, &value, &policy, Some(lease)).await
}

pub(super) async fn allow_check(
    state: &AppState,
    provider: crate::cloud_drive::Provider,
    policy: &Value,
    foreground: bool,
) -> Result<bool, ApiError> {
    let budget = policy["dailyBudget"]
        .as_i64()
        .unwrap_or(1000)
        .clamp(1, 100000);
    let interval = policy["intervalSeconds"]
        .as_i64()
        .unwrap_or(2)
        .clamp(2, 3600);
    let mut conn = state.redis.connection()?;
    let gate: i64=redis::Script::new("if redis.call('GET',KEYS[1]) or redis.call('GET',KEYS[3]) then return 0 end; local n=tonumber(redis.call('GET',KEYS[2]) or '0'); local b=tonumber(redis.call('GET',KEYS[4]) or '0'); if n>=tonumber(ARGV[1]) or (ARGV[3]=='0' and b>=tonumber(ARGV[4])) then return 0 end; redis.call('SET',KEYS[1],'1','EX',ARGV[2]); redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); if ARGV[3]=='0' then redis.call('INCR',KEYS[4]); redis.call('EXPIRE',KEYS[4],86400) end; return 1")
        .key(format!("pansou:link-check:gate:{}",provider.name())).key(format!("pansou:link-check:budget:{}:{}",provider.name(),Utc::now().date_naive())).key(format!("pansou:link-check:breaker:{}",provider.name())).key(format!("pansou:link-check:background:{}:{}",provider.name(),Utc::now().date_naive())).arg(budget).arg(interval).arg(if foreground {1}else{0}).arg(budget * 4 / 5).invoke_async(&mut conn).await.map_err(|_|ApiError::Unavailable("检测调度暂不可用".into()))?;
    Ok(gate == 1)
}
pub(super) async fn record(
    state: &AppState,
    id: Uuid,
    value: &Value,
    policy: &Value,
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
    policy: &Value,
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
        policy["validSeconds"].as_i64().unwrap_or(86400)
    } else {
        policy["invalidSeconds"].as_i64().unwrap_or(604800)
    }
    .clamp(60, 2592000);
    // Keep observations and their resource aggregates atomic, with the same lock order
    // as ingestion/synchronization/expiry. Concurrent checks cannot publish stale facts.
    let mut tx = state.pool.begin().await?;
    crate::crawl::lock_index(&mut tx).await?;
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
    refresh_bound_aggregates(&mut tx, id).await?;
    tx.commit().await?;
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

async fn refresh_bound_aggregates(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<(), ApiError> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT DISTINCT resource_id FROM resource_link_bindings WHERE link_id=$1 AND scope_key='managed'")
        .bind(id).fetch_all(&mut **tx).await?;
    sqlx::query(include_str!("refresh_resources.sql"))
        .bind(&ids)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn refresh_aggregates(state: &AppState) -> Result<(), ApiError> {
    // Fast indexed no-op when checks are disabled or every observation is unknown.
    let due: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_catalog WHERE validity IN(0,1) AND valid_until IS NOT NULL AND valid_until<=now())")
        .fetch_one(&state.pool).await?;
    if !due {
        return Ok(());
    }
    let mut tx = state.pool.begin().await?;
    crate::crawl::lock_index(&mut tx).await?;
    let expired: Vec<Uuid> = sqlx::query_scalar("UPDATE link_catalog SET validity=-1,valid_until=NULL,updated_at=now() WHERE id IN (SELECT id FROM link_catalog WHERE validity IN(0,1) AND valid_until IS NOT NULL AND valid_until<=now() ORDER BY valid_until,id LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id")
        .fetch_all(&mut *tx).await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT DISTINCT resource_id FROM resource_link_bindings WHERE link_id=ANY($1) AND scope_key='managed'")
        .bind(&expired).fetch_all(&mut *tx).await?;
    sqlx::query(include_str!("refresh_resources.sql"))
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// The outbox is locked while its snapshot is bound, so concurrent edits cannot be lost.
async fn sync_batch(state: &AppState) -> Result<(), ApiError> {
    // Bound both batch size and duty cycle; release the crawl commit lock per resource.
    let started = std::time::Instant::now();
    for _ in 0..50 {
        if state.shutdown.is_cancelled() || started.elapsed() >= Duration::from_millis(200) {
            break;
        }
        let mut tx = state.pool.begin().await?;
        crate::crawl::lock_index(&mut tx).await?;
        let Some(id)=sqlx::query_scalar::<_,String>("SELECT resource_id FROM link_sync_queue ORDER BY updated_at,resource_id FOR UPDATE SKIP LOCKED LIMIT 1").fetch_optional(&mut *tx).await? else {break};
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
        let mut active_catalog = std::collections::HashSet::new();
        for (scope, links) in scopes {
            for link in serde_json::from_value::<Vec<Link>>(links).unwrap_or_default() {
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
                            sqlx::query_scalar(
                                "SELECT id FROM link_catalog WHERE input_fingerprint=$1",
                            )
                            .bind(&key)
                            .fetch_one(&mut *tx)
                            .await?
                        }
                    };
                    if matches!(link.r#type.as_str(), "baidu" | "quark") {
                        // Disabled checks should not create an ever-growing dormant queue.
                        // The bounded catalog sweep compensates when checks are enabled later.
                        sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,priority) SELECT c.id,c.input_version,'original',1 FROM link_catalog c WHERE c.id=$1 AND EXISTS(SELECT 1 FROM policy_settings WHERE key='link-check' AND value_json->>'enabled'='true') ON CONFLICT DO NOTHING").bind(link_id).execute(&mut *tx).await?;
                    }
                    catalog.insert(key.clone(), link_id);
                    link_id
                };
                active_catalog.insert(link_id);
                if existing.remove(&(scope.clone(), key.clone())) != Some((link_id, revision)) {
                    sqlx::query("INSERT INTO resource_link_bindings(resource_id,scope_key,link_key,link_id,links_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(resource_id,scope_key,link_key) DO UPDATE SET link_id=excluded.link_id,links_revision=excluded.links_revision,updated_at=now()")
                        .bind(&id).bind(&scope).bind(&key).bind(link_id).bind(revision).execute(&mut *tx).await?;
                }
            }
        }
        sqlx::query("UPDATE link_catalog SET last_seen_at=now() WHERE id=ANY($1) AND last_seen_at<now()-interval '1 hour'")
            .bind(active_catalog.into_iter().collect::<Vec<_>>()).execute(&mut *tx).await?;
        for ((scope, key), _) in existing {
            sqlx::query("DELETE FROM resource_link_bindings WHERE resource_id=$1 AND scope_key=$2 AND link_key=$3")
                .bind(&id).bind(scope).bind(key).execute(&mut *tx).await?;
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
    }
    Ok(())
}
async fn check_tick(state: &AppState) -> Result<(), ApiError> {
    let enabled:bool=sqlx::query_scalar("SELECT COALESCE((value_json->>'enabled')::boolean,false) FROM policy_settings WHERE key='link-check'").fetch_one(&state.pool).await?;
    if !enabled {
        return Ok(());
    }
    let providers: Vec<String> = sqlx::query_scalar("SELECT provider FROM cloud_account_settings WHERE provider IN('baidu','quark') AND length(trim(credential))>0 ORDER BY provider")
        .fetch_all(&state.pool).await?;
    if providers.is_empty() {
        return Ok(());
    }
    sqlx::query(include_str!("recover_checks.sql")).execute(&state.pool).await?;
    for provider in &providers {
        sqlx::query(include_str!("enqueue_checks.sql")).bind(provider).execute(&state.pool).await?;
    }
    let token = Uuid::new_v4();
    let row = sqlx::query(include_str!("claim_check.sql")).bind(&providers).bind(token).fetch_optional(&state.pool).await?;
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
                    &json!({}),
                    Some((row.get("id"), token)),
                )
                .await?;
            }
        }
        sqlx::query("UPDATE link_check_jobs SET status='completed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$2").bind(row.get::<i64,_>("id")).bind(token).execute(&state.pool).await?;
    }
    Ok(())
}

async fn housekeeping(state: &AppState) -> Result<(), ApiError> {
    let rows = sqlx::query("SELECT id,request_key,link_id,authorization_json FROM link_resolve_requests WHERE status IN('queued','running') AND deadline_at<=now() ORDER BY deadline_at LIMIT 100").fetch_all(&state.pool).await?;
    for row in rows {
        let auth: Value = row.get("authorization_json");
        let link: Option<Link> = auth["linkRef"]
            .as_str()
            .and_then(|r| serde_json::from_value(auth["snapshot"]["links"][r].clone()).ok());
        if let Some(link) = link {
            let value = fallback(
                row.get("request_key"),
                &link,
                &fact(state, row.get("link_id")).await?,
                "deadline_exceeded",
            );
            sqlx::query("UPDATE link_resolve_requests SET status='completed',response_json=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND response_json IS NULL AND deadline_at<=now()").bind(row.get::<Uuid,_>("id")).bind(value).execute(&state.pool).await?;
        }
    }
    sqlx::query(include_str!("cleanup_resolves.sql"))
        .execute(&state.pool)
        .await?;
    sqlx::query(include_str!("cleanup_checks.sql")).execute(&state.pool).await?;
    Ok(())
}

pub async fn run(state: Arc<AppState>) -> Result<(), ApiError> {
    tracing::info!("link worker started; delivery/check policies control upstream access");
    let _heartbeat =
        crate::runtime::Heartbeat::start(state.clone(), crate::runtime::WorkerKind::Links);
    // Separate lanes keep slow upstream cleanup from starving ingestion synchronization/checks.
    use crate::runtime::{WorkerKind, always_lane, lane};
    tokio::join!(
        always_lane(&state, "link-sync", 2, || sync_batch(&state)),
        always_lane(&state, "link-check", 2, || check_tick(&state)),
        lane(&state, WorkerKind::Links, "link-cleanup", 2, || {
            delivery::cleanup_tick(&state)
        }),
        always_lane(&state, "link-maintenance", 30, || async {
            refresh_aggregates(&state).await?;
            housekeeping(&state).await
        }),
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
        record(&state, first_id, &json!({"status":"invalid"}), &json!({}))
            .await
            .unwrap();
        record(&state, second_id, &json!({"status":"valid"}), &json!({}))
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
            &json!({}),
        )
        .await
        .unwrap();
        assert_eq!(validity(&multiple).await, -1);
        let valid = json!({"status":"valid"});
        let unknown = json!({"status":"unknown","errorKind":"upstream"});
        let policy = json!({});
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
