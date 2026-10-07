//! Public link capabilities. Search snapshots are private, session-bound and short lived.
mod capability;
mod delivery;
mod management;
mod projection;
mod status;
mod worker;

use capability::{authorize, snapshot};
pub use delivery::{clear_cloud_provider_delivery, get_cloud_providers, put_cloud_provider};
pub use management::{cleanup_jobs, ignore_cleanup, retry_cleanup};
pub(crate) use projection::{compact, project};
pub use status::{resource_statuses, statuses};
pub use worker::run as worker;

#[cfg(test)]
use crate::models::SearchResult;
use crate::{
    app::AppState,
    auth::Session,
    error::ApiError,
    models::{Link, SearchRequest},
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
// HTTP responsiveness and the external write lifetime are separate budgets.
const RESPONSE_WAIT: Duration = Duration::from_millis(500);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(120);
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
    created_at: DateTime<Utc>,
}
impl Fact {
    fn stale(&self) -> bool {
        self.checked_at.is_some() && self.valid_until.is_none_or(|t| t <= Utc::now())
    }
    fn current(&self) -> i16 {
        if self.stale() { -1 } else { self.validity }
    }
    fn public(&self) -> Value {
        let validity = self.current();
        let status = match validity {
            1 => "valid",
            0 => "invalid",
            _ if self.last_attempt_at.is_some() || self.checked_at.is_some() => "unknown",
            _ => "unchecked",
        };
        // Only expose fixed diagnostics. Never persist/echo upstream error
        // strings that could contain account credentials or share tokens.
        let newer_failed_attempt = self.validity == -1
            && self
                .last_attempt_at
                .is_some_and(|attempt| self.checked_at.is_none_or(|checked| attempt > checked));
        let message = if self.stale() && !newer_failed_attempt {
            Some("检测结果已过期")
        } else {
            match self.last_error_code.as_deref() {
                Some("account_unavailable") => Some("网盘账号暂不可用"),
                Some("password_invalid") => Some("提取码无效"),
                Some("rate_limited") => Some("网盘检测频率受限"),
                Some("resource_missing") => Some("分享资源不存在"),
                Some("original_invalid") => Some("分享链接已失效"),
                Some(_) => Some("检测未完成，请稍后重试"),
                None => None,
            }
        };
        json!({"validity":validity,"checkedAt":self.checked_at,"lastAttemptAt":self.last_attempt_at,"stale":self.stale(),"reasonCode":self.last_error_code,"createdAt":self.created_at,"checkStatus":status,"checkMessage":message})
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
    resource: Option<&str>,
) -> Result<(), ApiError> {
    let id = match resource {
        Some(id) => owned_id(state, id, link).await?,
        None => register(state, link).await?,
    };
    let policy = delivery::load_provider(
        state,
        crate::cloud_drive::Provider::from_name(&link.r#type)?,
    )
    .await?;
    worker::record(state, id, value, &policy).await
}
const FACT_COLUMNS: &str =
    "id,validity,checked_at,valid_until,last_attempt_at,last_error_code,created_at";
type Facts = HashMap<(Option<String>, String), Fact>;
pub(super) async fn load_facts(
    state: &AppState,
    owners: &[String],
    keys: &[String],
) -> Result<Facts, ApiError> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let rows=sqlx::query(&format!("SELECT resource_id,input_fingerprint,{FACT_COLUMNS} FROM resource_links WHERE input_fingerprint=ANY($1) AND (resource_id=ANY($2) OR resource_id IS NULL) ORDER BY checked_at ASC NULLS FIRST,id"))
        .bind(keys).bind(owners).fetch_all(&state.pool).await?;
    rows.iter()
        .map(|r| {
            Ok((
                (r.try_get("resource_id")?, r.try_get("input_fingerprint")?),
                sqlx::FromRow::from_row(r)?,
            ))
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(Into::into)
}
fn scoped_fact<'a>(facts: &'a Facts, owner: Option<&str>, link: &Link) -> Option<&'a Fact> {
    facts.get(&(owner.map(str::to_owned), fingerprint(link)))
}
/// Read existing per-link observations in one batch. Listing admin resources
/// must not register links or enqueue checks, and must match the password too.
pub(crate) async fn admin_resource_observations(
    state: &AppState,
    resources: &mut [Value],
) -> Result<(), ApiError> {
    let fingerprints: Vec<String> = resources
        .iter()
        .filter_map(|r| r["links"].as_array())
        .flatten()
        .filter_map(|l| serde_json::from_value::<Link>(l.clone()).ok())
        .map(|l| fingerprint(&l))
        .collect();
    let owners: Vec<String> = resources
        .iter()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    let facts = load_facts(state, &owners, &fingerprints).await?;
    for resource in resources {
        let owner = resource["id"].as_str().unwrap_or("").to_owned();
        let mut validities = Vec::new();
        let mut checked_at: Option<DateTime<Utc>> = None;
        if let Some(links) = resource["links"].as_array_mut() {
            for value in links {
                let Ok(link) = serde_json::from_value::<Link>(value.clone()) else {
                    validities.push(-1);
                    continue;
                };
                let observation = scoped_fact(&facts,if owner.is_empty(){None}else{Some(&owner)},&link).map(Fact::public)
                    .unwrap_or_else(|| json!({"validity":-1,"checkedAt":null,"lastAttemptAt":null,"stale":false,"reasonCode":null,"createdAt":null,"checkStatus":"unchecked","checkMessage":null}));
                validities.push(observation["validity"].as_i64().unwrap_or(-1) as i16);
                if let Some(fact) = scoped_fact(
                    &facts,
                    if owner.is_empty() { None } else { Some(&owner) },
                    &link,
                ) {
                    checked_at = checked_at.max(fact.checked_at);
                }
                if let (Some(link), Some(fields)) = (value.as_object_mut(), observation.as_object())
                {
                    link.extend(fields.clone());
                }
                value["linkKey"] = json!(fingerprint(&link));
                value["checkSupported"] =
                    json!(crate::cloud_drive::Provider::from_name(&link.r#type).is_ok());
            }
        }
        // Read current link facts even if the worker is paused or bindings have
        // not been synchronized yet. An expired catalog value cannot appear
        // as a still-valid resource summary on the admin page.
        let validity = aggregate(validities);
        resource["linkValidity"] = json!(validity);
        resource["checkStatus"] = json!(match validity {
            1 => "valid",
            0 => "invalid",
            _ => "unchecked",
        });
        resource["checkedAt"] = json!(checked_at);
        resource["linkValidityUpdatedAt"] = json!(checked_at);
        resource["checkMessage"] = json!(match validity {
            1 => Some("至少一个链接有效"),
            0 => Some("所有链接均已失效"),
            _ => None,
        });
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdminLinkCheck {
    link_key: String,
}

/// A manual check targets the exact current link input, not a mutable array
/// index or the resource aggregate. It shares the normal quota and breaker.
pub async fn admin_resource_link_check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<AdminLinkCheck>,
) -> Result<Json<Value>, ApiError> {
    admin(&state, &headers).await?;
    let stored: Value =
        sqlx::query_scalar("SELECT resource_links_json(id) FROM managed_resources WHERE id=$1")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::NotFound("资源不存在".into()))?;
    let link = stored
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| serde_json::from_value::<Link>(v.clone()).ok())
        .find(|link| fingerprint(link) == input.link_key)
        .ok_or_else(|| ApiError::Conflict("链接已变更，请刷新后重试".into()))?;
    let provider = crate::cloud_drive::Provider::from_name(&link.r#type)?;
    let reference = crate::cloud_drive::ShareInput {
        url: link.url.clone(),
        provider: Some(provider),
        password: link.password.clone(),
    }
    .parse()?;
    let _slot = state
        .cloud_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::Unavailable("检测繁忙，请稍后重试".into()))?;
    let drive = crate::cloud_drive::Drive::load(&state, provider).await?;
    let policy = delivery::load_provider(&state, provider).await?;
    if !worker::allow_check(&state, provider, &policy, true).await? {
        return Err(ApiError::Unavailable(
            "检测频率或额度受限，请稍后重试".into(),
        ));
    }
    let result = tokio::time::timeout(Duration::from_secs(20), drive.check(&reference))
        .await
        .unwrap_or_else(|_| json!({"status":"unknown","message":"检测超时，请稍后重试"}));
    let link_id = owned_id(&state, &id, &link).await?;
    worker::record(&state, link_id, &result, &policy).await?;
    let mut observation = fact(&state, link_id).await?.public();
    observation["linkKey"] = json!(input.link_key);
    observation["message"] = result["message"].clone();
    Ok(Json(json!({"code":0,"data":observation})))
}
async fn fact(state: &AppState, id: Uuid) -> Result<Fact, ApiError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {FACT_COLUMNS} FROM resource_links WHERE id=$1"
    ))
    .bind(id)
    .fetch_one(&state.pool)
    .await?)
}
pub(super) async fn owned_id(
    state: &AppState,
    resource: &str,
    link: &Link,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar("SELECT id FROM resource_links WHERE resource_id=$1 AND input_fingerprint=$2 ORDER BY position LIMIT 1")
        .bind(resource).bind(fingerprint(link)).fetch_optional(&state.pool).await?
        .ok_or_else(||ApiError::Conflict("链接已变更，请刷新后重试".into()))
}
pub(super) async fn register(state: &AppState, link: &Link) -> Result<Uuid, ApiError> {
    let key = fingerprint(link);
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,48))")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let existing:Option<Uuid>=sqlx::query_scalar("SELECT id FROM resource_links WHERE resource_id IS NULL AND input_fingerprint=$1 ORDER BY created_at DESC LIMIT 1")
        .bind(&key).fetch_optional(&mut *tx).await?;
    let id = if let Some(id) = existing {
        id
    } else {
        sqlx::query_scalar("INSERT INTO resource_links(id,provider,identity,original_url,original_password,input_fingerprint,next_check_at) VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING id")
            .bind(Uuid::new_v4()).bind(&link.r#type).bind(resource_clean::link_identity(&link.url)).bind(&link.url).bind(&link.password).bind(key).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    Ok(id)
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
    let end = tokio::time::Instant::now() + RESPONSE_WAIT;
    #[cfg(not(test))]
    let work_timeout = RESOLVE_TIMEOUT;
    #[cfg(test)]
    let work_timeout = Duration::from_secs(
        state
            .resolve_test_timeout_seconds
            .load(std::sync::atomic::Ordering::SeqCst)
            .min(RESOLVE_TIMEOUT.as_secs()),
    );
    let deadline = Utc::now() + chrono::Duration::seconds(work_timeout.as_secs() as i64);
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
    }
    let id = if snap.source.is_none() {
        owned_id(&state, &snap.resource_id, &link).await?
    } else {
        register(&state, &link).await?
    };
    // A click can create urgent work even if this link was registered while checks
    // were disabled. Never replace or steal another worker's running lease.
    sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,priority) SELECT c.id,c.input_version,'original',10 FROM resource_links c WHERE c.id=$1 AND c.provider IN('baidu','quark','aliyun','xunlei','guangya') AND EXISTS(SELECT 1 FROM policy_settings WHERE key='link-check' AND value_json->>'enabled'='true') ON CONFLICT(link_id,input_version) WHERE kind='original' AND status IN('queued','running') DO UPDATE SET priority=10 WHERE link_check_jobs.status='queued' AND link_check_jobs.priority<>10")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if state.shutdown.is_cancelled() {
        return Err(ApiError::Unavailable("服务正在关闭".into()));
    }
    // A short database critical section bounds requests across every API instance.
    // It never covers cloud I/O. Replays bypass capacity checks.
    let mut admission = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(773013)")
        .execute(&mut *admission)
        .await?;
    let replay: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2)")
        .bind(subject(&session)).bind(input.request_key).fetch_one(&mut *admission).await?;
    if !replay {
        let counts = sqlx::query("SELECT count(*) total,count(*) FILTER(WHERE subject_key=$1) owned FROM link_resolve_requests WHERE status IN('queued','running') AND deadline_at>clock_timestamp()")
            .bind(subject(&session)).fetch_one(&mut *admission).await?;
        if counts.get::<i64, _>("total") >= 32 || counts.get::<i64, _>("owned") >= 4 {
            return Err(ApiError::TooManyRequests("取链任务繁忙，请稍后重试".into()));
        }
    }
    let inserted=sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,user_id,request_fingerprint,link_id,authorization_json,status,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8) ON CONFLICT(subject_key,request_key) DO NOTHING")
        .bind(Uuid::new_v4()).bind(input.request_key).bind(subject(&session)).bind(session.user_id).bind(&fp).bind(id).bind(json!({"snapshot":snap,"linkRef":input.link_ref})).bind(deadline).execute(&mut *admission).await?.rows_affected();
    admission.commit().await?;
    if inserted == 0 {
        let old:String=sqlx::query_scalar("SELECT request_fingerprint FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2").bind(subject(&session)).bind(input.request_key).fetch_one(&state.pool).await?;
        if old != fp {
            return Err(ApiError::Conflict("requestKey 已用于其他参数".into()));
        }
    } else {
        let state = state.clone();
        let session = session.clone();
        let tasks = state.resolutions.clone();
        let reject_state = state.clone();
        let reject_subject = subject(&session);
        if let Err(error) = tasks.spawn(async move {
            if let Err(e) = run_resolution(&state, &session, input.request_key, id, &link).await {
                tracing::error!(error=%e,"link resolution failed; deadline recovery will finalize");
            }
        }) {
            // No task ran and no external write occurred; a rejected admission is retryable.
            sqlx::query("DELETE FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2 AND status='queued'")
                .bind(reject_subject).bind(input.request_key).execute(&reject_state.pool).await?;
            return Err(error);
        }
    }
    loop {
        let out = operation(&state, &session, input.request_key).await?;
        if out.0 != StatusCode::ACCEPTED || tokio::time::Instant::now() >= end {
            return Ok(response(out.0, out.1));
        }
        tokio::time::sleep_until(end.min(tokio::time::Instant::now() + Duration::from_millis(250)))
            .await;
    }
}
async fn progress(
    state: &AppState,
    session: &Session,
    key: Uuid,
    stage: &str,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE link_resolve_requests SET progress_stage=$3,updated_at=now() WHERE subject_key=$1 AND request_key=$2 AND status IN('queued','running') AND response_json IS NULL AND deadline_at>clock_timestamp()")
        .bind(subject(session)).bind(key).bind(stage).execute(&state.pool).await?;
    Ok(())
}
async fn complete_resolution(
    state: &AppState,
    subject_key: &str,
    key: Uuid,
    result: &Value,
    require_live_deadline: bool,
) -> Result<Option<Value>, ApiError> {
    Ok(
        sqlx::query_scalar(include_str!("link_resolution/complete_resolve.sql"))
            .bind(subject_key)
            .bind(key)
            .bind(result)
            .bind(result["delivery"].as_str())
            .bind(result["reasonCode"].as_str())
            .bind(if result["status"] == "unavailable" {
                "unavailable"
            } else {
                "available"
            })
            .bind(require_live_deadline)
            .fetch_optional(&state.pool)
            .await?,
    )
}
async fn run_resolution(
    state: &AppState,
    session: &Session,
    key: Uuid,
    id: Uuid,
    link: &Link,
) -> Result<(), ApiError> {
    if sqlx::query("UPDATE link_resolve_requests SET status='running',updated_at=now() WHERE subject_key=$1 AND request_key=$2 AND status='queued' AND deadline_at>clock_timestamp()").bind(subject(session)).bind(key).execute(&state.pool).await?.rows_affected() == 0 {
        return Ok(());
    }
    progress(state, session, key, "checking").await?;
    let current = fact(state, id).await?;
    // Delivery owns the decision: check our exact owned-share mapping before the source.
    let result = if crate::cloud_drive::Provider::from_name(&link.r#type).is_ok() {
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
    // An expired operation must never be overwritten by a late upstream response.
    if complete_resolution(state, &subject(session), key, &result, true)
        .await?
        .is_none()
    {
        delivery::retire_timed_out_artifacts(state, session, key).await?;
    }
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
        result = complete_resolution(state, &subject(session), key, &value, false).await?;
        if result.is_none() {
            // Another caller may have finalized this request after our initial read.
            result = sqlx::query_scalar("SELECT response_json FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2")
                .bind(subject(session)).bind(key).fetch_one(&state.pool).await?;
        }
    }
    if let Some(mut value) = result {
        let current = fact(state, row.get("link_id")).await?;
        if current.current() == 0 && value["delivery"] != "reshared" {
            value = fallback(key, link, &current, "original_invalid");
        }
        if value["delivery"] == "reshared" {
            let share=sqlx::query("SELECT s.target_account_key,c.provider,a.credential,a.account_key,a.auth_status FROM link_share_cache s JOIN resource_links c ON c.id=s.link_id JOIN cloud_account_settings a ON a.provider=c.provider WHERE s.id=$1 AND s.state='ready' AND s.share_validity=1 AND s.cleanup_after>now()+make_interval(secs=>COALESCE((s.ownership_manifest_json->>'minRemainingSeconds')::double precision,5)) AND (s.share_expires_at IS NULL OR s.share_expires_at>now()+make_interval(secs=>COALESCE((s.ownership_manifest_json->>'minRemainingSeconds')::double precision,5)))").bind(row.get::<Option<Uuid>,_>("share_cache_id")).fetch_optional(&state.pool).await?;
            let ready = share.is_some_and(|r| {
                let Ok(provider) =
                    crate::cloud_drive::Provider::from_name(&r.get::<String, _>("provider"))
                else {
                    return false;
                };
                if r.get::<String, _>("auth_status") == "reauthorization_required" {
                    return false;
                }
                r.get::<Option<String>, _>("account_key")
                    .unwrap_or_else(|| {
                        crate::cloud_drive::credential_fingerprint(
                            provider,
                            &r.get::<String, _>("credential"),
                        )
                    })
                    == r.get::<String, _>("target_account_key")
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
        json!({"status":"processing","requestKey":key,"stage":row.get::<String,_>("progress_stage"),"pollAfterMs":poll_interval_ms((Utc::now()-row.get::<DateTime<Utc>,_>("created_at")).num_seconds()),"deadlineAt":row.get::<DateTime<Utc>,_>("deadline_at")}),
    ))
}
fn poll_interval_ms(elapsed_seconds: i64) -> u64 {
    match elapsed_seconds {
        ..=5 => 750,
        6..=20 => 1500,
        _ => 2500,
    }
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
#[cfg(test)]
mod unit_tests {
    use super::*;
    #[test]
    fn latest_failure_diagnostic_is_not_replaced_by_old_check_expiry() {
        let checked = Utc::now() - chrono::Duration::hours(2);
        let mut fact = Fact {
            id: Uuid::new_v4(),
            validity: -1,
            checked_at: Some(checked),
            valid_until: None,
            last_attempt_at: Some(Utc::now()),
            last_error_code: Some("account_unavailable".into()),
            created_at: checked,
        };
        assert_eq!(fact.public()["checkStatus"], "unknown");
        assert_eq!(fact.public()["checkMessage"], "网盘账号暂不可用");
        fact.last_error_code = Some("upstream cookie=SECRET".into());
        assert_eq!(fact.public()["checkMessage"], "检测未完成，请稍后重试");
        fact.last_attempt_at = Some(checked);
        assert_eq!(fact.public()["checkMessage"], "检测结果已过期");
    }
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
            created_at: Utc::now(),
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
