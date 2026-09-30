use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub(super) fn ok(data: Value) -> Json<Value> {
    Json(json!({"code":0,"message":"success","data":data}))
}
pub(super) fn json_response(data: Value) -> Response {
    Json(data).into_response()
}
pub(super) fn admin_only(
    headers: &HeaderMap,
    state: &AppState,
) -> impl std::future::Future<Output = Result<crate::auth::Session, ApiError>> {
    let auth = state.auth();
    let headers = headers.clone();
    async move {
        let s = auth.session(&headers).await?;
        let id = s
            .user_id
            .ok_or_else(|| ApiError::Unauthorized("请先登录".into()))?;
        let u = auth.public_user(id).await?;
        if u.role != "admin" {
            return Err(ApiError::Forbidden("需要管理员权限".into()));
        }
        Ok(s)
    }
}

pub(super) async fn policy(state: &AppState) -> Value {
    let value = match crate::policy::load(&state.pool).await {
        Ok(policy) => policy,
        Err(error) => {
            tracing::warn!(%error, "failed to load user policy; using defaults");
            crate::policy::UserPolicy::default()
        }
    };
    serde_json::to_value(value).unwrap_or_else(|_| json!({}))
}
