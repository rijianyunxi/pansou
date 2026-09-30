use anyhow::{Context, Result, bail};
use rand::Rng;
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{env, str::FromStr, time::Duration};

fn env_u32(name: &str, default: u32) -> Result<u32> {
    match env::var(name) {
        Ok(value) => value
            .parse::<u32>()
            .with_context(|| format!("{name} 必须是非负整数")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("读取 {name} 失败")),
    }
}

fn env_u64(name: &str, default: u64) -> Result<u64> {
    match env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("{name} 必须是非负整数")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("读取 {name} 失败")),
    }
}

pub async fn connect(url: &str) -> Result<PgPool> {
    let max_connections = env_u32("PANSOU_DB_MAX_CONNECTIONS", 32)?;
    let min_connections = env_u32("PANSOU_DB_MIN_CONNECTIONS", 2)?;
    if max_connections == 0 || min_connections > max_connections {
        bail!("PostgreSQL 连接池配置无效：MIN 必须小于等于 MAX，且 MAX 不能为 0");
    }
    let acquire_timeout = env_u64("PANSOU_DB_ACQUIRE_TIMEOUT_SECONDS", 10)?;
    let idle_timeout = env_u64("PANSOU_DB_IDLE_TIMEOUT_SECONDS", 600)?;
    let max_lifetime = env_u64("PANSOU_DB_MAX_LIFETIME_SECONDS", 1800)?;
    let options = PgConnectOptions::from_str(url)
        .context("PANSOU_DATABASE_URL 无效")?
        .application_name("pansou-api");
    PgPoolOptions::new()
        .max_connections(max_connections)
        .min_connections(min_connections)
        .acquire_timeout(Duration::from_secs(acquire_timeout))
        .idle_timeout(Some(Duration::from_secs(idle_timeout)))
        .max_lifetime(Some(Duration::from_secs(max_lifetime)))
        .test_before_acquire(true)
        .connect_with(options)
        .await
        .context("无法连接 PostgreSQL")
}

pub async fn init_db(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("执行 PostgreSQL migrations 失败")?;
    Ok(())
}

pub async fn ensure_admin(pool: &PgPool) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE role='admin' AND deleted_at IS NULL)",
    )
    .fetch_one(pool)
    .await?;
    if exists {
        return Ok(());
    }
    let configured = env::var("PANSOU_ADMIN_INITIAL_PASSWORD")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let (password, generated) = match configured {
        Some(value) => (value, false),
        None => {
            let value: String = rand::rng()
                .sample_iter(&rand::distr::Alphanumeric)
                .take(24)
                .map(char::from)
                .collect();
            (value, true)
        }
    };
    let hash = crate::auth::hash_password(&password)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,nickname,role,status) VALUES('admin','admin',$1,'Administrator','admin','active') ON CONFLICT(username_normalized) DO UPDATE SET role='admin',status='active',deleted_at=NULL")
        .bind(hash)
        .execute(pool)
        .await?;
    if generated {
        tracing::warn!("initial admin password generated once: {}", password);
    }
    Ok(())
}
