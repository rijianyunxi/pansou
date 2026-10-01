use super::common::{admin_only, ok};
use crate::{
    app::AppState,
    error::ApiError,
    runtime::{self, WorkerKind},
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerUpdate {
    enabled: bool,
}

pub async fn runtime_worker_update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Json(update): Json<WorkerUpdate>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let key = match kind.as_str() {
        "crawl" => "crawlEnabled",
        // Legacy links switch now pauses cleanup only, never local sync or click delivery.
        "links" | "cleanup" => "linkEnabled",
        _ => return Err(ApiError::BadRequest("未知后台任务类型".into())),
    };
    // Merge only the selected switch, so simultaneous edits cannot overwrite the other.
    sqlx::query("INSERT INTO policy_settings(key,value_json) VALUES('background-workers',$1) ON CONFLICT(key) DO UPDATE SET value_json=policy_settings.value_json || $2")
        .bind(json!({"crawlEnabled":true,"linkEnabled":true,key:update.enabled}))
        .bind(json!({key:update.enabled})).execute(&state.pool).await?;
    Ok(ok(json!({"settings":runtime::settings(&state).await?})))
}

async fn worker_status(state: &AppState, kind: WorkerKind, enabled: bool) -> Value {
    let count = match state.redis.connection() {
        Ok(mut conn) => conn
            .zcount::<_, _, _, i64>(kind.key(), Utc::now().timestamp() - 45, "+inf")
            .await
            .ok(),
        Err(_) => None,
    };
    json!({"state":match count {None=>"unknown",Some(0)=>"offline",Some(_)=>"online"},"count":count,"enabled":enabled})
}

pub async fn monitor(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let settings = runtime::settings(&state).await?;
    let (crawl_worker, link_worker, redis) = tokio::join!(
        worker_status(&state, WorkerKind::Crawl, settings.crawl_enabled),
        worker_status(&state, WorkerKind::Links, settings.link_enabled),
        state.redis.ping(),
    );
    let crawl = sqlx::query("SELECT count(*) FILTER(WHERE j.status='queued') queued, count(*) FILTER(WHERE j.status='running') running, count(*) FILTER(WHERE j.status='failed') failed, count(*) FILTER(WHERE j.status='paused') paused, count(*) FILTER(WHERE j.status='running' AND j.lease_until<now()) expired, count(*) FILTER(WHERE j.status='queued' AND j.next_run_at<=now() AND c.enabled AND c.next_page_at<=now() AND NOT EXISTS(SELECT 1 FROM crawl_jobs running WHERE running.channel_id=j.channel_id AND running.status='running')) ready, MAX(j.updated_at) last_activity FROM crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id")
        .fetch_one(&state.pool).await?;
    let index = sqlx::query("SELECT (SELECT count(*) FROM crawl_channels) channels, (SELECT count(*) FROM crawl_channels WHERE enabled) active_channels, (SELECT count(*) FROM crawl_page_failures) review, (SELECT MAX(last_synced_at) FROM crawl_channels) last_sync, (SELECT count(*) FROM crawl_channels c WHERE c.enabled AND c.next_sync_at<=now()) overdue_channels")
        .fetch_one(&state.pool).await?;
    let counts = state.admin_stats.monitor(&state.pool).await?;
    let links = sqlx::query("SELECT count(*) sync_pending,min(updated_at) oldest_sync FROM link_sync_queue")
        .fetch_one(&state.pool).await?;
    let link_queues = sqlx::query("SELECT 'checks' kind,status,count(*) count FROM link_check_jobs GROUP BY status UNION ALL SELECT 'cleanup',status,count(*) FROM link_cleanup_jobs GROUP BY status UNION ALL SELECT 'resolve',status,count(*) FROM link_resolve_requests GROUP BY status")
        .fetch_all(&state.pool).await?;
    let cleanup_due: i64 = sqlx::query_scalar("SELECT count(*) FROM link_cleanup_jobs WHERE status='queued' AND run_after<=now() OR status='running' AND lease_until<now()")
        .fetch_one(&state.pool).await?;
    let stuck_checks: i64 = sqlx::query_scalar("SELECT count(*) FROM link_check_jobs WHERE status='running' AND lease_until<now()")
        .fetch_one(&state.pool).await?;
    let recent_failures = sqlx::query("SELECT provider,identity,validity,failure_count,last_error_code,last_attempt_at,next_check_at FROM link_catalog WHERE failure_count>0 AND last_error_code IS NOT NULL ORDER BY last_attempt_at DESC,id LIMIT 8")
        .fetch_all(&state.pool).await?.into_iter().map(|r|json!({
            "provider":r.get::<String,_>("provider"),"identity":r.get::<Option<String>,_>("identity"),
            "validity":r.get::<i16,_>("validity"),"failureCount":r.get::<i32,_>("failure_count"),
            "lastErrorCode":r.get::<Option<String>,_>("last_error_code"),
            "lastAttemptAt":r.get::<Option<DateTime<Utc>>,_>("last_attempt_at"),
            "nextCheckAt":r.get::<Option<DateTime<Utc>>,_>("next_check_at")})).collect::<Vec<_>>();
    let recent_cleanup = sqlx::query("SELECT j.status,j.stage,j.last_error_code,j.attempts,j.updated_at,c.provider FROM link_cleanup_jobs j LEFT JOIN link_share_cache s ON s.id=j.share_cache_id LEFT JOIN link_catalog c ON c.id=s.link_id ORDER BY j.updated_at DESC LIMIT 8")
        .fetch_all(&state.pool).await?.into_iter().map(|r|json!({
            "status":r.get::<String,_>("status"),"stage":r.get::<Option<String>,_>("stage"),
            "lastErrorCode":r.get::<Option<String>,_>("last_error_code"),"attempts":r.get::<i32,_>("attempts"),
            "provider":r.get::<Option<String>,_>("provider"),
            "updatedAt":r.get::<DateTime<Utc>, _>("updated_at")})).collect::<Vec<_>>();
    let outcomes = sqlx::query("SELECT count(*) FILTER(WHERE status IN('queued','running') AND deadline_at>now()) processing,count(*) FILTER(WHERE status='completed' AND delivery='reshared' AND response_json->>'cacheHit'='false') transferred,count(*) FILTER(WHERE status='completed' AND delivery='reshared' AND response_json->>'cacheHit'='true') reused,count(*) FILTER(WHERE status='completed' AND delivery='original' AND reason_code NOT IN('delivery_disabled','unsupported_provider')) fallback,count(*) FILTER(WHERE status='completed' AND delivery='original' AND reason_code IN('delivery_disabled','unsupported_provider')) direct,count(*) FILTER(WHERE status='completed' AND response_json->>'status'='unavailable') unavailable FROM link_resolve_requests WHERE created_at>now()-interval '24 hours'").fetch_one(&state.pool).await?;
    let delivery_stats = json!({"processing":outcomes.get::<i64,_>("processing"),"transferred":outcomes.get::<i64,_>("transferred"),"reused":outcomes.get::<i64,_>("reused"),"fallback":outcomes.get::<i64,_>("fallback"),"direct":outcomes.get::<i64,_>("direct"),"unavailable":outcomes.get::<i64,_>("unavailable")});
    let policies = sqlx::query(
        "SELECT key,value_json FROM policy_settings WHERE key IN('link-delivery','link-check')",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut checks_enabled = false;
    let mut delivery_enabled = json!({"baidu":false,"quark":false});
    for row in policies {
        let value: Value = row.get("value_json");
        if row.get::<String, _>("key") == "link-check" {
            checks_enabled = value["enabled"].as_bool().unwrap_or(false);
        } else {
            for provider in ["baidu", "quark"] {
                delivery_enabled[provider] =
                    json!(value[provider]["enabled"].as_bool().unwrap_or(false));
            }
        }
    }
    let rows = sqlx::query("SELECT s.id,s.name,s.priority,s.enabled,s.updated_at,h.snapshot_json FROM resource_sources s LEFT JOIN source_health h ON h.source_id=s.id WHERE s.kind='live' ORDER BY s.priority,s.id")
        .fetch_all(&state.pool).await?;
    let sources = rows.into_iter().map(|row|json!({
        "id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),
        "priority":row.get::<i32,_>("priority"),"kind":"live","enabled":row.get::<bool,_>("enabled"),
        "version":row.get::<DateTime<Utc>,_>("updated_at"),
        "health":row.get::<Option<Value>,_>("snapshot_json").map(super::public::normalize_monitor_health),
    })).collect::<Vec<_>>();
    let failures = sqlx::query("SELECT channel_id,kind,last_error,updated_at FROM crawl_jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 5")
        .fetch_all(&state.pool).await?.into_iter().map(|r|json!({"channel":r.get::<String,_>("channel_id"),"kind":r.get::<String,_>("kind"),"error":r.get::<Option<String>,_>("last_error"),"at":r.get::<DateTime<Utc>,_>("updated_at")})).collect::<Vec<_>>();
    let mut queues = json!({"checks":{"queued":0,"running":0,"failed":0,"completed":0},"cleanup":{"queued":0,"running":0,"failed":0,"blocked":0,"completed":0},"resolve":{"queued":0,"running":0,"failed":0,"completed":0}});
    for r in link_queues {
        queues[r.get::<String, _>("kind")][r.get::<String, _>("status")] =
            json!(r.get::<i64, _>("count"));
    }
    Ok(ok(json!({
        "generatedAt":Utc::now(),"sources":sources,
        "services":{"api":{"state":"online","startedAt":state.started_at},"postgres":{"state":"online","connections":state.pool.size(),"idle":state.pool.num_idle()},"redis":{"state":if redis.is_ok(){"online"}else{"unavailable"}}},
        "workers":{"crawl":crawl_worker,"links":link_worker},
        "crawl":{"queued":crawl.get::<i64,_>("queued"),"ready":crawl.get::<i64,_>("ready"),"running":crawl.get::<i64,_>("running"),"failed":crawl.get::<i64,_>("failed"),"paused":crawl.get::<i64,_>("paused"),"expired":crawl.get::<i64,_>("expired"),"lastActivityAt":crawl.get::<Option<DateTime<Utc>>,_>("last_activity"),"channels":index.get::<i64,_>("channels"),"activeChannels":index.get::<i64,_>("active_channels"),"overdueChannels":index.get::<i64,_>("overdue_channels"),"review":index.get::<i64,_>("review"),"resources":counts.resources,"lastSyncAt":index.get::<Option<DateTime<Utc>>,_>("last_sync"),"recentFailures":failures},
        "links":{"syncPending":links.get::<i64,_>("sync_pending"),"oldestSyncAt":links.get::<Option<DateTime<Utc>>,_>("oldest_sync"),"catalog":counts.catalog,"valid":counts.valid,"invalid":counts.invalid,"errors":counts.errors,"queues":queues,"cleanupDue":cleanup_due,"checksEnabled":checks_enabled,"deliveryEnabled":delivery_enabled,"deliveryStats":delivery_stats,"checkHealth":{"due":counts.check_due,"failing":counts.check_failing,"unknown":counts.check_unknown,"stuckJobs":stuck_checks},"recentCheckFailures":recent_failures,"recentCleanup":recent_cleanup},
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::build_router, auth, db, redis_store::RedisStore};
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
    use tower::ServiceExt;
    use uuid::Uuid;

    async fn call(
        router: &axum::Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&body)
                .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&body)})),
        )
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
    async fn monitor_and_worker_controls_follow_runtime_architecture() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = db::connect(&url).await.unwrap();
        db::init_db(&pool).await.unwrap();
        let redis = RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
            .await
            .unwrap();
        let state = Arc::new(AppState::new(pool.clone(), redis));
        let router = build_router(state.clone());
        let id = Uuid::new_v4().simple().to_string();
        let username = format!("runtime_{id}");
        sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
            .bind(&username).bind(auth::hash_password(&id).unwrap()).execute(&pool).await.unwrap();
        let (admin, _) = state.auth().login(&username, &id).await.unwrap();
        let anon = state.auth().issue(true).await.unwrap();
        assert_eq!(
            call(&router, "GET", "/api/monitor", None, Value::Null)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &router,
                "GET",
                "/api/monitor",
                Some(&anon.token),
                Value::Null
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                "/api/admin/runtime/workers/crawl",
                Some(&anon.token),
                json!({"enabled":false})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                "/api/admin/runtime/workers/unknown",
                Some(&admin.token),
                json!({"enabled":false})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                "/api/admin/runtime/workers/crawl",
                Some(&admin.token),
                json!({"enabled":"false"})
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        sqlx::query("UPDATE users SET role='user' WHERE username=$1")
            .bind(&username)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            call(
                &router,
                "GET",
                "/api/monitor",
                Some(&admin.token),
                Value::Null
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                "/api/admin/runtime/workers/crawl",
                Some(&admin.token),
                json!({"enabled":false})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        sqlx::query("UPDATE users SET role='admin' WHERE username=$1")
            .bind(&username)
            .execute(&pool)
            .await
            .unwrap();

        let channel = format!("runtime_{}", &id[..12]);
        let tg = format!("tg_{id}");
        let live = format!("live_{id}");
        sqlx::query("INSERT INTO crawl_channels(id) VALUES($1)")
            .bind(&channel)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,transform,kind,channel_id) VALUES($1,'TG','https://t.me/s/test','GET','html','','telegram',$2)").bind(&tg).bind(&channel).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,transform,kind) VALUES($1,'Live','https://example.invalid','GET','json','','live')").bind(&live).execute(&pool).await.unwrap();
        for source in [&live, &tg] {
            sqlx::query("INSERT INTO source_health(source_id,snapshot_json) VALUES($1,$2)")
                .bind(source).bind(json!({"isHealthy":true,"requestCount":1,"successCount":1,"zeroResultCount":1,"lastSuccessTime":Utc::now().timestamp_millis()})).execute(&pool).await.unwrap();
        }
        assert_eq!(
            call(
                &router,
                "PUT",
                "/api/admin/runtime/workers/crawl",
                Some(&admin.token),
                json!({"enabled":false})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                "/api/admin/runtime/workers/cleanup",
                Some(&admin.token),
                json!({"enabled":false})
            )
            .await
            .0,
            StatusCode::OK
        );
        let settings = runtime::settings(&state).await.unwrap();
        assert!(!settings.crawl_enabled && !settings.link_enabled);
        let sync_state = Arc::new(AppState::new(pool.clone(), state.redis.clone()));
        let independent = Arc::new(AtomicUsize::new(0));
        let sync_ticks = independent.clone();
        runtime::always_lane(&sync_state, "local-sync-independent", 1, || async {
            sync_ticks.fetch_add(1, Ordering::SeqCst);
            sync_state.shutdown.cancel();
            Ok(())
        })
        .await;
        assert_eq!(
            independent.load(Ordering::SeqCst),
            1,
            "cleanup pause must not pause local synchronization"
        );
        let fresh_state = AppState::new(pool.clone(), state.redis.clone());
        assert!(
            !runtime::settings(&fresh_state).await.unwrap().crawl_enabled,
            "pause must survive a new process state"
        );
        let (_, crawl_overview) = call(
            &router,
            "GET",
            "/api/admin/crawl/overview",
            Some(&admin.token),
            Value::Null,
        )
        .await;
        assert_eq!(crawl_overview["data"]["workerEnabled"], false);
        let (status, overview) = call(
            &router,
            "GET",
            "/api/monitor",
            Some(&admin.token),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{overview}");
        let overview = &overview["data"];
        assert_eq!(overview["workers"]["crawl"]["enabled"], false);
        assert!(overview["crawl"]["review"].is_number());
        assert!(overview["links"]["queues"]["cleanup"]["blocked"].is_number());
        assert!(overview["links"]["deliveryStats"]["fallback"].is_number());
        let sources = overview["sources"].as_array().unwrap();
        assert!(sources.iter().all(|s| s["kind"] == "live"));
        assert!(!sources.iter().any(|s| s["id"] == tg));
        assert_eq!(
            sources.iter().find(|s| s["id"] == live).unwrap()["health"]["healthy"],
            true
        );

        // A paused loop leaves work untouched; resuming through the API starts the same loop.
        let ticks = Arc::new(AtomicUsize::new(0));
        let lane_state = state.clone();
        let lane_ticks = ticks.clone();
        let lane = tokio::spawn(async move {
            runtime::lane(&lane_state, WorkerKind::Crawl, "test", 1, || async {
                lane_ticks.fetch_add(1, Ordering::SeqCst);
                lane_state.shutdown.cancel();
                Ok(())
            })
            .await;
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(ticks.load(Ordering::SeqCst), 0);
        let heartbeat = runtime::Heartbeat::start(state.clone(), WorkerKind::Crawl);
        tokio::time::timeout(Duration::from_secs(3), async {
            while worker_status(&state, WorkerKind::Crawl, false).await["state"] != "online" {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let (_, updated) = call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/crawl",
            Some(&admin.token),
            json!({"enabled":true}),
        )
        .await;
        assert_eq!(
            updated["data"]["settings"]["linkEnabled"], false,
            "one switch must preserve the other"
        );
        tokio::time::timeout(Duration::from_secs(3), lane)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ticks.load(Ordering::SeqCst), 1);
        drop(heartbeat);
        tokio::time::timeout(Duration::from_secs(3), async {
            while worker_status(&state, WorkerKind::Crawl, true).await["state"] != "offline" {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();

        assert_eq!(
            call(
                &router,
                "POST",
                "/api/admin/monitor/reset",
                Some(&admin.token),
                Value::Null
            )
            .await
            .0,
            StatusCode::OK
        );
        assert!(
            !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM source_health WHERE source_id=$1)"
            )
            .bind(&live)
            .fetch_one(&pool)
            .await
            .unwrap()
        );
        assert!(
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM source_health WHERE source_id=$1)"
            )
            .bind(&tg)
            .fetch_one(&pool)
            .await
            .unwrap()
        );
    }
}
