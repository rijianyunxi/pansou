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
}

impl WorkerKind {
    pub fn key(self) -> &'static str {
        match self {
            Self::Crawl => "pansou:crawl:workers",
            Self::Links => "pansou:link:workers",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerSettings {
    pub crawl_enabled: bool,
    pub link_enabled: bool,
}

impl Default for WorkerSettings {
    fn default() -> Self {
        Self {
            crawl_enabled: true,
            link_enabled: true,
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
    Ok(match kind {
        WorkerKind::Crawl => settings.crawl_enabled,
        WorkerKind::Links => settings.link_enabled,
    })
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
                if let Err(error) = tick().await {
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

/// Local bookkeeping and policy-controlled checks are independent of the cleanup pause.
pub async fn always_lane<F, Fut>(state: &AppState, name: &str, seconds: u64, tick: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<(), ApiError>>,
{
    while !state.shutdown.is_cancelled() {
        if let Err(error) = tick().await {
            tracing::error!(%error, lane=name, "background tick failed");
        }
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(seconds)) => {},
        }
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
