use crate::error::ApiError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{PgPool, Row};

pub const POLICY_KEYS: [&str; 23] = [
    "showHotSearch",
    "anonymousCustomChannels",
    "showAuthButtons",
    "homeSearchPlaceholder",
    "sessionDays",
    "customChannelLimit",
    "defaultConcurrency",
    "requestTimeoutMs",
    "circuitBreakerMaxFailures",
    "proxyCircuitBreakerMaxFailures",
    "proxyCircuitBreakerTimeoutSeconds",
    "searchTimeoutMs",
    "cacheTtlMinutes",
    "cacheMaxMemoryMb",
    "anonymousSearchRateLimitWindowSeconds",
    "anonymousSearchRateLimitPerSession",
    "anonymousSearchRateLimitPerIp",
    "loggedSearchRateLimitWindowSeconds",
    "loggedSearchRateLimitPerSession",
    "loggedSearchRateLimitPerIp",
    "anonymousSearchConcurrency",
    "loggedSearchConcurrency",
    "globalSearchConcurrency",
];

const LEGACY_KEYS: [&str; 4] = [
    "anonymous_custom_channels",
    "show_hot_search",
    "show_auth_buttons",
    "home_search_placeholder",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct UserPolicy {
    pub show_hot_search: bool,
    pub anonymous_custom_channels: bool,
    pub show_auth_buttons: bool,
    pub home_search_placeholder: String,
    pub session_days: u64,
    pub custom_channel_limit: usize,
    pub default_concurrency: usize,
    pub request_timeout_ms: u64,
    pub circuit_breaker_max_failures: i64,
    pub proxy_circuit_breaker_max_failures: i32,
    pub proxy_circuit_breaker_timeout_seconds: i64,
    pub search_timeout_ms: u64,
    pub cache_ttl_minutes: u64,
    pub cache_max_memory_mb: u64,
    pub anonymous_search_rate_limit_window_seconds: u64,
    pub anonymous_search_rate_limit_per_session: u64,
    pub anonymous_search_rate_limit_per_ip: u64,
    pub logged_search_rate_limit_window_seconds: u64,
    pub logged_search_rate_limit_per_session: u64,
    pub logged_search_rate_limit_per_ip: u64,
    pub anonymous_search_concurrency: u64,
    pub logged_search_concurrency: u64,
    pub global_search_concurrency: u64,
}

impl Default for UserPolicy {
    fn default() -> Self {
        Self {
            show_hot_search: true,
            anonymous_custom_channels: false,
            show_auth_buttons: true,
            home_search_placeholder: "搜索电影、剧集、资料等资源…".into(),
            session_days: 30,
            custom_channel_limit: 10,
            default_concurrency: 4,
            request_timeout_ms: 5_000,
            circuit_breaker_max_failures: 5,
            proxy_circuit_breaker_max_failures: 3,
            proxy_circuit_breaker_timeout_seconds: 300,
            search_timeout_ms: 30_000,
            cache_ttl_minutes: 10,
            cache_max_memory_mb: 100,
            anonymous_search_rate_limit_window_seconds: 60,
            anonymous_search_rate_limit_per_session: 20,
            anonymous_search_rate_limit_per_ip: 60,
            logged_search_rate_limit_window_seconds: 60,
            logged_search_rate_limit_per_session: 60,
            logged_search_rate_limit_per_ip: 240,
            anonymous_search_concurrency: 2,
            logged_search_concurrency: 4,
            global_search_concurrency: 64,
        }
    }
}

fn in_range<T: PartialOrd>(name: &str, value: T, min: T, max: T) -> Result<(), ApiError> {
    if value < min || value > max {
        return Err(ApiError::BadRequest(format!("{name} 超出允许范围")));
    }
    Ok(())
}

impl UserPolicy {
    pub fn validate(mut self) -> Result<Self, ApiError> {
        self.home_search_placeholder = self.home_search_placeholder.trim().to_owned();
        let placeholder_len = self.home_search_placeholder.chars().count();
        if !(1..=120).contains(&placeholder_len) {
            return Err(ApiError::BadRequest(
                "homeSearchPlaceholder 长度必须为 1 到 120 个字符".into(),
            ));
        }
        in_range("sessionDays", self.session_days, 1, 365)?;
        in_range("customChannelLimit", self.custom_channel_limit, 0, 100)?;
        in_range("defaultConcurrency", self.default_concurrency, 1, 16)?;
        in_range("requestTimeoutMs", self.request_timeout_ms, 1_000, 60_000)?;
        in_range(
            "circuitBreakerMaxFailures",
            self.circuit_breaker_max_failures,
            1,
            20,
        )?;
        in_range(
            "proxyCircuitBreakerMaxFailures",
            self.proxy_circuit_breaker_max_failures,
            1,
            20,
        )?;
        in_range(
            "proxyCircuitBreakerTimeoutSeconds",
            self.proxy_circuit_breaker_timeout_seconds,
            10,
            3_600,
        )?;
        in_range("searchTimeoutMs", self.search_timeout_ms, 1_000, 120_000)?;
        in_range("cacheTtlMinutes", self.cache_ttl_minutes, 1, 10)?;
        in_range("cacheMaxMemoryMb", self.cache_max_memory_mb, 16, 512)?;
        in_range(
            "anonymousSearchRateLimitWindowSeconds",
            self.anonymous_search_rate_limit_window_seconds,
            10,
            3_600,
        )?;
        in_range(
            "anonymousSearchRateLimitPerSession",
            self.anonymous_search_rate_limit_per_session,
            1,
            300,
        )?;
        in_range(
            "anonymousSearchRateLimitPerIp",
            self.anonymous_search_rate_limit_per_ip,
            1,
            1_000,
        )?;
        in_range(
            "loggedSearchRateLimitWindowSeconds",
            self.logged_search_rate_limit_window_seconds,
            10,
            3_600,
        )?;
        in_range(
            "loggedSearchRateLimitPerSession",
            self.logged_search_rate_limit_per_session,
            1,
            300,
        )?;
        in_range(
            "loggedSearchRateLimitPerIp",
            self.logged_search_rate_limit_per_ip,
            1,
            1_000,
        )?;
        in_range(
            "anonymousSearchConcurrency",
            self.anonymous_search_concurrency,
            1,
            16,
        )?;
        in_range(
            "loggedSearchConcurrency",
            self.logged_search_concurrency,
            1,
            32,
        )?;
        in_range(
            "globalSearchConcurrency",
            self.global_search_concurrency,
            8,
            256,
        )?;
        Ok(self)
    }

    pub fn session_ttl_seconds(&self) -> u64 {
        self.session_days * 24 * 60 * 60
    }
}

fn canonical_key(key: &str) -> Option<&'static str> {
    POLICY_KEYS
        .iter()
        .copied()
        .find(|candidate| *candidate == key)
        .or(match key {
            "anonymous_custom_channels" => Some("anonymousCustomChannels"),
            "show_hot_search" => Some("showHotSearch"),
            "show_auth_buttons" => Some("showAuthButtons"),
            "home_search_placeholder" => Some("homeSearchPlaceholder"),
            _ => None,
        })
}

fn merge_values(current: UserPolicy, input: &Value) -> Result<UserPolicy, ApiError> {
    let input = input
        .as_object()
        .ok_or_else(|| ApiError::BadRequest("策略配置必须是 JSON 对象".into()))?;
    let mut merged = serde_json::to_value(current)
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .as_object()
        .cloned()
        .unwrap_or_default();
    for key in POLICY_KEYS {
        if let Some(value) = input.get(key) {
            merged.insert(key.into(), value.clone());
        }
    }
    serde_json::from_value::<UserPolicy>(Value::Object(merged))
        .map_err(|error| ApiError::BadRequest(format!("策略配置格式错误：{error}")))?
        .validate()
}

pub async fn load(pool: &PgPool) -> Result<UserPolicy, ApiError> {
    let rows = sqlx::query("SELECT key,value_json FROM policy_settings ORDER BY updated_at,key")
        .fetch_all(pool)
        .await?;
    let mut values = serde_json::to_value(UserPolicy::default())
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut canonical_values = Map::new();
    let mut legacy_values = Map::new();
    for row in rows {
        let key: String = row.try_get("key")?;
        let value: Value = row.try_get("value_json")?;
        let Some(canonical) = canonical_key(&key) else {
            continue;
        };
        if POLICY_KEYS.contains(&key.as_str()) {
            canonical_values.insert(canonical.into(), value);
        } else {
            legacy_values.insert(canonical.into(), value);
        }
    }
    for (key, value) in legacy_values {
        values.insert(key, value);
    }
    for (key, value) in canonical_values {
        values.insert(key, value);
    }
    serde_json::from_value::<UserPolicy>(Value::Object(values))
        .map_err(|error| ApiError::Internal(format!("读取策略配置失败：{error}")))?
        .validate()
        .or_else(|error| {
            tracing::warn!(%error, "stored user policy invalid; using defaults");
            Ok(UserPolicy::default())
        })
}

pub async fn save(pool: &PgPool, input: &Value) -> Result<UserPolicy, ApiError> {
    let next = merge_values(load(pool).await?, input)?;
    let serialized =
        serde_json::to_value(&next).map_err(|error| ApiError::Internal(error.to_string()))?;
    let object = serialized
        .as_object()
        .ok_or_else(|| ApiError::Internal("策略序列化失败".into()))?;
    let mut transaction = pool.begin().await?;
    for key in POLICY_KEYS {
        let value = object
            .get(key)
            .cloned()
            .ok_or_else(|| ApiError::Internal(format!("缺少策略字段 {key}")))?;
        sqlx::query(
            "INSERT INTO policy_settings(key,value_json,updated_at) VALUES($1,$2,now())\n             ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=now()",
        )
        .bind(key)
        .bind(value)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query("DELETE FROM policy_settings WHERE key = ANY($1)")
        .bind(LEGACY_KEYS.as_slice())
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "UPDATE system_settings SET default_concurrency=$1,request_timeout_ms=$2,cache_ttl_minutes=$3,updated_at=now() WHERE id=1",
    )
    .bind(next.default_concurrency as i32)
    .bind(next.request_timeout_ms as i32)
    .bind(next.cache_ttl_minutes as i32)
    .execute(&mut *transaction)
    .await?;
    sqlx::query("UPDATE search_settings SET concurrency=NULL,updated_at=now() WHERE id=1")
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn partial_updates_keep_unspecified_policy_values() {
        let current = UserPolicy::default();
        let next = merge_values(
            current.clone(),
            &json!({"showHotSearch": false, "defaultConcurrency": 7}),
        )
        .unwrap();
        assert!(!next.show_hot_search);
        assert_eq!(next.default_concurrency, 7);
        assert_eq!(next.session_days, current.session_days);
    }

    #[test]
    fn rejects_out_of_range_policy_values() {
        let error =
            merge_values(UserPolicy::default(), &json!({"requestTimeoutMs": 999})).unwrap_err();
        assert!(error.to_string().contains("requestTimeoutMs"));
    }

    #[test]
    fn serializes_the_frontend_camel_case_contract() {
        let value = serde_json::to_value(UserPolicy::default()).unwrap();
        for key in POLICY_KEYS {
            assert!(value.get(key).is_some(), "missing policy key: {key}");
        }
        assert_eq!(value.as_object().map(Map::len), Some(POLICY_KEYS.len()));
    }
}
