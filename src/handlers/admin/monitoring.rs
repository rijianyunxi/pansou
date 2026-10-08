use crate::handlers::common::{admin_only, ok};
use crate::{app::AppState, error::ApiError};
use axum::{Json, extract::State, http::HeaderMap};
use serde_json::{Value, json};
use std::sync::Arc;

pub async fn admin_monitor_reset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    sqlx::query("DELETE FROM source_health h USING resource_sources s WHERE h.source_id=s.id AND s.kind='live'")
        .execute(&state.pool)
        .await?;
    Ok(ok(json!({})))
}
