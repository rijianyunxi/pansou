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
    pub search_subnet_limit_multiplier: u64,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            trust_proxy_headers: false,
            search_subnet_limit_multiplier: 4,
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
            search_subnet_limit_multiplier: env_u64(
                "PANSOU_SEARCH_SUBNET_LIMIT_MULTIPLIER",
                defaults.search_subnet_limit_multiplier,
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

fn window_retry_after(timestamp: i64, window_seconds: u64) -> u64 {
    window_seconds - timestamp.rem_euclid(window_seconds as i64) as u64
}

async fn consume_budgets(
    redis: &RedisStore,
    namespace: &str,
    window_seconds: u64,
    budgets: &[(String, u64)],
) -> Result<Option<u64>, ApiError> {
    let timestamp = chrono::Utc::now().timestamp();
    let bucket = timestamp / window_seconds as i64;
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
    // Redis TTL starts at the first request, but the budget resets at the
    // wall-clock bucket boundary. Report that boundary, not the key TTL.
    Ok((rejected != 0).then(|| window_retry_after(timestamp, window_seconds)))
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
    match consume_budgets(redis, "search", window_seconds, &budgets).await? {
        None => Ok(()),
        Some(retry_after) => Err(ApiError::SearchLimitExceeded {
            message: "搜索次数已超过当前限制，请稍后再试".into(),
            retry_after,
        }),
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
    policy: &UserPolicy,
    session: &Session,
    ttl_seconds: u64,
) -> Result<SearchPermit, ApiError> {
    let session_limit = if session.user_id.is_some() {
        policy.logged_search_concurrency
    } else {
        policy.anonymous_search_concurrency
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
        .arg(policy.global_search_concurrency)
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
        1 => Err(ApiError::SearchLimitExceeded {
            message: "当前会话已有过多搜索正在执行，请等待完成后重试".into(),
            // A running search may release its permit before the lease expires.
            retry_after: 1,
        }),
        _ => Err(ApiError::Unavailable("当前搜索任务较多，请稍后再试".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{StatusCode, header},
        response::IntoResponse,
    };
    use redis::AsyncCommands;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn retry_after_tracks_fixed_window_boundary_instead_of_key_ttl() {
        assert_eq!(window_retry_after(120, 60), 60);
        assert_eq!(window_retry_after(121, 60), 59);
        assert_eq!(window_retry_after(179, 60), 1);
        assert_eq!(window_retry_after(180, 60), 60);
        assert_eq!(window_retry_after(239, 120), 1);
    }

    async fn test_redis() -> RedisStore {
        let url = env::var("PANSOU_TEST_REDIS_URL").expect("isolated test Redis URL");
        let parsed = url::Url::parse(&url).unwrap();
        let db: u8 = parsed.path().trim_start_matches('/').parse().unwrap();
        assert!((1..=15).contains(&db), "Never use production Redis DB 0");
        RedisStore::connect(&url).await.unwrap()
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_REDIS_URL with nonzero DB"]
    async fn session_ip_and_subnet_budgets_reject_as_429_for_both_tiers() {
        let redis = test_redis().await;
        let unique = uuid::Uuid::new_v4();
        let byte = unique.as_bytes()[0];
        let ip: IpAddr = Ipv4Addr::new(198, 18, byte, 1).into();
        let other_ip: IpAddr = Ipv4Addr::new(198, 18, byte, 2).into();
        let policy = UserPolicy {
            anonymous_search_rate_limit_window_seconds: 3600,
            anonymous_search_rate_limit_per_session: 1,
            anonymous_search_rate_limit_per_ip: 1,
            logged_search_rate_limit_window_seconds: 3600,
            logged_search_rate_limit_per_session: 1,
            logged_search_rate_limit_per_ip: 1,
            ..UserPolicy::default()
        };
        let config = SecurityConfig {
            search_subnet_limit_multiplier: 1,
            ..SecurityConfig::default()
        };
        let bucket = chrono::Utc::now().timestamp() / 3600;
        let mut cleanup = Vec::new();
        for (tier, user_id) in [("anonymous", None), ("logged", Some(1))] {
            let sessions: Vec<_> = (0..3)
                .map(|i| Session {
                    token: format!("{unique}_{tier}_{i}"),
                    user_id,
                })
                .collect();
            for session in &sessions {
                cleanup.push(format!(
                    "pansou:rate:search:{tier}:session:{}:{bucket}",
                    session.token
                ));
            }
            for identity in [
                format!("ip:{ip}"),
                format!("ip:{other_ip}"),
                format!("subnet:{}", subnet_key(ip)),
            ] {
                cleanup.push(format!("pansou:rate:search:{tier}:{identity}:{bucket}"));
            }
            authorize_search_rate(&redis, &config, &sessions[0], ip, &policy)
                .await
                .unwrap();
            for (session, address) in [
                (&sessions[0], ip),
                (&sessions[1], ip),
                (&sessions[2], other_ip),
            ] {
                let response = authorize_search_rate(&redis, &config, session, address, &policy)
                    .await
                    .unwrap_err()
                    .into_response();
                assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
                let wait: u64 = response.headers()[header::RETRY_AFTER]
                    .to_str()
                    .unwrap()
                    .parse()
                    .unwrap();
                assert!((1..=3600).contains(&wait));
            }
            let mut conn = redis.connection().unwrap();
            let count: Option<u64> = conn
                .get(format!(
                    "pansou:rate:search:{tier}:session:{}:{bucket}",
                    sessions[1].token
                ))
                .await
                .unwrap();
            assert_eq!(
                count, None,
                "Rejected requests must not consume other budgets"
            );
        }
        let _: usize = redis.connection().unwrap().del(cleanup).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_REDIS_URL with nonzero DB"]
    async fn session_concurrency_is_429_global_capacity_is_503_and_release_recovers() {
        let redis = test_redis().await;
        let policy = UserPolicy {
            anonymous_search_concurrency: 1,
            global_search_concurrency: 2,
            ..UserPolicy::default()
        };
        let sessions: Vec<_> = (0..3)
            .map(|_| Session {
                token: uuid::Uuid::new_v4().to_string(),
                user_id: None,
            })
            .collect();
        let first = acquire_search_permit(&redis, &policy, &sessions[0], 30)
            .await
            .unwrap();
        let response = acquire_search_permit(&redis, &policy, &sessions[0], 30)
            .await
            .err()
            .unwrap()
            .into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        let second = acquire_search_permit(&redis, &policy, &sessions[1], 30)
            .await
            .unwrap();
        let error = acquire_search_permit(&redis, &policy, &sessions[2], 30)
            .await
            .err()
            .unwrap();
        assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
        first.release().await;
        let recovered = acquire_search_permit(&redis, &policy, &sessions[0], 30)
            .await
            .unwrap();
        second.release().await;
        recovered.release().await;
        let total: Option<u64> = redis
            .connection()
            .unwrap()
            .get("pansou:concurrency:search:global")
            .await
            .unwrap();
        assert_eq!(total, None, "Denied requests must not leak permits");
    }

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
