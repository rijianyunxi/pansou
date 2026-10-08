use super::string_list;
use crate::handlers::admin_paging::PageCursor;
use crate::handlers::common::{admin_only, ok};
use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc};

pub async fn admin_resources_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let page = q
        .get("page")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1)
        .clamp(1, 1_000_000);
    let limit = q
        .get("pageSize")
        .or_else(|| q.get("limit"))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let offset = (page - 1) * limit;
    let needle = q.get("q").cloned().unwrap_or_default();
    let cloud_type = q.get("cloudType").cloned().unwrap_or_default();
    let channel = q.get("channel").cloned().unwrap_or_default();
    let mut cursor_filters = vec![needle.clone(), cloud_type.clone()];
    if !channel.is_empty() {
        cursor_filters.push(channel.clone());
    }
    let cursor = PageCursor::parse(
        q.get("before").map(String::as_str),
        "resources",
        &cursor_filters,
        limit,
    )?;
    // OFFSET traverses only narrow index keys for direct page jumps.
    // The ID tie-breaker keeps page order deterministic without changing the API.
    let mut query = sqlx::QueryBuilder::new(
        "WITH page AS MATERIALIZED (SELECT id,updated_at FROM managed_resources",
    );
    crate::admin_stats::resource_filters(&mut query, &needle, &cloud_type);
    channel_resource_filter(&mut query, &channel);
    if let Some(cursor) = &cursor {
        query
            .push(" AND (updated_at,id)<(")
            .push_bind(cursor.at)
            .push(",")
            .push_bind(&cursor.id)
            .push(")");
    }
    query
        .push(" ORDER BY updated_at DESC,id DESC LIMIT ")
        .push_bind(limit + 1);
    if cursor.is_none() {
        query.push(" OFFSET ").push_bind(offset);
    }
    query.push(") SELECT p.updated_at,r.id,r.name,r.description,r.datetime,resource_link_types(r.id) AS cloud_types_json,resource_links_json(r.id) AS links_json,r.images_json,r.enabled FROM page p JOIN managed_resources r ON r.id=p.id ORDER BY p.updated_at DESC,p.id DESC");
    let mut rows = query.build().fetch_all(&state.pool).await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                PageCursor::next(
                    "resources",
                    cursor_filters,
                    limit,
                    row.get("updated_at"),
                    row.get("id"),
                )
            })
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let total = if channel.is_empty() {
        state
            .admin_stats
            .resource_total(&state.pool, &needle, &cloud_type)
            .await?
    } else if needle.is_empty() && cloud_type.is_empty() {
        state
            .admin_stats
            .channels(&state.pool, &[channel.clone()])
            .await?
            .get(&channel)
            .map(|counts| counts.resource_count)
            .unwrap_or(0)
    } else {
        let mut count = sqlx::QueryBuilder::new("SELECT count(*) FROM managed_resources");
        crate::admin_stats::resource_filters(&mut count, &needle, &cloud_type);
        channel_resource_filter(&mut count, &channel);
        count
            .build_query_scalar::<i64>()
            .fetch_one(&state.pool)
            .await?
    };
    let mut resources = rows.into_iter().map(|r| json!({
        "id": r.get::<String,_>("id"), "name": r.get::<String,_>("name"),
        "description": r.get::<Option<String>,_>("description"), "datetime": r.get::<Option<String>,_>("datetime"),
        "cloud_types": r.get::<Value,_>("cloud_types_json"), "links": r.get::<Value,_>("links_json"),
        "images": r.get::<Value,_>("images_json"),
        "enabled": r.get::<bool,_>("enabled")
    })).collect::<Vec<_>>();
    crate::link_resolution::admin_resource_observations(&state, &mut resources).await?;
    let cloud_types = state.admin_stats.cloud_types(&state.pool).await?;
    Ok(ok(
        json!({"items":resources,"resources":resources,"cloudTypes":cloud_types,"page":page,"pageSize":limit,"limit":limit,"total":total,"hasMore":has_more,"nextCursor":next_cursor}),
    ))
}

fn channel_resource_filter<'a>(
    query: &mut sqlx::QueryBuilder<'a, sqlx::Postgres>,
    channel: &'a str,
) {
    if !channel.is_empty() {
        query
            .push(" AND enabled AND source_channel_ids @> ARRAY[")
            .push_bind(channel)
            .push("]::text[]");
    }
}

pub async fn admin_resources_post(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if name.is_empty() {
        return Err(ApiError::BadRequest("resource name is required".into()));
    }
    // Accept the legacy declaration for input compatibility, but never store
    // it independently: provider types are determined by the actual links.
    if let Some(types) = body.get("cloud_types") {
        if !types
            .as_array()
            .is_some_and(|types| types.iter().all(Value::is_string))
        {
            return Err(ApiError::BadRequest("cloud_types 必须是字符串数组".into()));
        }
    }
    let raw_links = body.get("links").cloned().unwrap_or_else(|| json!([]));
    let mut links: Vec<crate::models::Link> = serde_json::from_value(raw_links).map_err(|_| {
        ApiError::BadRequest("links 必须是包含 type、url 和可选 password 的数组".into())
    })?;
    for link in &mut links {
        if let Some(provider) = crate::resource_clean::cloud_type(&link.url) {
            link.r#type = provider.into();
        }
    }
    let cloud_types = json!(
        links
            .iter()
            .map(|link| link.r#type.as_str())
            .filter(|provider| !provider.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
    );
    // Strip presentation observations supplied by the admin list. They must
    // never become a second persisted copy of catalog check facts.
    let links = json!(links);
    let description = body.get("description").and_then(Value::as_str);
    let images = body.get("images").cloned().unwrap_or_else(|| json!([]));
    let datetime = body.get("datetime").and_then(Value::as_str);
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO managed_resources(id,name,description,datetime,images_json,enabled,updated_at) VALUES($1,$2,$3,$4,$5,true,now()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,datetime=excluded.datetime,images_json=excluded.images_json,updated_at=now()")
        .bind(&id).bind(&name).bind(description).bind(datetime).bind(&images).execute(&mut *tx).await?;
    crate::resource_links::replace(
        &mut tx,
        &id,
        &serde_json::from_value::<Vec<crate::models::Link>>(links.clone())
            .map_err(|e| ApiError::BadRequest(e.to_string()))?,
    )
    .await?;
    tx.commit().await?;
    state.admin_stats.invalidate().await;
    let mut resource = json!({"id":id,"name":name,"description":description,"datetime":datetime,"cloud_types":cloud_types,"links":links,"images":images,"enabled":true});
    crate::link_resolution::admin_resource_observations(
        &state,
        std::slice::from_mut(&mut resource),
    )
    .await?;
    Ok(ok(json!({"resource":resource})))
}

pub async fn admin_resources_enabled(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| ApiError::BadRequest("enabled 必须是布尔值".into()))?;
    let ids = string_list(&payload, "ids");
    let count =
        sqlx::query("UPDATE managed_resources SET enabled=$1,updated_at=now() WHERE id = ANY($2)")
            .bind(enabled)
            .bind(&ids)
            .execute(&state.pool)
            .await?
            .rows_affected();
    state.admin_stats.invalidate().await;
    Ok(Json(
        json!({"code":0,"message":if enabled {"enabled"} else {"disabled"},"data":{"count":count}}),
    ))
}

pub async fn admin_resources_batch_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let ids = string_list(&payload, "ids");
    let count = sqlx::query("DELETE FROM managed_resources WHERE id=ANY($1)")
        .bind(&ids)
        .execute(&state.pool)
        .await?
        .rows_affected();
    state.admin_stats.invalidate().await;
    Ok(Json(
        json!({"code":0,"message":"deleted","data":{"count":count}}),
    ))
}

pub async fn admin_resources_check(
    state: State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    crate::handlers::cloud_drive::resources_check(state, headers, payload).await
}
pub async fn admin_resources_cloud_delete(
    state: State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Json<Value>,
) -> Result<axum::response::Response, ApiError> {
    crate::handlers::cloud_drive::cloud_delete(state, headers, payload).await
}

pub async fn admin_resource_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let row = sqlx::query("SELECT id,name,description,datetime,resource_link_types(id) AS cloud_types_json,resource_links_json(id) AS links_json,images_json,enabled FROM managed_resources WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let mut resource = row.map(|row| json!({
        "id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),
        "description":row.get::<Option<String>,_>("description"),"datetime":row.get::<Option<String>,_>("datetime"),
        "cloud_types":row.get::<Value,_>("cloud_types_json"),"links":row.get::<Value,_>("links_json"),
        "images":row.get::<Value,_>("images_json"),
        "enabled":row.get::<bool,_>("enabled")
    }));
    if let Some(resource) = resource.as_mut() {
        crate::link_resolution::admin_resource_observations(&state, std::slice::from_mut(resource))
            .await?;
    }
    Ok(Json(
        json!({"code":0,"message":"success","data":{"resource":resource}}),
    ))
}

pub async fn admin_resource_update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(mut payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if let Some(object) = payload.as_object_mut() {
        object.insert("id".into(), Value::String(id));
    }
    admin_resources_post(State(state), headers, Json(payload)).await
}

pub async fn admin_resource_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    sqlx::query("DELETE FROM managed_resources WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    state.admin_stats.invalidate().await;
    Ok(Json(json!({"code":0,"message":"deleted"})))
}
