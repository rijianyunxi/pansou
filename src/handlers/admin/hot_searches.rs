use super::string_list;
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

pub async fn admin_hot_searches_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let page = q
        .get("page")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1)
        .max(1);
    let page_size = q
        .get("pageSize")
        .or_else(|| q.get("limit"))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let offset = (page - 1) * page_size;
    let query = q.get("q").cloned().unwrap_or_default();
    let status = q.get("status").cloned().unwrap_or_default();
    let source = q.get("source").cloned().unwrap_or_default();
    let rows=sqlx::query("SELECT term,score,pinned,status,source,manual_weight,last_searched,updated_at FROM hot_searches WHERE ($1='' OR term ILIKE '%'||$1||'%') AND ($2='' OR status=$2) AND ($3='' OR source=$3) ORDER BY pinned DESC,score DESC,last_searched DESC LIMIT $4 OFFSET $5")
        .bind(&query).bind(&status).bind(&source).bind(page_size).bind(offset).fetch_all(&state.pool).await?;
    let total:i64=sqlx::query_scalar("SELECT count(*) FROM hot_searches WHERE ($1='' OR term ILIKE '%'||$1||'%') AND ($2='' OR status=$2) AND ($3='' OR source=$3)").bind(&query).bind(&status).bind(&source).fetch_one(&state.pool).await?;
    let items=rows.into_iter().map(|r|json!({"term":r.get::<String,_>("term"),"score":r.get::<i64,_>("score"),"pinned":r.get::<bool,_>("pinned"),"status":r.get::<String,_>("status"),"source":r.get::<String,_>("source"),"manualWeight":r.get::<i32,_>("manual_weight"),"lastSearched":r.get::<chrono::DateTime<chrono::Utc>,_>("last_searched"),"updatedAt":r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at")})).collect::<Vec<_>>();
    Ok(ok(
        json!({"items":items,"page":page,"pageSize":page_size,"total":total}),
    ))
}

pub async fn admin_hot_searches_post(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let term = body
        .get("term")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if term.is_empty() {
        return Err(ApiError::BadRequest("term is required".into()));
    }
    let score = body.get("score").and_then(Value::as_i64).unwrap_or(0);
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("approved");
    let source = body
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    let pinned = body.get("pinned").and_then(Value::as_bool).unwrap_or(false);
    let manual_weight = body
        .get("manualWeight")
        .or_else(|| body.get("manual_weight"))
        .and_then(Value::as_i64)
        .unwrap_or(0) as i32;
    let mut tx = state.pool.begin().await?;
    crate::hot_search::lock(&mut tx).await?;
    let protected: i64 = sqlx::query_scalar("SELECT count(*) FROM hot_searches WHERE term<>$1 AND (pinned OR source='manual' OR status<>'approved')")
        .bind(&term).fetch_one(&mut *tx).await?;
    if protected >= crate::hot_search::LIMIT {
        return Err(ApiError::Conflict(
            "热门搜索已保留30条人工维护的词，请先删除一条再新增".into(),
        ));
    }
    let r=sqlx::query("INSERT INTO hot_searches(term,normalized_term,score,last_searched,status,source,pinned,manual_weight,updated_at) VALUES($1,$2,$3,now(),$4,$5,$6,$7,now()) ON CONFLICT(term) DO UPDATE SET score=excluded.score,status=excluded.status,source=excluded.source,pinned=excluded.pinned,manual_weight=excluded.manual_weight,updated_at=now() RETURNING term,score,pinned,status,source,manual_weight,last_searched,updated_at").bind(&term).bind(term.to_lowercase()).bind(score).bind(status).bind(source).bind(pinned).bind(manual_weight).fetch_one(&mut *tx).await?;
    if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM hot_searches WHERE term=$1)")
        .bind(&term)
        .fetch_one(&mut *tx)
        .await?
    {
        return Err(ApiError::Conflict(
            "该词热度未进入前30名，可设为置顶或人工来源后添加".into(),
        ));
    }
    tx.commit().await?;
    let item = json!({"term":r.get::<String,_>("term"),"score":r.get::<i64,_>("score"),"pinned":r.get::<bool,_>("pinned"),"status":r.get::<String,_>("status"),"source":r.get::<String,_>("source"),"manualWeight":r.get::<i32,_>("manual_weight"),"lastSearched":r.get::<chrono::DateTime<chrono::Utc>,_>("last_searched"),"updatedAt":r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at")});
    Ok(ok(json!({"item":item})))
}

async fn hot_search_terms_action(
    state: &AppState,
    headers: &HeaderMap,
    payload: &Value,
    action: &str,
) -> Result<Json<Value>, ApiError> {
    admin_only(headers, state).await?;
    let terms = string_list(payload, "terms");
    let result = match action {
        "delete" => {
            sqlx::query("DELETE FROM hot_searches WHERE term = ANY($1)")
                .bind(&terms)
                .execute(&state.pool)
                .await?
        }
        "status" => {
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("approved");
            sqlx::query("UPDATE hot_searches SET status=$1,updated_at=now() WHERE term = ANY($2)")
                .bind(status)
                .bind(&terms)
                .execute(&state.pool)
                .await?
        }
        "pinned" => {
            let pinned = payload
                .get("pinned")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            sqlx::query("UPDATE hot_searches SET pinned=$1,updated_at=now() WHERE term = ANY($2)")
                .bind(pinned)
                .bind(&terms)
                .execute(&state.pool)
                .await?
        }
        _ => unreachable!(),
    };
    Ok(Json(
        json!({"code":0,"message":if action=="delete" {"deleted"} else {"updated"},"data":{"count":result.rows_affected()}}),
    ))
}

pub async fn admin_hot_searches_batch_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    hot_search_terms_action(&state, &headers, &payload, "delete").await
}
pub async fn admin_hot_searches_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    hot_search_terms_action(&state, &headers, &payload, "status").await
}
pub async fn admin_hot_searches_pinned(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    hot_search_terms_action(&state, &headers, &payload, "pinned").await
}

pub async fn admin_hot_search_update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(term): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    sqlx::query("UPDATE hot_searches SET term=COALESCE(NULLIF($1,''),term), normalized_term=COALESCE(NULLIF($1,''),normalized_term), score=COALESCE($2,score), status=COALESCE($3,status), source=COALESCE($4,source), pinned=COALESCE($5,pinned), manual_weight=COALESCE($6,manual_weight), updated_at=now() WHERE term=$7")
        .bind(payload.get("term").and_then(Value::as_str))
        .bind(payload.get("score").and_then(Value::as_i64))
        .bind(payload.get("status").and_then(Value::as_str))
        .bind(payload.get("source").and_then(Value::as_str))
        .bind(payload.get("pinned").and_then(Value::as_bool))
        .bind(payload.get("manualWeight").or_else(|| payload.get("manual_weight")).and_then(Value::as_i64).map(|value| value as i32))
        .bind(term)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"code":0,"message":"saved"})))
}

pub async fn admin_hot_search_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(term): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    sqlx::query("DELETE FROM hot_searches WHERE term=$1")
        .bind(term)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"code":0,"message":"deleted"})))
}
