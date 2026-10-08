use crate::handlers::common::{admin_only, ok};
use crate::{app::AppState, auth::hash_password, error::ApiError};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc};

pub async fn admin_users_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let page = query
        .get("page")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(1)
        .clamp(1, 1_000_000);
    let page_size = query
        .get("pageSize")
        .or_else(|| query.get("limit"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let offset = (page - 1) * page_size;
    let keyword = query
        .get("q")
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    let status = query
        .get("status")
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    let filter = "WHERE deleted_at IS NULL
        AND ($1 = '' OR username ILIKE '%' || $1 || '%' OR COALESCE(nickname, '') ILIKE '%' || $1 || '%')
        AND ($2 = '' OR status = $2)";
    let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM users {filter}"))
        .bind(&keyword)
        .bind(&status)
        .fetch_one(&state.pool)
        .await?;
    let rows=sqlx::query(&format!("SELECT id,username,nickname,role,status,created_at,last_login_at,last_login_ip,COALESCE(jsonb_array_length(custom_channels_json),0) AS channel_count FROM users {filter} ORDER BY id DESC LIMIT $3 OFFSET $4"))
        .bind(&keyword)
        .bind(&status)
        .bind(page_size)
        .bind(offset)
        .fetch_all(&state.pool).await?;
    Ok(ok(
        json!({"items":rows.into_iter().map(|r|json!({"id":r.get::<i64,_>("id"),"username":r.get::<String,_>("username"),"nickname":r.get::<Option<String>,_>("nickname"),"role":r.get::<String,_>("role"),"status":r.get::<String,_>("status"),"createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),"lastLoginAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("last_login_at"),"lastLoginIp":r.get::<Option<String>,_>("last_login_ip"),"channelCount":r.get::<i32,_>("channel_count")})).collect::<Vec<_>>(),"total":total,"page":page,"pageSize":page_size,"totalPages":(total + page_size - 1) / page_size}),
    ))
}
pub async fn admin_users_post(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let username = body
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("username is required".into()))?;
    let password = body
        .get("password")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("password is required".into()))?;
    let hash = hash_password(password)?;
    let normalized = username.to_lowercase();
    let duplicate: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE username_normalized=$1)")
            .bind(&normalized)
            .fetch_one(&state.pool)
            .await?;
    if duplicate {
        return Err(ApiError::Conflict("用户名已存在".into()));
    }
    // This endpoint is the administrator console's "创建管理员" action;
    // never downgrade the newly created account to a normal user when the
    // browser omits the role field.
    let role = "admin";
    let row=sqlx::query("INSERT INTO users(username,username_normalized,password_hash,nickname,role,status) VALUES($1,$2,$3,$4,$5,'active') RETURNING id").bind(username).bind(&normalized).bind(hash).bind(body.get("nickname").and_then(Value::as_str)).bind(role).fetch_one(&state.pool).await?;
    let id = row.get::<i64, _>("id");
    Ok(Json(
        json!({"code":0,"message":"created","data":{"user":{"id":id,"username":username,"nickname":body.get("nickname").and_then(Value::as_str),"role":role,"status":"active"}}}),
    ))
}

pub async fn admin_user_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    sqlx::query("UPDATE users SET deleted_at=now(),status='disabled' WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"code":0,"message":"deleted"})))
}
async fn set_user_status(
    state: &AppState,
    headers: &HeaderMap,
    id: i64,
    status: &str,
) -> Result<Json<Value>, ApiError> {
    admin_only(headers, state).await?;
    sqlx::query("UPDATE users SET status=$1,updated_at=now() WHERE id=$2")
        .bind(status)
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(
        json!({"code":0,"message":"saved","data":{"id":id,"status":status}}),
    ))
}
pub async fn admin_user_enable(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    set_user_status(&state, &headers, id, "active").await
}
pub async fn admin_user_disable(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    set_user_status(&state, &headers, id, "disabled").await
}
pub async fn admin_user_channels_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let channels: Value = sqlx::query_scalar(
        "SELECT custom_channels_json FROM users WHERE id=$1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .flatten()
    .unwrap_or_else(|| json!([]));
    Ok(Json(
        json!({"code":0,"message":"success","data":{"channels":channels,"limit":20}}),
    ))
}
pub async fn admin_user_channel_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let channel = payload.get("channel").and_then(Value::as_str).unwrap_or("");
    let current: Value = sqlx::query_scalar(
        "SELECT custom_channels_json FROM users WHERE id=$1 AND deleted_at IS NULL",
    )
    .bind(id)
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
            .filter(|value| value.as_str() != Some(channel))
            .collect(),
    );
    sqlx::query("UPDATE users SET custom_channels_json=$1,custom_channels_updated_at=now(),updated_at=now() WHERE id=$2").bind(&next).bind(id).execute(&state.pool).await?;
    Ok(Json(
        json!({"code":0,"message":"deleted","data":{"channels":next}}),
    ))
}
pub async fn admin_user_sessions_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let count = state.auth().revoke_user_sessions(id).await?;

    Ok(Json(
        json!({"code":0,"message":"revoked","data":{"count":count}}),
    ))
}
