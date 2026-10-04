mod admin_stats;
mod app;
mod auth;
mod cloud_auth;
mod cloud_drive;
mod crawl;
mod db;
mod error;
mod handlers;
mod link_resolution;
mod local_index;
mod migration_preflight;
mod models;
mod outbound;
mod policy;
mod redis_store;
mod resource_clean;
#[cfg(test)]
mod resource_schema_tests;
mod runtime;
mod search_cache;
mod security;
#[cfg(test)]
mod sql_optimization_tests;
mod telegram;
#[cfg(test)]
mod telegram_tests;
mod transform;

use anyhow::{Context, Result};
use app::{AppState, build_router};
use db::{ensure_admin, init_db};
use redis_store::RedisStore;
use std::{env, future::IntoFuture, net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    // Backend-only configuration lives in the Rust application root.
    match dotenvy::dotenv() {
        Ok(_) => {}
        Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
        // Parse errors may contain a complete Cookie; do not include the raw line in logs.
        Err(_) => {
            anyhow::bail!("读取 .env 失败：请检查配置语法，包含空格或分号的 Cookie 必须整体加引号")
        }
    }
    let filter = env::var("RUST_LOG").unwrap_or_else(|_| "pansou_api=info,tower_http=info".into());
    if let Ok(path) = env::var("PANSOU_LOG_FILE") {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(file) => {
                use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
                tracing_subscriber::registry()
                    .with(tracing_subscriber::EnvFilter::try_new(filter.clone())?)
                    .with(tracing_subscriber::fmt::layer())
                    .with(
                        tracing_subscriber::fmt::layer()
                            .with_ansi(false)
                            .with_writer(std::sync::Arc::new(file)),
                    )
                    .init();
            }
            Err(error) => {
                eprintln!("无法打开日志文件 {path}: {error}，仅输出到终端");
                tracing_subscriber::fmt().with_env_filter(filter).init();
            }
        }
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
    let database_url = env::var("PANSOU_DATABASE_URL")
        .context("缺少 PANSOU_DATABASE_URL，请在项目根目录 .env 中配置 PostgreSQL")?;
    let redis_url = env::var("PANSOU_REDIS_URL")
        .context("缺少 PANSOU_REDIS_URL，请在项目根目录 .env 中配置 Redis")?;
    let pool = db::connect(&database_url).await?;
    let mode = env::args().nth(1).unwrap_or_else(|| "serve".into());
    if mode == "migration-preflight" {
        println!(
            "{}",
            serde_json::to_string_pretty(&migration_preflight::report(&pool).await?)?
        );
        return Ok(());
    }
    init_db(&pool).await?;
    ensure_admin(&pool).await?;
    let redis = RedisStore::connect(&redis_url).await?;
    let state = Arc::new(AppState::new(pool, redis));

    if !matches!(
        mode.as_str(),
        "serve" | "worker" | "link-worker" | "auth-worker"
    ) {
        anyhow::bail!(
            "运行模式必须是 serve、worker、link-worker、auth-worker 或 migration-preflight"
        );
    }
    let mut workers = tokio::task::JoinSet::new();
    // Authentication is not controlled by crawling/link-delivery switches.
    // Database leases serialize it when API and link Worker run separately.
    let auth_enabled = match env::var("PANSOU_AUTH_WORKER_ENABLED").as_deref() {
        Ok("true" | "1") => true,
        Ok("false" | "0") => false,
        Err(_) => matches!(mode.as_str(), "serve" | "link-worker" | "auth-worker"),
        Ok(_) => anyhow::bail!("PANSOU_AUTH_WORKER_ENABLED 必须是 true/false 或 1/0"),
    };
    if mode == "auth-worker" && !auth_enabled {
        anyhow::bail!("auth-worker 模式不能禁用凭证维护");
    }
    if auth_enabled {
        let auth_state = state.clone();
        workers.spawn(async move { cloud_auth::worker(auth_state).await });
    }
    if mode != "serve" {
        if mode != "auth-worker" {
            let worker_state = state.clone();
            workers.spawn(async move {
                if mode == "worker" {
                    crawl::worker(worker_state).await
                } else {
                    link_resolution::worker(worker_state).await
                }
            });
        }
        let result = tokio::select! {
            _ = runtime::shutdown_signal() => Ok(()),
            result = workers.join_next() => Err(anyhow::anyhow!("后台 Worker 意外退出：{result:?}")),
        };
        state.shutdown.cancel();
        drain_workers(&mut workers).await?;
        return result;
    }
    let embedded = match env::var("PANSOU_EMBEDDED_WORKERS").as_deref() {
        Ok("false" | "0") => false,
        Ok("true" | "1") | Err(_) => true,
        Ok(_) => anyhow::bail!("PANSOU_EMBEDDED_WORKERS 必须是 true/false 或 1/0"),
    };
    let app = build_router(state.clone());
    let host = env::var("PANSOU_API_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = env::var("PANSOU_API_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3666);
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    if embedded {
        let crawl_state = state.clone();
        workers.spawn(async move { crawl::worker(crawl_state).await });
        let link_state = state.clone();
        workers.spawn(async move { link_resolution::worker(link_state).await });
    }
    info!(%addr, "pansou Rust API listening");
    info!(embedded_workers = embedded, "background runtime configured");
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(state.shutdown.clone().cancelled_owned())
    .into_future();
    tokio::pin!(server);
    let (result, server_finished) = tokio::select! {
        result = &mut server => (result.map_err(anyhow::Error::from), true),
        _ = runtime::shutdown_signal() => (Ok(()), false),
        result = workers.join_next() => {
            (Err(anyhow::anyhow!("后台 Worker 意外退出：{result:?}")), false)
        }
    };
    state.resolutions.close();
    state.shutdown.cancel();
    // All producers have stopped admission. Drain HTTP, tracked resolutions and
    // workers together so their budgets do not accumulate during shutdown.
    let http_drain = async {
        if !server_finished {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(30), &mut server).await;
        }
    };
    let (_, (), workers_result) = tokio::join!(
        http_drain,
        state.resolutions.drain(),
        drain_workers(&mut workers),
    );
    workers_result?;
    result
}

async fn drain_workers(
    workers: &mut tokio::task::JoinSet<Result<(), error::ApiError>>,
) -> Result<()> {
    let drain = async {
        let mut first_error = None;
        while let Some(result) = workers.join_next().await {
            let result = result
                .map_err(anyhow::Error::from)
                .and_then(|r| r.map_err(anyhow::Error::from));
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(150), drain).await {
        Ok(result) => result,
        Err(_) => {
            tracing::warn!("shutdown deadline exceeded; durable job leases will recover");
            workers.shutdown().await;
            Ok(())
        }
    }
}
