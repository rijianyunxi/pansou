use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    SessionRequired(String),
    #[error("{0}")]
    SessionCreationLimitExceeded(String),
    #[error("{0}")]
    SearchLimitExceeded(String),
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
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_)
            | Self::SessionRequired(_)
            | Self::SessionCreationLimitExceeded(_)
            | Self::SearchLimitExceeded(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Gone(_) => StatusCode::GONE,
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
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
            Self::SessionCreationLimitExceeded(_) => "SESSION_CREATION_LIMIT_EXCEEDED",
            Self::SearchLimitExceeded(_) => "SEARCH_LIMIT_EXCEEDED",
            Self::Unavailable(_) => "SERVER_BUSY",
            Self::Unauthorized(_) => "UNAUTHORIZED",
            Self::Forbidden(_) => "FORBIDDEN",
            Self::BadRequest(_) => "BAD_REQUEST",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict(_) => "CONFLICT",
            Self::Gone(_) => "REF_EXPIRED",
            Self::TooManyRequests(_) => "RATE_LIMITED",
            Self::Upstream(_) => "UPSTREAM_ERROR",
            Self::Internal(_) => "INTERNAL_ERROR",
        };
        (
            status,
            Json(json!({
                "statusCode": status.as_u16(),
                "code": code,
                "statusMessage": self.to_string(),
                "message": self.to_string(),
            })),
        )
            .into_response()
    }
}
