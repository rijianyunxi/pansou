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
const CHANNEL_SELECT: &str = "SELECT c.* FROM crawl_channels c";
async fn channels_data(
    state: &AppState,
    rows: Vec<PgRow>,
    details: bool,
) -> Result<Vec<Value>, ApiError> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let pool = &state.pool;
    let ids = rows
        .iter()
        .map(|r| r.get::<String, _>("id"))
        .collect::<Vec<_>>();
    let stats = state.admin_stats.channels(pool, &ids).await?;
    let policies=sqlx::query(&format!("SELECT p.channel_id,p.default_key,{} FROM outbound_policies p WHERE p.channel_id=ANY($1) OR p.default_key='telegram'",outbound::POLICY_COLUMNS)).bind(&ids).fetch_all(pool).await?;
    let task_states = sqlx::query(include_str!("../sql/channel_task_states.sql"))
        .bind(&ids).fetch_all(pool).await?
        .into_iter().map(|r| (r.get::<String, _>("id"), r)).collect::<HashMap<_, _>>();
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
        let task = &task_states[&id];
        let p = by_channel.get(&id);
        let effective = if p.is_some_and(|p| p.inherit) {
            default.as_ref()
        } else {
            p
        };
        let mut v = json!({"id":id,"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"enabled":r.get::<bool,_>("enabled"),"version":r.get::<i64,_>("version"),"historyComplete":r.get::<bool,_>("history_complete"),"historyCursor":r.get::<Option<i64>,_>("history_cursor"),"historyPages":r.get::<i32,_>("history_pages"),"nextPageAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_page_at"),"newestMessage":r.get::<i64,_>("newest_message"),"oldestMessage":r.get::<Option<i64>,_>("oldest_message"),"lastSyncedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("last_synced_at"),"nextSyncAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_sync_at"),"coverage":r.get::<String,_>("coverage"),"lastError":r.get::<Option<String>,_>("last_error"),"failedMessageCount":st.failed_count,"resourceCount":st.resource_count,"latestJob":task.get::<Option<Value>,_>("latest_job"),"taskState":task.get::<String,_>("task_state"),"taskStateAt":task.get::<chrono::DateTime<chrono::Utc>,_>("observed_at"),"outbound":p,"effectiveOutbound":effective});
        if details {
            v["transform"] = json!(r.get::<Option<String>, _>("transform"));
        }
        v["taskPhase"] = json!(task.get::<Option<String>, _>("task_phase"));
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
    let items = channels_data(&s, rows, false).await?;
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
    Ok(ok(channels_data(&s, vec![r], true).await?.remove(0)))
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
    s.admin_stats.invalidate().await;
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
pub async fn crawl_channel_delete(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let mut tx = s.pool.begin().await?;
    // Match page commits/config edits: index first, then channel. In-flight
    // requests cannot commit after this transaction deletes their channel/job.
    crawl::lock_index(&mut tx).await?;
    sqlx::query("SELECT id FROM crawl_channels WHERE id=$1 FOR UPDATE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    // Retain managed resources and their links. Only remove ingestion history;
    // occurrence projections, statistics and outbound policies cascade away.
    for statement in [
        "DELETE FROM resource_occurrences WHERE channel_id=$1",
        "DELETE FROM source_messages WHERE channel_id=$1",
        "DELETE FROM crawl_page_failures WHERE channel_id=$1",
        "DELETE FROM crawl_jobs WHERE channel_id=$1",
        "UPDATE resource_sources SET channel_id=NULL WHERE channel_id=$1",
        "DELETE FROM crawl_channels WHERE id=$1",
    ] {
        sqlx::query(statement).bind(&id).execute(&mut *tx).await?;
    }
    crawl::bump(&mut tx).await?;
    tx.commit().await?;
    *s.search_cache.lock().await = Default::default();
    s.admin_stats.invalidate().await;
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
    let jobs = sqlx::query(&format!(
        "WITH channel_states AS ({}) SELECT
         count(*) FILTER(WHERE task_state='queued') queued,
         count(*) FILTER(WHERE task_state='running') running,
         count(*) FILTER(WHERE task_state='backoff') backoff,
         count(*) FILTER(WHERE task_phase='fetching') fetching,
         count(*) FILTER(WHERE task_state='failed') failed FROM channel_states",
        include_str!("../sql/channel_task_states.sql"),
    ))
    .bind(Option::<Vec<String>>::None)
    .fetch_one(&s.pool)
    .await?;
    let review = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM crawl_page_failures")
        .fetch_one(&s.pool)
        .await?;
    let worker_enabled = crate::runtime::settings(&s).await?.crawl_enabled;
    let scheduling = crawl::settings(&s.pool).await?;
    Ok(ok(
        json!({"workerState":match workers{None=>"unknown",Some(0)=>"offline",Some(_)=>"online"},"workerCount":workers,"workerEnabled":worker_enabled,"queued":jobs.get::<i64,_>("queued"),"running":jobs.get::<i64,_>("running"),"backoff":jobs.get::<i64,_>("backoff"),"fetching":jobs.get::<i64,_>("fetching"),"failed":jobs.get::<i64,_>("failed"),"review":review,"scheduling":scheduling,"serverTime":chrono::Utc::now()}),
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
fn message(r: &PgRow) -> Value {
    json!({"channelId":r.get::<String,_>("channel_id"),"messageId":r.get::<i64,_>("message_id"),"publishedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("published_at"),"status":r.get::<String,_>("parse_status"),"parseError":r.get::<Option<String>,_>("parse_error"),"parseVersion":r.get::<String,_>("parse_version")})
}
async fn message_list(
    pool: &PgPool,
    channel: &str,
    q: HashMap<String, String>,
) -> Result<Value, ApiError> {
    let size = number(&q, "pageSize", 20, 1, 100)?;
    let page = number(&q, "page", 1, 1, 1000000)?;
    let status = q.get("status").cloned().unwrap_or_default();
    let from = date(&q, "from")?;
    let to = date(&q, "to")?;
    let rows=sqlx::query("SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version FROM source_messages WHERE channel_id=$1 AND ($2='' OR parse_status=$2) AND ($3::timestamptz IS NULL OR published_at>=$3) AND ($4::timestamptz IS NULL OR published_at<=$4) ORDER BY message_id DESC LIMIT $5 OFFSET $6").bind(channel).bind(&status).bind(from).bind(to).bind(size).bind((page-1)*size).fetch_all(pool).await?;
    // Trigger-maintained totals answer instantly without a date window; with
    // one, the aggregate scopes every count to that published_at range.
    let counts = if from.is_none() && to.is_none() {
        let r=sqlx::query("SELECT COALESCE(message_count,0) total,COALESCE(parsed_count,0) parsed,COALESCE(empty_count,0) empty,COALESCE(failed_count,0) failed FROM channel_statistics WHERE channel_id=$1").bind(channel).fetch_optional(pool).await?;
        r.map(|r| (r.get::<i64, _>("total"), r.get::<i64, _>("parsed"), r.get::<i64, _>("empty"), r.get::<i64, _>("failed"))).unwrap_or_default()
    } else {
        let r=sqlx::query("SELECT count(*) total,count(*) FILTER(WHERE parse_status='parsed') parsed,count(*) FILTER(WHERE parse_status='empty') empty,count(*) FILTER(WHERE parse_status='failed') failed FROM source_messages WHERE channel_id=$1 AND ($2::timestamptz IS NULL OR published_at>=$2) AND ($3::timestamptz IS NULL OR published_at<=$3)").bind(channel).bind(from).bind(to).fetch_one(pool).await?;
        (r.get::<i64, _>("total"), r.get::<i64, _>("parsed"), r.get::<i64, _>("empty"), r.get::<i64, _>("failed"))
    };
    let total = match status.as_str() {
        "parsed" => counts.1,
        "empty" => counts.2,
        "failed" => counts.3,
        _ => counts.0,
    };
    Ok(
        json!({"items":rows.iter().map(message).collect::<Vec<_>>(),"total":total,"page":page,"pageSize":size,"counts":{"all":counts.0,"parsed":counts.1,"empty":counts.2,"failed":counts.3}}),
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageAction {
    action: String,
    ids: Vec<i64>,
}
pub async fn crawl_messages_action(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(channel): Path<String>,
    Json(f): Json<MessageAction>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let mut ids = f.ids.clone();
    ids.sort_unstable();
    ids.dedup();
    ids.retain(|id| *id >= 1);
    if ids.is_empty() || ids.len() > 100 || !matches!(f.action.as_str(), "retry" | "ignore") {
        return Err(ApiError::BadRequest(
            "请选择1～100条记录及重试/忽略操作".into(),
        ));
    }
    let mut tx = s.pool.begin().await?;
    let enabled = sqlx::query_scalar::<_, bool>(
        "SELECT enabled FROM crawl_channels WHERE id=$1 FOR UPDATE",
    )
    .bind(&channel)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    let targets = sqlx::query_scalar::<_, i64>(
        "SELECT message_id FROM source_messages WHERE channel_id=$1 AND message_id=ANY($2) AND parse_status='failed' ORDER BY message_id DESC",
    )
    .bind(&channel)
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    if targets.len() != ids.len() {
        return Err(ApiError::Conflict(
            "所选记录不存在或不是失败状态，请刷新".into(),
        ));
    }
    let mut jobs = 0i64;
    if f.action == "retry" {
        if !enabled {
            return Err(ApiError::Conflict("请先恢复频道采集".into()));
        }
        // One retry job per page window: a fetch at cursor=max+1 re-parses
        // the group and its neighbours, walking down to the oldest id.
        let mut group_max = 0i64;
        let mut group_min = 0i64;
        for id in targets {
            if group_max == 0 {
                group_max = id;
                group_min = id;
                continue;
            }
            if group_max - id < 19 {
                group_min = id;
                continue;
            }
            sqlx::query("INSERT INTO crawl_jobs(channel_id,kind,cursor_before,stop_at) VALUES($1,'retry',$2,$3)")
                .bind(&channel).bind(group_max + 1).bind(group_min).execute(&mut *tx).await?;
            jobs += 1;
            group_max = id;
            group_min = id;
        }
        if group_max > 0 {
            sqlx::query("INSERT INTO crawl_jobs(channel_id,kind,cursor_before,stop_at) VALUES($1,'retry',$2,$3)")
                .bind(&channel).bind(group_max + 1).bind(group_min).execute(&mut *tx).await?;
            jobs += 1;
        }
    } else {
        // Failed rows carry no live occurrences; clear any stale ones first
        // so the message delete cannot hit the occurrence foreign key.
        sqlx::query("DELETE FROM resource_occurrences WHERE channel_id=$1 AND message_id=ANY($2)")
            .bind(&channel)
            .bind(&ids)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM source_messages WHERE channel_id=$1 AND message_id=ANY($2) AND parse_status='failed'")
            .bind(&channel)
            .bind(&ids)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(ok(json!({"affected":ids.len(),"jobs":jobs})))
}
pub async fn crawl_message_get(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path((channel, id)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let r = sqlx::query("SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version FROM source_messages WHERE channel_id=$1 AND message_id=$2")
        .bind(&channel)
        .bind(id)
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("消息不存在".into()))?;
    let stored=sqlx::query("SELECT o.result_json,r.id,r.enabled,r.manual_override,r.deleted_at FROM resource_occurrences o JOIN managed_resources r ON r.id=o.resource_id WHERE o.channel_id=$1 AND o.message_id=$2").bind(&channel).bind(id).fetch_all(&s.pool).await?;
    let mut data = message(&r);
    data["stored"]=json!(stored.iter().map(|r|json!({"result":r.get::<Value,_>("result_json"),"enabled":r.get::<bool,_>("enabled"),"manualOverride":r.get::<bool,_>("manual_override"),"deleted":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("deleted_at").is_some()})).collect::<Vec<_>>());
    Ok(ok(data))
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
            let job=sqlx::query_scalar::<_,i64>("INSERT INTO crawl_jobs(channel_id,kind,cursor_before,stop_at,failure_id) VALUES($1,'retry',$2,COALESCE($2,0),$3) RETURNING id").bind(&channel).bind(r.get::<Option<i64>,_>("cursor_before")).bind(id).fetch_one(&mut *tx).await?;
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
