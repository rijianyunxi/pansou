use super::common::{admin_only, ok};
use crate::{
    app::AppState,
    crawl,
    error::ApiError,
    outbound::{self, Owner, Policy},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::{collections::HashMap, sync::Arc};
fn number(
    q: &HashMap<String, String>,
    key: &str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, ApiError> {
    match q.get(key) {
        None => Ok(default),
        Some(v) => v
            .parse::<i64>()
            .ok()
            .filter(|n| (*n >= min) && (*n <= max))
            .ok_or_else(|| ApiError::BadRequest(format!("{key} 超出有效范围"))),
    }
}
fn flag(q: &HashMap<String, String>, key: &str) -> Result<Option<bool>, ApiError> {
    match q.get(key).map(String::as_str) {
        None | Some("") => Ok(None),
        Some("true") => Ok(Some(true)),
        Some("false") => Ok(Some(false)),
        _ => Err(ApiError::BadRequest(format!("{key} 必须为布尔值"))),
    }
}
fn date(
    q: &HashMap<String, String>,
    key: &str,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, ApiError> {
    q.get(key)
        .filter(|s| !s.is_empty())
        .map(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|t| t.with_timezone(&chrono::Utc))
                .map_err(|_| ApiError::BadRequest(format!("{key} 必须含时区")))
        })
        .transpose()
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    kind: String,
    id: i64,
    channel: String,
    date: Option<chrono::DateTime<chrono::Utc>>,
}
fn read_cursor(q: &HashMap<String, String>, kind: &str) -> Result<Option<Cursor>, ApiError> {
    use base64::Engine;
    let Some(raw) = q.get("cursor").filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let bad = || ApiError::BadRequest("分页游标无效，请从第一批重新查询".into());
    if raw.len() > 512 {
        return Err(bad());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| bad())?;
    let c: Cursor = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    if c.kind != kind || c.id < 1 || c.channel.len() > 64 {
        return Err(bad());
    }
    Ok(Some(c))
}
fn cursor_value(
    kind: &str,
    id: i64,
    channel: String,
    date: Option<chrono::DateTime<chrono::Utc>>,
) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Cursor {
            kind: kind.into(),
            id,
            channel,
            date,
        })
        .expect("serialize cursor"),
    )
}
fn job(r: &PgRow) -> Value {
    json!({"id":r.get::<i64,_>("id"),"channelId":r.get::<String,_>("channel_id"),"kind":r.get::<String,_>("kind"),"status":r.get::<String,_>("status"),"pages":r.get::<i32,_>("pages"),"messages":r.get::<i32,_>("messages"),"resources":r.get::<i32,_>("resources"),"failures":r.get::<i32,_>("failures"),"nextRunAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_run_at"),"attempts":r.get::<i32,_>("attempts"),"cursorBefore":r.get::<Option<i64>,_>("cursor_before"),"lastError":r.get::<Option<String>,_>("last_error"),"stopReason":r.get::<Option<String>,_>("stop_reason"),"diagnostics":r.get::<Value,_>("diagnostics_json"),"createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),"updatedAt":r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at"),"completedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("completed_at")})
}
const CHANNEL_SELECT: &str = "SELECT c.* FROM crawl_channels c";
async fn channels_data(
    pool: &PgPool,
    rows: Vec<PgRow>,
    details: bool,
) -> Result<Vec<Value>, ApiError> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids = rows
        .iter()
        .map(|r| r.get::<String, _>("id"))
        .collect::<Vec<_>>();
    let stats = sqlx::query(include_str!("../sql/channel_summaries.sql"))
        .bind(&ids)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| (r.get::<String, _>("id"), r))
        .collect::<HashMap<_, _>>();
    let policies=sqlx::query(&format!("SELECT p.channel_id,p.default_key,{} FROM outbound_policies p WHERE p.channel_id=ANY($1) OR p.default_key='telegram'",outbound::POLICY_COLUMNS)).bind(&ids).fetch_all(pool).await?;
    let mut by_channel = HashMap::new();
    let mut default = None;
    for r in policies {
        let p = outbound::from_row(&r)?;
        if let Some(id) = r.get::<Option<String>, _>("channel_id") {
            by_channel.insert(id, p);
        } else {
            default = Some(p);
        }
    }
    let mut items = Vec::with_capacity(rows.len());
    for r in rows {
        let id = r.get::<String, _>("id");
        let st = &stats[&id];
        let p = by_channel.get(&id);
        let effective = if p.is_some_and(|p| p.inherit) {
            default.as_ref()
        } else {
            p
        };
        let mut v = json!({"id":id,"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"enabled":r.get::<bool,_>("enabled"),"version":r.get::<i64,_>("version"),"historyComplete":r.get::<bool,_>("history_complete"),"historyCursor":r.get::<Option<i64>,_>("history_cursor"),"historyPages":r.get::<i32,_>("history_pages"),"nextPageAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_page_at"),"newestMessage":r.get::<i64,_>("newest_message"),"oldestMessage":r.get::<Option<i64>,_>("oldest_message"),"lastSyncedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("last_synced_at"),"nextSyncAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_sync_at"),"coverage":r.get::<String,_>("coverage"),"lastError":r.get::<Option<String>,_>("last_error"),"messageCount":st.get::<i64,_>("message_count"),"resourceCount":st.get::<i64,_>("resource_count"),"failureCount":st.get::<i64,_>("failure_count"),"latestJob":st.get::<Option<Value>,_>("latest_job"),"outbound":p,"effectiveOutbound":effective});
        if details {
            v["transform"] = json!(r.get::<Option<String>, _>("transform"));
        }
        items.push(v);
    }
    Ok(items)
}
pub async fn crawl_channels(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let page = number(&q, "page", 1, 1, 100000)?;
    let size = number(&q, "pageSize", 20, 1, 100)?;
    let enabled = flag(&q, "enabled")?;
    let filter = " WHERE ($1='' OR c.id ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%') AND ($2::bool IS NULL OR c.enabled=$2)";
    let kw = q.get("q").cloned().unwrap_or_default();
    let total =
        sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM crawl_channels c{filter}"))
            .bind(&kw)
            .bind(enabled)
            .fetch_one(&s.pool)
            .await?;
    let rows = sqlx::query(&format!(
        "{CHANNEL_SELECT}{filter} ORDER BY c.id LIMIT $3 OFFSET $4"
    ))
    .bind(kw)
    .bind(enabled)
    .bind(size)
    .bind((page - 1) * size)
    .fetch_all(&s.pool)
    .await?;
    let items = channels_data(&s.pool, rows, false).await?;
    Ok(ok(
        json!({"items":items,"total":total,"page":page,"pageSize":size}),
    ))
}
pub async fn crawl_channel_get(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let r = sqlx::query(&format!("{CHANNEL_SELECT} WHERE c.id=$1"))
        .bind(id)
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    Ok(ok(channels_data(&s.pool, vec![r], true).await?.remove(0)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelForm {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub enabled: bool,
    #[serde(default)]
    pub transform: Option<String>,
    pub outbound: Policy,
    #[serde(default)]
    pub expected_version: i64,
}
async fn save_channel(
    s: &AppState,
    id: &str,
    f: ChannelForm,
    create: bool,
) -> Result<(), ApiError> {
    if crate::telegram::normalize_channel(&f.id).as_deref() != Some(id) {
        return Err(ApiError::BadRequest("无效频道或不允许修改频道身份".into()));
    }
    if f.name.trim().is_empty() || f.name.len() > 240 || f.description.len() > 4000 {
        return Err(ApiError::BadRequest("名称必填且不能超过240字符".into()));
    }
    if let Some(ref dsl) = f.transform {
        crate::transform::validate(dsl)?;
    }
    let mut tx = s.pool.begin().await?;
    crawl::lock_index(&mut tx).await?;
    if create {
        let inserted=sqlx::query("INSERT INTO crawl_channels(id,name,description,enabled,transform) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(id).bind(f.name.trim()).bind(&f.description).bind(f.enabled).bind(&f.transform).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            return Err(ApiError::Conflict("频道已存在，请在现有频道中编辑".into()));
        }
    } else {
        let n=sqlx::query("UPDATE crawl_channels SET name=$2,description=$3,enabled=$4,transform=$5,version=version+1,updated_at=now() WHERE id=$1 AND version=$6").bind(id).bind(f.name.trim()).bind(&f.description).bind(f.enabled).bind(&f.transform).bind(f.expected_version).execute(&mut *tx).await?.rows_affected();
        if n == 0 {
            return Err(ApiError::Conflict(
                "频道不存在或配置已被其他操作更新，请重新加载".into(),
            ));
        }
    }
    outbound::save(&mut tx, Owner::Channel(id), &f.outbound).await?;
    sqlx::query("UPDATE crawl_jobs SET status=$2,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE channel_id=$1 AND status=ANY($3)").bind(id).bind(if f.enabled{"queued"}else{"paused"}).bind(if f.enabled{vec!["paused"]}else{vec!["queued","running"]}).execute(&mut *tx).await?;
    crawl::bump(&mut tx).await?;
    tx.commit().await?;
    *s.search_cache.lock().await = Default::default();
    Ok(())
}
pub async fn crawl_channel_create(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(f): Json<ChannelForm>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let id = crate::telegram::normalize_channel(&f.id)
        .ok_or_else(|| ApiError::BadRequest("仅支持公开t.me频道".into()))?;
    save_channel(&s, &id, f, true).await?;
    Ok(ok(json!({"id":id})))
}
pub async fn crawl_channel_update(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(f): Json<ChannelForm>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    save_channel(&s, &id, f, false).await?;
    Ok(ok(json!({"id":id})))
}
pub async fn crawl_default_get(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    Ok(ok(
        json!({"outbound":outbound::read(&s.pool,Owner::Default).await?,"inheritors":sqlx::query_scalar::<_,i64>("SELECT count(*) FROM outbound_policies p JOIN crawl_channels c ON c.id=p.channel_id WHERE p.inherit").fetch_one(&s.pool).await?}),
    ))
}
pub async fn crawl_default_put(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(p): Json<Policy>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(773002)")
        .execute(&mut *tx)
        .await?;
    outbound::save(&mut tx, Owner::Default, &p).await?;
    tx.commit().await?;
    Ok(ok(
        json!({"outbound":outbound::read(&s.pool,Owner::Default).await?}),
    ))
}
pub async fn crawl_overview(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    use redis::AsyncCommands;
    let workers = match s.redis.connection() {
        Err(_) => None,
        Ok(mut conn) => conn
            .zcount::<_, _, _, i64>(
                "pansou:crawl:workers",
                chrono::Utc::now().timestamp() - 45,
                "+inf",
            )
            .await
            .ok(),
    };
    let jobs=sqlx::query("SELECT count(*) FILTER(WHERE status='queued') queued,count(*) FILTER(WHERE status='running') running,count(*) FILTER(WHERE status='failed') failed FROM crawl_jobs").fetch_one(&s.pool).await?;
    let review = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM crawl_page_failures")
        .fetch_one(&s.pool)
        .await?;
    let worker_enabled = crate::runtime::settings(&s).await?.crawl_enabled;
    Ok(ok(
        json!({"workerState":match workers{None=>"unknown",Some(0)=>"offline",Some(_)=>"online"},"workerCount":workers,"workerEnabled":worker_enabled,"queued":jobs.get::<i64,_>("queued"),"running":jobs.get::<i64,_>("running"),"failed":jobs.get::<i64,_>("failed"),"review":review,"serverTime":chrono::Utc::now()}),
    ))
}
pub async fn crawl_job_create(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(channel): Path<String>,
    Json(b): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let kind = b.get("kind").and_then(Value::as_str).unwrap_or("sync");
    let id = crawl::enqueue_request(
        &s.pool,
        &channel,
        kind,
        b.get("requestKey").and_then(Value::as_str),
    )
    .await?;
    Ok(ok(json!({"id":id})))
}
pub async fn crawl_jobs(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let size = number(&q, "limit", 20, 1, 100)?;
    let cursor = read_cursor(&q, "jobs")?.map(|c| c.id).unwrap_or(i64::MAX);
    let from = date(&q, "from")?;
    let to = date(&q, "to")?;
    let mut rows=sqlx::query("SELECT * FROM crawl_jobs WHERE ($1='' OR channel_id=$1) AND ($2='' OR status=$2) AND ($3='' OR kind=$3) AND id<$4 AND ($5::timestamptz IS NULL OR created_at>=$5) AND ($6::timestamptz IS NULL OR created_at<=$6) ORDER BY id DESC LIMIT $7").bind(q.get("channel").cloned().unwrap_or_default()).bind(q.get("status").cloned().unwrap_or_default()).bind(q.get("kind").cloned().unwrap_or_default()).bind(cursor).bind(from).bind(to).bind(size+1).fetch_all(&s.pool).await?;
    let more = rows.len() > size as usize;
    rows.truncate(size as usize);
    Ok(ok(
        json!({"items":rows.iter().map(job).collect::<Vec<_>>(),"hasMore":more,"nextCursor":if more{rows.last().map(|r|cursor_value("jobs",r.get::<i64,_>("id"),String::new(),None))}else{None}}),
    ))
}
pub async fn crawl_job_get(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let r = sqlx::query("SELECT * FROM crawl_jobs WHERE id=$1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("任务不存在".into()))?;
    Ok(ok(job(&r)))
}
pub async fn crawl_job_retry(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let mut tx = s.pool.begin().await?;
    let j = sqlx::query("SELECT channel_id,kind FROM crawl_jobs WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::NotFound("任务不存在".into()))?;
    let channel = j.get::<String, _>("channel_id");
    sqlx::query("SELECT id FROM crawl_channels WHERE id=$1 FOR UPDATE")
        .bind(&channel)
        .fetch_one(&mut *tx)
        .await?;
    let n=sqlx::query("UPDATE crawl_jobs SET status='queued',attempts=0,last_error=NULL,lease_id=NULL,lease_until=NULL,completed_at=NULL,next_run_at=now() WHERE id=$1 AND status='failed' AND EXISTS(SELECT 1 FROM crawl_channels WHERE id=$2 AND enabled) AND NOT EXISTS(SELECT 1 FROM crawl_jobs WHERE channel_id=$2 AND kind=$3 AND status IN ('queued','running','paused'))").bind(id).bind(channel).bind(j.get::<String,_>("kind")).execute(&mut *tx).await?.rows_affected();
    if n == 0 {
        return Err(ApiError::Conflict(
            "任务无法重试：频道暂停或同类任务已存在".into(),
        ));
    }
    tx.commit().await?;
    Ok(ok(json!({"id":id})))
}
pub async fn crawl_job_cancel(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let n=sqlx::query("UPDATE crawl_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL,stop_reason='admin_cancelled',completed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','running','paused')").bind(id).execute(&s.pool).await?.rows_affected();
    if n == 0 {
        return Err(ApiError::Conflict("任务已结束或不存在".into()));
    }
    Ok(ok(json!({"ok":true})))
}
fn message(r: &PgRow) -> Value {
    json!({"channelId":r.get::<String,_>("channel_id"),"messageId":r.get::<i64,_>("message_id"),"publishedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("published_at"),"status":r.get::<String,_>("parse_status"),"parseError":r.get::<Option<String>,_>("parse_error"),"parseVersion":r.get::<String,_>("parse_version"),"summary":crate::telegram::message_text(&r.get::<String, _>("raw_html")).chars().take(160).collect::<String>()})
}
async fn message_list(
    pool: &PgPool,
    channel: &str,
    q: HashMap<String, String>,
) -> Result<Value, ApiError> {
    let size = number(&q, "limit", 20, 1, 100)?;
    let parsed = read_cursor(&q, "messages")?;
    if parsed.as_ref().is_some_and(|c| c.channel != channel) {
        return Err(ApiError::BadRequest("游标不属于该频道".into()));
    }
    let cursor = parsed.map(|c| c.id).unwrap_or(i64::MAX);
    let mut rows=sqlx::query("SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version,raw_html FROM source_messages WHERE channel_id=$1 AND ($2='' OR parse_status=$2) AND message_id<$3 AND ($4::timestamptz IS NULL OR published_at>=$4) AND ($5::timestamptz IS NULL OR published_at<=$5) ORDER BY message_id DESC LIMIT $6").bind(channel).bind(q.get("status").cloned().unwrap_or_default()).bind(cursor).bind(date(&q,"from")?).bind(date(&q,"to")?).bind(size+1).fetch_all(pool).await?;
    let more = rows.len() > size as usize;
    rows.truncate(size as usize);
    Ok(
        json!({"items":rows.iter().map(message).collect::<Vec<_>>(),"hasMore":more,"nextCursor":if more {rows.last().map(|r|cursor_value("messages",r.get("message_id"),channel.into(),None))}else{None}}),
    )
}
pub async fn crawl_messages(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(channel): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    Ok(ok(message_list(&s.pool, &channel, q).await?))
}
pub async fn crawl_message_get(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path((channel, id)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let r = sqlx::query("SELECT * FROM source_messages WHERE channel_id=$1 AND message_id=$2")
        .bind(&channel)
        .bind(id)
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("消息不存在".into()))?;
    let stored=sqlx::query("SELECT o.result_json,r.id,r.enabled,r.manual_override,r.deleted_at FROM resource_occurrences o JOIN managed_resources r ON r.id=o.resource_id WHERE o.channel_id=$1 AND o.message_id=$2").bind(&channel).bind(id).fetch_all(&s.pool).await?;
    let mut data = message(&r);
    data["rawHtml"] = json!(r.get::<String, _>("raw_html"));
    data["rawText"] = json!(crate::telegram::message_text(
        &r.get::<String, _>("raw_html")
    ));
    data["stored"]=json!(stored.iter().map(|r|json!({"result":r.get::<Value,_>("result_json"),"enabled":r.get::<bool,_>("enabled"),"manualOverride":r.get::<bool,_>("manual_override"),"deleted":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("deleted_at").is_some()})).collect::<Vec<_>>());
    Ok(ok(data))
}
pub async fn crawl_message_preview(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path((channel, id)): Path<(String, i64)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let r = sqlx::query(
        "SELECT raw_html,published_at FROM source_messages WHERE channel_id=$1 AND message_id=$2",
    )
    .bind(&channel)
    .bind(id)
    .fetch_optional(&s.pool)
    .await?
    .ok_or_else(|| ApiError::NotFound("消息不存在".into()))?;
    let mut source = crawl::source_for(&s.pool, &channel).await?;
    if let Some(dsl) = body.get("transform").and_then(Value::as_str) {
        crate::transform::validate(dsl)?;
        source.transform = dsl.into();
    }
    let m = crate::telegram::Message {
        id,
        html: r.get("raw_html"),
        published: r.get("published_at"),
    };
    static PREVIEW_SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    let guard = PREVIEW_SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::Unavailable("解析预览繁忙，请稍后重试".into()))?;
    let data = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            crawl::parse_message(&source, &channel, &m)
        }),
    )
    .await
    .map_err(|_| ApiError::Unavailable("解析预览超过预算".into()))?
    .map_err(|_| ApiError::Internal("解析任务失败".into()))?;
    Ok(ok(serde_json::to_value(data).unwrap()))
}

pub async fn crawl_settings_get(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    Ok(ok(
        serde_json::to_value(crawl::settings(&s.pool).await?).unwrap()
    ))
}
pub async fn crawl_settings_put(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(f): Json<crawl::Settings>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    if !(1..=32).contains(&f.concurrent_channels)
        || !(0..=3600).contains(&f.page_delay_seconds)
        || !(60..=86400).contains(&f.daily_interval_seconds)
    {
        return Err(ApiError::BadRequest(
            "并发1～32，等待0～3600秒，日常间隔60～86400秒".into(),
        ));
    }
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(773012)")
        .execute(&mut *tx)
        .await?;
    let n=sqlx::query("UPDATE crawl_settings SET concurrent_channels=$1,page_delay_seconds=$2,daily_interval_seconds=$3,version=version+1 WHERE id=1 AND version=$4").bind(f.concurrent_channels).bind(f.page_delay_seconds).bind(f.daily_interval_seconds).bind(f.version).execute(&mut *tx).await?.rows_affected();
    if n == 0 {
        return Err(ApiError::Conflict("配置已更新，请重新加载".into()));
    }
    sqlx::query("UPDATE crawl_channels SET next_sync_at=COALESCE(last_synced_at,now())+make_interval(secs=>$1::double precision)").bind(f.daily_interval_seconds as f64).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(ok(
        serde_json::to_value(crawl::settings(&s.pool).await?).unwrap()
    ))
}
pub async fn crawl_failures(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(channel): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let before = number(&q, "before", i64::MAX, 1, i64::MAX)?;
    let rows=sqlx::query("SELECT f.*,j.status AS retry_status FROM crawl_page_failures f LEFT JOIN crawl_jobs j ON j.id=f.retry_job_id WHERE f.channel_id=$1 AND f.id<$2 ORDER BY f.id DESC LIMIT 101").bind(channel).bind(before).fetch_all(&s.pool).await?;
    let items=rows.iter().take(100).map(|r|json!({"id":r.get::<i64,_>("id"),"kind":r.get::<String,_>("kind"),"cursorBefore":r.get::<Option<i64>,_>("cursor_before"),"pageNumber":r.get::<Option<i32>,_>("page_number"),"lastError":r.get::<String,_>("last_error"),"retryStatus":r.get::<Option<String>,_>("retry_status"),"createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at")})).collect::<Vec<_>>();
    Ok(ok(
        json!({"items":items,"hasMore":rows.len()>100,"nextBefore":items.last().and_then(|v|v["id"].as_i64())}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailureAction {
    action: String,
    ids: Vec<i64>,
}
pub async fn crawl_failures_action(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(channel): Path<String>,
    Json(f): Json<FailureAction>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let ids = f
        .ids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if ids.is_empty() || ids.len() > 100 || !matches!(f.action.as_str(), "retry" | "ignore") {
        return Err(ApiError::BadRequest(
            "请选择1～100条记录及重试/忽略操作".into(),
        ));
    }
    let mut tx = s.pool.begin().await?;
    let enabled =
        sqlx::query_scalar::<_, bool>("SELECT enabled FROM crawl_channels WHERE id=$1 FOR UPDATE")
            .bind(&channel)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    if f.action == "retry" && !enabled {
        return Err(ApiError::Conflict("请先恢复频道采集".into()));
    }
    let rows=sqlx::query("SELECT f.* FROM crawl_page_failures f WHERE f.channel_id=$1 AND f.id=ANY($2) ORDER BY f.id FOR UPDATE").bind(&channel).bind(&ids).fetch_all(&mut *tx).await?;
    if rows.len() != ids.len() {
        return Err(ApiError::Conflict(
            "所选记录不存在或不属于此频道，请刷新".into(),
        ));
    }
    for r in rows {
        let id = r.get::<i64, _>("id");
        let retry_job = r.get::<Option<i64>, _>("retry_job_id");
        let busy=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM crawl_jobs WHERE id=$1 AND status IN ('queued','running','paused'))").bind(retry_job).fetch_one(&mut *tx).await?;
        if busy {
            return Err(ApiError::Conflict("所选页面正在重试，请等待完成".into()));
        }
        if f.action == "ignore" {
            sqlx::query("DELETE FROM crawl_page_failures WHERE id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        } else {
            let job=sqlx::query_scalar::<_,i64>("INSERT INTO crawl_jobs(channel_id,kind,cursor_before,failure_id) VALUES($1,'retry',$2,$3) RETURNING id").bind(&channel).bind(r.get::<Option<i64>,_>("cursor_before")).bind(id).fetch_one(&mut *tx).await?;
            sqlx::query(
                "UPDATE crawl_page_failures SET retry_job_id=$2,updated_at=now() WHERE id=$1",
            )
            .bind(id)
            .bind(job)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(ok(json!({"affected":ids.len(),"action":f.action})))
}
