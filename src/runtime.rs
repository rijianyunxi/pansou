use crate::{app::AppState, error::ApiError};
use chrono::Utc;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::task::JoinHandle;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum WorkerKind {
    Crawl,
    Links,
    /// Background link scheduling, independent of the legacy cleanup-only switch.
    LinkSchedule,
    LinkSync,
    LinkCheck,
    LinkMaintenance,
}

impl WorkerKind {
    pub fn key(self) -> &'static str {
        match self {
            Self::Crawl => "pansou:crawl:workers",
            Self::Links
            | Self::LinkSchedule
            | Self::LinkSync
            | Self::LinkCheck
            | Self::LinkMaintenance => "pansou:link:workers",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerSettings {
    pub crawl_enabled: bool,
    pub link_enabled: bool,
    pub link_schedule_enabled: bool,
    pub link_sync_enabled: bool,
    pub link_check_enabled: bool,
    pub link_maintenance_enabled: bool,
}

impl Default for WorkerSettings {
    fn default() -> Self {
        Self {
            crawl_enabled: true,
            link_enabled: true,
            link_schedule_enabled: true,
            link_sync_enabled: true,
            link_check_enabled: true,
            link_maintenance_enabled: true,
        }
    }
}

impl WorkerSettings {
    fn enabled(&self, kind: WorkerKind) -> bool {
        match kind {
            WorkerKind::Crawl => self.crawl_enabled,
            WorkerKind::LinkSchedule => self.link_schedule_enabled,
            WorkerKind::Links => self.link_schedule_enabled && self.link_enabled,
            WorkerKind::LinkSync => self.link_schedule_enabled && self.link_sync_enabled,
            WorkerKind::LinkCheck => self.link_schedule_enabled && self.link_check_enabled,
            WorkerKind::LinkMaintenance => {
                self.link_schedule_enabled && self.link_maintenance_enabled
            }
        }
    }
}

pub async fn settings(state: &AppState) -> Result<WorkerSettings, ApiError> {
    let value = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT value_json FROM policy_settings WHERE key='background-workers'",
    )
    .fetch_optional(&state.pool)
    .await?;
    value
        .map(serde_json::from_value)
        .transpose()
        .map(|v| v.unwrap_or_default())
        .map_err(|_| ApiError::Unavailable("后台任务开关配置无效".into()))
}

pub async fn enabled(state: &AppState, kind: WorkerKind) -> Result<bool, ApiError> {
    let settings = settings(state).await?;
    Ok(settings.enabled(kind))
}

/// Heartbeats live only as long as their worker future, including panic/abort paths.
pub struct Heartbeat {
    task: JoinHandle<()>,
    state: Arc<AppState>,
    kind: WorkerKind,
    id: String,
}

impl Heartbeat {
    pub fn start(state: Arc<AppState>, kind: WorkerKind) -> Self {
        let id = Uuid::new_v4().to_string();
        let task_state = state.clone();
        let task_id = id.clone();
        let task = tokio::spawn(async move {
            loop {
                let result = async {
                    let mut conn = task_state.redis.connection()?;
                    let now = Utc::now().timestamp();
                    redis::pipe()
                        .atomic()
                        .cmd("ZADD")
                        .arg(kind.key())
                        .arg(now)
                        .arg(&task_id)
                        .ignore()
                        .cmd("ZREMRANGEBYSCORE")
                        .arg(kind.key())
                        .arg("-inf")
                        .arg(now - 45)
                        .ignore()
                        .cmd("EXPIRE")
                        .arg(kind.key())
                        .arg(60)
                        .ignore()
                        .query_async::<()>(&mut conn)
                        .await
                        .map_err(|e| ApiError::Unavailable(e.to_string()))
                }
                .await;
                if let Err(error) = result {
                    tracing::warn!(%error, "worker heartbeat failed");
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
        Self {
            task,
            state,
            kind,
            id,
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.task.abort();
        let state = self.state.clone();
        let key = self.kind.key();
        let id = self.id.clone();
        tokio::spawn(async move {
            if let Ok(mut conn) = state.redis.connection() {
                let _: redis::RedisResult<i64> = conn.zrem(key, id).await;
            }
        });
    }
}

/// Finish the current batch before pausing or shutting down; never abort cloud writes mid-tick.
pub async fn lane<F, Fut>(state: &AppState, kind: WorkerKind, name: &str, seconds: u64, tick: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<(), ApiError>>,
{
    while !state.shutdown.is_cancelled() {
        match enabled(state, kind).await {
            Ok(true) => {
                let started = std::time::Instant::now();
                let result = tick().await;
                record_lane_run(state, name, started.elapsed(), &result).await;
                if let Err(error) = result {
                    tracing::error!(%error, lane=name, "background tick failed");
                }
            }
            Ok(false) => {}
            Err(error) => tracing::error!(%error, lane=name, "background settings unavailable"),
        }
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(seconds)) => {},
        }
    }
}

fn lane_error_code(error: &ApiError) -> &'static str {
    match error {
        ApiError::Unauthorized(_) | ApiError::Forbidden(_) => "account_unavailable",
        ApiError::TooManyRequests(_) => "rate_limited",
        ApiError::Unavailable(_) => "dependency_unavailable",
        ApiError::Upstream(_) => "upstream_error",
        ApiError::Conflict(_) => "task_conflict",
        _ => "worker_error",
    }
}

/// Record maintenance executions and other lane failures, not every idle 2s poll.
/// Rate-limit repeated failures and bound retention; raw errors may contain secrets.
pub(crate) async fn record_lane_run(
    state: &AppState,
    name: &str,
    elapsed: Duration,
    result: &Result<(), ApiError>,
) {
    if name != "link-maintenance" && result.is_ok() {
        return;
    }
    let status = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    let code = result.as_ref().err().map(lane_error_code);
    let stored=sqlx::query("INSERT INTO worker_task_runs(lane,status,error_code,duration_ms) SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM worker_task_runs WHERE lane=$1 AND status=$2 AND created_at>now()-interval '30 seconds')")
        .bind(name).bind(status).bind(code).bind(elapsed.as_millis().min(i64::MAX as u128) as i64).execute(&state.pool).await;
    if stored.is_err() {
        tracing::warn!(lane = name, "worker execution history unavailable");
    }
    if name == "link-maintenance" {
        let _=sqlx::query("DELETE FROM worker_task_runs WHERE id IN(SELECT id FROM worker_task_runs WHERE created_at<now()-interval '7 days' ORDER BY created_at,id LIMIT 1000)").execute(&state.pool).await;
    }
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn legacy_cleanup_pause_does_not_disable_new_link_schedule() {
        let settings: WorkerSettings =
            serde_json::from_value(serde_json::json!({"crawlEnabled":false,"linkEnabled":false}))
                .unwrap();
        assert!(!settings.crawl_enabled && !settings.link_enabled);
        assert!(settings.link_schedule_enabled);
        assert!(
            settings.link_sync_enabled
                && settings.link_check_enabled
                && settings.link_maintenance_enabled
        );
        assert!(
            serde_json::from_value::<WorkerSettings>(
                serde_json::json!({"linkScheduleEnabled":"false"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<WorkerSettings>(serde_json::json!({"unknown":false})).is_err()
        );
    }

    #[test]
    fn independent_lanes_and_global_gate_preserve_each_other() {
        let kinds = [
            WorkerKind::LinkSync,
            WorkerKind::LinkCheck,
            WorkerKind::Links,
            WorkerKind::LinkMaintenance,
        ];
        for (index, key) in [
            "linkSyncEnabled",
            "linkCheckEnabled",
            "linkEnabled",
            "linkMaintenanceEnabled",
        ]
        .iter()
        .enumerate()
        {
            let mut settings: WorkerSettings =
                serde_json::from_value(serde_json::json!({*key:false})).unwrap();
            for (i, kind) in kinds.iter().enumerate() {
                assert_eq!(settings.enabled(*kind), i != index);
            }
            assert!(settings.enabled(WorkerKind::Crawl));
            settings.link_schedule_enabled = false;
            for kind in kinds {
                assert!(!settings.enabled(kind));
            }
            assert!(settings.enabled(WorkerKind::Crawl));
            settings.link_schedule_enabled = true;
            for (i, kind) in kinds.iter().enumerate() {
                assert_eq!(settings.enabled(*kind), i != index);
            }
        }
    }
}
