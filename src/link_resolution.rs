//! Public link capabilities. Search snapshots are private, session-bound and short lived.
mod delivery;
mod worker;
pub use delivery::{get_policy, put_policy};
pub use worker::run as worker;

use crate::{
    app::AppState,
    auth::Session,
    error::ApiError,
    models::{Link, SearchRequest, SearchResult},
    resource_clean,
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc, time::Duration};
use uuid::Uuid;

const REF_SECONDS: u64 = 1800;
async fn admin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let session = state.auth().session(headers).await?;
    let id = session
        .user_id
        .ok_or_else(|| ApiError::Forbidden("需要管理员权限".into()))?;
    if state.auth().public_user(id).await?.role != "admin" {
        return Err(ApiError::Forbidden("需要管理员权限".into()));
    }
    Ok(())
}
type HmacSha256 = Hmac<Sha256>;
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn keyed(key: &str, value: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC key");
    mac.update(value.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn subject(session: &Session) -> String {
    keyed(&session.token, "pansou:link-subject:v2")
}
pub(super) fn fingerprint(link: &Link) -> String {
    hash(
        &json!([
            "v1",
            link.r#type,
            resource_clean::link_identity(&link.url),
            link.password
        ])
        .to_string(),
    )
}
#[derive(Clone, Serialize, Deserialize)]
struct Snapshot {
    subject: String,
    request: SearchRequest,
    source: Option<String>,
    source_revision: Option<DateTime<Utc>>,
    resource_id: String,
    links: HashMap<String, Link>,
    expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub(super) struct Fact {
    id: Uuid,
    validity: i16,
    checked_at: Option<DateTime<Utc>>,
    valid_until: Option<DateTime<Utc>>,
    last_attempt_at: Option<DateTime<Utc>>,
    last_error_code: Option<String>,
}
impl Fact {
    fn stale(&self) -> bool {
        self.checked_at.is_some() && self.valid_until.is_none_or(|t| t <= Utc::now())
    }
    fn current(&self) -> i16 {
        if self.stale() { -1 } else { self.validity }
    }
    fn public(&self) -> Value {
        json!({"validity":self.current(),"checkedAt":self.checked_at,"lastAttemptAt":self.last_attempt_at,"stale":self.stale(),"reasonCode":self.last_error_code})
    }
}
fn aggregate(values: impl IntoIterator<Item = i16>) -> i16 {
    let values: Vec<_> = values.into_iter().collect();
    if values.contains(&1) {
        1
    } else if !values.is_empty() && values.iter().all(|v| *v == 0) {
        0
    } else {
        -1
    }
}
pub(crate) async fn record_check(
    state: &AppState,
    link: &Link,
    value: &Value,
) -> Result<(), ApiError> {
    let id = register(state, link).await?;
    let policy: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='link-check'")
            .fetch_one(&state.pool)
            .await?;
    worker::record(state, id, value, &policy).await
}
const FACT_COLUMNS: &str = "id,validity,checked_at,valid_until,last_attempt_at,last_error_code";
async fn fact(state: &AppState, id: Uuid) -> Result<Fact, ApiError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {FACT_COLUMNS} FROM link_catalog WHERE id=$1"
    ))
    .bind(id)
    .fetch_one(&state.pool)
    .await?)
}
pub(super) async fn register(state: &AppState, link: &Link) -> Result<Uuid, ApiError> {
    Ok(sqlx::query_scalar("INSERT INTO link_catalog(id,provider,identity,original_url,original_password,input_fingerprint,next_check_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(input_fingerprint) DO UPDATE SET last_seen_at=now() RETURNING id")
        .bind(Uuid::new_v4()).bind(&link.r#type).bind(resource_clean::link_identity(&link.url)).bind(&link.url).bind(&link.password).bind(fingerprint(link)).fetch_one(&state.pool).await?)
}
fn clean(value: &str, links: &[Link]) -> String {
    let mut value = resource_clean::clean_field(value);
    for link in links {
        value = value.replace(&link.url, "");
        if let Some(password) = &link.password {
            if !password.is_empty() {
                value = value.replace(password, "");
            }
        }
    }
    // Also remove scheme-less, encoded and HTML-decoded share-address tokens.
    value
        .split_whitespace()
        .filter(|token| {
            !token.contains("/s/")
                && !token.contains("%2F")
                && !token.contains("%2f")
                && !token.contains("pan.")
        })
        .collect::<Vec<_>>()
        .join(" ")
}
pub(crate) async fn project(
    state: &AppState,
    session: &Session,
    req: &SearchRequest,
    source: Option<&str>,
    results: &[SearchResult],
) -> Result<Vec<Value>, ApiError> {
    let custom = req.channels.is_some();
    let source_revision = if let Some(id) = source.filter(|_| !custom) {
        sqlx::query_scalar("SELECT updated_at FROM resource_sources WHERE id=$1 AND enabled")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
    } else {
        None
    };
    let fingerprints: Vec<_> = results
        .iter()
        .flat_map(|r| r.links.iter().map(fingerprint))
        .collect();
    let rows = if custom {
        vec![]
    } else {
        sqlx::query(&format!(
        "SELECT input_fingerprint,{FACT_COLUMNS} FROM link_catalog WHERE input_fingerprint=ANY($1)"
    ))
    .bind(&fingerprints)
    .fetch_all(&state.pool)
    .await?
    };
    let facts: HashMap<String, Fact> = rows
        .iter()
        .map(|r| Ok((r.try_get("input_fingerprint")?, sqlx::FromRow::from_row(r)?)))
        .collect::<Result<_, sqlx::Error>>()?;
    let mut pipe = redis::pipe();
    let expires_at = Utc::now() + chrono::Duration::seconds(REF_SECONDS as i64);
    let mut projected = vec![];
    for result in results {
        let result_ref = if custom {
            format!("custom:{}", Uuid::new_v4())
        } else {
            Uuid::new_v4().to_string()
        };
        let mut private = HashMap::new();
        let mut keys = vec![];
        let links: Vec<_> = result.links.iter().map(|link| {
            let link_ref = Uuid::new_v4().to_string();
            private.insert(link_ref.clone(), link.clone());
            let key = keyed(&session.token, &resource_clean::link_identity(&link.url)); keys.push(key.clone());
            let fact = facts.get(&fingerprint(link));
            json!({"linkRef":link_ref,"linkKey":key,"type":clean(&link.r#type,&result.links),"validity":fact.map_or(-1,Fact::current),"checkedAt":fact.and_then(|f| f.checked_at),"stale":fact.is_some_and(Fact::stale)})
        }).collect();
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            keys.push(format!("empty:{}:{}", source.unwrap_or("local"), result.id));
        }
        let snapshot = Snapshot {
            subject: subject(session),
            request: req.clone(),
            source: source.map(str::to_owned),
            source_revision,
            resource_id: result.id.clone(),
            links: private,
            expires_at,
        };
        if custom {
            let mut refs = state.custom_link_refs.lock().await;
            refs.retain(|_, (expiry, _)| *expiry > Utc::now());
            let payload = serde_json::to_string(&snapshot)
                .map_err(|_| ApiError::Internal("引用编码失败".into()))?;
            if refs.len() >= 10000
                || refs.values().map(|(_, value)| value.len()).sum::<usize>() + payload.len()
                    > 64 * 1024 * 1024
            {
                return Err(ApiError::Unavailable("实时链接引用繁忙，请稍后搜索".into()));
            }
            refs.insert(result_ref.clone(), (expires_at, payload));
        } else {
            pipe.cmd("SETEX")
                .arg(format!("pansou:link-ref:v2:{result_ref}"))
                .arg(REF_SECONDS)
                .arg(
                    serde_json::to_string(&snapshot)
                        .map_err(|_| ApiError::Internal("引用编码失败".into()))?,
                )
                .ignore();
        }
        projected.push(json!({"id":keyed(&session.token,&format!("{}:{}",source.unwrap_or("local"),result.id)),"resultRef":result_ref,"dedupKey":keyed(&session.token,&keys.join(":")),"name":clean(&result.name,&result.links),"description":result.description.as_ref().map(|v|clean(v,&result.links)),"datetime":result.datetime.as_ref().map(|v|clean(v,&result.links)),"cloud_types":links.iter().map(|l|l["type"].clone()).collect::<Vec<_>>(),"validity":aggregate(links.iter().map(|l| l["validity"].as_i64().unwrap_or(-1) as i16)),"links":links,"images":[],"refsExpireAt":expires_at}));
    }
    if !results.is_empty() && !custom {
        let _: () = pipe
            .query_async(&mut state.redis.connection()?)
            .await
            .map_err(|_| ApiError::Unavailable("链接引用暂不可用".into()))?;
    }
    Ok(projected)
}

async fn authorize(
    state: &AppState,
    session: &Session,
    snapshot: &Snapshot,
) -> Result<(), ApiError> {
    if snapshot.subject != subject(session) {
        return Err(ApiError::Forbidden("引用不属于当前会话".into()));
    }
    if snapshot.expires_at <= Utc::now() {
        return Err(ApiError::Gone("引用已过期，请重新搜索".into()));
    }
    let mut request = snapshot.request.clone();
    let policy = crate::policy::load(&state.pool).await?;
    crate::handlers::search::resolve_custom_channels(state, session, &mut request, &policy).await?;
    if request.channels.is_some() {
        let source = snapshot
            .source
            .as_deref()
            .and_then(|s| s.strip_prefix("custom:"));
        if !source.is_some_and(|s| request.channels.as_ref().unwrap().iter().any(|c| c == s)) {
            return Err(ApiError::Forbidden("频道引用范围不符".into()));
        }
        return Ok(());
    }
    let sources = crate::handlers::search::load_sources(
        state,
        request.source_ids.as_ref(),
        request.channels.as_ref(),
    )
    .await?;
    if let Some(source) = &snapshot.source {
        if !sources.live_sources.iter().any(|s| &s.id == source) {
            return Err(ApiError::Forbidden("来源已停用或不可访问".into()));
        }
        let revision: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT updated_at FROM resource_sources WHERE id=$1 AND enabled")
                .bind(source)
                .fetch_optional(&state.pool)
                .await?;
        if revision != snapshot.source_revision {
            return Err(ApiError::Conflict(
                "LINK_CHANGED：来源配置已改变，请重新搜索".into(),
            ));
        }
    } else {
        let rows=sqlx::query("SELECT r.enabled,r.deleted_at,r.manual_override,r.links_json,o.result_json FROM managed_resources r LEFT JOIN resource_occurrences o ON o.resource_id=r.id AND o.channel_id=ANY($2) LEFT JOIN source_messages m ON m.channel_id=o.channel_id AND m.message_id=o.message_id WHERE r.id=$1 AND (r.origin<>'telegram' OR m.parse_status='parsed')")
            .bind(&snapshot.resource_id).bind(&sources.local_channels).fetch_all(&state.pool).await?;
        if rows.is_empty() {
            return Err(ApiError::NotFound("资源不存在或频道权限已改变".into()));
        }
        let allowed = rows.iter().any(|r| {
            if !r.get::<bool, _>("enabled")
                || r.get::<Option<DateTime<Utc>>, _>("deleted_at").is_some()
            {
                return false;
            }
            let value = if r.get::<bool, _>("manual_override") {
                r.get::<Value, _>("links_json")
            } else {
                r.get::<Option<Value>, _>("result_json")
                    .map(|v| v["links"].clone())
                    .unwrap_or_else(|| r.get("links_json"))
            };
            let current = serde_json::from_value::<Vec<Link>>(value).unwrap_or_default();
            let mut expected: Vec<_> = snapshot.links.values().map(fingerprint).collect();
            expected.sort();
            expected.dedup();
            let mut actual: Vec<_> = current.iter().map(fingerprint).collect();
            actual.sort();
            actual.dedup();
            expected == actual
        });
        if !allowed {
            return Err(ApiError::Conflict(
                "LINK_CHANGED：资源已下架或链接已变化，请重新搜索".into(),
            ));
        }
    }
    Ok(())
}
async fn snapshot(
    state: &AppState,
    session: &Session,
    result_ref: &str,
) -> Result<Snapshot, ApiError> {
    if let Some(id) = result_ref.strip_prefix("custom:") {
        Uuid::parse_str(id).map_err(|_| ApiError::BadRequest("resultRef 格式无效".into()))?;
        let value = state
            .custom_link_refs
            .lock()
            .await
            .get(result_ref)
            .map(|(_, value)| value.clone())
            .ok_or_else(|| ApiError::Gone("实时引用已过期或服务已重启，请重新搜索".into()))?;
        let snapshot: Snapshot =
            serde_json::from_str(&value).map_err(|_| ApiError::Unavailable("引用不可用".into()))?;
        authorize(state, session, &snapshot).await?;
        return Ok(snapshot);
    }
    Uuid::parse_str(result_ref).map_err(|_| ApiError::BadRequest("resultRef 格式无效".into()))?;
    let value: Option<String> = state
        .redis
        .connection()?
        .get(format!("pansou:link-ref:v2:{result_ref}"))
        .await
        .map_err(|_| ApiError::Unavailable("链接引用暂不可用".into()))?;
    let snapshot: Snapshot = serde_json::from_str(
        &value.ok_or_else(|| ApiError::Gone("引用已过期，请重新搜索".into()))?,
    )
    .map_err(|_| ApiError::Unavailable("链接引用不可用".into()))?;
    authorize(state, session, &snapshot).await?;
    Ok(snapshot)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkRef {
    result_ref: String,
    link_ref: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveInput {
    result_ref: String,
    link_ref: String,
    request_key: Uuid,
}
fn response(status: StatusCode, data: Value) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"code":0,"message":"success","data":data})),
    )
        .into_response()
}
fn fallback(key: Uuid, link: &Link, fact: &Fact, reason: &str) -> Value {
    let invalid = fact.current() == 0;
    let invalid_reason = if fact.last_error_code.as_deref() == Some("resource_missing") {
        "resource_missing"
    } else {
        "original_invalid"
    };
    let mut value = json!({"requestKey":key,"status":if invalid{"unavailable"}else{"completed"},"type":link.r#type,"delivery":if invalid{Value::Null}else{json!("original")},"originalValidity":fact.current(),"validity":fact.current(),"checkedAt":fact.checked_at,"stale":fact.stale(),"reasonCode":if invalid{invalid_reason}else{reason},"deliveryExpiresAt":null,"shareExpiresAt":null,"cacheHit":false});
    if !invalid {
        value["url"] = json!(link.url);
        value["password"] = json!(link.password);
    }
    value
}
pub async fn resolve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<ResolveInput>,
) -> Result<Response, ApiError> {
    let session = state.auth().session(&headers).await?;
    let snap = snapshot(&state, &session, &input.result_ref).await?;
    let link = snap
        .links
        .get(&input.link_ref)
        .cloned()
        .ok_or_else(|| ApiError::NotFound("链接引用不存在".into()))?;
    if !(link.url.starts_with("https://")
        || link.url.starts_with("http://")
        || link.url.starts_with("magnet:?"))
    {
        return Err(ApiError::BadRequest("链接协议不支持".into()));
    }
    let fp = hash(&json!([input.result_ref, input.link_ref, fingerprint(&link)]).to_string());
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2)").bind(subject(&session)).bind(input.request_key).fetch_one(&state.pool).await?;
    if !exists {
        let mut redis = state.redis.connection()?;
        let n:i64=redis::Script::new("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n").key(format!("pansou:resolve-limit:{}",subject(&session))).invoke_async(&mut redis).await.map_err(|_|ApiError::Unavailable("取链限流暂不可用".into()))?;
        if n > 30 {
            return Err(ApiError::TooManyRequests("获取过于频繁，请稍后重试".into()));
        }
        let running:i64=sqlx::query_scalar("SELECT count(*) FROM link_resolve_requests WHERE subject_key=$1 AND status IN('queued','running') AND deadline_at>now()").bind(subject(&session)).fetch_one(&state.pool).await?;
        if running >= 4 {
            return Err(ApiError::TooManyRequests(
                "已有多个链接正在获取，请稍候".into(),
            ));
        }
    }
    let id = register(&state, &link).await?;
    sqlx::query("UPDATE link_check_jobs SET priority=10 WHERE link_id=$1 AND status='queued'")
        .bind(id)
        .execute(&state.pool)
        .await?;
    let inserted=sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,user_id,request_fingerprint,link_id,authorization_json,status,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',now()+interval '60 seconds') ON CONFLICT(subject_key,request_key) DO NOTHING")
        .bind(Uuid::new_v4()).bind(input.request_key).bind(subject(&session)).bind(session.user_id).bind(&fp).bind(id).bind(json!({"snapshot":snap,"linkRef":input.link_ref})).execute(&state.pool).await?.rows_affected();
    if inserted == 0 {
        let old:String=sqlx::query_scalar("SELECT request_fingerprint FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2").bind(subject(&session)).bind(input.request_key).fetch_one(&state.pool).await?;
        if old != fp {
            return Err(ApiError::Conflict("requestKey 已用于其他参数".into()));
        }
    } else {
        let state = state.clone();
        let session = session.clone();
        tokio::spawn(async move {
            if let Err(e) = run_resolution(&state, &session, input.request_key, id, &link).await {
                tracing::error!(error=%e,"link resolution failed; deadline recovery will finalize");
            }
        });
    }
    let end = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let out = operation(&state, &session, input.request_key).await?;
        if out.0 != StatusCode::ACCEPTED || tokio::time::Instant::now() >= end {
            return Ok(response(out.0, out.1));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
async fn run_resolution(
    state: &AppState,
    session: &Session,
    key: Uuid,
    id: Uuid,
    link: &Link,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE link_resolve_requests SET status='running',updated_at=now() WHERE subject_key=$1 AND request_key=$2 AND status='queued'").bind(subject(session)).bind(key).execute(&state.pool).await?;
    let current = fact(state, id).await?;
    // Delivery owns the decision: check our exact owned-share mapping before the source.
    let result = if matches!(link.r#type.as_str(), "baidu" | "quark") {
        match delivery::deliver(state, session, key, id, link, &current).await {
            Ok(result) => result,
            Err(error) => {
                tracing::warn!(error=%error,"delivery unavailable; returning safe fallback");
                fallback(key, link, &fact(state, id).await?, "delivery_failed")
            }
        }
    } else {
        fallback(
            key,
            link,
            &current,
            if matches!(link.r#type.as_str(), "baidu" | "quark") {
                current.last_error_code.as_deref().unwrap_or("check_failed")
            } else {
                "unsupported_provider"
            },
        )
    };
    sqlx::query("UPDATE link_resolve_requests SET status='completed',response_json=$3,delivery=$4,reason_code=$5,result_kind=$6,completed_at=now(),updated_at=now() WHERE subject_key=$1 AND request_key=$2 AND status IN('queued','running')")
        .bind(subject(session)).bind(key).bind(&result).bind(result["delivery"].as_str()).bind(result["reasonCode"].as_str()).bind(if result["status"]=="unavailable"{"unavailable"}else{"available"}).execute(&state.pool).await?;
    Ok(())
}
async fn authorize_write(state: &AppState, session: &Session, key: Uuid) -> Result<(), ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", session.token)
            .parse()
            .map_err(|_| ApiError::Unauthorized("会话无效".into()))?,
    );
    state.auth().session(&headers).await?;
    let row=sqlx::query("SELECT authorization_json,deadline_at FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2 AND status IN('queued','running')").bind(subject(session)).bind(key).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::Conflict("操作已结束".into()))?;
    if row.get::<DateTime<Utc>, _>("deadline_at") <= Utc::now() {
        return Err(ApiError::Conflict("操作已超时".into()));
    }
    let auth: Value = row.get("authorization_json");
    let snap: Snapshot = serde_json::from_value(auth["snapshot"].clone())
        .map_err(|_| ApiError::Unavailable("操作授权不可用".into()))?;
    authorize(state, session, &snap).await
}
async fn operation(
    state: &AppState,
    session: &Session,
    key: Uuid,
) -> Result<(StatusCode, Value), ApiError> {
    let row =
        sqlx::query("SELECT * FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2")
            .bind(subject(session))
            .bind(key)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::NotFound("操作不存在".into()))?;
    let auth: Value = row.get("authorization_json");
    let snap: Snapshot = serde_json::from_value(auth["snapshot"].clone())
        .map_err(|_| ApiError::Unavailable("操作授权不可用".into()))?;
    authorize(state, session, &snap).await?;
    if row.get::<DateTime<Utc>, _>("expires_at") <= Utc::now() {
        return Err(ApiError::Gone("操作已过期".into()));
    }
    let link = snap
        .links
        .get(auth["linkRef"].as_str().unwrap_or(""))
        .ok_or_else(|| ApiError::NotFound("链接不存在".into()))?;
    let mut result: Option<Value> = row.get("response_json");
    if result.is_none() && row.get::<DateTime<Utc>, _>("deadline_at") <= Utc::now() {
        let value = fallback(
            key,
            link,
            &fact(state, row.get("link_id")).await?,
            "deadline_exceeded",
        );
        sqlx::query("UPDATE link_resolve_requests SET status='completed',response_json=$3,completed_at=now() WHERE subject_key=$1 AND request_key=$2 AND response_json IS NULL").bind(subject(session)).bind(key).bind(&value).execute(&state.pool).await?;
        result = Some(value);
    }
    if let Some(mut value) = result {
        let current = fact(state, row.get("link_id")).await?;
        if current.current() == 0 && value["delivery"] != "reshared" {
            value = fallback(key, link, &current, "original_invalid");
        }
        if value["delivery"] == "reshared" {
            let share=sqlx::query("SELECT s.target_account_key,c.provider,a.credential FROM link_share_cache s JOIN link_catalog c ON c.id=s.link_id JOIN cloud_account_settings a ON a.provider=c.provider WHERE s.id=$1 AND s.state='ready' AND s.share_validity=1 AND s.cleanup_after>now()+make_interval(secs=>COALESCE((s.ownership_manifest_json->>'minRemainingSeconds')::double precision,5)) AND (s.share_expires_at IS NULL OR s.share_expires_at>now()+make_interval(secs=>COALESCE((s.ownership_manifest_json->>'minRemainingSeconds')::double precision,5)))").bind(row.get::<Option<Uuid>,_>("share_cache_id")).fetch_optional(&state.pool).await?;
            let ready = share.is_some_and(|r| {
                let provider = if r.get::<String, _>("provider") == "baidu" {
                    crate::cloud_drive::Provider::Baidu
                } else {
                    crate::cloud_drive::Provider::Quark
                };
                crate::cloud_drive::credential_fingerprint(
                    provider,
                    &r.get::<String, _>("credential"),
                ) == r.get::<String, _>("target_account_key")
            });
            if !ready {
                value = fallback(key, link, &current, "delivery_expired");
            }
        }
        if row.get::<Option<Value>, _>("response_json").as_ref() != Some(&value) {
            sqlx::query("UPDATE link_resolve_requests SET response_json=$3,delivery=$4,reason_code=$5 WHERE subject_key=$1 AND request_key=$2").bind(subject(session)).bind(key).bind(&value).bind(value["delivery"].as_str()).bind(value["reasonCode"].as_str()).execute(&state.pool).await?;
        }
        return Ok((StatusCode::OK, value));
    }
    Ok((
        StatusCode::ACCEPTED,
        json!({"status":"processing","requestKey":key,"pollAfterMs":1500}),
    ))
}
pub async fn poll(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key): Path<Uuid>,
) -> Result<Response, ApiError> {
    let session = state.auth().session(&headers).await?;
    let (status, value) = operation(&state, &session, key).await?;
    Ok(response(status, value))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusInput {
    items: Vec<LinkRef>,
}
async fn link_status(
    state: &AppState,
    session: &Session,
    item: &LinkRef,
) -> Result<Value, ApiError> {
    let snap = snapshot(state, session, &item.result_ref).await?;
    let link = snap
        .links
        .get(&item.link_ref)
        .ok_or_else(|| ApiError::NotFound("链接不存在".into()))?;
    let fact: Option<Fact> = sqlx::query_as(&format!(
        "SELECT {FACT_COLUMNS} FROM link_catalog WHERE input_fingerprint=$1"
    ))
    .bind(fingerprint(link))
    .fetch_optional(&state.pool)
    .await?;
    let mut result=fact.map(|f|f.public()).unwrap_or_else(||json!({"validity":-1,"checkedAt":null,"lastAttemptAt":null,"stale":false,"reasonCode":null}));
    result["linkRef"] = json!(item.link_ref);
    result["type"] = json!(link.r#type);
    Ok(result)
}
pub async fn statuses(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<StatusInput>,
) -> Result<Response, ApiError> {
    let session = state.auth().session(&headers).await?;
    if input.items.len() > 50 {
        return Err(ApiError::BadRequest("每次最多50条".into()));
    }
    let mut results = vec![];
    for item in input.items {
        results.push(match link_status(&state, &session, &item).await {
            Ok(v) => v,
            Err(e) => json!({"linkRef":item.link_ref,"errorCode":e.status().as_u16()}),
        });
    }
    Ok(response(StatusCode::OK, json!({"items":results})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceStatusInput {
    result_refs: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckPolicy {
    enabled: bool,
    valid_seconds: i64,
    invalid_seconds: i64,
    interval_seconds: i64,
    daily_budget: i64,
}
pub async fn get_check_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    admin(&state, &headers).await?;
    let value: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='link-check'")
            .fetch_one(&state.pool)
            .await?;
    Ok(response(StatusCode::OK, value))
}
pub async fn put_check_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(policy): Json<CheckPolicy>,
) -> Result<Response, ApiError> {
    admin(&state, &headers).await?;
    if !(60..=2592000).contains(&policy.valid_seconds)
        || !(60..=2592000).contains(&policy.invalid_seconds)
        || !(2..=3600).contains(&policy.interval_seconds)
        || !(1..=100000).contains(&policy.daily_budget)
    {
        return Err(ApiError::BadRequest("检测预算或时间间隔无效".into()));
    }
    sqlx::query("UPDATE policy_settings SET value_json=$1,updated_at=now() WHERE key='link-check'")
        .bind(json!(policy))
        .execute(&state.pool)
        .await?;
    Ok(response(StatusCode::OK, json!(policy)))
}
pub async fn resource_statuses(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<ResourceStatusInput>,
) -> Result<Response, ApiError> {
    let session = state.auth().session(&headers).await?;
    if input.result_refs.len() > 50 {
        return Err(ApiError::BadRequest("每次最多50条".into()));
    }
    let mut results = vec![];
    for result_ref in input.result_refs {
        match snapshot(&state, &session, &result_ref).await {
            Err(e) => results.push(json!({"resultRef":result_ref,"errorCode":e.status().as_u16()})),
            Ok(snap) => {
                let mut values = vec![];
                for link_ref in snap.links.keys() {
                    values.push(
                        link_status(
                            &state,
                            &session,
                            &LinkRef {
                                result_ref: result_ref.clone(),
                                link_ref: link_ref.clone(),
                            },
                        )
                        .await?,
                    );
                }
                results.push(json!({"resultRef":result_ref,"validity":aggregate(values.iter().map(|v|v["validity"].as_i64().unwrap_or(-1) as i16)),"checkedAt":values.iter().filter_map(|v|v["checkedAt"].as_str()).min()}));
            }
        }
    }
    Ok(response(StatusCode::OK, json!({"items":results})))
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    #[test]
    fn aggregates_only_definitive_facts() {
        assert_eq!(aggregate([]), -1);
        assert_eq!(aggregate([0, -1]), -1);
        assert_eq!(aggregate([0, 0]), 0);
        assert_eq!(aggregate([0, 1]), 1);
    }
    #[test]
    fn invalid_response_has_no_credentials() {
        let link = Link {
            r#type: "baidu".into(),
            url: "https://pan.baidu.com/s/abc".into(),
            password: Some("abcd".into()),
        };
        let f = Fact {
            id: Uuid::new_v4(),
            validity: 0,
            checked_at: Some(Utc::now()),
            valid_until: Some(Utc::now() + chrono::Duration::hours(1)),
            last_attempt_at: None,
            last_error_code: None,
        };
        let out = fallback(Uuid::new_v4(), &link, &f, "transfer_failed");
        assert!(out.get("url").is_none());
        assert!(out.get("password").is_none());
        assert_eq!(out["status"], "unavailable");
    }
    #[test]
    fn keys_are_session_scoped_and_passwords_versioned() {
        assert_ne!(keyed("a", "url"), keyed("b", "url"));
        let a = Link {
            r#type: "baidu".into(),
            url: "https://pan.baidu.com/s/abc".into(),
            password: None,
        };
        let mut b = a.clone();
        b.password = Some("1234".into());
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }
}
#[cfg(test)]
mod tests;
