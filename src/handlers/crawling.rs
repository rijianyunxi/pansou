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
    // Task counts are live; resource summaries may retain their 30-second cache.
    let task_counts =
        sqlx::query_as::<_, (String, i64, i64)>(include_str!("../sql/channel_task_counts.sql"))
            .bind(&ids)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|(id, failed, today_success)| (id, (failed, today_success)))
            .collect::<HashMap<_, _>>();
    let policies = sqlx::query(&format!(
        "SELECT p.channel_id,{} FROM outbound_policies p WHERE p.channel_id=ANY($1)",
        outbound::POLICY_COLUMNS
    ))
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let daily_allowed =
        crawl::DailySchedule::new(&crawl::settings(pool).await?)?.allows_pages(chrono::Utc::now());
    let task_states = sqlx::query(include_str!("../sql/channel_task_states.sql"))
        .bind(&ids)
        .bind(daily_allowed)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| (r.get::<String, _>("id"), r))
        .collect::<HashMap<_, _>>();
    let mut by_channel = HashMap::new();
    for r in policies {
        let p = outbound::from_row(&r)?;
        if let Some(id) = r.get::<Option<String>, _>("channel_id") {
            by_channel.insert(id, p);
        }
    }
    let mut items = Vec::with_capacity(rows.len());
    for r in rows {
        let id = r.get::<String, _>("id");
        let st = &stats[&id];
        let (failed_count, today_success_count) = task_counts[&id];
        let task = &task_states[&id];
        let p = by_channel.get(&id);
        let mut v = json!({"id":id,"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"enabled":r.get::<bool,_>("enabled"),"version":r.get::<i64,_>("version"),"historyComplete":r.get::<bool,_>("history_complete"),"historyCursor":r.get::<Option<i64>,_>("history_cursor"),"historyPages":r.get::<i32,_>("history_pages"),"nextPageAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_page_at"),"newestMessage":r.get::<i64,_>("newest_message"),"oldestMessage":r.get::<Option<i64>,_>("oldest_message"),"lastSyncedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("last_synced_at"),"nextSyncAt":r.get::<chrono::DateTime<chrono::Utc>,_>("next_sync_at"),"coverage":r.get::<String,_>("coverage"),"lastError":r.get::<Option<String>,_>("last_error"),"failedMessageCount":failed_count,"todaySuccessCount":today_success_count,"resourceCount":st.resource_count,"todayResourceCount":st.today_resource_count,"latestJob":task.get::<Option<Value>,_>("latest_job"),"taskState":task.get::<String,_>("task_state"),"taskStateAt":task.get::<chrono::DateTime<chrono::Utc>,_>("observed_at"),"outbound":p,"effectiveOutbound":p});
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
    // tasks and outbound policies cascade away. Resource content remains stored.
    for statement in [
        "UPDATE managed_resources SET source_channel_ids=array_remove(source_channel_ids,$1) WHERE source_channel_ids @> ARRAY[$1]::text[]",
        "DELETE FROM crawl_message_tasks WHERE channel_id=$1",
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
    let scheduling = crawl::settings(&s.pool).await?;
    let daily_allowed = crawl::DailySchedule::new(&scheduling)?.allows_pages(chrono::Utc::now());
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
    .bind(daily_allowed)
    .fetch_one(&s.pool)
    .await?;
    let review = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM crawl_page_failures")
        .fetch_one(&s.pool)
        .await?;
    let failed_messages = crawl::failed_message_count(&s.pool).await?;
    let worker_enabled = crate::runtime::settings(&s).await?.crawl_enabled;
    Ok(ok(
        json!({"workerState":match workers{None=>"unknown",Some(0)=>"offline",Some(_)=>"online"},"workerCount":workers,"workerEnabled":worker_enabled,"queued":jobs.get::<i64,_>("queued"),"running":jobs.get::<i64,_>("running"),"backoff":jobs.get::<i64,_>("backoff"),"fetching":jobs.get::<i64,_>("fetching"),"failed":jobs.get::<i64,_>("failed"),"review":review,"failedMessages":failed_messages,"scheduling":scheduling,"serverTime":chrono::Utc::now()}),
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
async fn message_list(
    pool: &PgPool,
    channel: &str,
    q: HashMap<String, String>,
) -> Result<Value, ApiError> {
    let size = number(&q, "pageSize", 20, 1, 100)?;
    let page = number(&q, "page", 1, 1, 1000000)?;
    let status = q.get("status").map(String::as_str).unwrap_or("all");
    let scope = q.get("scope").map(String::as_str).unwrap_or("all");
    if !matches!(status, "all" | "success" | "failed") || !matches!(scope, "all" | "today") {
        return Err(ApiError::BadRequest("无效的任务筛选".into()));
    }
    let mut tx = pool.begin().await?;
    crawl::prune_tasks(&mut tx, channel).await?;
    let counts = sqlx::query("SELECT count(*) total,count(*) FILTER(WHERE status<>'failed') success,count(*) FILTER(WHERE status='failed') failed FROM crawl_message_tasks WHERE channel_id=$1 AND ($2='all' OR task_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))")
        .bind(channel).bind(scope).fetch_one(&mut *tx).await?;
    let rows = sqlx::query("SELECT t.message_id,t.task_at,t.status,t.error_message,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name) ORDER BY r.name,r.id) FROM managed_resources r WHERE r.id=ANY(t.resource_ids)),'[]'::jsonb) resources FROM crawl_message_tasks t WHERE t.channel_id=$1 AND ($2='all' OR ($2='success' AND t.status<>'failed') OR ($2='failed' AND t.status='failed')) AND ($3='all' OR t.task_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')) ORDER BY t.task_at DESC,t.message_id DESC LIMIT $4 OFFSET $5")
        .bind(channel).bind(status).bind(scope).bind(size).bind((page-1)*size).fetch_all(&mut *tx).await?;
    let total = counts.get::<i64, _>(match status {
        "success" => "success",
        "failed" => "failed",
        _ => "total",
    });
    let items: Vec<_> = rows.iter().map(|r| json!({"messageId":r.get::<i64,_>("message_id"),"taskAt":r.get::<chrono::DateTime<chrono::Utc>,_>("task_at"),"status":r.get::<String,_>("status"),"errorMessage":r.get::<Option<String>,_>("error_message"),"resources":r.get::<Value,_>("resources")})).collect();
    let result = json!({"items":items,"total":total,"page":page,"pageSize":size,"counts":{"all":counts.get::<i64,_>("total"),"success":counts.get::<i64,_>("success"),"failed":counts.get::<i64,_>("failed")}});
    tx.commit().await?;
    Ok(result)
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
    Path((channel, message)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let row = sqlx::query("SELECT message_id,task_at,status,error_message,raw_html,published_at FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=$2")
        .bind(&channel).bind(message).fetch_optional(&s.pool).await?
        .ok_or_else(|| ApiError::NotFound("采集记录不存在或已处理".into()))?;
    let raw_html = row.get::<Option<String>, _>("raw_html");
    Ok(ok(json!({
        "messageId": row.get::<i64, _>("message_id"),
        "taskAt": row.get::<chrono::DateTime<chrono::Utc>, _>("task_at"),
        "status": row.get::<String, _>("status"),
        "errorMessage": row.get::<Option<String>, _>("error_message"),
        "publishedAt": row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("published_at"),
        "rawText": raw_html.as_deref().map(crate::telegram::message_text),
        "rawHtml": raw_html,
        "messageUrl": format!("https://t.me/{channel}/{message}"),
    })))
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
    crawl::lock_index(&mut tx).await?;
    let enabled =
        sqlx::query_scalar::<_, bool>("SELECT enabled FROM crawl_channels WHERE id=$1 FOR UPDATE")
            .bind(&channel)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    let targets = sqlx::query_scalar::<_, i64>(
        "SELECT message_id FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=ANY($2) AND status='failed' ORDER BY message_id DESC",
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
        // Discard the failed task; resource provenance lives independently.
        sqlx::query("DELETE FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=ANY($2) AND status='failed'")
            .bind(&channel)
            .bind(&ids)
            .execute(&mut *tx)
            .await?;
        crawl::prune_tasks(&mut tx, &channel).await?;
    }
    tx.commit().await?;
    Ok(ok(json!({"affected":ids.len(),"jobs":jobs})))
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrawlCronPreview {
    daily_cron: String,
}

pub async fn crawl_cron_preview(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(f): Json<CrawlCronPreview>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    if f.daily_cron.len() > 200 {
        return Err(ApiError::BadRequest("cron 表达式最多 200 个字符".into()));
    }
    let expression = f
        .daily_cron
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let plan = crawl::DailySchedule::from_expression(&expression)?;
    let observed: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&s.pool)
        .await?;
    let mut cursor = observed;
    let mut times = Vec::with_capacity(5);
    for _ in 0..5 {
        cursor = plan.next_after(cursor)?;
        times.push(cursor);
    }
    Ok(ok(
        json!({"dailyCron":expression,"timeZone":"Asia/Shanghai","nextRuns":times,"observedAt":observed}),
    ))
}

pub async fn crawl_settings_put(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(mut f): Json<crawl::Settings>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    if !(1..=32).contains(&f.concurrent_channels) || !(0..=3600).contains(&f.page_delay_seconds) {
        return Err(ApiError::BadRequest("并发1～32，等待0～3600秒".into()));
    }
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(773012)")
        .execute(&mut *tx)
        .await?;
    f.daily_cron = f
        .daily_cron
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let plan = crawl::DailySchedule::new(&f)?;
    let now: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *tx)
        .await?;
    let next = plan.next_after(now)?;
    let old = sqlx::query_scalar::<_, String>("SELECT daily_cron FROM crawl_settings WHERE id=1")
        .fetch_one(&mut *tx)
        .await?;
    let n=sqlx::query("UPDATE crawl_settings SET concurrent_channels=$1,page_delay_seconds=$2,daily_cron=$3,version=version+1 WHERE id=1 AND version=$4").bind(f.concurrent_channels).bind(f.page_delay_seconds).bind(&f.daily_cron).bind(f.version).execute(&mut *tx).await?.rows_affected();
    if n == 0 {
        return Err(ApiError::Conflict("配置已更新，请重新加载".into()));
    }
    sqlx::query("UPDATE crawl_channels SET next_sync_at=CASE WHEN last_synced_at IS NULL THEN now() ELSE $1 END")
        .bind(next).execute(&mut *tx).await?;
    if old != f.daily_cron {
        sqlx::query("UPDATE crawl_jobs j SET next_run_at=CASE WHEN c.last_synced_at IS NULL OR $1 THEN now() ELSE $2 END FROM crawl_channels c WHERE c.id=j.channel_id AND j.kind='sync' AND j.status='queued' AND j.attempts=0")
            .bind(plan.allows_pages(now)).bind(next).execute(&mut *tx).await?;
    }
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
