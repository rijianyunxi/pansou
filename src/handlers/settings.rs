use super::common::{admin_only, json_response, ok};
use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use std::sync::Arc;

pub async fn user_policy_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let policy = crate::policy::load(&state.pool).await?;
    Ok(ok(
        serde_json::to_value(policy).map_err(|error| ApiError::Internal(error.to_string()))?
    ))
}
pub async fn user_policy_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let policy = crate::policy::save(&state.pool, &body).await?;
    Ok(Json(json!({
        "code": 0,
        "message": "saved",
        "data": serde_json::to_value(policy)
            .map_err(|error| ApiError::Internal(error.to_string()))?,
    })))
}

fn sanitize_source_ids(body: &Value) -> Option<Vec<String>> {
    let sources = body.get("sources")?;
    if sources.is_null() {
        return None;
    }
    let values = sources.as_array()?;
    let mut ids = Vec::new();
    for value in values {
        let Some(id) = value.as_str().map(str::trim) else {
            continue;
        };
        let mut characters = id.chars();
        let valid = id.len() <= 64
            && characters.next().is_some_and(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit()
            })
            && characters.all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || character == '_'
                    || character == '-'
            });
        if valid && !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_owned());
        }
    }
    Some(ids)
}

async fn search_settings_payload(state: &AppState) -> Result<Value, ApiError> {
    let rows =
        sqlx::query("SELECT id,updated_at FROM resource_sources WHERE enabled=true ORDER BY id")
            .fetch_all(&state.pool)
            .await?;
    let sources = rows
        .iter()
        .map(|row| row.get::<String, _>("id"))
        .collect::<Vec<_>>();
    let latest_source_update = rows
        .iter()
        .map(|row| row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"))
        .max();
    let settings_update = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
        "SELECT updated_at FROM policy_settings WHERE key='search-settings-meta'",
    )
    .fetch_one(&state.pool)
    .await?;
    let revision = latest_source_update
        .map(|updated_at| updated_at.max(settings_update))
        .unwrap_or(settings_update);
    Ok(json!({
        "code": 0,
        "message": "success",
        "data": {"sources": sources},
        "version": format!("{}:{}", revision.timestamp_millis(), sources.join(",")),
    }))
}

pub async fn settings_search_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    Ok(Json(search_settings_payload(&state).await?))
}

pub async fn settings_search_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    if body.get("sources").is_some()
        && !body
            .get("sources")
            .is_some_and(|value| value.is_null() || value.is_array())
    {
        return Err(ApiError::BadRequest(
            "sources 必须是字符串数组或 null".into(),
        ));
    }
    let requested = sanitize_source_ids(&body);
    let mut transaction = state.pool.begin().await?;
    if let Some(requested) = requested {
        let catalog_ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM resource_sources WHERE kind='live' ORDER BY id",
        )
        .fetch_all(&mut *transaction)
        .await?;
        let selected = requested
            .into_iter()
            .filter(|id| catalog_ids.contains(id))
            .collect::<Vec<_>>();
        sqlx::query(
            "UPDATE resource_sources SET enabled=(id = ANY($1)),updated_at=now() WHERE kind='live'",
        )
        .bind(&selected)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query("INSERT INTO policy_settings(key,value_json,updated_at) VALUES('search-settings-meta','{}',clock_timestamp()) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at")
        .execute(&mut *transaction).await?;
    transaction.commit().await?;
    Ok(Json(search_settings_payload(&state).await?))
}

fn source_value(r: &PgRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"url":r.get::<String,_>("url"),"method":r.get::<String,_>("method"),"format":r.get::<String,_>("format"),"priority":r.get::<i32,_>("priority"),"enabled":r.get::<bool,_>("enabled"),"request":r.get::<Option<Value>,_>("request_json"),"transform":r.get::<String,_>("transform")})
}
pub async fn sources_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let rows = sqlx::query("SELECT * FROM resource_sources WHERE kind='live' ORDER BY priority,id")
        .fetch_all(&state.pool)
        .await?;
    let mut sources = vec![];
    for r in rows {
        let mut src = source_value(&r);
        src["outbound"] = json!(
            crate::outbound::read(
                &state.pool,
                crate::outbound::Owner::Source(&r.get::<String, _>("id"))
            )
            .await?
        );
        sources.push(src);
    }
    Ok(ok(json!({"sources":sources})))
}
pub async fn source_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    admin_only(&headers, &state).await?;
    let src = body.get("source").unwrap_or(&body);
    let id = src
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("source.id is required".into()))?;
    let name = src.get("name").and_then(Value::as_str).unwrap_or(id);
    let desc = src.get("description").and_then(Value::as_str).unwrap_or("");
    let url = src
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("source.url is required".into()))?;
    if crate::telegram::channel(url).is_some() {
        return Err(ApiError::BadRequest("TG 频道请在 TG 采集页维护".into()));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM resource_sources WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let method = src.get("method").and_then(Value::as_str).unwrap_or("GET");
    let format = src.get("format").and_then(Value::as_str).unwrap_or("json");
    let priority = src.get("priority").and_then(Value::as_i64).unwrap_or(0) as i32;
    let enabled = src.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let transform = src
        .get("transform")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::BadRequest(
                "source.transform is required and must be Rust native JSON DSL".into(),
            )
        })?;
    crate::transform::validate(transform)?;
    let request = src.get("request").cloned();
    sqlx::query("INSERT INTO resource_sources(id,name,description,url,method,format,priority,enabled,request_json,transform,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,url=excluded.url,method=excluded.method,format=excluded.format,priority=excluded.priority,enabled=excluded.enabled,request_json=excluded.request_json,transform=excluded.transform,updated_at=now()").bind(id).bind(name).bind(desc).bind(url).bind(method).bind(format).bind(priority).bind(enabled).bind(request).bind(transform).execute(&mut *tx).await?;
    let p = if let Some(v) = src.get("outbound") {
        serde_json::from_value::<crate::outbound::Policy>(v.clone())
            .map_err(|e| ApiError::BadRequest(format!("无效出站策略：{e}")))?
    } else {
        crate::outbound::read(&state.pool, crate::outbound::Owner::Source(id))
            .await?
            .unwrap_or_else(crate::outbound::Policy::direct)
    };
    crate::outbound::save(&mut tx, crate::outbound::Owner::Source(id), &p).await?;
    tx.commit().await?;
    *state.search_cache.lock().await = Default::default();
    Ok(json_response(
        json!({"code":0,"message":"saved","data":src}),
    ))
}
pub async fn sources_export(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    admin_only(&headers, &state).await?;
    let rows=sqlx::query("SELECT id,name,description,url,method,format,priority,enabled,request_json,transform FROM resource_sources WHERE kind='live' ORDER BY priority,id").fetch_all(&state.pool).await?;
    let mut data = vec![];
    for r in rows {
        let mut src = source_value(&r);
        src["outbound"] = json!(
            crate::outbound::read(
                &state.pool,
                crate::outbound::Owner::Source(&r.get::<String, _>("id"))
            )
            .await?
        );
        data.push(src);
    }
    let mut out = Json(data).into_response();
    out.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    Ok(out)
}
pub async fn sources_import(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let list = body
        .as_array()
        .cloned()
        .or_else(|| body.get("sources").and_then(Value::as_array).cloned())
        .ok_or_else(|| ApiError::BadRequest("sources must be an array".into()))?;
    let mut count = 0;
    for src in list {
        source_put(
            State(state.clone()),
            headers.clone(),
            Json(json!({"source":src})),
        )
        .await?;
        count += 1;
    }
    Ok(Json(
        json!({"code":0,"message":"imported","data":{"count":count}}),
    ))
}
pub async fn cloud_get(
    State(state): State<Arc<AppState>>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let provider = uri.0.path().split('/').next_back().unwrap_or("");
    let configured: bool =
        sqlx::query_scalar("SELECT credential<>'' FROM cloud_account_settings WHERE provider=$1")
            .bind(provider)
            .fetch_optional(&state.pool)
            .await?
            .unwrap_or(false);
    Ok(ok(
        json!({"provider":provider,"configured":configured,"cookieLength":0}),
    ))
}
pub async fn cloud_put(
    State(state): State<Arc<AppState>>,
    uri: OriginalUri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    super::cloud_accounts::cloud_origin(&headers)?;
    admin_only(&headers, &state).await?;
    let provider = uri.0.path().split('/').next_back().unwrap_or("");
    let kind = crate::cloud_drive::Provider::from_name(provider)?;
    let cookie = match body.get(if kind.token_auth() {
        "credential"
    } else {
        "cookie"
    }) {
        Some(Value::Null) => Some(String::new()),
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => Some(s.trim().to_owned()),
        _ => {
            return Err(ApiError::BadRequest(
                "登录凭据必须为字符串；null 表示清除，留空不修改".into(),
            ));
        }
    };
    if let Some(cookie) = cookie {
        if cookie.len() > 16384
            || (!kind.token_auth()
                && (cookie.chars().any(char::is_control)
                    || (!cookie.is_empty() && !cookie.contains('='))))
        {
            return Err(ApiError::BadRequest(
                "登录凭据格式不正确或超过长度限制".into(),
            ));
        }
        if kind.token_auth() && !cookie.is_empty() {
            crate::cloud_drive::validate_credential(kind, &cookie)?;
        }
        if provider == "baidu" && !cookie.is_empty() {
            use crate::cloud_drive::transport::cookie_value;
            if (cookie_value(&cookie, "BDUSS").is_empty()
                && cookie_value(&cookie, "BDUSS_BFESS").is_empty())
                || cookie_value(&cookie, "BAIDUID").is_empty()
            {
                return Err(ApiError::BadRequest(
                    "百度 Cookie 需要 BDUSS/BDUSS_BFESS 和 BAIDUID".into(),
                ));
            }
        }
        let epoch = crate::cloud_auth::stored(&state, kind)
            .await?
            .map(|s| s.binding_epoch)
            .unwrap_or(0);
        if cookie.is_empty() {
            crate::cloud_auth::disconnect(&state, kind, epoch).await?;
        } else {
            crate::cloud_auth::import(&state, kind, &cookie, "reauthorize", epoch).await?;
        }
    }
    cloud_get(State(state), uri, headers).await
}
pub async fn wechat_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let row = sqlx::query(
        "SELECT value_json->>'appId' AS app_id,value_json->>'qrPage' AS qr_page,value_json->>'envVersion' AS env_version,value_json->>'secret' AS secret FROM policy_settings WHERE key='wechat-mini'",
    )
    .fetch_optional(&state.pool)
    .await?;
    Ok(ok(row.map(|r| {
        let app_id=r.get::<String,_>("app_id");
        let secret=r.get::<String,_>("secret");
        let configured=!app_id.is_empty() && !secret.is_empty();
        json!({"appId":app_id,"qrPage":r.get::<String,_>("qr_page"),"envVersion":r.get::<String,_>("env_version"),"secretConfigured":!secret.is_empty(),"secretLength":secret.chars().count(),"configured":configured})
    }).unwrap_or(json!({"appId":"","qrPage":"pages/login/index","envVersion":"release","secretConfigured":false,"secretLength":0,"configured":false}))))
}
pub async fn wechat_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let app_id = body.get("appId").and_then(Value::as_str).unwrap_or("");
    let qr = body
        .get("qrPage")
        .and_then(Value::as_str)
        .unwrap_or("pages/login/index");
    let env = body
        .get("envVersion")
        .and_then(Value::as_str)
        .unwrap_or("release");
    let secret = body.get("secret").and_then(Value::as_str).unwrap_or("");
    let config = json!({"appId":app_id,"secret":secret,"qrPage":qr,"envVersion":env});
    sqlx::query("INSERT INTO policy_settings(key,value_json,updated_at) VALUES('wechat-mini',$1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value_json=CASE WHEN $2='' THEN EXCLUDED.value_json || jsonb_build_object('secret',COALESCE(policy_settings.value_json->>'secret','')) ELSE EXCLUDED.value_json END,updated_at=EXCLUDED.updated_at")
        .bind(config).bind(secret).execute(&state.pool).await?;
    wechat_get(State(state), headers).await
}

pub async fn source_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    sqlx::query("DELETE FROM resource_sources WHERE id=$1 AND kind='live'")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"code":0,"message":"deleted"})))
}

async fn set_source_enabled(
    state: Arc<AppState>,
    headers: HeaderMap,
    id: String,
    enabled: bool,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let live =
        sqlx::query_scalar::<_, bool>("SELECT kind='live' FROM resource_sources WHERE id=$1")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?
            .unwrap_or(false);
    if !live {
        return Err(ApiError::BadRequest(
            "TG来源请在采集页维护，或来源不存在".into(),
        ));
    }
    sqlx::query(
        "UPDATE resource_sources SET enabled=$1,updated_at=now() WHERE id=$2 AND kind='live'",
    )
    .bind(enabled)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({"code":0,"message":"saved"})))
}

pub async fn source_enable(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    set_source_enabled(state, headers, id, true).await
}

pub async fn source_disable(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    set_source_enabled(state, headers, id, false).await
}

#[cfg(test)]
mod tests {
    use super::sanitize_source_ids;
    use serde_json::json;

    #[test]
    fn search_settings_sources_are_sanitized_and_deduplicated() {
        assert_eq!(
            sanitize_source_ids(&json!({
                "sources": ["pansearch", " pansearch ", "xiaokupan", "BAD ID", "-bad", 1]
            })),
            Some(vec!["pansearch".to_owned(), "xiaokupan".to_owned()])
        );
    }

    #[test]
    fn null_search_sources_mean_no_explicit_selection() {
        assert_eq!(sanitize_source_ids(&json!({"sources": null})), None);
    }
}
