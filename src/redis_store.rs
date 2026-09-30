use crate::error::ApiError;
use anyhow::{Context, Result, ensure};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use std::{env, time::Duration};

#[derive(Clone)]
pub struct RedisStore {
    manager: Option<ConnectionManager>,
}

fn timeout_from_env(name: &str, default: u64) -> Result<Duration> {
    let seconds = match env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("{name} 必须是非负整数"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("读取 {name} 失败")),
    };
    Ok(Duration::from_secs(seconds))
}

impl RedisStore {
    pub async fn connect(url: &str) -> Result<Self> {
        let client = redis::Client::open(url).context("Redis 连接地址无效")?;
        let config = ConnectionManagerConfig::new()
            .set_number_of_retries(6)
            .set_factor(100)
            .set_max_delay(2_000)
            .set_connection_timeout(timeout_from_env(
                "PANSOU_REDIS_CONNECTION_TIMEOUT_SECONDS",
                3,
            )?)
            .set_response_timeout(timeout_from_env(
                "PANSOU_REDIS_RESPONSE_TIMEOUT_SECONDS",
                5,
            )?);
        let mut manager = ConnectionManager::new_with_config(client, config)
            .await
            .context("无法连接 Redis")?;
        let response: String = redis::cmd("PING")
            .query_async(&mut manager)
            .await
            .context("Redis PING 失败")?;
        ensure!(response == "PONG", "Redis PING 返回异常: {response}");
        Ok(Self {
            manager: Some(manager),
        })
    }

    pub fn connection(&self) -> Result<ConnectionManager, ApiError> {
        self.manager
            .clone()
            .ok_or_else(|| ApiError::Internal("Redis test client is disconnected".into()))
    }

    pub async fn ping(&self) -> Result<String, ApiError> {
        let mut connection = self.connection()?;
        redis::cmd("PING")
            .query_async(&mut connection)
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))
    }

    #[cfg(test)]
    pub fn disconnected() -> Self {
        Self { manager: None }
    }
}
