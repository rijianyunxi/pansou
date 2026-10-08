use crate::handlers::common::{admin_only, ok};
use crate::{app::AppState, auth::hash_password, error::ApiError};
use axum::{Json, extract::State, http::HeaderMap};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub async fn admin_account_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let s = admin_only(&headers, &state).await?;
    let user = state.auth().public_user(s.user_id.unwrap()).await?;
    Ok(ok(
        json!({"account":{"id":user.id,"username":user.username,"role":user.role},"user":user}),
    ))
}
#[derive(Deserialize)]
pub struct AdminAccountBody {
    username: Option<String>,
    password: Option<String>,
    nickname: Option<String>,
}
pub async fn admin_account_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AdminAccountBody>,
) -> Result<Json<Value>, ApiError> {
    let s = admin_only(&headers, &state).await?;
    let id = s.user_id.unwrap();
    if let Some(name) = body.username {
        sqlx::query(
            "UPDATE users SET username=$1,username_normalized=$2,updated_at=now() WHERE id=$3",
        )
        .bind(&name)
        .bind(name.to_lowercase())
        .bind(id)
        .execute(&state.pool)
        .await?;
    }
    if let Some(pw) = body.password {
        sqlx::query("UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2")
            .bind(hash_password(&pw)?)
            .bind(id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(nick) = body.nickname {
        sqlx::query("UPDATE users SET nickname=$1,updated_at=now() WHERE id=$2")
            .bind(nick)
            .bind(id)
            .execute(&state.pool)
            .await?;
    }
    admin_account_get(State(state), headers).await
}
