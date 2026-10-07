use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    extract::{Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
};
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc};

pub async fn health(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let rows =
        sqlx::query("SELECT id,name,priority,enabled FROM resource_sources ORDER BY priority,id")
            .fetch_all(&state.pool)
            .await?;
    let sources=rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"priority":r.get::<i32,_>("priority"),"enabled":r.get::<bool,_>("enabled")})).collect::<Vec<_>>();
    let redis_response = state.redis.ping().await?;

    Ok(Json(
        json!({"status":"ok","sources_enabled":sources.iter().filter(|s|s.get("enabled").and_then(Value::as_bool).unwrap_or(false)).count(),"sources":sources,"liveness":{"status":"ok","checked_at":chrono::Utc::now().to_rfc3339()},"postgres":{"status":"ok"},"redis":{"status":"ok","response":redis_response},"resource_sources":{"count":sources.len()}}),
    ))
}
pub async fn robots() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "User-agent: *\nAllow: /\nDisallow: /api/\n",
    )
}
pub async fn sitemap() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"><url><loc>/</loc></url><url><loc>/copyright</loc></url></urlset>",
    )
}

pub async fn hot_searches(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let limit = query
        .get("limit")
        .and_then(|x| x.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, crate::hot_search::LIMIT);
    let rows=sqlx::query("SELECT term,score,pinned,status FROM hot_searches WHERE status='approved' ORDER BY pinned DESC,score DESC,last_searched DESC,term ASC LIMIT $1").bind(limit).fetch_all(&state.pool).await?;
    let data=rows.into_iter().map(|r|json!({"term":r.get::<String,_>("term"),"score":r.get::<i64,_>("score"),"pinned":r.get::<bool,_>("pinned"),"status":r.get::<String,_>("status")})).collect::<Vec<_>>();
    Ok(Json(
        json!({"code":0,"message":"success","data":{"hotSearches":data}}),
    ))
}
pub(super) fn normalize_monitor_health(mut health: Value) -> Value {
    let Some(object) = health.as_object_mut() else {
        return health;
    };
    // Legacy snapshots stored the latest latency under both percentile names.
    // Hide those values until a writer has computed and identified a real window.
    if !object
        .get("responseTimeWindow")
        .is_some_and(Value::is_object)
    {
        object.insert("p50ResponseTime".into(), Value::Null);
        object.insert("p95ResponseTime".into(), Value::Null);
        object.insert("responseTimeWindow".into(), Value::Null);
    }
    if object.get("dimensionSchemaVersion").and_then(Value::as_i64) != Some(2) {
        let dimensions = ["network", "http", "business", "parsing", "results"]
            .into_iter()
            .map(|name| (name.to_owned(), json!({"state":"unknown","passRate":null,"observedCount":0,"passCount":0,"recent":""})))
            .collect::<serde_json::Map<String, Value>>();
        object.insert("dimensions".into(), Value::Object(dimensions));
        object.insert("parsingSuccessRate".into(), Value::Null);
    }
    if !object.contains_key("healthy")
        && let Some(value) = object.remove("isHealthy")
    {
        object.insert("healthy".into(), value);
    }
    if !object.contains_key("failureCount")
        && let Some(value) = object.get("totalFailureCount").cloned()
    {
        object.insert("failureCount".into(), value);
    }
    if !object.contains_key("lastSuccessAt")
        && let Some(value) = object.remove("lastSuccessTime")
    {
        object.insert("lastSuccessAt".into(), value);
    }
    if !object.contains_key("lastFailureAt")
        && let Some(value) = object.remove("lastFailureTime")
    {
        object.insert("lastFailureAt".into(), value);
    }
    if !object.contains_key("lastErrorMessage") {
        object.insert("lastErrorMessage".into(), Value::String(String::new()));
    }
    if !object.contains_key("recentFailures") {
        let failures = object
            .get("recentOutcomes")
            .and_then(Value::as_array)
            .map(|outcomes| {
                outcomes
                    .iter()
                    .filter(|event| event.get("ok").and_then(Value::as_bool) == Some(false))
                    .rev()
                    .take(10)
                    .map(|event| {
                        json!({
                            "at": event.get("at").cloned().unwrap_or(Value::Null),
                            "responseTimeMs": event.get("responseTimeMs").cloned().unwrap_or(Value::Null),
                            "errorCategory": event.get("errorCategory").and_then(Value::as_str).unwrap_or("request_failed"),
                            "message": event.get("message").and_then(Value::as_str).unwrap_or("资源源请求失败"),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        object.insert("recentFailures".into(), Value::Array(failures));
    }
    health
}
