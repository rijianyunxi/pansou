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
    if c.kind != kind || c.id < 1 || c.channel.len() > 64 || (kind == "review" && c.date.is_none())
    {
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
    json!({"id":r.get::<i64,_>("id"),"channelId":r.get::<String,_>("channel_id"),"kind":r.get::<String,_>("kind"),"status":r.get::<String,_>("status"),"pages":r.get::<i32,_>("pages"),"messages":r.get::<i32,_>("messages"),"resources":r.get::<i32,_>("resources"),"failures":r.get::<i32,_>("failures"),"maxPages":r.get::<i32,_>("max_pages"),"cursorBefore":r.get::<Option<i64>,_>("cursor_before"),"targetMessageId":r.get::<Option<i64>,_>("target_message_id"),"lastError":r.get::<Option<String>,_>("last_error"),"stopReason":r.get::<Option<String>,_>("stop_reason"),"diagnostics":r.get::<Value,_>("diagnostics_json"),"createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),"updatedAt":r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at"),"completedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("completed_at")})
}
const CHANNEL_SELECT: &str = "SELECT c.*,EXISTS(SELECT 1 FROM resource_sources s WHERE s.channel_id=c.id AND s.enabled) published FROM crawl_channels c";
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
        let mut v = json!({"id":id,"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"enabled":r.get::<bool,_>("enabled"),"managed":r.get::<bool,_>("managed"),"archived":r.get::<bool,_>("archived"),"published":r.get::<bool,_>("published"),"version":r.get::<i64,_>("version"),"intervalSeconds":r.get::<i32,_>("interval_seconds"),"newestMessage":r.get::<i64,_>("newest_message"),"oldestMessage":r.get::<Option<i64>,_>("oldest_message"),"lastSyncedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("last_synced_at"),"nextSyncAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_sync_at"),"coverage":r.get::<String,_>("coverage"),"lastError":r.get::<Option<String>,_>("last_error"),"messageCount":st.get::<i64,_>("message_count"),"resourceCount":st.get::<i64,_>("resource_count"),"failureCount":st.get::<i64,_>("failure_count"),"latestJob":st.get::<Option<Value>,_>("latest_job"),"outbound":p,"effectiveOutbound":effective});
        if details {
            v["transform"] = json!(r.get::<Option<String>, _>("transform"));
            let bindings=sqlx::query("SELECT id,name,enabled FROM resource_sources WHERE channel_id=$1 ORDER BY priority,id").bind(&id).fetch_all(pool).await?;
            v["bindings"]=json!(bindings.iter().map(|s|json!({"id":s.get::<String,_>("id"),"name":s.get::<String,_>("name"),"published":s.get::<bool,_>("enabled")})).collect::<Vec<_>>());
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
    let published = flag(&q, "published")?;
    let managed = flag(&q, "managed")?;
    let filter = " WHERE NOT c.archived AND ($1='' OR c.id ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%') AND ($2::bool IS NULL OR c.enabled=$2) AND ($3::bool IS NULL OR EXISTS(SELECT 1 FROM resource_sources s WHERE s.channel_id=c.id AND s.enabled)=$3) AND ($4::bool IS NULL OR c.managed=$4)";
    let kw = q.get("q").cloned().unwrap_or_default();
    let total =
        sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM crawl_channels c{filter}"))
            .bind(&kw)
            .bind(enabled)
            .bind(published)
            .bind(managed)
            .fetch_one(&s.pool)
            .await?;
    let rows = sqlx::query(&format!(
        "{CHANNEL_SELECT}{filter} ORDER BY c.managed DESC,c.id LIMIT $5 OFFSET $6"
    ))
    .bind(kw)
    .bind(enabled)
    .bind(published)
    .bind(managed)
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
    let r = sqlx::query(&format!(
        "{CHANNEL_SELECT} WHERE c.id=$1 AND NOT c.archived"
    ))
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
    pub interval_seconds: i32,
    #[serde(default)]
    pub transform: Option<String>,
    pub outbound: Policy,
    #[serde(default)]
    pub expected_version: i64,
    #[serde(default)]
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub publish: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub name: String,
    pub published: bool,
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
    if f.name.trim().is_empty()
        || f.name.len() > 240
        || f.description.len() > 4000
        || !(60..=86400).contains(&f.interval_seconds)
    {
        return Err(ApiError::BadRequest(
            "名称必填，同步间隔须为60～86400秒".into(),
        ));
    }
    if let Some(ref dsl) = f.transform {
        crate::transform::validate(dsl)?;
    }
    let mut tx = s.pool.begin().await?;
    if create {
        let inserted=sqlx::query("INSERT INTO crawl_channels(id,name,description,managed,enabled,interval_seconds,transform) VALUES($1,$2,$3,true,$4,$5,$6) ON CONFLICT DO NOTHING").bind(id).bind(f.name.trim()).bind(&f.description).bind(f.enabled).bind(f.interval_seconds).bind(&f.transform).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            return Err(ApiError::Conflict("频道已存在，请在现有频道中编辑".into()));
        }
    } else {
        let n=sqlx::query("UPDATE crawl_channels SET name=$2,description=$3,enabled=$4,interval_seconds=$5,transform=$6,version=version+1,updated_at=now() WHERE id=$1 AND version=$7 AND NOT archived").bind(id).bind(f.name.trim()).bind(&f.description).bind(f.enabled).bind(f.interval_seconds).bind(&f.transform).bind(f.expected_version).execute(&mut *tx).await?.rows_affected();
        if n == 0 {
            return Err(ApiError::Conflict(
                "频道不存在或配置已被其他操作更新，请重新加载".into(),
            ));
        }
    }
    outbound::save(&mut tx, Owner::Channel(id), &f.outbound).await?;
    for b in f.bindings {
        let n=sqlx::query("UPDATE resource_sources SET name=$3,enabled=$4,updated_at=now() WHERE id=$1 AND channel_id=$2").bind(&b.id).bind(id).bind(b.name).bind(b.published).execute(&mut *tx).await?.rows_affected();
        if n == 0 {
            return Err(ApiError::BadRequest("公共来源绑定不属于该频道".into()));
        }
        if b.published {
            sqlx::query(
                "INSERT INTO search_setting_sources(source_id) VALUES($1) ON CONFLICT DO NOTHING",
            )
            .bind(b.id)
            .execute(&mut *tx)
            .await?;
        }
    }
    if f.publish {
        let has = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM resource_sources WHERE channel_id=$1)",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if !has {
            let source_id = format!("tg-{id}");
            sqlx::query("INSERT INTO resource_sources(id,name,description,url,method,format,priority,enabled,transform,channel_id,kind) VALUES($1,$2,$3,$4,'GET','html',0,true,'',$5,'telegram')").bind(&source_id).bind(&f.name).bind(&f.description).bind(format!("https://t.me/s/{id}")).bind(id).execute(&mut *tx).await?;
            sqlx::query(
                "INSERT INTO search_setting_sources(source_id) VALUES($1) ON CONFLICT DO NOTHING",
            )
            .bind(source_id)
            .execute(&mut *tx)
            .await?;
        }
    }
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
pub async fn crawl_channel_archive(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let mut tx = s.pool.begin().await?;
    let requested = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(requested_until>now(),false) FROM crawl_channels WHERE id=$1 FOR UPDATE",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    if requested {
        return Err(ApiError::Conflict(
            "仍有有效用户请求该频道，请先解除请求或等待到期".into(),
        ));
    }
    let users = sqlx::query_scalar::<_, Value>(
        "SELECT custom_channels_json FROM users WHERE deleted_at IS NULL",
    )
    .fetch_all(&mut *tx)
    .await?;
    if users
        .iter()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(Value::as_str)
        .any(|v| crate::telegram::normalize_channel(v).as_deref() == Some(id.as_str()))
    {
        return Err(ApiError::Conflict("仍有用户绑定该频道，不能归档".into()));
    }
    let n=sqlx::query("UPDATE crawl_channels SET archived=true,enabled=false,version=version+1 WHERE id=$1 AND NOT archived").bind(&id).execute(&mut *tx).await?.rows_affected();
    if n == 0 {
        return Err(ApiError::NotFound("频道不存在".into()));
    }
    sqlx::query("UPDATE crawl_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL,stop_reason='channel_archived',completed_at=now() WHERE channel_id=$1 AND status IN ('queued','running','paused')").bind(&id).execute(&mut *tx).await?;
    sqlx::query("UPDATE resource_sources SET enabled=false WHERE channel_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crawl::bump(&mut tx).await?;
    tx.commit().await?;
    *s.search_cache.lock().await = Default::default();
    Ok(ok(json!({"ok":true})))
}
pub async fn crawl_default_get(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    Ok(ok(
        json!({"outbound":outbound::read(&s.pool,Owner::Default).await?,"inheritors":sqlx::query_scalar::<_,i64>("SELECT count(*) FROM outbound_policies p JOIN crawl_channels c ON c.id=p.channel_id WHERE p.inherit AND NOT c.archived").fetch_one(&s.pool).await?}),
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
    let review=sqlx::query_scalar::<_,i64>("SELECT count(*) FROM source_messages m JOIN crawl_channels c ON c.id=m.channel_id WHERE NOT c.archived AND m.parse_status IN ('failed','review')").fetch_one(&s.pool).await?;
    Ok(ok(
        json!({"workerState":match workers{None=>"unknown",Some(0)=>"offline",Some(_)=>"online"},"workerCount":workers,"queued":jobs.get::<i64,_>("queued"),"running":jobs.get::<i64,_>("running"),"failed":jobs.get::<i64,_>("failed"),"review":review,"serverTime":chrono::Utc::now()}),
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
    let max = b.get("maxPages").and_then(Value::as_i64).unwrap_or(500);
    if !(1..=10000).contains(&max) {
        return Err(ApiError::BadRequest("预算须为1～10000".into()));
    }
    let id = crawl::enqueue_request(
        &s.pool,
        &channel,
        kind,
        max as i32,
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
    let j = sqlx::query("SELECT channel_id,kind,target_message_id FROM crawl_jobs WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::NotFound("任务不存在".into()))?;
    let channel = j.get::<String, _>("channel_id");
    sqlx::query("SELECT id FROM crawl_channels WHERE id=$1 FOR UPDATE")
        .bind(&channel)
        .fetch_one(&mut *tx)
        .await?;
    let n=sqlx::query("UPDATE crawl_jobs SET status='queued',attempts=0,last_error=NULL,lease_id=NULL,lease_until=NULL,completed_at=NULL,next_run_at=now() WHERE id=$1 AND status='failed' AND EXISTS(SELECT 1 FROM crawl_channels WHERE id=$2 AND enabled AND NOT archived) AND NOT EXISTS(SELECT 1 FROM crawl_jobs WHERE channel_id=$2 AND kind=$3 AND target_message_id IS NOT DISTINCT FROM $4 AND status IN ('queued','running','paused'))").bind(id).bind(channel).bind(j.get::<String,_>("kind")).bind(j.get::<Option<i64>,_>("target_message_id")).execute(&mut *tx).await?.rows_affected();
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
    review: bool,
) -> Result<Value, ApiError> {
    let size = number(&q, "limit", 20, 1, 100)?;
    let parsed = read_cursor(&q, if review { "review" } else { "messages" })?;
    if !review && parsed.as_ref().is_some_and(|c| c.channel != channel) {
        return Err(ApiError::BadRequest("游标不属于该频道".into()));
    }
    let cursor = parsed.as_ref().map(|c| c.id).unwrap_or(i64::MAX);
    let before_channel = parsed
        .as_ref()
        .map(|c| c.channel.clone())
        .unwrap_or_default();
    let before_date = parsed.as_ref().and_then(|c| c.date);
    let mut rows=sqlx::query("SELECT m.channel_id,m.message_id,m.published_at,m.parse_status,m.parse_error,m.parse_version,m.raw_html FROM source_messages m JOIN crawl_channels c ON c.id=m.channel_id WHERE NOT c.archived AND ($1='' OR m.channel_id=$1) AND ($2='' OR m.parse_status=$2) AND (NOT $3 OR m.parse_status IN ('failed','review')) AND ($3 OR m.message_id<$4) AND (NOT $3 OR $9::timestamptz IS NULL OR COALESCE(m.published_at,to_timestamp(0))<$9 OR (COALESCE(m.published_at,to_timestamp(0))=$9 AND (m.channel_id>$5 OR (m.channel_id=$5 AND m.message_id<$4)))) AND ($6::timestamptz IS NULL OR m.published_at>=$6) AND ($7::timestamptz IS NULL OR m.published_at<=$7) ORDER BY CASE WHEN $3 THEN COALESCE(m.published_at,to_timestamp(0)) ELSE NULL END DESC,m.channel_id,m.message_id DESC LIMIT $8").bind(channel).bind(q.get("status").cloned().unwrap_or_default()).bind(review).bind(cursor).bind(before_channel).bind(date(&q,"from")?).bind(date(&q,"to")?).bind(size+1).bind(before_date).fetch_all(pool).await?;
    let more = rows.len() > size as usize;
    rows.truncate(size as usize);
    Ok(
        json!({"items":rows.iter().map(message).collect::<Vec<_>>(),"hasMore":more,"nextCursor":if more{rows.last().map(|r|cursor_value(if review{"review"}else{"messages"},r.get::<i64,_>("message_id"),r.get::<String,_>("channel_id"),if review{Some(r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("published_at").unwrap_or(chrono::DateTime::from_timestamp(0,0).unwrap()))}else{None}))}else{None}}),
    )
}
pub async fn crawl_messages(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(channel): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    Ok(ok(message_list(&s.pool, &channel, q, false).await?))
}
pub async fn crawl_review(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let channel = q.get("channel").cloned().unwrap_or_default();
    Ok(ok(message_list(&s.pool, &channel, q, true).await?))
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
pub async fn crawl_message_reparse(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path((channel, id)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let mut tx = s.pool.begin().await?;
    let c = sqlx::query_scalar::<_, bool>(
        "SELECT enabled AND NOT archived FROM crawl_channels WHERE id=$1 FOR UPDATE",
    )
    .bind(&channel)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);
    if !c {
        return Err(ApiError::Conflict("频道暂停或不存在".into()));
    }
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM source_messages WHERE channel_id=$1 AND message_id=$2)",
    )
    .bind(&channel)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(ApiError::NotFound("消息不存在".into()));
    }
    let active=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM crawl_jobs WHERE channel_id=$1 AND kind='reparse_message' AND target_message_id=$2 AND status IN ('queued','running','paused'))").bind(&channel).bind(id).fetch_one(&mut *tx).await?;
    if active {
        return Err(ApiError::Conflict("该消息已有重解析任务".into()));
    }
    let job=sqlx::query_scalar::<_,i64>("INSERT INTO crawl_jobs(channel_id,kind,target_message_id,max_pages) VALUES($1,'reparse_message',$2,1) RETURNING id").bind(channel).bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(ok(json!({"id":job})))
}
