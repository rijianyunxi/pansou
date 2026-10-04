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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerUpdate {
    enabled: bool,
    #[serde(default)]
    activate_checks: bool,
}

pub async fn runtime_worker_update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Json(update): Json<WorkerUpdate>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    if update.activate_checks && (kind != "link-check" || !update.enabled) {
        return Err(ApiError::BadRequest(
            "只能在启用后台检测时激活检测功能".into(),
        ));
    }
    let key = match kind.as_str() {
        "crawl" => "crawlEnabled",
        // Legacy links switch now pauses cleanup only, never local sync or click delivery.
        "links" | "cleanup" => "linkEnabled",
        "link-schedule" => "linkScheduleEnabled",
        "link-sync" => "linkSyncEnabled",
        "link-check" => "linkCheckEnabled",
        runtime::LINK_MAINTENANCE => "linkMaintenanceEnabled",
        _ => return Err(ApiError::BadRequest("未知后台任务类型".into())),
    };
    // Merge only the selected switch, so simultaneous edits cannot overwrite the other.
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO policy_settings(key,value_json) VALUES('background-workers',$1) ON CONFLICT(key) DO UPDATE SET value_json=policy_settings.value_json || $2,updated_at=now()")
        .bind(json!({"crawlEnabled":true,"linkEnabled":true,"linkScheduleEnabled":true,"linkSyncEnabled":true,"linkCheckEnabled":true,"linkMaintenanceEnabled":true,key:update.enabled}))
        .bind(json!({key:update.enabled})).execute(&mut *tx).await?;
    // An explicit, confirmed activation is separate from resuming an existing lane.
    // Preserve budgets/cache policy; ordinary pauses and the global switch never enable it.
    if update.activate_checks {
        let updated = sqlx::query("UPDATE policy_settings SET value_json=value_json || '{\"enabled\":true}'::jsonb,updated_at=now() WHERE key='link-check'")
            .execute(&mut *tx).await?;
        if updated.rows_affected() != 1 {
            return Err(ApiError::Unavailable(
                "检测参数尚未初始化，未修改任何开关".into(),
            ));
        }
    }
    tx.commit().await?;
    *state.worker_settings.lock().await = None;
    let checks_enabled = sqlx::query_scalar::<_, bool>("SELECT COALESCE((value_json->>'enabled')::boolean,false) FROM policy_settings WHERE key='link-check'")
        .fetch_optional(&state.pool).await?.unwrap_or(false);
    Ok(ok(
        json!({"settings":runtime::settings(&state).await?,"checksEnabled":checks_enabled}),
    ))
}

pub(super) async fn worker_status(state: &AppState, kind: WorkerKind, enabled: bool) -> Value {
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
    let (crawl_worker, mut link_worker, redis) = tokio::join!(
        worker_status(&state, WorkerKind::Crawl, settings.crawl_enabled),
        worker_status(&state, WorkerKind::Links, settings.link_enabled),
        state.redis.ping(),
    );
    link_worker["scheduleEnabled"] = json!(settings.link_schedule_enabled);
    link_worker["syncEnabled"] = json!(settings.link_sync_enabled);
    link_worker["checkEnabled"] = json!(settings.link_check_enabled);
    link_worker["maintenanceEnabled"] = json!(settings.link_maintenance_enabled);
    let daily_allowed =
        crate::crawl::DailySchedule::new(&crate::crawl::settings(&state.pool).await?)?
            .allows_pages(Utc::now());
    let crawl = sqlx::query("SELECT count(*) FILTER(WHERE j.status='queued') queued, count(*) FILTER(WHERE j.status='running') running, count(*) FILTER(WHERE j.status='failed') failed, count(*) FILTER(WHERE j.status='paused') paused, count(*) FILTER(WHERE j.status='running' AND j.lease_until<now()) expired, count(*) FILTER(WHERE j.status='queued' AND j.next_run_at<=now() AND c.enabled AND c.next_page_at<=now() AND (j.kind<>'sync' OR c.last_synced_at IS NULL OR $1) AND NOT EXISTS(SELECT 1 FROM crawl_jobs running WHERE running.channel_id=j.channel_id AND running.status='running')) ready, MAX(j.updated_at) last_activity FROM crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id")
        .bind(daily_allowed).fetch_one(&state.pool).await?;
    let index = sqlx::query("SELECT (SELECT count(*) FROM crawl_channels) channels, (SELECT count(*) FROM crawl_channels WHERE enabled) active_channels, (SELECT count(*) FROM crawl_page_failures) review, (SELECT MAX(last_synced_at) FROM crawl_channels) last_sync, (SELECT count(*) FROM crawl_channels c WHERE c.enabled AND c.next_sync_at<=now() AND (c.last_synced_at IS NULL OR $1)) overdue_channels")
        .bind(daily_allowed).fetch_one(&state.pool).await?;
    let counts = state.admin_stats.monitor(&state.pool).await?;
    let links = sqlx::query(
        "SELECT count(*) sync_pending,min(updated_at) oldest_sync FROM link_sync_queue",
    )
    .fetch_one(&state.pool)
    .await?;
    let link_queues = sqlx::query("SELECT 'checks' kind,status,count(*) count FROM link_check_jobs GROUP BY status UNION ALL SELECT 'cleanup',status,count(*) FROM link_cleanup_jobs GROUP BY status UNION ALL SELECT 'resolve',status,count(*) FROM link_resolve_requests GROUP BY status")
        .fetch_all(&state.pool).await?;
    let cleanup_due: i64 = sqlx::query_scalar("SELECT count(*) FROM link_cleanup_jobs WHERE status='queued' AND run_after<=now() OR status='running' AND lease_until<now()")
        .fetch_one(&state.pool).await?;
    let stuck_checks: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM link_check_jobs WHERE status='running' AND lease_until<now()",
    )
    .fetch_one(&state.pool)
    .await?;
    let ready_check_accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM cloud_account_settings WHERE provider IN('baidu','quark','aliyun','xunlei','guangya') AND (length(trim(credential))>0 OR credential_cipher IS NOT NULL) AND auth_status NOT IN('reauthorization_required','disconnected')")
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
    let policies = sqlx::query("SELECT provider,delivery_enabled FROM cloud_provider_policies")
        .fetch_all(&state.pool)
        .await?;
    let checks_enabled = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE((value_json->>'enabled')::boolean,false) FROM policy_settings WHERE key='link-check'",
    )
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or(false);
    let mut delivery_enabled =
        json!({"baidu":false,"quark":false,"aliyun":false,"xunlei":false,"guangya":false});
    for row in policies {
        let provider: String = row.get("provider");
        delivery_enabled[provider] = json!(row.get::<bool, _>("delivery_enabled"));
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
    let mut lanes = serde_json::Map::new();
    for kind in [
        WorkerKind::LinkSync,
        WorkerKind::LinkCheck,
        WorkerKind::Links,
        WorkerKind::LinkMaintenance,
    ] {
        let count = match state.redis.connection() {
            Ok(mut conn) => conn
                .zcount::<_, _, _, i64>(kind.heartbeat_key(), Utc::now().timestamp() - 45, "+inf")
                .await
                .ok(),
            Err(_) => None,
        };
        lanes.insert(kind.name().into(), json!({"count":count,"state":match count {None=>"unknown",Some(0)=>"offline",Some(_)=>"online"}}));
    }
    for row in sqlx::query("SELECT * FROM worker_lane_metrics")
        .fetch_all(&state.pool)
        .await?
    {
        let entry = lanes
            .entry(row.get::<String, _>("lane"))
            .or_insert_with(|| json!({}));
        entry["metrics"] = json!({"processed":row.get::<i64,_>("processed"),"runs":row.get::<i64,_>("runs"),"failures":row.get::<i64,_>("failures"),"lastDurationMs":row.get::<i64,_>("last_duration_ms"),"lastSuccessAt":row.get::<Option<DateTime<Utc>>,_>("last_success_at"),"lastErrorAt":row.get::<Option<DateTime<Utc>>,_>("last_error_at"),"lastErrorCode":row.get::<Option<String>,_>("last_error_code")});
    }
    link_worker["lanes"] = json!(lanes);
    let aggregate_pending: i64 = sqlx::query_scalar("SELECT count(*) FROM link_aggregate_queue")
        .fetch_one(&state.pool)
        .await?;
    Ok(ok(json!({
        "generatedAt":Utc::now(),"sources":sources,
        "services":{"api":{"state":"online","startedAt":state.started_at},"postgres":{"state":"online","connections":state.pool.size(),"idle":state.pool.num_idle()},"redis":{"state":if redis.is_ok(){"online"}else{"unavailable"}}},
        "workers":{"crawl":crawl_worker,"links":link_worker},
        "crawl":{"queued":crawl.get::<i64,_>("queued"),"ready":crawl.get::<i64,_>("ready"),"running":crawl.get::<i64,_>("running"),"failed":crawl.get::<i64,_>("failed"),"paused":crawl.get::<i64,_>("paused"),"expired":crawl.get::<i64,_>("expired"),"lastActivityAt":crawl.get::<Option<DateTime<Utc>>,_>("last_activity"),"channels":index.get::<i64,_>("channels"),"activeChannels":index.get::<i64,_>("active_channels"),"overdueChannels":index.get::<i64,_>("overdue_channels"),"review":index.get::<i64,_>("review"),"resources":counts.resources,"lastSyncAt":index.get::<Option<DateTime<Utc>>,_>("last_sync"),"recentFailures":failures},
        "links":{"aggregatePending":aggregate_pending,"syncPending":links.get::<i64,_>("sync_pending"),"oldestSyncAt":links.get::<Option<DateTime<Utc>>,_>("oldest_sync"),"catalog":counts.catalog,"valid":counts.valid,"invalid":counts.invalid,"errors":counts.errors,"queues":queues,"cleanupDue":cleanup_due,"checksEnabled":checks_enabled,"deliveryEnabled":delivery_enabled,"deliveryStats":delivery_stats,"checkHealth":{"due":counts.check_due,"failing":counts.check_failing,"unknown":counts.check_unknown,"stuckJobs":stuck_checks,"readyAccounts":ready_check_accounts},"recentCheckFailures":recent_failures,"recentCleanup":recent_cleanup},
    })))
}

#[cfg(test)]
mod tests;
