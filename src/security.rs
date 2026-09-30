use crate::{auth::Session, error::ApiError, policy::UserPolicy, redis_store::RedisStore};
use axum::http::HeaderMap;
use redis::Script;
use std::{
    env,
    net::{IpAddr, SocketAddr},
};

#[derive(Clone, Debug)]
pub struct SecurityConfig {
    pub trust_proxy_headers: bool,
    pub session_create_window_seconds: u64,
    pub session_create_per_ip: u64,
    pub session_create_per_subnet: u64,
    pub session_create_global: u64,
    pub search_subnet_limit_multiplier: u64,
    pub anonymous_search_concurrency: u64,
    pub logged_search_concurrency: u64,
    pub global_search_concurrency: u64,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            trust_proxy_headers: false,
            session_create_window_seconds: 60,
            session_create_per_ip: 5,
            session_create_per_subnet: 30,
            session_create_global: 300,
            search_subnet_limit_multiplier: 4,
            anonymous_search_concurrency: 2,
            logged_search_concurrency: 4,
            global_search_concurrency: 64,
        }
    }
}

fn env_u64(name: &str, default: u64, minimum: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
        .max(minimum)
}

fn env_bool(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

impl SecurityConfig {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        Self {
            trust_proxy_headers: env_bool(
                "PANSOU_TRUST_PROXY_HEADERS",
                defaults.trust_proxy_headers,
            ),
            session_create_window_seconds: env_u64(
                "PANSOU_SESSION_CREATE_WINDOW_SECONDS",
                defaults.session_create_window_seconds,
                10,
            ),
            session_create_per_ip: env_u64(
                "PANSOU_SESSION_CREATE_PER_IP",
                defaults.session_create_per_ip,
                1,
            ),
            session_create_per_subnet: env_u64(
                "PANSOU_SESSION_CREATE_PER_SUBNET",
                defaults.session_create_per_subnet,
                1,
            ),
            session_create_global: env_u64(
                "PANSOU_SESSION_CREATE_GLOBAL",
                defaults.session_create_global,
                1,
            ),
            search_subnet_limit_multiplier: env_u64(
                "PANSOU_SEARCH_SUBNET_LIMIT_MULTIPLIER",
                defaults.search_subnet_limit_multiplier,
                1,
            ),
            anonymous_search_concurrency: env_u64(
                "PANSOU_ANONYMOUS_SEARCH_CONCURRENCY",
                defaults.anonymous_search_concurrency,
                1,
            ),
            logged_search_concurrency: env_u64(
                "PANSOU_LOGGED_SEARCH_CONCURRENCY",
                defaults.logged_search_concurrency,
                1,
            ),
            global_search_concurrency: env_u64(
                "PANSOU_GLOBAL_SEARCH_CONCURRENCY",
                defaults.global_search_concurrency,
                1,
            ),
        }
    }
}

pub fn client_ip(headers: &HeaderMap, remote: SocketAddr, config: &SecurityConfig) -> IpAddr {
    if config.trust_proxy_headers {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .and_then(|value| value.parse::<IpAddr>().ok())
        {
            return ip;
        }
        if let Some(ip) = headers
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .and_then(|value| value.parse::<IpAddr>().ok())
        {
            return ip;
        }
    }
    remote.ip()
}

pub fn subnet_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            format!("{}.{}.{}.0/24", octets[0], octets[1], octets[2])
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            format!(
                "{:x}:{:x}:{:x}:{:x}::/64",
                segments[0], segments[1], segments[2], segments[3]
            )
        }
    }
}

async fn consume_budgets(
    redis: &RedisStore,
    namespace: &str,
    window_seconds: u64,
    budgets: &[(String, u64)],
) -> Result<bool, ApiError> {
    let bucket = chrono::Utc::now().timestamp() / window_seconds as i64;
    let keys = budgets
        .iter()
        .map(|(identity, _)| format!("pansou:rate:{namespace}:{identity}:{bucket}"))
        .collect::<Vec<_>>();
    let script = Script::new(
        r#"
        for index, key in ipairs(KEYS) do
          local current = tonumber(redis.call('GET', key) or '0')
          local limit = tonumber(ARGV[index + 1])
          if current >= limit then
            return index
          end
        end
        for _, key in ipairs(KEYS) do
          local current = redis.call('INCR', key)
          if current == 1 then
            redis.call('EXPIRE', key, ARGV[1])
          end
        end
        return 0
        "#,
    );
    let mut invocation = script.prepare_invoke();
    for key in &keys {
        invocation.key(key);
    }
    invocation.arg(window_seconds);
    for (_, limit) in budgets {
        invocation.arg(*limit);
    }
    let mut connection = redis.connection()?;
    let rejected: i64 = invocation
        .invoke_async(&mut connection)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    Ok(rejected == 0)
}

pub async fn authorize_session_creation(
    redis: &RedisStore,
    config: &SecurityConfig,
    ip: IpAddr,
) -> Result<(), ApiError> {
    let budgets = [
        ("global".to_owned(), config.session_create_global),
        (format!("ip:{ip}"), config.session_create_per_ip),
        (
            format!("subnet:{}", subnet_key(ip)),
            config.session_create_per_subnet,
        ),
    ];
    if consume_budgets(
        redis,
        "session-create",
        config.session_create_window_seconds,
        &budgets,
    )
    .await?
    {
        Ok(())
    } else {
        Err(ApiError::SessionCreationLimitExceeded(
            "匿名会话创建过于频繁，请稍后再试".into(),
        ))
    }
}

pub async fn authorize_search_rate(
    redis: &RedisStore,
    config: &SecurityConfig,
    session: &Session,
    ip: IpAddr,
    policy: &UserPolicy,
) -> Result<(), ApiError> {
    let (tier, window_seconds, session_limit, ip_limit) = if session.user_id.is_some() {
        (
            "logged",
            policy.logged_search_rate_limit_window_seconds,
            policy.logged_search_rate_limit_per_session,
            policy.logged_search_rate_limit_per_ip,
        )
    } else {
        (
            "anonymous",
            policy.anonymous_search_rate_limit_window_seconds,
            policy.anonymous_search_rate_limit_per_session,
            policy.anonymous_search_rate_limit_per_ip,
        )
    };
    let subnet_limit = ip_limit.saturating_mul(config.search_subnet_limit_multiplier);
    let budgets = [
        (format!("{tier}:session:{}", session.token), session_limit),
        (format!("{tier}:ip:{ip}"), ip_limit),
        (format!("{tier}:subnet:{}", subnet_key(ip)), subnet_limit),
    ];
    if consume_budgets(redis, "search", window_seconds, &budgets).await? {
        Ok(())
    } else {
        Err(ApiError::SearchLimitExceeded(
            "搜索次数已超过当前限制，请稍后再试".into(),
        ))
    }
}

pub struct SearchPermit {
    redis: RedisStore,
    session_key: String,
    global_key: String,
    released: bool,
}

impl SearchPermit {
    pub async fn release(mut self) {
        release_permit(&self.redis, &self.session_key, &self.global_key).await;
        self.released = true;
    }
}

impl Drop for SearchPermit {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let redis = self.redis.clone();
        let session_key = self.session_key.clone();
        let global_key = self.global_key.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                release_permit(&redis, &session_key, &global_key).await;
            });
        }
    }
}

async fn release_permit(redis: &RedisStore, session_key: &str, global_key: &str) {
    let script = Script::new(
        r#"
        for _, key in ipairs(KEYS) do
          if redis.call('EXISTS', key) == 1 then
            local current = redis.call('DECR', key)
            if current <= 0 then redis.call('DEL', key) end
          end
        end
        return 1
        "#,
    );
    let Ok(mut connection) = redis.connection() else {
        return;
    };
    let _: Result<i64, _> = script
        .key(session_key)
        .key(global_key)
        .invoke_async(&mut connection)
        .await;
}

pub async fn acquire_search_permit(
    redis: &RedisStore,
    config: &SecurityConfig,
    session: &Session,
    ttl_seconds: u64,
) -> Result<SearchPermit, ApiError> {
    let session_limit = if session.user_id.is_some() {
        config.logged_search_concurrency
    } else {
        config.anonymous_search_concurrency
    };
    let session_key = format!("pansou:concurrency:search:session:{}", session.token);
    let global_key = "pansou:concurrency:search:global".to_owned();
    let script = Script::new(
        r#"
        local session_current = tonumber(redis.call('GET', KEYS[1]) or '0')
        local global_current = tonumber(redis.call('GET', KEYS[2]) or '0')
        if session_current >= tonumber(ARGV[1]) then return 1 end
        if global_current >= tonumber(ARGV[2]) then return 2 end
        redis.call('INCR', KEYS[1])
        redis.call('INCR', KEYS[2])
        redis.call('EXPIRE', KEYS[1], ARGV[3])
        redis.call('EXPIRE', KEYS[2], ARGV[3])
        return 0
        "#,
    );
    let mut connection = redis.connection()?;
    let rejected: i64 = script
        .key(&session_key)
        .key(&global_key)
        .arg(session_limit)
        .arg(config.global_search_concurrency)
        .arg(ttl_seconds.max(30))
        .invoke_async(&mut connection)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    match rejected {
        0 => Ok(SearchPermit {
            redis: redis.clone(),
            session_key,
            global_key,
            released: false,
        }),
        1 => Err(ApiError::SearchLimitExceeded(
            "当前会话已有过多搜索正在执行，请等待完成后重试".into(),
        )),
        _ => Err(ApiError::Unavailable("当前搜索任务较多，请稍后再试".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn groups_ipv4_by_24_subnet() {
        assert_eq!(
            subnet_key(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 99))),
            "192.0.2.0/24"
        );
    }

    #[test]
    fn groups_ipv6_by_64_subnet() {
        assert_eq!(
            subnet_key(IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 3, 4, 5, 6))),
            "2001:db8:1:2::/64"
        );
    }
}
