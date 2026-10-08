use crate::handlers::admin_paging::PageCursor;
use crate::handlers::common::{admin_only, ok};
use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use std::{collections::HashMap, sync::Arc};

fn admin_log_array(row: &PgRow, column: &str) -> Vec<String> {
    row.try_get::<Value, _>(column)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn admin_log_counts(row: &PgRow, column: &str) -> Value {
    let Some(object) = row
        .try_get::<Value, _>(column)
        .ok()
        .and_then(|value| value.as_object().cloned())
    else {
        return json!({});
    };
    Value::Object(
        object
            .into_iter()
            .filter_map(|(key, value)| {
                let count = value
                    .as_i64()
                    .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))?;
                Some((key, json!(count.max(0))))
            })
            .collect(),
    )
}

fn admin_log_json(row: PgRow) -> Value {
    let created_at = row
        .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
        .timestamp_millis();
    let completed_at = row
        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("completed_at")
        .map(|value| value.timestamp_millis());
    let result_count = i64::from(row.get::<i32, _>("result_count")).max(0);
    json!({
        "id": row.get::<i64, _>("id"),
        "sessionId": row.get::<Option<String>, _>("session_id"),
        "userId": row.get::<Option<i64>, _>("user_id"),
        "username": row.get::<Option<String>, _>("username"),
        "nickname": row.get::<Option<String>, _>("nickname"),
        "keyword": row.get::<String, _>("keyword"),
        "ip": row.get::<String, _>("ip"),
        "searchScope": row.get::<String, _>("search_scope"),
        "channels": admin_log_array(&row, "channels_json"),
        "sourceIds": admin_log_array(&row, "source_ids_json"),
        "status": row.get::<String, _>("status"),
        "resultCount": result_count,
        "hasResults": row.get::<bool, _>("has_results"),
        "outcomeRecorded": row.get::<bool, _>("outcome_recorded"),
        "sourceResultCounts": admin_log_counts(&row, "source_result_counts_json"),
        "completedAt": completed_at,
        "createdAt": created_at,
    })
}

const LOG_IP: &str = "COALESCE(NULLIF(NULLIF(l.ip, 'unknown'), ''), u.last_login_ip, 'unknown')";

struct SearchLogFilters<'a> {
    keyword: &'a str,
    user_id: Option<i64>,
    session_id: Option<&'a str>,
    ip: &'a str,
    scope: &'a str,
    from: Option<i64>,
    to: Option<i64>,
}
impl<'a> SearchLogFilters<'a> {
    fn push(&self, sql: &mut sqlx::QueryBuilder<'a, sqlx::Postgres>) {
        // User metadata participates only in text/IP filters. Unfiltered counts
        // and pagination use the log indexes without joining the user table.
        if !self.keyword.is_empty() || !self.ip.is_empty() {
            sql.push(" LEFT JOIN users u ON u.id=l.user_id");
        }
        sql.push(" WHERE true");
        if !self.keyword.is_empty() {
            let pattern = format!("%{}%", self.keyword);
            sql.push(" AND (l.keyword ILIKE ")
                .push_bind(pattern.clone())
                .push(" OR u.username ILIKE ")
                .push_bind(pattern.clone())
                .push(" OR u.nickname ILIKE ")
                .push_bind(pattern.clone())
                .push(" OR ")
                .push(LOG_IP)
                .push(" ILIKE ")
                .push_bind(pattern)
                .push(")");
        }
        if let Some(user) = self.user_id {
            sql.push(" AND l.user_id=").push_bind(user);
        }
        if let Some(session) = self.session_id {
            sql.push(" AND l.session_id=").push_bind(session);
        }
        if !self.ip.is_empty() {
            sql.push(" AND ")
                .push(LOG_IP)
                .push(" ILIKE ")
                .push_bind(format!("%{}%", self.ip));
        }
        if !self.scope.is_empty() {
            sql.push(" AND l.search_scope=").push_bind(self.scope);
        }
        if let Some(from) = self.from {
            sql.push(" AND l.created_at>=to_timestamp(")
                .push_bind(from)
                .push("::double precision/1000.0)");
        }
        if let Some(to) = self.to {
            sql.push(" AND l.created_at<=to_timestamp(")
                .push_bind(to)
                .push("::double precision/1000.0)");
        }
    }
}

pub async fn admin_search_logs_get(
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
    let keyword = query
        .get("keyword")
        .or_else(|| query.get("q"))
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let user_id = query
        .get("userId")
        .and_then(|value| value.parse::<i64>().ok());
    let session_id = query
        .get("sessionId")
        .cloned()
        .filter(|value| !value.trim().is_empty());
    let ip = query
        .get("ip")
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let search_scope = query
        .get("searchScope")
        .or_else(|| query.get("scope"))
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let from = query
        .get("from")
        .or_else(|| query.get("startTime"))
        .and_then(|value| value.parse::<i64>().ok())
        .map(|value| {
            if value.unsigned_abs() < 1_000_000_000_000 {
                value * 1000
            } else {
                value
            }
        });
    let to = query
        .get("to")
        .or_else(|| query.get("endTime"))
        .and_then(|value| value.parse::<i64>().ok())
        .map(|value| {
            if value.unsigned_abs() < 1_000_000_000_000 {
                value * 1000
            } else {
                value
            }
        });
    if let (Some(from), Some(to)) = (from, to)
        && from > to
    {
        return Err(ApiError::BadRequest("invalid time range".into()));
    }
    let offset = (page - 1) * page_size;
    let cursor_filters = vec![
        keyword.clone(),
        user_id.map(|v| v.to_string()).unwrap_or_default(),
        session_id.clone().unwrap_or_default(),
        ip.clone(),
        search_scope.clone(),
        from.map(|v| v.to_string()).unwrap_or_default(),
        to.map(|v| v.to_string()).unwrap_or_default(),
    ];
    let cursor = PageCursor::parse(
        query.get("before").map(String::as_str),
        "search-logs",
        &cursor_filters,
        page_size,
    )?;
    let cursor_id = cursor
        .as_ref()
        .map(|c| {
            c.id.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("分页游标无效".into()))
        })
        .transpose()?;
    let filters = SearchLogFilters {
        keyword: &keyword,
        user_id,
        session_id: session_id.as_deref(),
        ip: &ip,
        scope: &search_scope,
        from,
        to,
    };
    let mut count = sqlx::QueryBuilder::new("SELECT count(*) FROM search_logs l");
    filters.push(&mut count);
    let total: i64 = count.build_query_scalar().fetch_one(&state.pool).await?;
    let mut rows_sql = sqlx::QueryBuilder::new(
        "WITH page AS MATERIALIZED (SELECT l.id,l.created_at FROM search_logs l",
    );
    filters.push(&mut rows_sql);
    if let Some(cursor) = &cursor {
        rows_sql
            .push(" AND (l.created_at,l.id)<(")
            .push_bind(cursor.at)
            .push(",")
            .push_bind(cursor_id.unwrap())
            .push(")");
    }
    rows_sql
        .push(" ORDER BY l.created_at DESC,l.id DESC LIMIT ")
        .push_bind(page_size + 1);
    if cursor.is_none() {
        rows_sql.push(" OFFSET ").push_bind(offset);
    }
    rows_sql.push(") SELECT l.id,l.session_id,l.user_id,u.username,u.nickname,").push(LOG_IP)
        .push(" AS ip,l.keyword,l.search_scope,l.channels_json,l.source_ids_json,l.status,l.result_count,l.has_results,l.outcome_recorded,l.source_result_counts_json,l.completed_at,l.created_at FROM page p JOIN search_logs l ON l.id=p.id LEFT JOIN users u ON u.id=l.user_id ORDER BY p.created_at DESC,p.id DESC");
    let mut rows = rows_sql.build().fetch_all(&state.pool).await?;
    let has_more = rows.len() > page_size as usize;
    rows.truncate(page_size as usize);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                PageCursor::next(
                    "search-logs",
                    cursor_filters,
                    page_size,
                    row.get("created_at"),
                    row.get::<i64, _>("id").to_string(),
                )
            })
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let logs = rows.into_iter().map(admin_log_json).collect::<Vec<_>>();
    Ok(ok(json!({
        "logs": logs,
        "items": logs,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "totalPages": (total + page_size - 1) / page_size,
        "hasMore": has_more, "nextCursor": next_cursor,
    })))
}
pub async fn admin_search_logs_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let ids = body
        .and_then(|Json(value)| value.get("ids").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
        })
        .filter(|id| *id > 0)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(ok(json!({"deleted": 0})));
    }
    let deleted = sqlx::query("DELETE FROM search_logs WHERE id = ANY($1::bigint[])")
        .bind(&ids)
        .execute(&state.pool)
        .await?
        .rows_affected();
    Ok(ok(json!({"deleted": deleted})))
}
pub async fn admin_analytics_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let row=sqlx::query("SELECT count(*)::bigint AS searches, COALESCE(sum(CASE WHEN has_results THEN 1 ELSE 0 END),0)::bigint AS with_results, COALESCE(sum(CASE WHEN has_results THEN 0 ELSE 1 END),0)::bigint AS no_results, COALESCE(sum(result_count),0)::bigint AS result_count FROM search_logs WHERE status='completed' AND outcome_recorded=true").fetch_one(&state.pool).await?;
    let sources = Vec::<Value>::new();
    let keywords = Vec::<Value>::new();
    Ok(ok(
        json!({"overview":{"searches":row.get::<i64,_>("searches"),"withResults":row.get::<i64,_>("with_results"),"noResults":row.get::<i64,_>("no_results"),"resultCount":row.get::<i64,_>("result_count")},"sources":sources,"keywords":keywords}),
    ))
}

pub async fn admin_user_search_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let rows=sqlx::query("SELECT l.id,l.session_id,l.user_id,u.username,u.nickname,COALESCE(NULLIF(NULLIF(l.ip, 'unknown'), ''), u.last_login_ip, 'unknown') AS ip,l.keyword,l.search_scope,l.channels_json,l.source_ids_json,l.status,l.result_count,l.has_results,l.outcome_recorded,l.source_result_counts_json,l.completed_at,l.created_at FROM search_logs l LEFT JOIN users u ON u.id=l.user_id WHERE l.user_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 100")
        .bind(id).fetch_all(&state.pool).await?;
    let items = rows.into_iter().map(admin_log_json).collect::<Vec<_>>();
    let total = items.len();
    Ok(Json(
        json!({"code":0,"message":"success","data":{"logs":items.clone(),"items":items,"total":total,"page":1,"pageSize":100,"totalPages":1}}),
    ))
}
