use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{message}")]
    Crawl {
        message: String,
        terminal: bool,
        retry_after: i64,
        retry_node: bool,
    },
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    CloudAuthRequired(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    SessionRequired(String),
    #[error("{message}")]
    SearchLimitExceeded { message: String, retry_after: u64 },
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Gone(String),
    #[error("{0}")]
    TooManyRequests(String),
    #[error("{0}")]
    Internal(String),
    #[error("{0}")]
    Upstream(String),
    #[error("{0}")]
    Unavailable(String),
}
impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) | Self::CloudAuthRequired(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) | Self::SessionRequired(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Gone(_) => StatusCode::GONE,
            Self::TooManyRequests(_) | Self::SearchLimitExceeded { .. } => {
                StatusCode::TOO_MANY_REQUESTS
            }
            Self::Upstream(_) | Self::Crawl { .. } => StatusCode::BAD_GATEWAY,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(value: anyhow::Error) -> Self {
        Self::Internal(value.to_string())
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(value: sqlx::Error) -> Self {
        tracing::error!(error=%value, "database error");
        Self::Internal("数据库操作失败".into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        let code = match &self {
            Self::SessionRequired(_) => "SESSION_REQUIRED",
            Self::SearchLimitExceeded { .. } => "SEARCH_LIMIT_EXCEEDED",
            Self::Unavailable(_) => "SERVER_BUSY",
            Self::Unauthorized(_) => "UNAUTHORIZED",
            Self::Forbidden(_) => "FORBIDDEN",
            Self::BadRequest(_) => "BAD_REQUEST",
            Self::CloudAuthRequired(_) => "CLOUD_AUTH_REQUIRED",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict(_) => "CONFLICT",
            Self::Gone(_) => "REF_EXPIRED",
            Self::TooManyRequests(_) => "RATE_LIMITED",
            Self::Upstream(_) | Self::Crawl { .. } => "UPSTREAM_ERROR",
            Self::Internal(_) => "INTERNAL_ERROR",
        };
        let retry_after = match &self {
            Self::SearchLimitExceeded { retry_after, .. } => Some((*retry_after).max(1)),
            _ => None,
        };
        let mut payload = json!({
            "statusCode": status.as_u16(),
            "code": code,
            "statusMessage": self.to_string(),
            "message": self.to_string(),
        });
        if let Some(seconds) = retry_after {
            payload["retryAfter"] = json!(seconds);
        }
        let mut response = (status, Json(payload)).into_response();
        if let Some(seconds) = retry_after {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&seconds.to_string()).expect("numeric Retry-After"),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn search_limit_response_has_429_code_and_matching_retry_after() {
        for (configured, expected) in [(17, 17), (0, 1)] {
            let response = ApiError::SearchLimitExceeded {
                message: "slow down".into(),
                retry_after: configured,
            }
            .into_response();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(
                response.headers()[header::RETRY_AFTER],
                expected.to_string()
            );
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                    .unwrap();
            assert_eq!(body["statusCode"], 429);
            assert_eq!(body["code"], "SEARCH_LIMIT_EXCEEDED");
            assert_eq!(body["retryAfter"], expected);
            assert_eq!(body["message"], "slow down");
        }
    }

    #[tokio::test]
    async fn authentication_and_global_busy_responses_keep_their_semantics() {
        for (error, expected_status, expected_code) in [
            (
                ApiError::SessionRequired("expired".into()),
                StatusCode::UNAUTHORIZED,
                "SESSION_REQUIRED",
            ),
            (
                ApiError::Unauthorized("invalid".into()),
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
            ),
            (
                ApiError::Unavailable("busy".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVER_BUSY",
            ),
        ] {
            let response = error.into_response();
            assert_eq!(response.status(), expected_status);
            assert!(!response.headers().contains_key(header::RETRY_AFTER));
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                    .unwrap();
            assert_eq!(body["code"], expected_code);
            assert_eq!(body["statusCode"], expected_status.as_u16());
        }
    }
}
