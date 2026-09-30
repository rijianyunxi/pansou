mod app;
mod auth;
mod crawl;
mod db;
mod error;
mod handlers;
mod local_index;
mod migration_preflight;
mod models;
mod outbound;
mod policy;
mod redis_store;
mod resource_clean;
mod search_cache;
mod security;
mod telegram;
#[cfg(test)]
mod telegram_tests;
mod transform;

use anyhow::{Context, Result};
use app::{AppState, build_router};
use db::{ensure_admin, init_db};
use redis_store::RedisStore;
use std::{env, net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    // Backend-only configuration lives in the Rust application root.
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            env::var("RUST_LOG").unwrap_or_else(|_| "pansou_api=info,tower_http=info".into()),
        )
        .init();
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

    if mode == "worker" {
        return crawl::worker(state).await.map_err(anyhow::Error::from);
    }
    if mode != "serve" {
        anyhow::bail!("运行模式必须是 serve、worker 或 migration-preflight");
    }
    let app = build_router(state);
    let host = env::var("PANSOU_API_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = env::var("PANSOU_API_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3666);
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "pansou Rust API listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
