use super::common::policy;
use crate::{
    app::AppState,
    auth::{clear_session_cookie, session_cookie},
    error::ApiError,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use rand::Rng;
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

pub async fn account_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let auth = state.auth();
    let existing = auth.existing_session(&headers).await?;
    let created = existing.is_none();
    let s = if let Some(session) = existing {
        session
    } else {
        auth.issue(true).await?
    };
    let user = match s.user_id {
        Some(id) => Some(auth.public_user(id).await?),
        None => None,
    };
    let policy = policy(&state).await;
    let body = json!({"authenticated":user.is_some(),"user":user,"sessionId":s.token,"anonymousCustomChannels":policy.get("anonymousCustomChannels").and_then(Value::as_bool).unwrap_or(false),"showHotSearch":policy.get("showHotSearch").and_then(Value::as_bool).unwrap_or(true),"showAuthButtons":policy.get("showAuthButtons").and_then(Value::as_bool).unwrap_or(true),"homeSearchPlaceholder":policy.get("homeSearchPlaceholder").and_then(Value::as_str).unwrap_or("搜索电影、剧集、资料等资源…")});
    let mut out = Json(body).into_response();
    if created || headers.get(header::COOKIE).is_none() {
        out.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&session_cookie(&s.token, auth.session_ttl_seconds().await))
                .unwrap(),
        );
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}
pub async fn account_login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginBody>,
) -> Result<Response, ApiError> {
    let auth = state.auth();
    let (s, user) = auth.login(&body.username, &body.password).await?;
    let mut out = Json(json!({"ok":true,"user":user})).into_response();
    out.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&s.token, auth.session_ttl_seconds().await)).unwrap(),
    );
    Ok(out)
}
pub async fn account_logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let s = state.auth().session(&headers).await?;
    let mut out = Json(json!({"ok":true})).into_response();
    out.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_session_cookie()).unwrap(),
    );
    state.auth().revoke_session(&s).await?;

    Ok(out)
}
pub async fn profile_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let s = state.auth().session(&headers).await?;
    let id = s
        .user_id
        .ok_or_else(|| ApiError::Unauthorized("请先登录".into()))?;
    Ok(Json(json!({"user":state.auth().public_user(id).await?})))
}
#[derive(Deserialize)]
pub struct ProfileBody {
    nickname: String,
}
pub async fn profile_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ProfileBody>,
) -> Result<Json<Value>, ApiError> {
    let s = state.auth().session(&headers).await?;
    let id = s
        .user_id
        .ok_or_else(|| ApiError::Unauthorized("请先登录".into()))?;
    if body.nickname.chars().count() > 32 {
        return Err(ApiError::BadRequest("昵称不能超过 32 个字符".into()));
    }
    sqlx::query("UPDATE users SET nickname=$1,updated_at=now() WHERE id=$2")
        .bind(body.nickname.trim())
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(
        json!({"ok":true,"user":state.auth().public_user(id).await?}),
    ))
}

#[derive(Deserialize)]
pub struct ChannelBody {
    channels: Vec<String>,
}
fn anonymous_channels_key(token: &str) -> String {
    format!("pansou:anon_channels:{token}")
}

pub async fn channels_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = state.auth().session(&headers).await?;
    let policy = crate::policy::load(&state.pool).await?;
    if session.user_id.is_none() && !policy.anonymous_custom_channels {
        return Err(ApiError::Forbidden("未登录不可使用".into()));
    }
    let channels = if let Some(user_id) = session.user_id {
        sqlx::query_scalar::<_, Value>("SELECT custom_channels_json FROM users WHERE id=$1")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(json!([]))
    } else {
        let mut redis = state.redis.connection()?;
        let stored: Option<String> = redis
            .get(anonymous_channels_key(&session.token))
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        stored
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| json!([]))
    };
    Ok(Json(json!({
        "channels": channels,
        "limit": policy.custom_channel_limit,
        "anonymousCustomChannels": policy.anonymous_custom_channels,
    })))
}
pub async fn channels_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChannelBody>,
) -> Result<Json<Value>, ApiError> {
    let session = state.auth().session(&headers).await?;
    let policy = crate::policy::load(&state.pool).await?;
    if body.channels.len() > policy.custom_channel_limit {
        return Err(ApiError::BadRequest(format!(
            "频道数量不能超过 {} 个",
            policy.custom_channel_limit
        )));
    }
    if session.user_id.is_none() && !policy.anonymous_custom_channels {
        return Err(ApiError::Forbidden("未登录不可使用".into()));
    }
    let mut normalized = body
        .channels
        .iter()
        .map(|c| {
            crate::telegram::normalize_channel(c).ok_or_else(|| {
                ApiError::BadRequest("请输入公开 Telegram 频道用户名，私密邀请链接不支持".into())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort();
    normalized.dedup();
    let channels = serde_json::to_value(normalized)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    if let Some(user_id) = session.user_id {
        sqlx::query("UPDATE users SET custom_channels_json=$1,custom_channels_updated_at=now(),updated_at=now() WHERE id=$2")
            .bind(&channels)
            .bind(user_id)
            .execute(&state.pool)
            .await?;
    } else {
        let mut redis = state.redis.connection()?;
        let encoded = serde_json::to_string(&channels)
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        let _: () = redis
            .set_ex(
                anonymous_channels_key(&session.token),
                encoded,
                policy.session_ttl_seconds(),
            )
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
    }
    Ok(Json(json!({
        "channels": channels,
        "limit": policy.custom_channel_limit,
        "anonymousCustomChannels": policy.anonymous_custom_channels,
    })))
}

pub async fn channels_validate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let session = state.auth().session(&headers).await?;
    let raw = body
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let channel=crate::telegram::normalize_channel(raw).ok_or_else(||ApiError::BadRequest("请输入公开频道用户名或链接，例如 @channel_name 或 t.me/s/channel_name；不支持私密邀请链接。".into()))?;
    if session.user_id.is_none()
        && !crate::policy::load(&state.pool)
            .await?
            .anonymous_custom_channels
    {
        return Err(ApiError::Forbidden("未登录不可使用".into()));
    }
    Ok(Json(
        json!({"ok":true,"channel":channel,"message":"频道格式有效；公开访问状态由采集任务确认"}),
    ))
}

pub async fn wechat_login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let code = body
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if code.is_empty() {
        return Err(ApiError::BadRequest("code is required".into()));
    }
    let settings: Option<(String, String)> =
        sqlx::query_as("SELECT value_json->>'appId',value_json->>'secret' FROM policy_settings WHERE key='wechat-mini'")
            .fetch_optional(&state.pool)
            .await?;
    let (app_id, secret) = settings
        .filter(|(id, secret)| !id.trim().is_empty() && !secret.trim().is_empty())
        .ok_or_else(|| ApiError::Unavailable("微信小程序登录未配置 AppID/Secret".into()))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| ApiError::Internal("无法初始化微信登录服务".into()))?;
    let response = client
        .get("https://api.weixin.qq.com/sns/jscode2session")
        .query(&[
            ("appid", app_id.trim()),
            ("secret", secret.trim()),
            ("js_code", code),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|error| {
            // Never log the reqwest URL: its query contains the app secret/code.
            tracing::warn!(
                timeout = error.is_timeout(),
                connect = error.is_connect(),
                "wechat code exchange transport failure"
            );
            ApiError::Upstream("无法连接微信登录服务，请稍后重试".into())
        })?;
    if !response.status().is_success() {
        return Err(ApiError::Upstream(format!(
            "微信登录服务响应异常（HTTP {}）",
            response.status().as_u16()
        )));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| ApiError::Upstream("微信登录服务返回格式异常".into()))?;
    let openid = wechat_openid(&data)?;
    let auth = state.auth();
    let (session, user) = auth.login_wechat(app_id.trim(), openid).await?;
    let expires_at =
        chrono::Utc::now().timestamp_millis() + (auth.session_ttl_seconds().await as i64 * 1000);
    Ok(Json(
        json!({"token":session.token,"expiresAt":expires_at,"user":user}),
    ))
}

fn wechat_openid(data: &Value) -> Result<&str, ApiError> {
    if let Some(code) = data.get("errcode") {
        let code = code
            .as_i64()
            .ok_or_else(|| ApiError::Upstream("微信登录错误码格式异常".into()))?;
        if code != 0 {
            tracing::warn!(code, "wechat code exchange rejected");
            return Err(match code {
                40029 | 40163 => ApiError::BadRequest("微信登录凭证已失效，请重新点击登录".into()),
                40013 | 40125 | 40001 => {
                    ApiError::Unavailable("微信 AppID 或 Secret 配置错误，请联系管理员".into())
                }
                45011 => ApiError::TooManyRequests("微信登录过于频繁，请稍后重试".into()),
                40226 => ApiError::Forbidden("微信暂不允许此账号登录".into()),
                _ => ApiError::Upstream(format!("微信登录失败（错误码 {code}），请稍后重试")),
            });
        }
    }
    data.get("openid")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| ApiError::Upstream("微信登录响应缺少用户标识".into()))
}

#[cfg(test)]
mod wechat_tests {
    use super::*;
    #[test]
    fn exchange_requires_verified_identity() {
        assert_eq!(
            wechat_openid(&json!({"openid":"verified", "session_key":"private"})).unwrap(),
            "verified"
        );
        for data in [
            json!({}),
            json!({"openid":" "}),
            json!({"openid":123}),
            json!({"errcode":"invalid", "openid":"bad"}),
        ] {
            assert!(wechat_openid(&data).is_err());
        }
        assert!(matches!(
            wechat_openid(&json!({"errcode":40029,"openid":"bad"})),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            wechat_openid(&json!({"errcode":40125})),
            Err(ApiError::Unavailable(_))
        ));
        assert!(matches!(
            wechat_openid(&json!({"errcode":45011})),
            Err(ApiError::TooManyRequests(_))
        ));
        assert!(matches!(
            wechat_openid(&json!({"errcode":-1})),
            Err(ApiError::Upstream(_))
        ));
    }
}

pub async fn wechat_qr_confirm(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let ticket = body
        .get("ticket")
        .or_else(|| body.get("scene"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let code = body
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if ticket.is_empty() || code.is_empty() {
        return Err(ApiError::BadRequest(
            "ticket/scene and code are required".into(),
        ));
    }
    let configured:bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM policy_settings WHERE key='wechat-mini' AND value_json->>'appId'<>'' AND value_json->>'secret'<>'')").fetch_one(&state.pool).await?;
    if !configured {
        return Err(ApiError::Upstream(
            "微信小程序登录未配置 AppID/Secret".into(),
        ));
    }
    let mut redis = state.redis.connection()?;
    let exists: bool = redis
        .exists(format!("pansou:wechat:qr:{ticket}"))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    if !exists {
        return Err(ApiError::NotFound("登录二维码已过期".into()));
    }
    let _: () = redis
        .set_ex(format!("pansou:wechat:qr:{ticket}"), "confirmed", 300)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(json!({"ok":true,"status":"confirmed"})))
}

pub async fn wechat_qr_start(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    if !policy(&state)
        .await
        .get("showAuthButtons")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Err(ApiError::Forbidden("登录入口已关闭".into()));
    }
    let ticket: String = rand::rng()
        .sample_iter(&rand::distr::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    let mut redis = state.redis.connection()?;
    let _: () = redis
        .set_ex(format!("pansou:wechat:qr:{ticket}"), "pending", 300)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let qr_image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Crect width='100%25' height='100%25' fill='white'/%3E%3Ctext x='110' y='105' text-anchor='middle' font-size='16'%3Epansou QR%3C/text%3E%3Ctext x='110' y='130' text-anchor='middle' font-size='11'%3E请使用小程序扫码%3C/text%3E%3C/svg%3E";
    Ok(Json(
        json!({"ok":true,"ticket":ticket,"qrImage":qr_image,"expiresAt":chrono::Utc::now().timestamp_millis()+300_000}),
    ))
}

pub async fn wechat_qr_poll(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let ticket = query.get("ticket").map(String::as_str).unwrap_or("");
    if ticket.is_empty() {
        return Err(ApiError::BadRequest("ticket is required".into()));
    }
    let mut redis = state.redis.connection()?;
    let status: Option<String> = redis
        .get(format!("pansou:wechat:qr:{ticket}"))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    Ok(Json(json!({
        "ok": true,
        "status": status.unwrap_or_else(|| "expired".into()),
        "user": null
    })))
}

pub async fn channel_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(channel): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.auth().session(&headers).await?;
    let user_id = session
        .user_id
        .ok_or_else(|| ApiError::Forbidden("请先登录".into()))?;
    let current: Value = sqlx::query_scalar("SELECT custom_channels_json FROM users WHERE id=$1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten()
        .unwrap_or_else(|| json!([]));
    let next = Value::Array(
        current
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|value| value.as_str() != Some(channel.as_str()))
            .collect(),
    );
    sqlx::query("UPDATE users SET custom_channels_json=$1,custom_channels_updated_at=now(),updated_at=now() WHERE id=$2")
        .bind(&next)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    let count = next.as_array().map_or(0, Vec::len);
    Ok(Json(json!({"ok":true,"channels":next,"count":count})))
}
