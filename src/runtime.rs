use crate::{app::AppState, error::ApiError};
use chrono::Utc;
use futures::FutureExt;
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

pub const LINK_MAINTENANCE: &str = "link-maintenance";
impl WorkerKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Crawl => "crawl",
            Self::Links => "link-cleanup",
            Self::LinkSchedule => "link-schedule",
            Self::LinkSync => "link-sync",
            Self::LinkCheck => "link-check",
            Self::LinkMaintenance => LINK_MAINTENANCE,
        }
    }
    pub fn heartbeat_key(self) -> String {
        format!("pansou:lane:{}:workers", self.name())
    }

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
    let mut cache = state.worker_settings.lock().await;
    if cache
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() >= Duration::from_secs(2))
    {
        *cache = Some((std::time::Instant::now(), settings(state).await?));
    }
    Ok(cache.as_ref().unwrap().1.enabled(kind))
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
                    let keys = if matches!(kind, WorkerKind::Crawl | WorkerKind::LinkSchedule) {
                        vec![kind.key().to_owned(), kind.heartbeat_key()]
                    } else {
                        vec![kind.heartbeat_key()]
                    };
                    for key in keys {
                        redis::pipe()
                            .atomic()
                            .cmd("ZADD")
                            .arg(&key)
                            .arg(now)
                            .arg(&task_id)
                            .ignore()
                            .cmd("ZREMRANGEBYSCORE")
                            .arg(&key)
                            .arg("-inf")
                            .arg(now - 45)
                            .ignore()
                            .cmd("EXPIRE")
                            .arg(&key)
                            .arg(60)
                            .ignore()
                            .query_async::<()>(&mut conn)
                            .await
                            .map_err(|e| ApiError::Unavailable(e.to_string()))?;
                    }
                    Ok::<_, ApiError>(())
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

impl Heartbeat {
    pub async fn finish(self) {
        self.task.abort();
        if let Ok(mut conn) = self.state.redis.connection() {
            let _: redis::RedisResult<i64> = conn.zrem(self.kind.heartbeat_key(), &self.id).await;
            if matches!(self.kind, WorkerKind::Crawl | WorkerKind::LinkSchedule) {
                let _: redis::RedisResult<i64> = conn.zrem(self.kind.key(), &self.id).await;
            }
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.task.abort();
        // TTL/freshness handles panic and runtime teardown. Explicit cleanup is
        // performed by finish() during orderly lane shutdown.
    }
}

/// Finish the current batch before pausing or shutting down; never abort cloud writes mid-tick.
pub trait LaneOutcome {
    fn processed(&self) -> usize;
}
impl LaneOutcome for () {
    fn processed(&self) -> usize {
        0
    }
}
impl LaneOutcome for usize {
    fn processed(&self) -> usize {
        *self
    }
}

pub async fn lane<F, Fut, O>(state: &AppState, kind: WorkerKind, name: &str, seconds: u64, tick: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<O, ApiError>>,
    O: LaneOutcome,
{
    let mut failures = 0u32;
    while !state.shutdown.is_cancelled() {
        let mut processed = 0;
        match enabled(state, kind).await {
            Ok(true) => {
                let started = std::time::Instant::now();
                // Panic isolation includes construction and polling of the future.
                let result = std::panic::AssertUnwindSafe(async { tick().await })
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| Err(ApiError::Internal("后台任务 panic，稍后重试".into())));
                processed = result.as_ref().map_or(0, LaneOutcome::processed);
                failures = if result.is_err() {
                    failures.saturating_add(1)
                } else {
                    0
                };
                let summary = result.map(|_| ());
                record_lane_run(state, name, started.elapsed(), &summary).await;
                if processed > 0 || summary.is_err() {
                    let _ = sqlx::query("INSERT INTO worker_lane_metrics(lane,processed,runs,failures,last_duration_ms,last_success_at,last_error_at,last_error_code) VALUES($1,$2,1,$3,$4,CASE WHEN $3=0 THEN now() END,CASE WHEN $3=1 THEN now() END,$5) ON CONFLICT(lane) DO UPDATE SET processed=worker_lane_metrics.processed+excluded.processed,runs=worker_lane_metrics.runs+1,failures=worker_lane_metrics.failures+excluded.failures,last_duration_ms=excluded.last_duration_ms,last_success_at=COALESCE(excluded.last_success_at,worker_lane_metrics.last_success_at),last_error_at=COALESCE(excluded.last_error_at,worker_lane_metrics.last_error_at),last_error_code=excluded.last_error_code")
                        .bind(name).bind(processed as i64).bind(i64::from(summary.is_err())).bind(started.elapsed().as_millis() as i64)
                        .bind(summary.as_ref().err().map(lane_error_code)).execute(&state.pool).await;
                }
                if let Err(error) = summary {
                    tracing::error!(%error, lane=name, "background tick failed");
                }
            }
            Ok(false) => {
                failures = 0;
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                tracing::error!(%error, lane=name, "background settings unavailable");
            }
        }
        let delay = if failures > 0 {
            Duration::from_millis(
                (seconds.max(1) * 1000 * (1u64 << failures.min(6))).min(60000)
                    + rand::random::<u64>() % 500,
            )
        } else if processed > 0 {
            Duration::from_millis(20)
        } else {
            Duration::from_secs(seconds)
        };
        tokio::select! { _ = state.shutdown.cancelled() => break, _ = tokio::time::sleep(delay) => {} }
    }
}

/// Reserve a bounded maintenance time slot across instances, without a sticky leader.
pub async fn schedule_slot(state: &AppState, task: &str, seconds: i32) -> Result<bool, ApiError> {
    Ok(sqlx::query_scalar::<_, String>("INSERT INTO worker_schedule_slots(task,next_run_at) VALUES($1,clock_timestamp()+make_interval(secs=>$2)) ON CONFLICT(task) DO UPDATE SET next_run_at=excluded.next_run_at WHERE worker_schedule_slots.next_run_at<=clock_timestamp() RETURNING task")
        .bind(task).bind(seconds as f64).fetch_optional(&state.pool).await?.is_some())
}

fn lane_error_code(error: &ApiError) -> &'static str {
    match error {
        ApiError::Unauthorized(_) | ApiError::Forbidden(_) => "account_unavailable",
        ApiError::TooManyRequests(_) => "rate_limited",
        ApiError::Unavailable(_) => "dependency_unavailable",
        ApiError::Upstream(_) | ApiError::Crawl { .. } => "upstream_error",
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
    if name != LINK_MAINTENANCE && result.is_ok() {
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
    if name == LINK_MAINTENANCE {
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

/// Admission and task registration share a lock: closing cannot miss a late spawn.
#[derive(Default)]
pub struct ResolutionTasks {
    inner: std::sync::Mutex<(bool, tokio::task::JoinSet<()>)>,
}
impl ResolutionTasks {
    pub fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) -> Result<(), ApiError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        while let Some(result) = inner.1.try_join_next() {
            if let Err(error) = result {
                tracing::error!(%error, "resolution task failed");
            }
        }
        if inner.0 {
            return Err(ApiError::Unavailable("服务正在关闭".into()));
        }
        if inner.1.len() >= 16 {
            return Err(ApiError::TooManyRequests("取链任务繁忙，请稍后重试".into()));
        }
        inner.1.spawn(task);
        Ok(())
    }
    pub fn close(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).0 = true;
    }
    pub async fn drain(&self) {
        self.close();
        let mut tasks = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut inner.1)
        };
        // External acknowledgements need time beyond the 120s write-start deadline.
        if tokio::time::timeout(Duration::from_secs(150), async {
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    tracing::error!(%error, "resolution task failed during drain");
                }
            }
        })
        .await
        .is_err()
        {
            tracing::error!(
                remaining = tasks.len(),
                "resolution drain exceeded deadline; reconciliation required"
            );
            tasks.shutdown().await;
        }
    }
}

pub async fn provider_write_slot(
    state: &AppState,
    provider: &str,
) -> Result<tokio::sync::OwnedSemaphorePermit, ApiError> {
    let gate = state
        .provider_writes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(provider.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone();
    gate.acquire_owned()
        .await
        .map_err(|_| ApiError::Unavailable("网盘写入队列已关闭".into()))
}

/// LISTEN invalidates the shared per-process cache; the TTL also covers missed notifications.
pub async fn settings_listener(state: &AppState) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect_lazy_with((*state.pool.connect_options()).clone());
    while !state.shutdown.is_cancelled() {
        let listen = async {
            let mut listener = sqlx::postgres::PgListener::connect_with(&pool).await?;
            listener.listen("pansou_worker_settings_wakeup").await?;
            loop {
                listener.recv().await?;
                *state.worker_settings.lock().await = None;
            }
            #[allow(unreachable_code)]
            Ok::<(), sqlx::Error>(())
        };
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            result = listen => { if let Err(error) = result { tracing::warn!(%error, "worker settings listener reconnecting"); } }
        }
        tokio::select! { _ = state.shutdown.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
    }
    pool.close().await;
}

#[cfg(test)]
mod resolution_task_tests {
    use super::*;
    #[tokio::test]
    async fn close_rejects_late_work_and_drain_waits_for_acknowledgement() {
        let tasks = Arc::new(ResolutionTasks::default());
        let (send, receive) = tokio::sync::oneshot::channel();
        let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = completed.clone();
        tasks
            .spawn(async move {
                receive.await.unwrap();
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            })
            .unwrap();
        tasks.close();
        assert!(tasks.spawn(async {}).is_err());
        let copy = tasks.clone();
        let drain = tokio::spawn(async move {
            copy.drain().await;
        });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        send.send(()).unwrap();
        drain.await.unwrap();
        assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
    }
    #[tokio::test]
    async fn resolution_tasks_have_a_hard_local_capacity() {
        let tasks = ResolutionTasks::default();
        let release = tokio_util::sync::CancellationToken::new();
        for _ in 0..16 {
            let token = release.clone();
            tasks
                .spawn(async move {
                    token.cancelled().await;
                })
                .unwrap();
        }
        assert!(matches!(
            tasks.spawn(async {}),
            Err(ApiError::TooManyRequests(_))
        ));
        release.cancel();
        tasks.drain().await;
    }
}
