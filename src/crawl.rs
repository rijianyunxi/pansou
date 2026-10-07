use crate::{
    app::AppState,
    error::ApiError,
    models::{SearchResult, Source},
    resource_clean, telegram, transform,
};
use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

mod schedule;
pub use schedule::DailySchedule;

pub const SETTINGS_SELECT: &str = "SELECT concurrent_channels,page_delay_seconds,daily_cron,version FROM crawl_settings WHERE id=1";

pub async fn failed_message_count(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM crawl_message_tasks WHERE status='failed'")
        .fetch_one(pool)
        .await
}

fn hash(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

#[cfg(test)]
pub async fn enqueue(pool: &PgPool, channel: &str, kind: &str) -> Result<i64, ApiError> {
    enqueue_request(pool, channel, kind, None).await
}
pub async fn enqueue_request(
    pool: &PgPool,
    channel: &str,
    kind: &str,
    request_key: Option<&str>,
) -> Result<i64, ApiError> {
    if request_key.is_some_and(|k| k.is_empty() || k.len() > 100) {
        return Err(ApiError::BadRequest("requestKey 长度须为1～100".into()));
    }
    if !matches!(kind, "sync" | "backfill") {
        return Err(ApiError::BadRequest("仅支持日常增量和历史全量".into()));
    }
    let mut tx = pool.begin().await?;
    let enabled =
        sqlx::query_scalar::<_, bool>("SELECT enabled FROM crawl_channels WHERE id=$1 FOR UPDATE")
            .bind(channel)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    if let Some(key) = request_key {
        if let Some(row) =
            sqlx::query("SELECT id,kind FROM crawl_jobs WHERE channel_id=$1 AND request_key=$2")
                .bind(channel)
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
        {
            if row.get::<String, _>("kind") != kind {
                return Err(ApiError::Conflict(
                    "同一 requestKey 不能用于不同任务参数".into(),
                ));
            }
            return Ok(row.get("id"));
        }
    }
    if !enabled {
        return Err(ApiError::Conflict("频道已暂停，请先继续采集".into()));
    }
    let active=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM crawl_jobs WHERE channel_id=$1 AND kind=$2 AND status IN ('queued','running','paused'))").bind(channel).bind(kind).fetch_one(&mut *tx).await?;
    if active {
        return Err(ApiError::Conflict(
            "该频道已有同类型任务，请等待完成或取消".into(),
        ));
    }
    if kind == "backfill"
        && sqlx::query_scalar::<_, bool>("SELECT history_complete FROM crawl_channels WHERE id=$1")
            .bind(channel)
            .fetch_one(&mut *tx)
            .await?
    {
        return Err(ApiError::Conflict("历史已补齐，无需重新全量采集".into()));
    }
    let id=sqlx::query_scalar("INSERT INTO crawl_jobs(channel_id,kind,stop_at,cursor_before,request_key) SELECT id,$2,CASE WHEN $2='sync' THEN newest_message ELSE 0 END,CASE WHEN $2='backfill' THEN history_cursor ELSE NULL END,$3 FROM crawl_channels WHERE id=$1 RETURNING id").bind(channel).bind(kind).bind(request_key).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(id)
}

pub(crate) async fn source_for(pool: &PgPool, channel: &str) -> Result<Source, ApiError> {
    let r = sqlx::query(
        "SELECT c.id,c.name,c.description,c.transform FROM crawl_channels c WHERE c.id=$1",
    )
    .bind(channel)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    Ok(Source {
        id: format!("channel:{channel}"),
        name: r.get("name"),
        description: r.get("description"),
        url: format!("https://t.me/s/{channel}"),
        method: "GET".into(),
        format: "html".into(),
        priority: 0,
        enabled: true,
        request: None,
        transform: r
            .try_get::<Option<String>, _>("transform")?
            .unwrap_or_else(|| telegram::BUILTIN_TRANSFORM.to_owned()),
    })
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMessage {
    pub results: Vec<SearchResult>,
    pub status: String,
    pub error: Option<String>,
}
pub fn parse_message(source: &Source, channel: &str, message: &telegram::Message) -> ParsedMessage {
    match transform::apply(
        &source.transform,
        &message.html,
        "html",
        "",
        &format!("tg:{channel}:{}", message.id),
    ) {
        Err(e) => ParsedMessage {
            results: vec![],
            status: "failed".into(),
            error: Some(e.to_string()),
        },
        Ok(items) => {
            let ambiguous = items.len() == 1 && items[0].links.len() > 12;
            let results = if ambiguous {
                vec![]
            } else {
                items
                    .into_iter()
                    .map(|item| {
                        let mut item = resource_clean::normalize(item);
                        item.datetime = message.published.map(|t| {
                            t.with_timezone(&chrono::FixedOffset::east_opt(28800).unwrap())
                                .format("%Y-%m-%d %H:%M:%S")
                                .to_string()
                        });
                        item
                    })
                    .collect::<Vec<_>>()
            };
            ParsedMessage {
                status: if ambiguous {
                    "failed"
                } else if results.is_empty() {
                    "empty"
                } else {
                    "parsed"
                }
                .into(),
                error: ambiguous.then(|| "聚合消息缺少明确资源边界，需要调整规则".into()),
                results,
            }
        }
    }
}

pub struct Page {
    pub raw: String,
    pub diagnostics: Value,
}

pub async fn fetch_page(
    state: &AppState,
    source: &Source,
    channel: &str,
    before: Option<i64>,
) -> Result<Page, ApiError> {
    let mut plan =
        crate::outbound::Plan::load(&state.pool, crate::outbound::Owner::Channel(channel), "GET")
            .await?;
    let policy = crate::policy::load(&state.pool).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(policy.request_timeout_ms);
    let mut attempts = vec![];
    let mut last = None;
    while let Some(node) = plan.next(&state.pool).await? {
        let start = std::time::Instant::now();
        let result = tokio::time::timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            fetch_page_once(state, source, channel, before, node.clone()),
        )
        .await
        .unwrap_or_else(|_| Err(ApiError::Upstream("采集总预算超时".into())));
        attempts.push(json!({"nodeId":node.as_ref().map(|n|n.id.as_str()).unwrap_or("direct"),"status":if result.is_ok(){"success"}else{"failed"},"elapsedMs":start.elapsed().as_millis()}));
        match result {
            Ok(mut page) => {
                page.diagnostics["attempts"] = json!(attempts);
                page.diagnostics["policyVersion"] = json!(plan.version);
                return Ok(page);
            }
            Err(e) => {
                let text = e.to_string();
                let retry = matches!(
                    &e,
                    ApiError::Crawl {
                        retry_node: true,
                        ..
                    }
                );
                if let Some(ref n) = node {
                    if retry || text.contains("超时") {
                        crate::outbound::record_failure(state, n, None, &text, &policy).await;
                    } else {
                        sqlx::query("UPDATE proxy_nodes SET probe_in_flight=false,probe_lease_until=NULL WHERE id=$1").bind(&n.id).execute(&state.pool).await?;
                    }
                }
                last = Some(e);
                if !retry || tokio::time::Instant::now() >= deadline {
                    break;
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| ApiError::Crawl {
        message: "选中的节点均不可用，未选择直连".into(),
        terminal: true,
        retry_after: 0,
        retry_node: false,
    }))
}
async fn fetch_page_once(
    state: &AppState,
    source: &Source,
    channel: &str,
    before: Option<i64>,
    node: Option<crate::outbound::Candidate>,
) -> Result<Page, ApiError> {
    let target = match before {
        Some(id) => format!("https://t.me/s/{channel}?before={id}"),
        None => format!("https://t.me/s/{channel}"),
    };
    let outbound = node
        .as_ref()
        .map(|n| {
            format!(
                "{}/{}",
                n.base_url.trim_end_matches('/'),
                crate::outbound::encode_proxy_target(&target)
            )
        })
        .unwrap_or_else(|| target.clone());
    let mut url = reqwest::Url::parse(&outbound)
        .map_err(|_| ApiError::BadRequest("采集代理地址无效".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ApiError::BadRequest("采集仅允许 HTTP(S)".into()));
    }
    let allowed_host = url
        .host_str()
        .ok_or_else(|| ApiError::BadRequest("代理地址缺少主机".into()))?
        .to_owned();
    let started = std::time::Instant::now();
    // Do not forward arbitrary source headers/secrets to other hosts or follow uncontrolled redirects.
    let client = &state.crawl_http;
    for redirects in 0..=3 {
        let mut builder = client
            .get(url.clone())
            .header("Accept", "text/html")
            .header("Accept-Encoding", "identity");
        if let Some(headers) = source
            .request
            .as_ref()
            .and_then(|v| v.get("headers"))
            .and_then(Value::as_object)
        {
            for (key, value) in headers {
                if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "user-agent" | "accept-language"
                ) && let Some(value) = value.as_str()
                {
                    builder = builder.header(key, value);
                }
            }
        }
        let response = match builder.send().await {
            Ok(r) => r,
            Err(e) => {
                return Err(ApiError::Crawl {
                    message: format!("采集连接失败：{}", e.without_url()),
                    terminal: true,
                    retry_after: 0,
                    retry_node: true,
                });
            }
        };
        let status = response.status();
        if status.is_redirection() {
            if redirects == 3 {
                return Err(ApiError::Upstream("采集重定向过多".into()));
            }
            let next = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| url.join(v).ok())
                .ok_or_else(|| ApiError::Upstream("无效重定向".into()))?;
            if next.host_str() != Some(&allowed_host)
                || (url.scheme() == "https" && next.scheme() != "https")
            {
                return Err(ApiError::Upstream("拒绝跨主机或降级的采集重定向".into()));
            }
            url = next;
            continue;
        }
        if !status.is_success() {
            let retry = response
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .and_then(|h| {
                    h.parse::<i64>().ok().or_else(|| {
                        DateTime::parse_from_rfc2822(h)
                            .ok()
                            .map(|t| (t.with_timezone(&Utc) - Utc::now()).num_seconds())
                    })
                })
                .unwrap_or(300)
                .clamp(1, 86400);
            return Err(ApiError::Crawl {
                message: format!(
                    "采集 HTTP {}；Retry-After={}；未轮换代理绕过限制",
                    status.as_u16(),
                    retry
                ),
                terminal: matches!(status.as_u16(), 403 | 404),
                retry_after: retry,
                retry_node: matches!(status.as_u16(), 502 | 503 | 504),
            });
        }
        if response
            .content_length()
            .is_some_and(|n| n > 4 * 1024 * 1024)
        {
            return Err(ApiError::Upstream("采集响应超过 4MiB".into()));
        }
        let mut chunks = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), chunks.next())
            .await
            .map_err(|_| ApiError::Upstream("采集读取超时".into()))?
        {
            let chunk = chunk.map_err(|e| ApiError::Upstream(e.without_url().to_string()))?;
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(ApiError::Upstream("采集响应超过 4MiB".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        if let Some(n) = &node {
            crate::outbound::record_success(state, n, status.as_u16()).await;
        }
        let raw = String::from_utf8(bytes)
            .map_err(|_| ApiError::Upstream("TG 页面不是有效 UTF-8".into()))?;
        return Ok(Page {
            raw,
            diagnostics: json!({"target":target,"channelId":channel,"nodeId":node.as_ref().map(|n|n.id.as_str()).unwrap_or("direct"),"httpStatus":status.as_u16(),"elapsedMs":started.elapsed().as_millis()}),
        });
    }
    Err(ApiError::Upstream("采集失败".into()))
}

pub(crate) async fn lock_index(tx: &mut Transaction<'_, Postgres>) -> Result<(), ApiError> {
    sqlx::query("SELECT revision FROM config_revisions WHERE scope='local-index' FOR UPDATE")
        .fetch_one(&mut **tx)
        .await?;
    Ok(())
}
pub(crate) async fn bump(tx: &mut Transaction<'_, Postgres>) -> Result<(), ApiError> {
    sqlx::query("UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
pub async fn persist_message(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
    message: &telegram::Message,
    source: &Source,
) -> Result<(usize, bool), ApiError> {
    let parsed = parse_message(source, channel, message);
    persist_parsed_message(tx, channel, message, parsed).await
}

pub(crate) async fn prune_tasks(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
) -> Result<(), ApiError> {
    sqlx::query("SELECT prune_crawl_tasks($1)")
        .bind(channel)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn persist_parsed_message(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
    message: &telegram::Message,
    parsed: ParsedMessage,
) -> Result<(usize, bool), ApiError> {
    lock_index(tx).await?;
    let items = parsed.results;
    let status = parsed.status.as_str();
    let error = parsed.error;
    sqlx::query("INSERT INTO crawl_message_tasks(channel_id,message_id,task_at,status,error_message,raw_html,published_at) VALUES($1,$2,now(),$3,$4,$5,$6) ON CONFLICT(channel_id,message_id) DO UPDATE SET task_at=now(),status=EXCLUDED.status,error_message=EXCLUDED.error_message,raw_html=EXCLUDED.raw_html,published_at=EXCLUDED.published_at,resource_ids='{}'")
        .bind(channel).bind(message.id).bind(status).bind(error)
        .bind((status == "failed").then_some(message.html.as_str()))
        .bind(message.published).execute(&mut **tx).await?;
    if status == "failed" {
        return Ok((0, true));
    }
    let mut resource_ids = Vec::new();
    for mut item in items.iter().cloned() {
        item.datetime = message.published.map(|t| {
            t.with_timezone(&chrono::FixedOffset::east_opt(28800).unwrap())
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        });
        let mut identities = item
            .links
            .iter()
            .map(|link| resource_clean::link_identity(&link.url))
            .collect::<Vec<_>>();
        identities.sort();
        identities.dedup();
        let fingerprint = hash(&identities.join("\0"));
        let candidate = Uuid::new_v4().to_string();
        // The unique link-set identity also makes retries and concurrent workers idempotent.
        let inserted = sqlx::query_scalar::<_, String>("INSERT INTO managed_resources(id,name,description,datetime,images_json,origin,fingerprint,published_at,source_channel_ids,source_channel_id,source_message_id) VALUES($1,$2,$3,$4,$5,'telegram',$6,$7,ARRAY[$8::text],$8,$9) ON CONFLICT(fingerprint) WHERE origin='telegram' DO NOTHING RETURNING id")
            .bind(&candidate).bind(&item.name).bind(&item.description).bind(&item.datetime)
            .bind(json!(item.images.clone().unwrap_or_default()))
            .bind(&fingerprint).bind(message.published).bind(channel).bind(message.id)
            .fetch_optional(&mut **tx).await?;
        let id = if let Some(id) = inserted {
            crate::resource_links::replace(tx, &id, &item.links).await?;
            id
        } else {
            let id = sqlx::query_scalar::<_, String>("SELECT id FROM managed_resources WHERE origin='telegram' AND fingerprint=$1 FOR UPDATE")
                .bind(&fingerprint).fetch_one(&mut **tx).await?;
            // Keep channel membership even when an older repost or a manual edit
            // prevents replacing the canonical presentation.
            sqlx::query("UPDATE managed_resources SET source_channel_ids=array_append(source_channel_ids,$2) WHERE id=$1 AND NOT ($2=ANY(source_channel_ids))")
                .bind(&id).bind(channel).execute(&mut **tx).await?;
            let writable:bool=sqlx::query_scalar("SELECT enabled AND (published_at IS NULL OR $2::timestamptz>=published_at) FROM managed_resources WHERE id=$1").bind(&id).bind(message.published).fetch_one(&mut **tx).await?;
            if writable {
                sqlx::query("UPDATE managed_resources SET name=$2,description=$3,datetime=$4,images_json=$5,published_at=$6,source_channel_id=$7,source_message_id=$8,updated_at=now() WHERE id=$1 AND (name,description,datetime,images_json,published_at) IS DISTINCT FROM ($2,$3,$4,$5,$6)")
                    .bind(&id).bind(&item.name).bind(&item.description).bind(&item.datetime)
                    .bind(json!(item.images.clone().unwrap_or_default())).bind(message.published).bind(channel).bind(message.id).execute(&mut **tx).await?;
                crate::resource_links::replace(tx, &id, &item.links).await?;
            }
            id
        };
        resource_ids.push(id);
    }
    resource_ids.sort();
    resource_ids.dedup();
    sqlx::query(
        "UPDATE crawl_message_tasks SET resource_ids=$3 WHERE channel_id=$1 AND message_id=$2",
    )
    .bind(channel)
    .bind(message.id)
    .bind(&resource_ids)
    .execute(&mut **tx)
    .await?;
    prune_tasks(tx, channel).await?;
    Ok((items.len(), false))
}

#[derive(serde::Serialize, serde::Deserialize, Clone, sqlx::FromRow)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub concurrent_channels: i32,
    pub page_delay_seconds: i32,
    pub daily_cron: String,
    pub version: i64,
}
pub async fn settings(pool: &PgPool) -> Result<Settings, ApiError> {
    Ok(sqlx::query_as(SETTINGS_SELECT).fetch_one(pool).await?)
}
/// Wait on PostgreSQL notifications, page completion, or the nearest persisted
/// deadline. A minute-long fallback handles missed notifications/reconnections.
pub async fn worker(state: Arc<AppState>) -> Result<(), ApiError> {
    let heartbeat =
        crate::runtime::Heartbeat::start(state.clone(), crate::runtime::WorkerKind::Crawl);
    // Dedicated pool: LISTEN must not occupy an execution slot indefinitely.
    let listener_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect_lazy_with((*state.pool.connect_options()).clone());
    let mut listener: Option<sqlx::postgres::PgListener> = None;
    let mut reconnect_after = tokio::time::Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    let mut retention_due = tokio::time::Instant::now();
    while !state.shutdown.is_cancelled() {
        // Expire yesterday's handled records even for paused channels and
        // outside collection hours. Failures and resources are untouched.
        if tokio::time::Instant::now() >= retention_due {
            if let Err(e) = sqlx::query("SELECT prune_crawl_tasks(NULL)")
                .execute(&state.pool)
                .await
            {
                tracing::warn!(%e, "crawl message retention failed");
            }
            retention_due = tokio::time::Instant::now() + Duration::from_secs(60);
        }
        while let Some(result) = tasks.try_join_next() {
            if let Err(e) = result {
                tracing::error!(%e, "crawl page panicked");
            }
        }
        if listener.is_none() && tokio::time::Instant::now() >= reconnect_after {
            let connect = async {
                let mut connection =
                    sqlx::postgres::PgListener::connect_with(&listener_pool).await?;
                connection.listen("pansou_crawl_wakeup").await?;
                Ok::<_, sqlx::Error>(connection)
            };
            tokio::select! {
                _ = state.shutdown.cancelled() => break,
                result = tokio::time::timeout(Duration::from_secs(3), connect) => {
                    match result {
                        Ok(Ok(connection)) => listener = Some(connection),
                        _ => {
                            reconnect_after = tokio::time::Instant::now() + Duration::from_secs(60);
                            tracing::warn!("crawl notifications unavailable; using deadline fallback");
                        }
                    }
                }
            }
        }
        let mut wait = Duration::from_secs(60);
        if crate::runtime::enabled(&state, crate::runtime::WorkerKind::Crawl)
            .await
            .unwrap_or(false)
        {
            let cycle = async {
                // Scheduling scans are shared across instances; claiming stays
                // independent and retains the cluster-wide capacity lock.
                let scheduled = crate::runtime::schedule_slot(&state, "crawl-schedule", 1).await?;
                let config = if scheduled {
                    schedule_due(&state.pool).await?
                } else {
                    settings(&state.pool).await?
                };
                while tasks.len() < config.concurrent_channels as usize {
                    if state.shutdown.is_cancelled() {
                        break;
                    }
                    let Some(job) = claim_job(&state.pool).await? else {
                        break;
                    };
                    let s = state.clone();
                    tasks.spawn(async move {
                        if let Err(e) = execute_claimed(&s, job).await {
                            tracing::warn!(%e, "crawl page failed to commit");
                        }
                    });
                }
                let delay = next_wake_delay(&state.pool).await?;
                // A notification may arrive during the shared scan cooldown.
                // Revisit when that slot opens even if the next cron deadline is
                // hours away: a completed head page may need a new backfill job.
                Ok::<_, ApiError>(if scheduled {
                    delay
                } else {
                    delay.min(Duration::from_secs(1))
                })
            }
            .await;
            match cycle {
                Ok(delay) => wait = delay,
                Err(e) => tracing::warn!(%e, "crawl scheduling failed"),
            }
        }
        let notification = async {
            match listener.as_mut() {
                Some(connection) => connection.recv().await.map(|_| ()),
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = tokio::time::sleep(wait) => {},
            result = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Err(e)) = result { tracing::error!(%e, "crawl page panicked"); }
            },
            result = notification => {
                if let Err(e) = result {
                    tracing::warn!(%e, "crawl notification connection lost");
                    listener = None;
                    reconnect_after = tokio::time::Instant::now() + Duration::from_secs(60);
                }
            }
        }
    }
    while tasks.join_next().await.is_some() {}
    heartbeat.finish().await;
    Ok(())
}

async fn next_wake_delay(pool: &PgPool) -> Result<Duration, ApiError> {
    let row = sqlx::query("WITH capacity AS (SELECT (SELECT count(*) FROM crawl_jobs WHERE status='running')<concurrent_channels free FROM crawl_settings WHERE id=1), deadlines AS (SELECT lease_until due FROM crawl_jobs WHERE status='running' UNION ALL SELECT GREATEST(j.next_run_at,c.next_page_at) FROM crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id CROSS JOIN capacity WHERE capacity.free AND j.status='queued' AND c.enabled AND NOT EXISTS(SELECT 1 FROM crawl_jobs r WHERE r.channel_id=c.id AND r.status='running') UNION ALL SELECT c.next_sync_at FROM crawl_channels c CROSS JOIN capacity WHERE capacity.free AND c.enabled AND NOT EXISTS(SELECT 1 FROM crawl_jobs j WHERE j.channel_id=c.id AND j.kind='sync' AND j.status IN ('queued','running','paused','failed'))) SELECT min(due) due,now() observed FROM deadlines")
        .fetch_one(pool).await?;
    let Some(due) = row.get::<Option<DateTime<Utc>>, _>("due") else {
        return Ok(Duration::from_secs(60));
    };
    Ok((due - row.get::<DateTime<Utc>, _>("observed"))
        .to_std()
        .unwrap_or_default()
        .clamp(Duration::from_millis(100), Duration::from_secs(60)))
}

async fn schedule_due(pool: &PgPool) -> Result<Settings, ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(773012)")
        .execute(&mut *tx)
        .await?;
    let config: Settings = sqlx::query_as(SETTINGS_SELECT).fetch_one(&mut *tx).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *tx)
        .await?;
    let plan = DailySchedule::new(&config)?;
    let allowed = plan.allows_pages(now);
    sqlx::query("UPDATE crawl_jobs SET status='queued',lease_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<now()").execute(&mut *tx).await?;
    if !allowed {
        let next = plan.next_after(now)?;
        sqlx::query("UPDATE crawl_channels SET next_sync_at=$1 WHERE enabled AND last_synced_at IS NOT NULL AND next_sync_at<=now()")
            .bind(next).execute(&mut *tx).await?;
        sqlx::query("UPDATE crawl_jobs j SET next_run_at=$1 FROM crawl_channels c WHERE c.id=j.channel_id AND c.enabled AND c.last_synced_at IS NOT NULL AND j.kind='sync' AND j.status='queued' AND j.next_run_at<$1")
            .bind(next).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO crawl_jobs(channel_id,kind,stop_at) SELECT c.id,'sync',c.newest_message FROM crawl_channels c WHERE c.enabled AND c.next_sync_at<=now() AND (c.last_synced_at IS NULL OR $1) AND NOT EXISTS(SELECT 1 FROM crawl_jobs j WHERE j.channel_id=c.id AND j.kind='sync' AND j.status IN ('queued','running','paused','failed')) ON CONFLICT DO NOTHING")
        .bind(allowed).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO crawl_jobs(channel_id,kind,cursor_before) SELECT c.id,'backfill',c.history_cursor FROM crawl_channels c WHERE c.enabled AND c.newest_message>0 AND NOT c.history_complete AND NOT EXISTS(SELECT 1 FROM crawl_jobs j WHERE j.channel_id=c.id AND j.kind='backfill' AND j.status IN ('queued','running','paused','failed')) ON CONFLICT DO NOTHING").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(config)
}

async fn claim_job(pool: &PgPool) -> Result<Option<sqlx::postgres::PgRow>, ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(773012)")
        .execute(&mut *tx)
        .await?;
    let config: Settings = sqlx::query_as(SETTINGS_SELECT).fetch_one(&mut *tx).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let allowed = DailySchedule::new(&config)?.allows_pages(now);
    let count =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM crawl_jobs WHERE status='running'")
            .fetch_one(&mut *tx)
            .await?;
    if count >= config.concurrent_channels as i64 {
        return Ok(None);
    }
    let job = sqlx::query("UPDATE crawl_jobs SET status='running',lease_id=$1,lease_until=now()+interval '180 seconds',attempts=attempts+1,updated_at=now() WHERE id=(SELECT j.id FROM crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id WHERE j.status='queued' AND j.next_run_at<=now() AND c.next_page_at<=now() AND c.enabled AND (j.kind<>'sync' OR c.last_synced_at IS NULL OR $2) AND NOT EXISTS(SELECT 1 FROM crawl_jobs running WHERE running.channel_id=j.channel_id AND running.status='running') ORDER BY (j.kind='retry') DESC,(j.kind='sync') DESC,j.next_run_at,j.id FOR UPDATE OF j,c SKIP LOCKED LIMIT 1) RETURNING *")
        .bind(Uuid::new_v4()).bind(allowed).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(job)
}

/// Retry classification is independent of localized diagnostic text.
fn is_terminal_failure(error: &ApiError, attempts: i32) -> bool {
    attempts >= 6 || matches!(error, ApiError::Crawl { terminal: true, .. })
}

#[cfg(test)]
pub async fn tick(state: &AppState) -> Result<(), ApiError> {
    schedule_due(&state.pool).await?;
    if let Some(job) = claim_job(&state.pool).await? {
        execute_claimed(state, job).await?;
    }
    Ok(())
}

async fn execute_claimed(state: &AppState, job: sqlx::postgres::PgRow) -> Result<(), ApiError> {
    let lease = job.get::<Uuid, _>("lease_id");
    let id = job.get::<i64, _>("id");
    let channel = job.get::<String, _>("channel_id");
    if let Err(error) = process_job(state, &job, lease).await {
        let attempts = job.get::<i32, _>("attempts");
        let terminal = is_terminal_failure(&error, attempts);
        let retry_after = match &error {
            ApiError::Crawl { retry_after, .. } => (*retry_after).clamp(0, 86400),
            _ => 0,
        };
        let error = error.to_string();
        let delay = (60i64 * 2i64.pow(attempts.clamp(0, 6) as u32))
            .min(3600)
            .max(retry_after);
        let mut tx = state.pool.begin().await?;
        let channel_exists = sqlx::query("SELECT id FROM crawl_channels WHERE id=$1 FOR UPDATE")
            .bind(&channel)
            .fetch_optional(&mut *tx)
            .await?;
        if channel_exists.is_none() {
            return Ok(());
        }
        let updated=sqlx::query("UPDATE crawl_jobs SET status=$3,last_error=$4,failures=failures+1,lease_id=NULL,lease_until=NULL,next_run_at=now()+make_interval(secs=>$5::double precision),updated_at=now() WHERE id=$1 AND lease_id=$2").bind(id).bind(lease).bind(if terminal {"failed"}else{"queued"}).bind(&error).bind(delay as f64).execute(&mut *tx).await?.rows_affected();
        if updated > 0 {
            sqlx::query("UPDATE crawl_channels SET last_error=$2,next_page_at=now()+make_interval(secs=>$3::double precision) WHERE id=$1").bind(&channel).bind(&error).bind(if terminal {0.0}else{delay as f64}).execute(&mut *tx).await?;
            if terminal {
                if job.get::<String, _>("kind") == "retry" {
                    sqlx::query("UPDATE crawl_page_failures SET last_error=$2,retry_job_id=NULL,updated_at=now() WHERE id=$1").bind(job.get::<Option<i64>,_>("failure_id")).bind(&error).execute(&mut *tx).await?;
                } else {
                    sqlx::query("INSERT INTO crawl_page_failures(channel_id,job_id,kind,cursor_before,page_number,last_error) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(channel_id,kind,COALESCE(cursor_before,0)) DO UPDATE SET job_id=EXCLUDED.job_id,last_error=EXCLUDED.last_error,updated_at=now()").bind(&channel).bind(id).bind(job.get::<String,_>("kind")).bind(job.get::<Option<i64>,_>("cursor_before")).bind(job.get::<i32,_>("pages")+1).bind(&error).execute(&mut *tx).await?;
                }
            }
        }
        tx.commit().await?;
        tracing::warn!(job=id,%error,"crawl page failed");
    }
    Ok(())
}

async fn lock_page_lease(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
    id: i64,
    lease: Uuid,
) -> Result<bool, ApiError> {
    let channel_exists = sqlx::query("SELECT id FROM crawl_channels WHERE id=$1 FOR UPDATE")
        .bind(channel)
        .fetch_optional(&mut **tx)
        .await?;
    if channel_exists.is_none() {
        return Ok(false);
    }
    let owned = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM (SELECT j.id FROM crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id WHERE j.id=$1 AND j.lease_id=$2 AND j.status='running' AND j.lease_until>clock_timestamp() AND c.enabled FOR UPDATE OF j) owned)")
        .bind(id).bind(lease).fetch_one(&mut **tx).await?;
    if !owned {
        return Err(ApiError::Conflict("任务租约已失效，拒绝提交页面".into()));
    }
    Ok(true)
}

async fn process_job(
    state: &AppState,
    job: &sqlx::postgres::PgRow,
    lease: Uuid,
) -> Result<(), ApiError> {
    let id = job.get::<i64, _>("id");
    let channel = job.get::<String, _>("channel_id");
    let kind = job.get::<String, _>("kind");
    let cursor = job.get::<Option<i64>, _>("cursor_before");
    let source = source_for(&state.pool, &channel).await?;
    let page = fetch_page(state, &source, &channel, cursor).await?;
    let messages = telegram::messages(&page.raw, &channel)?;
    let previous = telegram::previous_cursor(&page.raw, &channel, cursor);
    let diagnostics = page.diagnostics;
    let stop = job.get::<i64, _>("stop_at");
    let pages = job.get::<i32, _>("pages") + 1;
    let oldest = messages.iter().map(|m| m.id).min();
    let newest = messages.iter().map(|m| m.id).max();
    let head = job.get::<Option<i64>, _>("head_message").or(newest);
    let reached = kind == "sync" && (stop == 0 || previous.is_some_and(|c| c <= stop));
    // Retry jobs walk until their target window is covered; stop_at=0 retry
    // jobs (checkpoint retries) stay single-page like before.
    let done = if kind == "retry" {
        previous.is_none() || (stop > 0 && previous.is_some_and(|c| c <= stop))
    } else {
        previous.is_none() || reached
    };
    let reason = if kind == "retry" {
        "failed_page_retried"
    } else if reached {
        "checkpoint_reached"
    } else {
        "accessible_history_end"
    };
    // Parse outside the index lock; commit one idempotent message at a time.
    // The page cursor advances only after every message is durable. A crash can
    // replay a partial page, but cannot skip its remaining messages.
    let parsed: Vec<_> = messages
        .iter()
        .map(|message| parse_message(&source, &channel, message))
        .collect();
    let mut resources = 0;
    let mut failures = 0;
    for (message, parsed) in messages.iter().zip(parsed) {
        // Older messages on the head/checkpoint page are already ingested.
        // Explicit retries and backfills continue to process their own windows.
        if kind == "sync" && message.id <= stop {
            continue;
        }
        let mut tx = state.pool.begin().await?;
        lock_index(&mut tx).await?;
        if !lock_page_lease(&mut tx, &channel, id, lease).await? {
            return Ok(());
        }
        if kind == "retry" && stop > 0 && job.get::<Option<i64>, _>("failure_id").is_none() {
            // A message retry can outlive an ignore/recovery and its retained
            // record. Only the still-unresolved targets need to be processed.
            let unresolved: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=$2 AND status='failed')",
            )
            .bind(&channel)
            .bind(message.id)
            .fetch_one(&mut *tx)
            .await?;
            if !unresolved {
                tx.commit().await?;
                continue;
            }
        }
        let (n, failed) = persist_parsed_message(&mut tx, &channel, message, parsed).await?;
        resources += n;
        failures += usize::from(failed);
        tx.commit().await?;
    }
    let mut tx = state.pool.begin().await?;
    lock_index(&mut tx).await?;
    if !lock_page_lease(&mut tx, &channel, id, lease).await? {
        return Ok(());
    }
    sqlx::query("UPDATE crawl_jobs SET status=$3,cursor_before=$4,head_message=$5,pages=$6,messages=messages+$7,resources=resources+$8,failures=failures+$9,lease_id=NULL,lease_until=NULL,next_run_at=now()+make_interval(secs=>(SELECT page_delay_seconds::double precision FROM crawl_settings WHERE id=1)),attempts=0,stop_reason=$10,diagnostics_json=$11,last_error=NULL,updated_at=now(),completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END WHERE id=$1 AND lease_id=$2")
        .bind(id).bind(lease).bind(if done{"completed"}else{"queued"}).bind(previous).bind(head).bind(pages).bind(messages.len() as i32).bind(resources as i32).bind(failures as i32).bind(if done{Some(reason)}else{None}).bind(diagnostics).execute(&mut *tx).await?;
    let schedule_config: Settings = sqlx::query_as(SETTINGS_SELECT).fetch_one(&mut *tx).await?;
    let observed: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *tx)
        .await?;
    let next_sync = DailySchedule::new(&schedule_config)?.next_after(observed)?;
    let checkpoint = if kind == "sync" && done { head } else { None };
    sqlx::query("UPDATE crawl_channels SET newest_message=GREATEST(newest_message,COALESCE($2,0)),oldest_message=LEAST(oldest_message,$3),last_synced_at=CASE WHEN $4 THEN now() ELSE last_synced_at END,next_sync_at=CASE WHEN $4 AND (SELECT version FROM crawl_settings WHERE id=1)=$8 THEN $7 ELSE next_sync_at END,coverage=CASE WHEN $5 THEN $6 ELSE coverage END,last_error=NULL,updated_at=now() WHERE id=$1")
        .bind(&channel).bind(checkpoint).bind(oldest).bind(kind=="sync" && done).bind(kind=="backfill").bind(if done {reason} else {"backfilling"}).bind(next_sync).bind(schedule_config.version).execute(&mut *tx).await?;
    sqlx::query("UPDATE crawl_channels SET next_page_at=now()+make_interval(secs=>(SELECT page_delay_seconds::double precision FROM crawl_settings WHERE id=1)),history_complete=CASE WHEN $2='backfill' THEN $3 ELSE history_complete END,history_cursor=CASE WHEN $2='backfill' THEN $4 ELSE history_cursor END,history_pages=history_pages+CASE WHEN $2='backfill' THEN 1 ELSE 0 END WHERE id=$1").bind(&channel).bind(&kind).bind(done).bind(previous).execute(&mut *tx).await?;
    if failures > 0 {
        let failure_kind = if kind == "retry" {
            sqlx::query_scalar::<_, String>("SELECT kind FROM crawl_page_failures WHERE id=$1")
                .bind(job.get::<Option<i64>, _>("failure_id"))
                .fetch_optional(&mut *tx)
                .await?
                .unwrap_or("backfill".into())
        } else {
            kind.clone()
        };
        sqlx::query("INSERT INTO crawl_page_failures(channel_id,job_id,kind,cursor_before,next_cursor,page_number,last_error) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(channel_id,kind,COALESCE(cursor_before,0)) DO UPDATE SET last_error=EXCLUDED.last_error,updated_at=now(),retry_job_id=NULL").bind(&channel).bind(id).bind(failure_kind).bind(cursor).bind(previous).bind(pages).bind(format!("{failures} 条消息解析未成功")).execute(&mut *tx).await?;
    } else if kind == "retry" {
        let failure_id = job.get::<Option<i64>, _>("failure_id");
        let parent=sqlx::query("SELECT j.* FROM crawl_page_failures f JOIN crawl_jobs j ON j.id=f.job_id WHERE f.id=$1 AND j.status='failed' AND j.cursor_before IS NOT DISTINCT FROM f.cursor_before FOR UPDATE OF j").bind(failure_id).fetch_optional(&mut *tx).await?;
        if let Some(parent) = parent {
            let parent_kind = parent.get::<String, _>("kind");
            let parent_head = parent.get::<Option<i64>, _>("head_message").or(newest);
            let parent_stop = parent.get::<i64, _>("stop_at");
            let reached = parent_kind == "sync"
                && (parent_stop == 0 || previous.is_some_and(|c| c <= parent_stop));
            let complete = previous.is_none() || reached;
            sqlx::query("UPDATE crawl_jobs SET status=$2,cursor_before=$3,head_message=$4,pages=pages+1,messages=messages+$5,resources=resources+$6,attempts=0,last_error=NULL,next_run_at=now(),completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END,stop_reason=CASE WHEN $2='completed' THEN $7 ELSE NULL END WHERE id=$1").bind(parent.get::<i64,_>("id")).bind(if complete {"completed"}else{"queued"}).bind(previous).bind(parent_head).bind(messages.len() as i32).bind(resources as i32).bind(if reached {"checkpoint_reached"}else{"accessible_history_end"}).execute(&mut *tx).await?;
            if parent_kind == "backfill" {
                sqlx::query("UPDATE crawl_channels SET history_cursor=$2,history_complete=$3,history_pages=history_pages+1,coverage=$4 WHERE id=$1").bind(&channel).bind(previous).bind(complete).bind(if complete {"accessible_history_end"}else{"backfilling"}).execute(&mut *tx).await?;
            } else if complete {
                sqlx::query("UPDATE crawl_channels SET newest_message=GREATEST(newest_message,COALESCE($2,0)),last_synced_at=now(),next_sync_at=CASE WHEN (SELECT version FROM crawl_settings WHERE id=1)=$4 THEN $3 ELSE next_sync_at END WHERE id=$1").bind(&channel).bind(parent_head).bind(next_sync).bind(schedule_config.version).execute(&mut *tx).await?;
            }
        }
        sqlx::query("DELETE FROM crawl_page_failures WHERE id=$1")
            .bind(failure_id)
            .execute(&mut *tx)
            .await?;
        if failure_id.is_none() && done {
            // Synthesized message retries cover a cursor window: stale
            // checkpoints inside it are resolved. Checkpoints re-created while
            // walking (still-failing pages) keep newer updated_at and survive.
            sqlx::query("DELETE FROM crawl_page_failures WHERE channel_id=$1 AND cursor_before>$2 AND cursor_before<=$3 AND updated_at<(SELECT created_at FROM crawl_jobs WHERE id=$4)")
                .bind(&channel).bind(stop).bind(job.get::<Option<i64>, _>("cursor_before").unwrap_or(0)).bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_terminal_failure;
    use crate::error::ApiError;

    #[test]
    fn structured_failures_ignore_display_wording() {
        let terminal = ApiError::Crawl {
            message: "任意新文案".into(),
            terminal: true,
            retry_after: 0,
            retry_node: false,
        };
        assert!(is_terminal_failure(&terminal, 1));
        let retry = ApiError::Crawl {
            message: "HTTP 403 appears in untrusted body".into(),
            terminal: false,
            retry_after: 120,
            retry_node: false,
        };
        assert!(!is_terminal_failure(&retry, 1));
        assert!(is_terminal_failure(&retry, 6));
        assert!(!is_terminal_failure(
            &ApiError::Upstream("无法识别频道页面结构".into()),
            2
        ));
    }
}
