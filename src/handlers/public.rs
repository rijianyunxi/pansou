use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
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
        .clamp(1, 100);
    let rows=sqlx::query("SELECT term,score,pinned,status FROM hot_searches WHERE status='approved' ORDER BY pinned DESC,score DESC,last_searched DESC LIMIT $1").bind(limit).fetch_all(&state.pool).await?;
    let data=rows.into_iter().map(|r|json!({"term":r.get::<String,_>("term"),"score":r.get::<i64,_>("score"),"pinned":r.get::<bool,_>("pinned"),"status":r.get::<String,_>("status")})).collect::<Vec<_>>();
    Ok(Json(
        json!({"code":0,"message":"success","data":{"hotSearches":data}}),
    ))
}
pub async fn monitor(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let _ = state.auth().session(&headers).await?;
    let rows = sqlx::query(
        "SELECT s.id,s.name,s.priority,s.enabled,s.updated_at,h.snapshot_json
         FROM resource_sources s
         LEFT JOIN source_health h ON h.source_id=s.id
         ORDER BY s.priority,s.id",
    )
    .fetch_all(&state.pool)
    .await?;
    let sources = rows
        .into_iter()
        .map(|row| {
            let snapshot = row.get::<Option<Value>, _>("snapshot_json");
            let health = snapshot.map(normalize_monitor_health);
            json!({
                "id": row.get::<String, _>("id"),
                "name": row.get::<String, _>("name"),
                "priority": row.get::<i32, _>("priority"),
                "kind": "source",
                "enabled": row.get::<bool, _>("enabled"),
                "version": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at").to_rfc3339(),
                "health": health,
            })
        })
        .collect::<Vec<_>>();
    let total = sources.len();
    let healthy = sources
        .iter()
        .filter(|source| {
            source
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && source
                    .get("health")
                    .and_then(|v| v.get("healthy"))
                    .and_then(Value::as_bool)
                    == Some(true)
        })
        .count();
    let failed = sources
        .iter()
        .filter(|source| {
            source
                .get("health")
                .and_then(|v| v.get("healthy"))
                .and_then(Value::as_bool)
                == Some(false)
        })
        .count();
    Ok(Json(json!({
        "code": 0,
        "data": {
            "generatedAt": chrono::Utc::now().to_rfc3339(),
            "sources": sources,
            "summary": {"total": total, "healthy": healthy, "failed": failed},
        }
    })))
}

fn normalize_monitor_health(mut health: Value) -> Value {
    let Some(object) = health.as_object_mut() else {
        return health;
    };
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
