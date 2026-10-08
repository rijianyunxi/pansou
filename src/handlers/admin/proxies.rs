use crate::handlers::common::{admin_only, ok};
use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;

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
    let rows=sqlx::query("SELECT p.source_id,p.channel_id,COALESCE(s.name,c.name) name FROM outbound_policy_nodes m JOIN outbound_policies p ON p.id=m.policy_id LEFT JOIN resource_sources s ON s.id=p.source_id LEFT JOIN crawl_channels c ON c.id=p.channel_id WHERE m.node_id=$1 ORDER BY p.id").bind(id).fetch_all(&state.pool).await?;
    Ok(ok(
        json!({"items":rows.iter().map(|r|json!({"sourceId":r.get::<Option<String>,_>("source_id"),"channelId":r.get::<Option<String>,_>("channel_id"),"name":r.get::<String,_>("name")})).collect::<Vec<_>>()}),
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
