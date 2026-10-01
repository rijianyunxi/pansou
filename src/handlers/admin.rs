use super::common::{admin_only, ok};
use crate::{app::AppState, auth::hash_password, error::ApiError};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use std::{collections::HashMap, sync::Arc};

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
        .max(1);
    let limit = q
        .get("pageSize")
        .or_else(|| q.get("limit"))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let offset = (page - 1) * limit;
    let needle = q.get("q").cloned().unwrap_or_default();
    let cloud_type = q.get("cloudType").cloned().unwrap_or_default();
    let rows = sqlx::query("SELECT id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,enabled,check_status,check_message,checked_at,link_validity,link_validity_updated_at FROM managed_resources WHERE deleted_at IS NULL AND ($1='' OR name ILIKE '%'||$1||'%') AND ($2='' OR cloud_types_json ? $2) ORDER BY updated_at DESC LIMIT $3 OFFSET $4")
        .bind(&needle).bind(&cloud_type).bind(limit).bind(offset).fetch_all(&state.pool).await?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM managed_resources WHERE deleted_at IS NULL AND ($1='' OR name ILIKE '%'||$1||'%') AND ($2='' OR cloud_types_json ? $2)")
        .bind(&needle).bind(&cloud_type).fetch_one(&state.pool).await?;
    let resources = rows.into_iter().map(|r| json!({
        "id": r.get::<String,_>("id"), "name": r.get::<String,_>("name"),
        "description": r.get::<Option<String>,_>("description"), "datetime": r.get::<Option<String>,_>("datetime"),
        "cloud_types": r.get::<Value,_>("cloud_types_json"), "links": r.get::<Value,_>("links_json"),
        "tags": r.get::<Value,_>("tags_json"), "images": r.get::<Value,_>("images_json"),
        "enabled": r.get::<bool,_>("enabled"), "checkStatus": r.get::<String,_>("check_status"),
        "linkValidity":r.get::<i16,_>("link_validity"), "linkValidityUpdatedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("link_validity_updated_at"),
        "checkMessage": r.get::<Option<String>,_>("check_message"), "checkedAt": r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("checked_at")
    })).collect::<Vec<_>>();
    let cloud_types: Vec<String> = sqlx::query_scalar("SELECT DISTINCT jsonb_array_elements_text(cloud_types_json) FROM managed_resources WHERE deleted_at IS NULL ORDER BY 1")
        .fetch_all(&state.pool).await.unwrap_or_default();
    Ok(ok(
        json!({"items":resources,"resources":resources,"cloudTypes":cloud_types,"page":page,"pageSize":limit,"limit":limit,"total":total}),
    ))
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
    let links = body.get("links").cloned().unwrap_or_else(|| json!([]));
    let cloud_types = body
        .get("cloud_types")
        .cloned()
        .or_else(|| {
            links.as_array().map(|items| {
                json!(
                    items
                        .iter()
                        .filter_map(|x| x.get("type").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                )
            })
        })
        .unwrap_or_else(|| json!([]));
    let description = body.get("description").and_then(Value::as_str);
    let tags = body.get("tags").cloned().unwrap_or_else(|| json!([]));
    let images = body.get("images").cloned().unwrap_or_else(|| json!([]));
    let datetime = body.get("datetime").and_then(Value::as_str);
    sqlx::query("INSERT INTO managed_resources(id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,enabled,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,now()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,datetime=excluded.datetime,cloud_types_json=excluded.cloud_types_json,links_json=excluded.links_json,tags_json=excluded.tags_json,images_json=excluded.images_json,search_text=excluded.search_text,manual_override=true,updated_at=now()")
        .bind(&id).bind(&name).bind(description).bind(datetime).bind(&cloud_types).bind(&links).bind(&tags).bind(&images).bind(name.to_owned()).execute(&state.pool).await?;
    let resource = json!({"id":id,"name":name,"description":description,"datetime":datetime,"cloud_types":cloud_types,"links":links,"tags":tags,"images":images,"enabled":true,"checkStatus":"unchecked"});
    Ok(ok(json!({"resource":resource})))
}

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
    let r=sqlx::query("INSERT INTO hot_searches(term,normalized_term,score,last_searched,status,source,pinned,manual_weight,updated_at) VALUES($1,$2,$3,now(),$4,$5,$6,$7,now()) ON CONFLICT(term) DO UPDATE SET score=excluded.score,status=excluded.status,source=excluded.source,pinned=excluded.pinned,manual_weight=excluded.manual_weight,updated_at=now() RETURNING term,score,pinned,status,source,manual_weight,last_searched,updated_at").bind(&term).bind(term.to_lowercase()).bind(score).bind(status).bind(source).bind(pinned).bind(manual_weight).fetch_one(&state.pool).await?;
    let item = json!({"term":r.get::<String,_>("term"),"score":r.get::<i64,_>("score"),"pinned":r.get::<bool,_>("pinned"),"status":r.get::<String,_>("status"),"source":r.get::<String,_>("source"),"manualWeight":r.get::<i32,_>("manual_weight"),"lastSearched":r.get::<chrono::DateTime<chrono::Utc>,_>("last_searched"),"updatedAt":r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at")});
    Ok(ok(json!({"item":item})))
}

pub async fn admin_proxies_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let rows=sqlx::query("SELECT n.*, (SELECT count(*) FROM outbound_policy_nodes m WHERE m.node_id=n.id) reference_count FROM proxy_nodes n ORDER BY (n.kind='direct') DESC,n.name,n.id").fetch_all(&state.pool).await?;
    Ok(ok(
        json!({"nodes":rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"kind":r.get::<String,_>("kind"),"name":r.get::<String,_>("name"),"baseUrl":r.get::<String,_>("base_url"),"enabled":r.get::<bool,_>("enabled"),"dailyLimit":r.get::<i32,_>("daily_limit"),"quotaUsed":if r.get::<Option<chrono::NaiveDate>,_>("quota_day")==Some(chrono::Utc::now().date_naive()){r.get::<i32,_>("quota_used")}else{0},"circuitState":r.get::<String,_>("circuit_state"),"lastStatus":r.get::<Option<i32>,_>("last_status"),"lastError":r.get::<Option<String>,_>("last_error"),"referenceCount":r.get::<i64,_>("reference_count")})).collect::<Vec<_>>()}),
    ))
}
pub async fn admin_proxy_references(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let rows=sqlx::query("SELECT p.source_id,p.channel_id,p.default_key,COALESCE(s.name,c.name,'TG 默认策略') name FROM outbound_policy_nodes m JOIN outbound_policies p ON p.id=m.policy_id LEFT JOIN resource_sources s ON s.id=p.source_id LEFT JOIN crawl_channels c ON c.id=p.channel_id WHERE m.node_id=$1 ORDER BY p.id").bind(id).fetch_all(&state.pool).await?;
    Ok(ok(
        json!({"items":rows.iter().map(|r|json!({"sourceId":r.get::<Option<String>,_>("source_id"),"channelId":r.get::<Option<String>,_>("channel_id"),"name":r.get::<String,_>("name"),"default":r.get::<Option<String>,_>("default_key").is_some()})).collect::<Vec<_>>()}),
    ))
}
pub async fn admin_proxies_post(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    if body.get("id").and_then(Value::as_str) == Some(crate::outbound::DIRECT) {
        return Err(ApiError::BadRequest("直连是内置节点，不能修改".into()));
    }

    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let base = body
        .get("baseUrl")
        .or_else(|| body.get("base_url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() || base.is_empty() {
        return Err(ApiError::BadRequest(
            "proxy name and baseUrl are required".into(),
        ));
    }
    let parsed = url::Url::parse(base)
        .map_err(|_| ApiError::BadRequest("节点地址必须是完整 HTTP(S) URL".into()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ApiError::BadRequest(
            "节点地址仅支持无凭据、查询参数或片段的 HTTP(S) 地址".into(),
        ));
    }
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let slug: String = name
                .to_lowercase()
                .chars()
                .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
                .collect::<String>()
                .split('-')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            let prefix = if slug.is_empty() { "proxy" } else { &slug };
            format!(
                "{prefix}-{}",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            )
        });
    let daily_limit = body
        .get("dailyLimit")
        .or_else(|| body.get("daily_limit"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, i32::MAX as i64) as i32;
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    sqlx::query("INSERT INTO proxy_nodes(id,name,base_url,enabled,daily_limit,updated_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,enabled=excluded.enabled,daily_limit=excluded.daily_limit,updated_at=now()")
        .bind(&id).bind(name).bind(base).bind(enabled).bind(daily_limit).execute(&state.pool).await?;
    let node = json!({"id":id,"name":name,"baseUrl":base,"enabled":enabled,"dailyLimit":daily_limit,"quotaUsed":0,"circuitState":"closed","lastStatus":null,"lastError":null});
    Ok(ok(json!({"node":node})))
}
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
            if value.abs() < 1_000_000_000_000 {
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
            if value.abs() < 1_000_000_000_000 {
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
    let ip_expression = "COALESCE(NULLIF(NULLIF(l.ip, 'unknown'), ''), u.last_login_ip, 'unknown')";
    let filters = format!(
        "WHERE ($1::text = '' OR l.keyword ILIKE '%' || $1::text || '%' OR COALESCE(u.username, '') ILIKE '%' || $1::text || '%' OR COALESCE(u.nickname, '') ILIKE '%' || $1::text || '%' OR {ip_expression} ILIKE '%' || $1::text || '%')\n          AND ($2::bigint IS NULL OR l.user_id = $2::bigint)\n          AND ($3::text IS NULL OR l.session_id = $3::text)\n          AND ($4::text = '' OR {ip_expression} ILIKE '%' || $4::text || '%')\n          AND ($5::text = '' OR l.search_scope = $5::text)\n          AND ($6::bigint IS NULL OR l.created_at >= to_timestamp($6::double precision / 1000.0))\n          AND ($7::bigint IS NULL OR l.created_at <= to_timestamp($7::double precision / 1000.0))"
    );
    let from_sql = format!(" FROM search_logs l LEFT JOIN users u ON u.id = l.user_id {filters}");
    let total_sql = format!("SELECT COUNT(*)::bigint AS total{from_sql}");
    let total_row = sqlx::query(&total_sql)
        .bind(&keyword)
        .bind(user_id)
        .bind(session_id.as_deref())
        .bind(&ip)
        .bind(&search_scope)
        .bind(from)
        .bind(to)
        .fetch_one(&state.pool)
        .await?;
    let total = total_row.get::<i64, _>("total").max(0);

    let rows_sql = format!(
        "SELECT l.id,l.session_id,l.user_id,u.username,u.nickname,{ip_expression} AS ip,
                l.keyword,l.search_scope,l.channels_json,l.source_ids_json,l.status,l.result_count,
                l.has_results,l.outcome_recorded,l.source_result_counts_json,l.completed_at,l.created_at
         {from_sql}
         ORDER BY l.created_at DESC,l.id DESC
         LIMIT $8 OFFSET $9"
    );
    let rows = sqlx::query(&rows_sql)
        .bind(&keyword)
        .bind(user_id)
        .bind(session_id.as_deref())
        .bind(&ip)
        .bind(&search_scope)
        .bind(from)
        .bind(to)
        .bind(page_size)
        .bind(offset)
        .fetch_all(&state.pool)
        .await?;
    let logs = rows.into_iter().map(admin_log_json).collect::<Vec<_>>();
    Ok(ok(json!({
        "logs": logs,
        "items": logs,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "totalPages": (total + page_size - 1) / page_size,
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
pub async fn admin_users_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let rows=sqlx::query("SELECT id,username,nickname,role,status,created_at,last_login_at FROM users WHERE deleted_at IS NULL ORDER BY id DESC").fetch_all(&state.pool).await?;
    Ok(ok(
        json!({"items":rows.into_iter().map(|r|json!({"id":r.get::<i64,_>("id"),"username":r.get::<String,_>("username"),"nickname":r.get::<Option<String>,_>("nickname"),"role":r.get::<String,_>("role"),"status":r.get::<String,_>("status"),"createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),"lastLoginAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("last_login_at")})).collect::<Vec<_>>()}),
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

fn string_list(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
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
        sqlx::query("UPDATE managed_resources SET enabled=$1,manual_override=true,updated_at=now() WHERE id = ANY($2)")
            .bind(enabled)
            .bind(&ids)
            .execute(&state.pool)
            .await?
            .rows_affected();
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
    let count = sqlx::query("WITH hidden AS (UPDATE managed_resources SET enabled=false,manual_override=true,deleted_at=now(),updated_at=now() WHERE id=ANY($1) AND origin='telegram' RETURNING id), removed AS (DELETE FROM managed_resources WHERE id=ANY($1) AND origin<>'telegram' RETURNING id) SELECT id FROM hidden UNION ALL SELECT id FROM removed")
        .bind(&ids)
        .execute(&state.pool)
        .await?
        .rows_affected();
    Ok(Json(
        json!({"code":0,"message":"deleted","data":{"count":count}}),
    ))
}

pub async fn admin_resources_check(
    state: State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    super::cloud_drive::resources_check(state, headers, payload).await
}
pub async fn admin_resources_cloud_delete(
    state: State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Json<Value>,
) -> Result<axum::response::Response, ApiError> {
    super::cloud_drive::cloud_delete(state, headers, payload).await
}

pub async fn admin_resource_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let row = sqlx::query("SELECT id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,enabled,check_status FROM managed_resources WHERE id=$1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let resource = row.map(|row| json!({
        "id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),
        "description":row.get::<Option<String>,_>("description"),"datetime":row.get::<Option<String>,_>("datetime"),
        "cloud_types":row.get::<Value,_>("cloud_types_json"),"links":row.get::<Value,_>("links_json"),
        "tags":row.get::<Value,_>("tags_json"),"images":row.get::<Value,_>("images_json"),
        "enabled":row.get::<bool,_>("enabled"),"checkStatus":row.get::<String,_>("check_status")
    }));
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
    sqlx::query("WITH hidden AS (UPDATE managed_resources SET enabled=false,manual_override=true,deleted_at=now(),updated_at=now() WHERE id=$1 AND origin='telegram') DELETE FROM managed_resources WHERE id=$1 AND origin<>'telegram'")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"code":0,"message":"deleted"})))
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

pub async fn admin_proxy_update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(mut payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if let Some(object) = payload.as_object_mut() {
        object.insert("id".into(), Value::String(id));
    }
    admin_proxies_post(State(state), headers, Json(payload)).await
}

pub async fn admin_proxy_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    if id == crate::outbound::DIRECT {
        return Err(ApiError::BadRequest(
            "直连是内置节点，不能删除或重置".into(),
        ));
    }
    match sqlx::query("DELETE FROM proxy_nodes WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await
    {
        Ok(r) if r.rows_affected() == 0 => return Err(ApiError::NotFound("节点不存在".into())),
        Err(sqlx::Error::Database(e)) if matches!(e.code().as_deref(), Some("23503" | "23001")) => {
            return Err(ApiError::Conflict(
                "节点仍被来源、频道或默认策略引用，请先解除绑定".into(),
            ));
        }
        Err(e) => return Err(e.into()),
        _ => {}
    }
    Ok(Json(json!({"code":0,"message":"deleted"})))
}

pub async fn admin_proxy_reset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    if id == crate::outbound::DIRECT {
        return Err(ApiError::BadRequest(
            "直连是内置节点，不能删除或重置".into(),
        ));
    }
    let row = sqlx::query("UPDATE proxy_nodes SET circuit_state='closed',failure_count=0,probe_in_flight=false,opened_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 RETURNING id,name,base_url,enabled,daily_limit,quota_used,circuit_state,last_status,last_error")
        .bind(id).fetch_optional(&state.pool).await?.ok_or_else(|| ApiError::NotFound("代理节点不存在".into()))?;
    let node = json!({"id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),"baseUrl":row.get::<String,_>("base_url"),"enabled":row.get::<bool,_>("enabled"),"dailyLimit":row.get::<i32,_>("daily_limit"),"quotaUsed":row.get::<i32,_>("quota_used"),"circuitState":row.get::<String,_>("circuit_state"),"lastStatus":row.get::<Option<i32>,_>("last_status"),"lastError":row.get::<Option<String>,_>("last_error")});
    Ok(Json(
        json!({"code":0,"message":"reset","data":{"node":node}}),
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
