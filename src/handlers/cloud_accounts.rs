use super::common::{admin_only, ok};
use crate::{app::AppState, cloud_auth, cloud_drive::Provider, error::ApiError};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

pub(super) fn cloud_response(result: Result<Value, ApiError>) -> Response {
    let mut response = match result {
        Ok(data) => ok(data).into_response(),
        Err(e) => e.into_response(),
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store, private".parse().unwrap());
    response
        .headers_mut()
        .insert("pragma", "no-cache".parse().unwrap());
    response
}
pub(super) fn cloud_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return Err(ApiError::Forbidden("不允许跨站修改网盘账号".into()));
    }
    if let Some(origin) = headers.get("origin") {
        let origin = origin
            .to_str()
            .ok()
            .and_then(|s| url::Url::parse(s).ok())
            .ok_or_else(|| ApiError::Forbidden("请求来源无效".into()))?;
        let host = headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        let expected = url::Url::parse(&format!("{}://{host}", origin.scheme()))
            .map_err(|_| ApiError::Forbidden("请求来源无效".into()))?;
        if !matches!(origin.scheme(), "http" | "https")
            || origin.host_str() != expected.host_str()
            || origin.port_or_known_default() != expected.port_or_known_default()
            || origin.path() != "/"
            || origin.query().is_some()
            || !origin.username().is_empty()
        {
            return Err(ApiError::Forbidden("不允许跨站修改网盘账号".into()));
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connect {
    pub intent: String,
    pub expected_epoch: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Import {
    pub intent: String,
    pub expected_epoch: i64,
    pub credential: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Disconnect {
    pub expected_epoch: i64,
}
pub async fn cloud_accounts(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    cloud_response(
        async {
            admin_only(&headers, &state).await?;
            cloud_auth::list(&state).await
        }
        .await,
    )
}
pub async fn cloud_account_start(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Connect>,
) -> Response {
    cloud_response(
        async {
            cloud_origin(&headers)?;
            let actor = admin_only(&headers, &state).await?.user_id.unwrap();
            let p = Provider::from_name(&provider)?;
            cloud_auth::start_login(&state, p, actor, &body.intent, body.expected_epoch).await
        }
        .await,
    )
}
pub async fn cloud_account_session(
    State(state): State<Arc<AppState>>,
    Path((provider, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Response {
    cloud_response(
        async {
            let actor = admin_only(&headers, &state).await?.user_id.unwrap();
            cloud_auth::session(&state, Provider::from_name(&provider)?, id, actor).await
        }
        .await,
    )
}
pub async fn cloud_account_cancel(
    State(state): State<Arc<AppState>>,
    Path((provider, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Response {
    cloud_response(
        async {
            cloud_origin(&headers)?;
            let actor = admin_only(&headers, &state).await?.user_id.unwrap();
            cloud_auth::cancel(&state, Provider::from_name(&provider)?, id, actor).await?;
            Ok(serde_json::json!({"cancelled":true}))
        }
        .await,
    )
}
pub async fn cloud_account_import(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Import>,
) -> Response {
    cloud_response(
        async {
            cloud_origin(&headers)?;
            admin_only(&headers, &state).await?;
            cloud_auth::import(
                &state,
                Provider::from_name(&provider)?,
                &body.credential,
                &body.intent,
                body.expected_epoch,
            )
            .await?;
            cloud_auth::list(&state).await
        }
        .await,
    )
}
pub async fn cloud_account_check(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    headers: HeaderMap,
) -> Response {
    cloud_response(
        async {
            cloud_origin(&headers)?;
            admin_only(&headers, &state).await?;
            cloud_auth::check(&state, Provider::from_name(&provider)?).await?;
            cloud_auth::list(&state).await
        }
        .await,
    )
}
pub async fn cloud_account_disconnect(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Disconnect>,
) -> Response {
    cloud_response(
        async {
            cloud_origin(&headers)?;
            admin_only(&headers, &state).await?;
            cloud_auth::disconnect(&state, Provider::from_name(&provider)?, body.expected_epoch)
                .await?;
            cloud_auth::list(&state).await
        }
        .await,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_cross_site_and_opaque_origins() {
        let mut h = HeaderMap::new();
        h.insert("host", "localhost:3666".parse().unwrap());
        h.insert("origin", "http://localhost:3666".parse().unwrap());
        assert!(cloud_origin(&h).is_ok());
        for origin in ["null", "https://evil.test", "http://localhost:3667"] {
            h.insert("origin", origin.parse().unwrap());
            assert!(cloud_origin(&h).is_err());
        }
    }
}

pub async fn cloud_account_qr_settings(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    headers: HeaderMap,
) -> Response {
    cloud_response(
        async {
            admin_only(&headers, &state).await?;
            cloud_auth::qr_settings::get(&state, Provider::from_name(&provider)?).await
        }
        .await,
    )
}
pub async fn cloud_account_save_qr_settings(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    body: Result<Json<cloud_auth::qr_settings::Update>, axum::extract::rejection::JsonRejection>,
) -> Response {
    cloud_response(
        async {
            cloud_origin(&headers)?;
            admin_only(&headers, &state).await?;
            // Do not reflect serde diagnostics (including unknown field names)
            // from a write-only settings body, and keep errors non-cacheable.
            let Json(body) =
                body.map_err(|_| ApiError::BadRequest("扫码设置请求格式无效".into()))?;
            cloud_auth::qr_settings::update(&state, Provider::from_name(&provider)?, body).await
        }
        .await,
    )
}
