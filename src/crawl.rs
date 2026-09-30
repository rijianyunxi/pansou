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

fn hash(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

pub async fn register_custom(pool: &PgPool, channels: &[String]) -> Result<(), ApiError> {
    for channel in channels {
        let mut tx = pool.begin().await?;
        sqlx::query("INSERT INTO crawl_channels(id,requested_until) VALUES($1,now()+interval '30 days') ON CONFLICT(id) DO UPDATE SET requested_until=EXCLUDED.requested_until WHERE NOT crawl_channels.archived").bind(channel).execute(&mut *tx).await?;
        let archived =
            sqlx::query_scalar::<_, bool>("SELECT archived FROM crawl_channels WHERE id=$1")
                .bind(channel)
                .fetch_one(&mut *tx)
                .await?;
        if archived {
            return Err(ApiError::Conflict("频道已归档，不能添加到用户频道".into()));
        }
        sqlx::query("INSERT INTO outbound_policies(channel_id,inherit) VALUES($1,true) ON CONFLICT(channel_id) DO NOTHING").bind(channel).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}

#[cfg(test)]
pub async fn enqueue(
    pool: &PgPool,
    channel: &str,
    kind: &str,
    max_pages: i32,
) -> Result<i64, ApiError> {
    enqueue_request(pool, channel, kind, max_pages, None).await
}
pub async fn enqueue_request(
    pool: &PgPool,
    channel: &str,
    kind: &str,
    max_pages: i32,
    request_key: Option<&str>,
) -> Result<i64, ApiError> {
    if request_key.is_some_and(|k| k.is_empty() || k.len() > 100) {
        return Err(ApiError::BadRequest("requestKey 长度须为1～100".into()));
    }
    if !matches!(kind, "sync" | "backfill" | "review" | "reparse")
        || !(1..=10000).contains(&max_pages)
    {
        return Err(ApiError::BadRequest("任务类型或 maxPages 无效".into()));
    }
    let mut tx = pool.begin().await?;
    let enabled = sqlx::query_scalar::<_, bool>(
        "SELECT enabled FROM crawl_channels WHERE id=$1 AND NOT archived FOR UPDATE",
    )
    .bind(channel)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::NotFound("频道不存在".into()))?;
    if let Some(key) = request_key {
        if let Some(row) = sqlx::query(
            "SELECT id,kind,max_pages FROM crawl_jobs WHERE channel_id=$1 AND request_key=$2",
        )
        .bind(channel)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?
        {
            if row.get::<String, _>("kind") != kind || row.get::<i32, _>("max_pages") != max_pages {
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
    let id=sqlx::query_scalar("INSERT INTO crawl_jobs(channel_id,kind,max_pages,stop_at,cursor_before,request_key) SELECT id,$2,$3,CASE WHEN $2='sync' THEN newest_message ELSE 0 END,CASE WHEN $2='backfill' THEN (SELECT cursor_before FROM crawl_jobs WHERE channel_id=$1 AND kind='backfill' ORDER BY id DESC LIMIT 1) ELSE NULL END,$4 FROM crawl_channels WHERE id=$1 RETURNING id").bind(channel).bind(kind).bind(max_pages).bind(request_key).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(id)
}

pub(crate) async fn source_for(pool: &PgPool, channel: &str) -> Result<Source, ApiError> {
    let r=sqlx::query("SELECT c.id,c.name,c.description,COALESCE(c.transform,t.transform) AS transform FROM crawl_channels c LEFT JOIN source_template_settings t ON t.id=1 WHERE c.id=$1 AND NOT c.archived").bind(channel).fetch_optional(pool).await?.ok_or_else(||ApiError::NotFound("频道不存在或已归档".into()))?;
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
            .ok_or_else(|| ApiError::BadRequest("频道解析模板未配置".into()))?,
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
            let review = items.len() == 1 && items[0].links.len() > 12;
            let results = if review {
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
                status: if review {
                    "review"
                } else if results.is_empty() {
                    "empty"
                } else {
                    "parsed"
                }
                .into(),
                error: review.then(|| "聚合消息缺少明确资源边界，需要调整规则".into()),
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
                let retry = text.contains("连接失败")
                    || text.contains("HTTP 502")
                    || text.contains("HTTP 503")
                    || text.contains("HTTP 504");
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
    Err(last.unwrap_or_else(|| ApiError::Upstream("选中的节点均不可用，未选择直连".into())))
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
                crate::handlers::search::encode_proxy_target(&target)
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
                return Err(ApiError::Upstream(format!(
                    "采集连接失败：{}",
                    e.without_url()
                )));
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
            return Err(ApiError::Upstream(format!(
                "采集 HTTP {}；Retry-After={}；未轮换代理绕过限制",
                status.as_u16(),
                retry
            )));
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

pub(crate) async fn bump(tx: &mut Transaction<'_, Postgres>) -> Result<(), ApiError> {
    sqlx::query("UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn persist_message(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
    message: &telegram::Message,
    source: &Source,
) -> Result<(usize, bool), ApiError> {
    let version = format!("{}:{}", telegram::PARSER_VERSION, hash(&source.transform));
    let raw_hash = hash(&message.html);
    let previous=sqlx::query("SELECT raw_hash,parse_version,parse_status FROM source_messages WHERE channel_id=$1 AND message_id=$2").bind(channel).bind(message.id).fetch_optional(&mut **tx).await?;
    if previous.as_ref().is_some_and(|r| {
        r.get::<String, _>("raw_hash") == raw_hash
            && r.get::<String, _>("parse_version") == version
            && r.get::<String, _>("parse_status") != "failed"
    }) {
        sqlx::query(
            "UPDATE source_messages SET last_seen_at=now() WHERE channel_id=$1 AND message_id=$2",
        )
        .bind(channel)
        .bind(message.id)
        .execute(&mut **tx)
        .await?;
        return Ok((0, false));
    }
    let parsed = parse_message(source, channel, message);
    let items = parsed.results;
    let status = parsed.status.as_str();
    let error = parsed.error;
    sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_html,raw_hash,published_at,parse_version,parse_status,parse_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(channel_id,message_id) DO UPDATE SET raw_html=EXCLUDED.raw_html,raw_hash=EXCLUDED.raw_hash,published_at=EXCLUDED.published_at,parse_version=EXCLUDED.parse_version,parse_status=EXCLUDED.parse_status,parse_error=EXCLUDED.parse_error,last_seen_at=now(),updated_at=now()")
        .bind(channel).bind(message.id).bind(&message.html).bind(raw_hash).bind(message.published).bind(version).bind(status).bind(error).execute(&mut **tx).await?;
    if matches!(status, "failed" | "review") {
        bump(tx).await?;
        return Ok((0, true));
    }
    let old=sqlx::query("SELECT resource_id,result_json FROM resource_occurrences WHERE channel_id=$1 AND message_id=$2").bind(channel).bind(message.id).fetch_all(&mut **tx).await?;
    sqlx::query("DELETE FROM resource_occurrences WHERE channel_id=$1 AND message_id=$2")
        .bind(channel)
        .bind(message.id)
        .execute(&mut **tx)
        .await?;
    let mut claimed = std::collections::HashSet::new();
    let mut changed = Vec::new();
    for mut item in items.iter().cloned() {
        item.datetime = message.published.map(|t| {
            t.with_timezone(&chrono::FixedOffset::east_opt(28800).unwrap())
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        });
        let mut identities = item
            .links
            .iter()
            .map(|l| resource_clean::link_identity(&l.url))
            .collect::<Vec<_>>();
        identities.sort();
        identities.dedup();
        let fingerprint = hash(&identities.join("\0"));
        let existing = sqlx::query_scalar::<_, String>(
            "SELECT id FROM managed_resources WHERE origin='telegram' AND fingerprint=$1",
        )
        .bind(&fingerprint)
        .fetch_optional(&mut **tx)
        .await?;
        let matching = old
            .iter()
            .find(|r| {
                let id = r.get::<String, _>("resource_id");
                if claimed.contains(&id) {
                    return false;
                }
                let value = r.get::<Value, _>("result_json");
                let Ok(previous) = serde_json::from_value::<SearchResult>(value) else {
                    return false;
                };
                (old.len() == 1 && items.len() == 1)
                    || previous
                        .links
                        .iter()
                        .any(|l| identities.contains(&resource_clean::link_identity(&l.url)))
            })
            .map(|r| r.get::<String, _>("resource_id"));
        let matching = if let Some(id) = matching {
            let count = sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM resource_occurrences WHERE resource_id=$1",
            )
            .bind(&id)
            .fetch_one(&mut **tx)
            .await?;
            if count == 0 { Some(id) } else { None }
        } else {
            None
        };
        let actual = if let Some(id) = existing {
            id
        } else if let Some(id) = matching {
            sqlx::query("UPDATE managed_resources SET fingerprint=$2 WHERE id=$1")
                .bind(&id)
                .bind(&fingerprint)
                .execute(&mut **tx)
                .await?;
            id
        } else {
            let id = Uuid::new_v4().to_string();
            sqlx::query_scalar::<_,String>("INSERT INTO managed_resources(id,name,origin,fingerprint) VALUES($1,$2,'telegram',$3) ON CONFLICT(fingerprint) WHERE origin='telegram' DO UPDATE SET fingerprint=EXCLUDED.fingerprint RETURNING id")
                .bind(&id).bind(&item.name).bind(&fingerprint).fetch_one(&mut **tx).await?
        };
        claimed.insert(actual.clone());
        item.id = actual.clone();
        sqlx::query("INSERT INTO resource_occurrences(channel_id,message_id,resource_id,result_json) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id,message_id,resource_id) DO UPDATE SET result_json=EXCLUDED.result_json,updated_at=now()")
            .bind(channel).bind(message.id).bind(&actual).bind(serde_json::to_value(&item).unwrap()).execute(&mut **tx).await?;
        changed.push(actual);
    }
    changed.extend(old.iter().map(|r| r.get::<String, _>("resource_id")));
    changed.sort();
    changed.dedup();
    for id in changed {
        refresh_resource(tx, &id).await?;
    }
    bump(tx).await?;
    Ok((items.len(), false))
}

async fn refresh_resource(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<(), ApiError> {
    // Serialize a resource refresh with admin overrides, and avoid rebuilding their indexes.
    let manual = sqlx::query_scalar::<_, bool>(
        "SELECT manual_override FROM managed_resources WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if manual {
        return Ok(());
    }
    let row=sqlx::query("SELECT o.result_json,m.published_at FROM resource_occurrences o JOIN source_messages m USING(channel_id,message_id) WHERE o.resource_id=$1 AND m.parse_status='parsed' ORDER BY m.published_at DESC NULLS LAST,o.updated_at DESC LIMIT 1").bind(id).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let item: SearchResult = serde_json::from_value(row.get("result_json"))
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let published = row.get::<Option<DateTime<Utc>>, _>("published_at");
    let search_text = item.name.clone();
    sqlx::query("UPDATE managed_resources SET name=$2,description=$3,datetime=$4,published_at=$5,cloud_types_json=$6,links_json=$7,tags_json=$8,images_json=$9,search_text=$10,updated_at=now() WHERE id=$1 AND NOT manual_override AND (name,description,datetime,published_at,cloud_types_json,links_json,tags_json,images_json,search_text) IS DISTINCT FROM ($2,$3,$4,$5,$6,$7,$8,$9,$10)")
 .bind(id).bind(&item.name).bind(&item.description).bind(&item.datetime).bind(published).bind(json!(item.cloud_types)).bind(json!(item.links)).bind(json!(item.tags.clone().unwrap_or_default())).bind(json!(item.images.clone().unwrap_or_default())).bind(&search_text).execute(&mut **tx).await?;
    let identities = item
        .links
        .iter()
        .map(|l| resource_clean::link_identity(&l.url))
        .collect::<Vec<_>>();
    sqlx::query("DELETE FROM resource_links WHERE resource_id=$1 AND NOT(identity=ANY($2))")
        .bind(id)
        .bind(&identities)
        .execute(&mut **tx)
        .await?;
    let urls = item.links.iter().map(|l| l.url.clone()).collect::<Vec<_>>();
    let types = item
        .links
        .iter()
        .map(|l| l.r#type.clone())
        .collect::<Vec<_>>();
    let passwords = item
        .links
        .iter()
        .map(|l| l.password.clone())
        .collect::<Vec<_>>();
    sqlx::query("INSERT INTO resource_links(resource_id,identity,url,cloud_type,password) SELECT $1,identity,url,cloud_type,password FROM unnest($2::text[],$3::text[],$4::text[],$5::text[]) x(identity,url,cloud_type,password) ON CONFLICT(resource_id,identity) DO UPDATE SET url=excluded.url,cloud_type=excluded.cloud_type,password=excluded.password WHERE (resource_links.url,resource_links.cloud_type,resource_links.password) IS DISTINCT FROM (excluded.url,excluded.cloud_type,excluded.password)").bind(id).bind(identities).bind(urls).bind(types).bind(passwords).execute(&mut **tx).await?;
    let mut texts=sqlx::query_scalar::<_,Value>("SELECT o.result_json FROM resource_occurrences o JOIN source_messages m USING(channel_id,message_id) WHERE o.resource_id=$1 AND m.parse_status='parsed'").bind(id).fetch_all(&mut **tx).await?.into_iter().map(|v|v["name"].as_str().unwrap_or_default().to_owned()).collect::<Vec<_>>();
    texts.push(search_text);
    let grams = resource_clean::grams(&texts.join(" "));
    sqlx::query("DELETE FROM resource_grams WHERE resource_id=$1 AND NOT(gram=ANY($2))")
        .bind(id)
        .bind(&grams)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO resource_grams(resource_id,gram) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING").bind(id).bind(grams).execute(&mut **tx).await?;
    Ok(())
}

pub async fn worker(state: Arc<AppState>) -> Result<(), ApiError> {
    tracing::info!("TG crawl worker started");
    use redis::AsyncCommands;
    let worker_id = Uuid::new_v4().to_string();
    let heartbeat_state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Ok(mut conn) = heartbeat_state.redis.connection() {
                let now = Utc::now().timestamp();
                let _: Result<(), _> = conn.zadd("pansou:crawl:workers", &worker_id, now).await;
                let _: Result<(), _> = conn
                    .zrembyscore("pansou:crawl:workers", "-inf", now - 45)
                    .await;
                let _: Result<(), _> = conn.expire("pansou:crawl:workers", 60).await;
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
    loop {
        if let Err(e) = tick(&state).await {
            tracing::error!(%e,"crawl worker tick failed");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

pub async fn tick(state: &AppState) -> Result<(), ApiError> {
    sqlx::query("UPDATE crawl_jobs SET status='queued',lease_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<now()").execute(&state.pool).await?;
    sqlx::query("INSERT INTO crawl_jobs(channel_id,kind,stop_at,max_pages) SELECT c.id,'sync',c.newest_message,1000 FROM crawl_channels c WHERE c.enabled AND c.next_sync_at<=now() AND (c.managed OR c.requested_until>now()) AND NOT c.archived AND EXISTS(SELECT 1 FROM outbound_policies p WHERE p.channel_id=c.id AND (NOT p.inherit OR EXISTS(SELECT 1 FROM outbound_policies d WHERE d.default_key='telegram')))  AND NOT EXISTS(SELECT 1 FROM crawl_jobs j WHERE j.channel_id=c.id AND j.kind='sync' AND j.status IN ('queued','running','paused')) ON CONFLICT DO NOTHING").execute(&state.pool).await?;
    // Auto-start a bounded first history import once latest-page data is searchable.
    sqlx::query("INSERT INTO crawl_jobs(channel_id,kind,max_pages) SELECT c.id,'backfill',500 FROM crawl_channels c WHERE c.enabled AND c.newest_message>0 AND (c.managed OR c.requested_until>now()) AND NOT c.archived AND EXISTS(SELECT 1 FROM outbound_policies p WHERE p.channel_id=c.id AND (NOT p.inherit OR EXISTS(SELECT 1 FROM outbound_policies d WHERE d.default_key='telegram')))  AND NOT EXISTS(SELECT 1 FROM crawl_jobs j WHERE j.channel_id=c.id AND j.kind='backfill') ON CONFLICT DO NOTHING").execute(&state.pool).await?;
    sqlx::query("INSERT INTO crawl_jobs(channel_id,kind,max_pages) SELECT c.id,'review',1000 FROM crawl_channels c WHERE c.enabled AND c.newest_message>0 AND c.next_review_at<=now() AND (c.managed OR c.requested_until>now()) AND NOT c.archived AND EXISTS(SELECT 1 FROM outbound_policies p WHERE p.channel_id=c.id AND (NOT p.inherit OR EXISTS(SELECT 1 FROM outbound_policies d WHERE d.default_key='telegram')))  AND NOT EXISTS(SELECT 1 FROM crawl_jobs j WHERE j.channel_id=c.id AND j.kind='review' AND j.status IN ('queued','running','paused')) ON CONFLICT DO NOTHING").execute(&state.pool).await?;
    let lease = Uuid::new_v4();
    let job=sqlx::query("UPDATE crawl_jobs SET status='running',lease_id=$1,lease_until=now()+interval '180 seconds',attempts=attempts+1,updated_at=now() WHERE id=(SELECT j.id FROM crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id WHERE j.status='queued' AND j.next_run_at<=now() AND c.enabled AND NOT c.archived AND (j.kind IN ('reparse','reparse_message') OR EXISTS(SELECT 1 FROM outbound_policies p WHERE p.channel_id=c.id AND (NOT p.inherit OR EXISTS(SELECT 1 FROM outbound_policies d WHERE d.default_key='telegram')))) AND NOT EXISTS(SELECT 1 FROM crawl_jobs running WHERE running.channel_id=j.channel_id AND running.status='running') ORDER BY (j.kind='sync') DESC,(j.kind='reparse') DESC,j.next_run_at,j.id FOR UPDATE OF j,c SKIP LOCKED LIMIT 1) RETURNING *").bind(lease).fetch_optional(&state.pool).await?;
    let Some(job) = job else {
        return Ok(());
    };
    let id = job.get::<i64, _>("id");
    let channel = job.get::<String, _>("channel_id");
    let result = process_job(state, &job, lease).await;
    if let Err(error) = result {
        let error = error.to_string();
        let permanent =
            error.contains("HTTP 403") || error.contains("HTTP 404") || error.contains("不公开");
        let attempts = job.get::<i32, _>("attempts");
        let pause = permanent || attempts >= 6;
        let delay = (60i64 * 2i64.pow(attempts.clamp(0, 8) as u32)).min(3600);
        let retry = error
            .split("Retry-After=")
            .nth(1)
            .and_then(|s| s.split('；').next())
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let delay = delay.max(retry);
        let updated=sqlx::query("UPDATE crawl_jobs SET status=$3,last_error=$4,failures=failures+1,lease_id=NULL,lease_until=NULL,next_run_at=now()+make_interval(secs=>$5::double precision),updated_at=now() WHERE id=$1 AND lease_id=$2")
            .bind(id).bind(lease).bind(if pause{"failed"}else{"queued"}).bind(&error).bind(delay as f64).execute(&state.pool).await?.rows_affected();
        if updated == 0 {
            return Ok(());
        }
        sqlx::query("UPDATE crawl_channels SET last_error=$2,next_sync_at=now()+interval '1 hour',updated_at=now() WHERE id=$1").bind(channel).bind(&error).execute(&state.pool).await?;
        tracing::warn!(job=id,%error,"crawl task failed/retained for retry");
    }
    Ok(())
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
    let (messages, previous, diagnostics) = if kind == "reparse" || kind == "reparse_message" {
        let rows=sqlx::query("SELECT message_id,raw_html,published_at FROM source_messages WHERE channel_id=$1 AND ($2::bigint IS NULL OR message_id<$2) AND ($3::bigint IS NULL OR message_id=$3) ORDER BY message_id DESC LIMIT 20").bind(&channel).bind(cursor).bind(job.get::<Option<i64>,_>("target_message_id")).fetch_all(&state.pool).await?;
        let msgs = rows
            .into_iter()
            .map(|r| telegram::Message {
                id: r.get("message_id"),
                html: r.get("raw_html"),
                published: r.get("published_at"),
            })
            .collect::<Vec<_>>();
        let previous = msgs.iter().map(|m| m.id).min();
        (msgs, previous, json!({"mode":"stored-raw"}))
    } else {
        let page = fetch_page(state, &source, &channel, cursor).await?;
        let messages = telegram::messages(&page.raw, &channel)?;
        let previous = telegram::previous_cursor(&page.raw, &channel, cursor);
        (messages, previous, page.diagnostics)
    };
    let stop = job.get::<i64, _>("stop_at");
    let pages = job.get::<i32, _>("pages") + 1;
    let oldest = messages.iter().map(|m| m.id).min();
    let newest = messages.iter().map(|m| m.id).max();
    let head = job.get::<Option<i64>, _>("head_message").or(newest);
    let recent_cutoff = Utc::now() - chrono::Duration::days(7);
    let reached = (kind == "sync" && (stop == 0 || previous.is_some_and(|cursor| cursor <= stop)))
        || (kind == "review"
            && telegram::reached_review_cutoff(&messages, previous, recent_cutoff));
    let done = kind == "reparse_message"
        || messages.is_empty()
        || previous.is_none()
        || reached
        || pages >= job.get::<i32, _>("max_pages");
    let reason = if kind == "reparse_message" {
        "stored_messages_complete"
    } else if reached {
        if kind == "review" {
            "recent_window_complete"
        } else {
            "checkpoint_reached"
        }
    } else if messages.is_empty() {
        "stored_messages_complete"
    } else if previous.is_none() {
        "accessible_history_end"
    } else {
        "page_budget_reached"
    };
    let mut tx = state.pool.begin().await?;
    let owned=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM (SELECT j.id FROM crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id WHERE j.id=$1 AND j.lease_id=$2 AND j.status='running' AND j.lease_until>now() AND c.enabled FOR UPDATE OF j,c) owned)").bind(id).bind(lease).fetch_one(&mut *tx).await?;
    if !owned {
        return Err(ApiError::Conflict("任务租约已失效，拒绝提交页面".into()));
    }
    let mut resources = 0;
    let mut failures = 0;
    for message in &messages {
        if kind == "reparse" || kind == "reparse_message" {
            sqlx::query(
                "UPDATE source_messages SET parse_version='' WHERE channel_id=$1 AND message_id=$2",
            )
            .bind(&channel)
            .bind(message.id)
            .execute(&mut *tx)
            .await?;
        }
        let (n, failed) = persist_message(&mut tx, &channel, message, &source).await?;
        resources += n;
        failures += usize::from(failed);
    }
    sqlx::query("UPDATE crawl_jobs SET status=$3,cursor_before=$4,head_message=$5,pages=$6,messages=messages+$7,resources=resources+$8,failures=failures+$9,lease_id=NULL,lease_until=NULL,next_run_at=now()+interval '3 seconds',attempts=0,stop_reason=$10,diagnostics_json=$11,last_error=NULL,updated_at=now(),completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END WHERE id=$1 AND lease_id=$2")
        .bind(id).bind(lease).bind(if done{"completed"}else{"queued"}).bind(previous).bind(head).bind(pages).bind(messages.len() as i32).bind(resources as i32).bind(failures as i32).bind(if done{Some(reason)}else{None}).bind(diagnostics).execute(&mut *tx).await?;
    let checkpoint = if kind == "sync" && done && reason != "page_budget_reached" {
        head
    } else {
        None
    };
    sqlx::query("UPDATE crawl_channels SET newest_message=GREATEST(newest_message,COALESCE($2,0)),oldest_message=LEAST(oldest_message,$3),last_synced_at=CASE WHEN $4 THEN now() ELSE last_synced_at END,next_sync_at=CASE WHEN $4 THEN now()+make_interval(secs=>interval_seconds::double precision) ELSE next_sync_at END,coverage=CASE WHEN $5 THEN $6 ELSE coverage END,last_error=NULL,updated_at=now() WHERE id=$1")
        .bind(&channel).bind(checkpoint).bind(oldest).bind(kind=="sync" && done).bind(kind=="backfill").bind(if done {reason} else {"backfilling"}).execute(&mut *tx).await?;
    if kind == "review" && done {
        sqlx::query(
            "UPDATE crawl_channels SET next_review_at=now()+interval '6 hours' WHERE id=$1",
        )
        .bind(&channel)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
