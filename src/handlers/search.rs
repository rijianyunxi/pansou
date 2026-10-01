use super::common::admin_only;
use crate::{
    app::AppState,
    error::ApiError,
    models::{SearchRequest, SearchResponse, SearchResult, Source, SourceMeta},
    transform,
};
use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, header},
    response::Response,
};
use futures::stream::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

/// Local channels define visibility only; they have no search priority or per-source output.
pub(crate) struct SearchSources {
    pub(crate) local_channels: Vec<String>,
    pub(crate) live_sources: Vec<Source>,
}

pub(crate) async fn load_sources(
    state: &AppState,
    ids: Option<&Vec<String>>,
    channels: Option<&Vec<String>>,
) -> Result<SearchSources, ApiError> {
    if let Some(channels) = channels {
        let template = sqlx::query_scalar::<_, String>(
            "SELECT transform FROM source_template_settings WHERE id=1",
        )
        .fetch_one(&state.pool)
        .await?;
        let live_sources = channels
            .iter()
            .map(|value| {
                let channel = crate::telegram::normalize_channel(value)
                    .ok_or_else(|| ApiError::BadRequest("无效公开频道".into()))?;
                Ok(Source {
                    id: format!("custom:{channel}"),
                    name: format!("@{channel}"),
                    description: String::new(),
                    url: format!("https://t.me/s/{channel}"),
                    method: "GET".into(),
                    format: "html".into(),
                    priority: 0,
                    enabled: true,
                    request: None,
                    transform: template.clone(),
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        return Ok(SearchSources {
            local_channels: vec![],
            live_sources,
        });
    }
    let mut sql="SELECT id,name,description,url,method,format,priority,enabled,request_json,transform FROM resource_sources WHERE enabled=true AND kind=\'live\'".to_string();
    if ids.is_some() {
        sql.push_str(" AND id = ANY($1)");
    }
    sql.push_str(" ORDER BY priority ASC,id ASC");
    let rows = if let Some(ids) = ids {
        sqlx::query(&sql).bind(ids).fetch_all(&state.pool).await?
    } else {
        sqlx::query(&sql).fetch_all(&state.pool).await?
    };
    let local_channels =
        sqlx::query_scalar::<_, String>("SELECT id FROM crawl_channels ORDER BY id")
            .fetch_all(&state.pool)
            .await?;
    let mut live_sources = Vec::new();
    for row in rows {
        let url: String = row.get("url");
        if let Some(channel) = crate::telegram::channel(&url) {
            let _ = channel;
            continue;
        }
        live_sources.push(Source {
            id: row.get("id"),
            name: row.get("name"),
            description: row.get("description"),
            url,
            method: row.get("method"),
            format: row.get("format"),
            priority: row.get("priority"),
            enabled: row.get("enabled"),
            request: row.get("request_json"),
            transform: row.get("transform"),
        });
    }
    Ok(SearchSources {
        local_channels,
        live_sources,
    })
}
async fn record_source_health(
    state: &AppState,
    source: &Source,
    ok: bool,
    result_count: usize,
    elapsed_ms: u128,
    error_message: Option<&str>,
    circuit_breaker_max_failures: i64,
) {
    let existing = sqlx::query_scalar::<_, Value>(
        "SELECT snapshot_json FROM source_health WHERE source_id=$1",
    )
    .bind(&source.id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| json!({}));
    let mut snapshot = existing;
    let Some(object) = snapshot.as_object_mut() else {
        return;
    };
    let now = chrono::Utc::now().timestamp_millis();
    let previous_requests = object
        .get("requestCount")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let previous_successes = object
        .get("successCount")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let previous_total_failures = object
        .get("totalFailureCount")
        .or_else(|| object.get("failureCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let requests = previous_requests + 1;
    let successes = previous_successes + i64::from(ok);
    let total_failures = previous_total_failures + i64::from(!ok);
    let consecutive_failures = if ok {
        0
    } else {
        object
            .get("failureCount")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0)
            + 1
    };
    let zero_results = object
        .get("zeroResultCount")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0)
        + i64::from(ok && result_count == 0);
    let result_total = object
        .get("resultCount")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0)
        + result_count as i64;
    let previous_avg = object
        .get("avgResponseTime")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let average = ((previous_avg * previous_requests as f64) + elapsed_ms as f64) / requests as f64;
    let recent_before = object.get("recent").and_then(Value::as_str).unwrap_or("");
    let mut recent = recent_before.to_owned();
    recent.push(if ok { '1' } else { '0' });
    let recent: String = recent
        .chars()
        .rev()
        .take(100)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let mut outcomes = object
        .get("recentOutcomes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    outcomes.push(json!({
        "at": now,
        "ok": ok,
        "resultCount": result_count,
        "responseTimeMs": elapsed_ms,
        "errorCategory": if ok { Value::Null } else { json!("request_failed") },
        "message": if ok { Value::Null } else { json!(error_message.unwrap_or("资源源请求失败")) },
    }));
    if outcomes.len() > 100 {
        let keep_from = outcomes.len() - 100;
        outcomes = outcomes.split_off(keep_from);
    }

    let hour = now - now.rem_euclid(3_600_000);
    let mut buckets = object
        .get("history")
        .and_then(|history| history.get("buckets"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(bucket) = buckets
        .iter_mut()
        .find(|bucket| bucket.get("t").and_then(Value::as_i64) == Some(hour))
    {
        let old = bucket.get("n").and_then(Value::as_i64).unwrap_or(0);
        bucket["n"] = json!(old + 1);
        let key = if ok { "s" } else { "f" };
        let old = bucket.get(key).and_then(Value::as_i64).unwrap_or(0);
        bucket[key] = json!(old + 1);
        if ok && result_count == 0 {
            let old = bucket.get("z").and_then(Value::as_i64).unwrap_or(0);
            bucket["z"] = json!(old + 1);
        }
    } else {
        buckets.push(json!({
            "t": hour,
            "n": 1,
            "s": i64::from(ok),
            "f": i64::from(!ok),
            "z": i64::from(ok && result_count == 0),
            "e": if ok { json!({}) } else { json!({"request_failed": 1}) },
        }));
    }
    if buckets.len() > 24 {
        let keep_from = buckets.len() - 24;
        buckets = buckets.split_off(keep_from);
    }

    let pass_rate = if requests == 0 {
        0.0
    } else {
        successes as f64 / requests as f64
    };
    let dimension_state = if ok { "pass" } else { "fail" };
    let result_state = if !ok {
        "fail"
    } else if result_count == 0 {
        "empty"
    } else {
        "pass"
    };
    let dimension_recent = recent.clone();
    object.insert("name".into(), json!(source.name));
    object.insert("recent".into(), json!(recent));
    object.insert("requestCount".into(), json!(requests));
    object.insert("successCount".into(), json!(successes));
    object.insert("failureCount".into(), json!(consecutive_failures));
    object.insert("totalFailureCount".into(), json!(total_failures));
    object.insert("failureWindowCount".into(), json!(consecutive_failures));
    object.insert("resultCount".into(), json!(result_total));
    object.insert("zeroResultCount".into(), json!(zero_results));
    object.insert("isHealthy".into(), json!(ok));
    object.insert(
        "circuitState".into(),
        json!(if consecutive_failures >= circuit_breaker_max_failures {
            "open"
        } else {
            "closed"
        }),
    );
    object.insert("avgResponseTime".into(), json!(average.round() as i64));
    object.insert("p50ResponseTime".into(), json!(elapsed_ms));
    object.insert("p95ResponseTime".into(), json!(elapsed_ms));
    object.insert("parsingSuccessRate".into(), json!(pass_rate));
    object.insert(
        "lastErrorMessage".into(),
        json!(if ok {
            ""
        } else {
            error_message.unwrap_or("资源源请求失败")
        }),
    );
    if ok {
        object.insert("lastSuccessTime".into(), json!(now));
    } else {
        object.insert("lastFailureTime".into(), json!(now));
    }
    object.insert("recentOutcomes".into(), Value::Array(outcomes));
    object.insert(
        "history".into(),
        json!({"windowHours": 24, "buckets": buckets}),
    );
    object.insert("dimensions".into(), json!({
        "network": {"state": dimension_state, "passRate": pass_rate, "recent": dimension_recent},
        "http": {"state": dimension_state, "passRate": pass_rate, "recent": dimension_recent},
        "business": {"state": dimension_state, "passRate": pass_rate, "recent": dimension_recent},
        "parsing": {"state": dimension_state, "passRate": pass_rate, "recent": dimension_recent},
        "results": {"state": result_state, "passRate": pass_rate, "recent": dimension_recent},
    }));
    if let Err(error) = sqlx::query(
        "INSERT INTO source_health(source_id,snapshot_json,updated_at) VALUES($1,$2,now())
         ON CONFLICT(source_id) DO UPDATE SET snapshot_json=EXCLUDED.snapshot_json,updated_at=now()",
    )
    .bind(&source.id)
    .bind(snapshot)
    .execute(&state.pool)
    .await
    {
        tracing::warn!(source=%source.id,error=%error,"source health snapshot update failed");
    }
}

use crate::outbound::{
    record_failure as record_proxy_failure, record_success as record_proxy_success,
};

pub(crate) fn encode_proxy_target(target: &str) -> String {
    target
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

async fn source_circuit_open(state: &AppState, source_id: &str, max_failures: i64) -> bool {
    let snapshot = sqlx::query_scalar::<_, Value>(
        "SELECT snapshot_json FROM source_health WHERE source_id=$1",
    )
    .bind(source_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    let Some(snapshot) = snapshot else {
        return false;
    };
    let failures = snapshot
        .get("failureCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let last_failure = snapshot
        .get("lastFailureTime")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    failures >= max_failures
        && chrono::Utc::now()
            .timestamp_millis()
            .saturating_sub(last_failure)
            < 60_000
}

async fn execute_custom(
    state: &AppState,
    source: &Source,
    kw: &str,
    policy: &crate::policy::UserPolicy,
) -> (SourceMeta, Vec<SearchResult>) {
    let started = Instant::now();
    let result = async {
        let mut url = reqwest::Url::parse(&source.url)
            .map_err(|_| ApiError::BadRequest("频道地址无效".into()))?;
        #[cfg(test)]
        if let Some(base) = &state.custom_test_base {
            url = reqwest::Url::parse(&format!(
                "{base}/s/{}",
                source.id.strip_prefix("custom:").unwrap()
            ))
            .unwrap();
        }
        url.query_pairs_mut().append_pair("q", kw);
        let response = state
            .crawl_http
            .get(url)
            .send()
            .await
            .map_err(|e| ApiError::Upstream(e.without_url().to_string()))?;
        if !response.status().is_success() {
            return Err(ApiError::Upstream(format!(
                "TG HTTP {}",
                response.status().as_u16()
            )));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ApiError::Upstream(e.without_url().to_string()))?;
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(ApiError::Upstream("TG 搜索响应过大".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        let html =
            String::from_utf8(bytes).map_err(|_| ApiError::Upstream("TG 页面编码无效".into()))?;
        transform::apply(&source.transform, &html, "html", kw, &source.id).map(|items| {
            items
                .into_iter()
                .map(crate::resource_clean::normalize)
                .collect::<Vec<_>>()
        })
    };
    let output =
        tokio::time::timeout(Duration::from_millis(policy.request_timeout_ms), result).await;
    let (status, results) = match output {
        Ok(Ok(items)) => ("success", items),
        _ => ("failed", vec![]),
    };
    let meta = SourceMeta {
        id: source.id.clone(),
        name: source.name.clone(),
        priority: 0,
        status: status.into(),
        result_count: results.len(),
        elapsed_ms: started.elapsed().as_millis(),
        transform_ms: None,
        proxy_nodes: vec![],
        results: vec![],
    };
    (meta, results)
}
async fn execute_source(
    state: &AppState,
    source: &Source,
    kw: &str,
    policy: &crate::policy::UserPolicy,
) -> (SourceMeta, Vec<SearchResult>) {
    let started = Instant::now();
    if source_circuit_open(state, &source.id, policy.circuit_breaker_max_failures).await {
        let meta = SourceMeta {
            id: source.id.clone(),
            name: source.name.clone(),
            priority: source.priority,
            status: "skipped".into(),
            result_count: 0,
            elapsed_ms: 0,
            transform_ms: None,
            proxy_nodes: vec![],
            results: vec![],
        };
        return (meta, vec![]);
    }
    let request = source.request.clone().unwrap_or(json!({}));
    let target_url = source.url.replace("{{keyword}}", kw);
    let mut target = match reqwest::Url::parse(&target_url) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(source=%source.id,error=%error,"source URL invalid");
            let meta = SourceMeta {
                id: source.id.clone(),
                name: source.name.clone(),
                priority: source.priority,
                status: "failed".into(),
                result_count: 0,
                elapsed_ms: started.elapsed().as_millis(),
                transform_ms: None,
                proxy_nodes: vec![],
                results: vec![],
            };
            return (meta, vec![]);
        }
    };
    if let Some(query) = request.get("query").and_then(Value::as_object) {
        let mut pairs = Vec::new();
        for (key, value) in query {
            pairs.push((
                key.clone(),
                value.as_str().unwrap_or("").replace("{{keyword}}", kw),
            ));
        }
        target.query_pairs_mut().extend_pairs(pairs);
    }
    let target_url = target.to_string();
    let headers = request
        .get("headers")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let body = request.get("body").map(|value| render_value(value, kw));
    let mut plan = match crate::outbound::Plan::load(
        &state.pool,
        crate::outbound::Owner::Source(&source.id),
        &source.method,
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            return (
                SourceMeta {
                    id: source.id.clone(),
                    name: source.name.clone(),
                    priority: source.priority,
                    status: "failed".into(),
                    result_count: 0,
                    elapsed_ms: started.elapsed().as_millis(),
                    transform_ms: None,
                    proxy_nodes: vec![json!({"status":"failed","error":e.to_string()})],
                    results: vec![],
                },
                vec![],
            );
        }
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(policy.request_timeout_ms);
    let mut proxy_nodes = Vec::new();
    let mut final_status = "failed";
    let mut final_items = Vec::new();
    let mut final_transform_ms = None;

    for attempt_index in 0..50 {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let mode = match plan.next(&state.pool).await {
            Ok(Some(m)) => m,
            Ok(None) => break,
            Err(e) => {
                proxy_nodes.push(json!({"status":"failed","error":e.to_string()}));
                break;
            }
        };
        let attempt_started = Instant::now();
        let outbound_url = match mode.as_ref() {
            Some(node) => format!(
                "{}/{}",
                node.base_url.trim_end_matches('/'),
                encode_proxy_target(&target_url)
            ),
            None => target_url.clone(),
        };
        let mut req = if source.method.eq_ignore_ascii_case("POST") {
            state.http.post(&outbound_url)
        } else {
            state.http.get(&outbound_url)
        };
        req = req.header(
            "Accept",
            if source.format.eq_ignore_ascii_case("json") {
                "application/json"
            } else {
                "text/html"
            },
        );
        for (key, value) in &headers {
            req = req.header(key, value);
        }
        req = req.timeout(deadline.saturating_duration_since(tokio::time::Instant::now()));
        if mode.is_some() {
            req = req.header("Accept-Encoding", "identity");
        }
        if source.method.eq_ignore_ascii_case("POST")
            && let Some(value) = &body
        {
            req = req.json(value);
        }
        let response = match req.send().await {
            Ok(response) => response,
            Err(error) => {
                if let Some(node) = mode.as_ref() {
                    record_proxy_failure(state, node, None, &error.to_string(), policy).await;
                }
                proxy_nodes.push(json!({
                    "nodeId": mode.as_ref().map(|node| node.id.as_str()).unwrap_or("direct"),
                    "nodeName": mode.as_ref().map(|node| node.name.as_str()).unwrap_or("直连"),
                    "status": "failed",
                    "httpStatus": Value::Null,
                    "elapsedMs": attempt_started.elapsed().as_millis(),
                    "attempt": attempt_index + 1,
                    "error": error.to_string(),
                }));
                continue;
            }
        };
        let http_status = response.status().as_u16();
        let elapsed_ms = attempt_started.elapsed().as_millis();
        let proxy_failed = !(200..300).contains(&http_status);
        if proxy_failed {
            if let Some(node) = mode.as_ref() {
                record_proxy_failure(
                    state,
                    node,
                    Some(http_status),
                    &format!("节点请求返回 HTTP {http_status}"),
                    policy,
                )
                .await;
            }
            proxy_nodes.push(json!({
                "nodeId": mode.as_ref().map(|node| node.id.as_str()).unwrap_or("direct"),
                "nodeName": mode.as_ref().map(|node| node.name.as_str()).unwrap_or("直连"),
                "status": "failed",
                "httpStatus": http_status,
                "elapsedMs": elapsed_ms,
                "attempt": attempt_index + 1,
                "error": format!("代理请求返回 HTTP {http_status}"),
            }));
            if http_status < 500 {
                break;
            }
            continue;
        }
        proxy_nodes.push(json!({
            "nodeId": mode.as_ref().map(|node| node.id.as_str()).unwrap_or("direct"),
            "nodeName": mode.as_ref().map(|node| node.name.as_str()).unwrap_or("直连"),
            "status": "success",
            "httpStatus": http_status,
            "elapsedMs": elapsed_ms,
            "attempt": attempt_index + 1,
        }));
        let raw = match response.text().await {
            Ok(raw) => raw,
            Err(error) => {
                if let Some(node) = mode.as_ref() {
                    record_proxy_failure(
                        state,
                        node,
                        Some(http_status),
                        &error.to_string(),
                        policy,
                    )
                    .await;
                }
                tracing::warn!(source=%source.id,error=%error,"source response read failed");
                continue;
            }
        };
        if let Some(node) = mode.as_ref() {
            record_proxy_success(state, node, http_status).await;
        }
        let transform_started = Instant::now();
        match transform::apply(&source.transform, &raw, &source.format, kw, &source.id) {
            Ok(items) => {
                final_status = "success";
                final_items = items;
                final_transform_ms = Some(transform_started.elapsed().as_millis());
            }
            Err(error) => {
                tracing::warn!(source=%source.id,error=%error,"transform failed");
                final_status = "failed";
                final_transform_ms = Some(transform_started.elapsed().as_millis());
            }
        }
        break;
    }
    let elapsed_ms = started.elapsed().as_millis();
    record_source_health(
        state,
        source,
        final_status == "success",
        final_items.len(),
        elapsed_ms,
        (final_status == "failed").then_some("资源源请求或解析失败"),
        policy.circuit_breaker_max_failures,
    )
    .await;
    let meta = SourceMeta {
        id: source.id.clone(),
        name: source.name.clone(),
        priority: source.priority,
        status: final_status.into(),
        result_count: final_items.len(),
        elapsed_ms,
        transform_ms: final_transform_ms,
        proxy_nodes,
        results: final_items.clone(),
    };
    (meta, final_items)
}
fn render_value(v: &Value, kw: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("{{keyword}}", kw)),
        Value::Array(a) => Value::Array(a.iter().map(|x| render_value(x, kw)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), render_value(v, kw)))
                .collect(),
        ),
        x => x.clone(),
    }
}
fn source_execution_stream(
    state: AppState,
    sources: SearchSources,
    kw: String,
    concurrency: usize,
    policy: crate::policy::UserPolicy,
) -> impl futures::Stream<Item = Result<(Option<SourceMeta>, Vec<SearchResult>), ApiError>> {
    let local_state = state.clone();
    let local_kw = kw.clone();
    let custom = sources
        .live_sources
        .iter()
        .any(|s| s.id.starts_with("custom:"));
    let local = futures::stream::once(async move {
        if sources.local_channels.is_empty() && custom {
            return Ok((None, vec![]));
        }
        crate::local_index::query(&local_state, &sources.local_channels, &local_kw)
            .await
            .map(|results| (None, results))
    });
    let live = futures::stream::iter(sources.live_sources.into_iter().map(move |source| {
        let state = state.clone();
        let kw = kw.clone();
        let policy = policy.clone();
        async move {
            let (meta, results) = if source.id.starts_with("custom:") {
                execute_custom(&state, &source, &kw, &policy).await
            } else {
                execute_source(&state, &source, &kw, &policy).await
            };
            Ok((Some(meta), results))
        }
    }))
    .buffer_unordered(concurrency.clamp(1, 32));
    // Do not start live requests until the single local batch has been returned.
    local.chain(live)
}

fn finalize_search(
    all: Vec<SearchResult>,
    mut metas: Vec<SourceMeta>,
    debug: bool,
) -> SearchResponse {
    // Ingestion deduplicates local resources; cross-source deduplication belongs to the client.
    metas.sort_by_key(|meta| meta.priority);
    SearchResponse {
        total: all.len(),
        results: all,
        sources: debug.then_some(metas),
    }
}

async fn run_search(
    state: &AppState,
    req: SearchRequest,
    debug: bool,
    policy: &crate::policy::UserPolicy,
) -> Result<SearchResponse, ApiError> {
    let kw = req.kw.trim().to_owned();
    if kw.chars().count() < 1 || kw.chars().count() > 100 {
        return Err(ApiError::BadRequest(
            "kw must contain 1 to 100 characters".into(),
        ));
    }
    let sources = load_sources(state, req.source_ids.as_ref(), req.channels.as_ref()).await?;
    let cache_key = if sources.local_channels.is_empty() && req.channels.is_none() {
        Some(search_cache_key(state, &req).await?)
    } else {
        None
    };
    if let Some(output) = match cache_key.as_deref() {
        Some(key) => get_cached_search(state, key, policy).await,
        None => None,
    } {
        return Ok(output);
    }
    let executions = source_execution_stream(
        state.clone(),
        sources,
        kw,
        req.conc.unwrap_or(policy.default_concurrency),
        policy.clone(),
    );
    let collect = async {
        let mut all = Vec::new();
        let mut metas = Vec::new();
        futures::pin_mut!(executions);
        while let Some(value) = executions.next().await {
            let (meta, items) = value?;
            if let Some(meta) = meta {
                metas.push(meta);
            }
            all.extend(items);
        }
        Ok::<_, ApiError>(finalize_search(all, metas, debug))
    };
    let output = tokio::time::timeout(Duration::from_millis(policy.search_timeout_ms), collect)
        .await
        .map_err(|_| ApiError::Upstream("搜索执行超时".into()))??;
    if let Some(cache_key) = cache_key {
        cache_search(state, cache_key, output.clone(), policy).await;
    }
    Ok(output)
}

fn valid_search_keyword(keyword: &str) -> bool {
    let length = keyword.trim().chars().count();
    (1..=100).contains(&length)
}

pub(crate) async fn resolve_custom_channels(
    state: &AppState,
    session: &crate::auth::Session,
    req: &mut SearchRequest,
    policy: &crate::policy::UserPolicy,
) -> Result<(), ApiError> {
    if req.channels.is_none() {
        return Ok(());
    }
    if session.user_id.is_none() && !policy.anonymous_custom_channels {
        return Err(ApiError::Forbidden(
            "管理员尚未允许匿名自定义频道搜索".into(),
        ));
    }
    let mut channels = req
        .channels
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            crate::telegram::normalize_channel(&c)
                .ok_or_else(|| ApiError::BadRequest("无效公开频道".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    channels.sort();
    channels.dedup();
    if channels.is_empty() || channels.len() > policy.custom_channel_limit {
        return Err(ApiError::BadRequest("自定义频道数量超出配额或为空".into()));
    }
    req.channels = Some(channels);
    req.source_ids = None;
    let _ = state;
    Ok(())
}

async fn search_cache_key(state: &AppState, req: &SearchRequest) -> Result<String, ApiError> {
    let revision = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
        "SELECT GREATEST(\n            COALESCE((SELECT MAX(updated_at) FROM resource_sources),to_timestamp(0)),\n            COALESCE((SELECT updated_at FROM source_template_settings WHERE id=1),to_timestamp(0))\n         )",
    )
    .fetch_one(&state.pool)
    .await?;
    let mut source_ids = req.source_ids.clone();
    if let Some(ids) = source_ids.as_mut() {
        ids.sort();
    }
    let mut channels = req.channels.clone();
    if let Some(channels) = channels.as_mut() {
        channels.sort();
    }
    let payload = json!({
        "keyword": req.kw.trim().to_lowercase(),
        "sourceIds": source_ids,
        "channels": channels,
        "revision": revision.timestamp_millis(),
    });
    Ok(format!(
        "{:x}",
        Sha256::digest(payload.to_string().as_bytes())
    ))
}

fn cache_capacity_bytes(policy: &crate::policy::UserPolicy) -> usize {
    usize::try_from(policy.cache_max_memory_mb.saturating_mul(1024 * 1024)).unwrap_or(usize::MAX)
}

async fn get_cached_search(
    state: &AppState,
    key: &str,
    policy: &crate::policy::UserPolicy,
) -> Option<SearchResponse> {
    let mut output = state
        .search_cache
        .lock()
        .await
        .get(key, cache_capacity_bytes(policy))?;
    if let Some(sources) = output.sources.as_mut() {
        for source in sources {
            source.elapsed_ms = 0;
            source.transform_ms = None;
        }
    }
    Some(output)
}

async fn cache_search(
    state: &AppState,
    key: String,
    output: SearchResponse,
    policy: &crate::policy::UserPolicy,
) {
    state.search_cache.lock().await.set(
        key,
        output,
        Duration::from_secs(policy.cache_ttl_minutes.saturating_mul(60)),
        cache_capacity_bytes(policy),
    );
}

async fn create_search_log(
    state: &AppState,
    session: &crate::auth::Session,
    req: &SearchRequest,
    ip: std::net::IpAddr,
) -> Option<i64> {
    let keyword = req.kw.trim();
    let scope = if req.channels.is_some() {
        "custom_channels"
    } else {
        "system"
    };
    let channels = req.channels.clone().unwrap_or_default();
    let source_ids = req.source_ids.clone().unwrap_or_default();
    sqlx::query_scalar::<_, i64>(
        "INSERT INTO search_logs(session_id,user_id,keyword,ip,search_scope,channels_json,source_ids_json,status,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'started',now()) RETURNING id",
    )
    .bind(&session.token)
    .bind(session.user_id)
    .bind(keyword)
    .bind(ip.to_string())
    .bind(scope)
    .bind(json!(channels))
    .bind(json!(source_ids))
    .fetch_one(&state.pool)
    .await
    .map_err(|error| tracing::warn!(%error, "search log create failed"))
    .ok()
}

async fn complete_search_log(state: &AppState, log_id: i64, output: &SearchResponse) {
    let source_result_counts = output
        .sources
        .as_ref()
        .map(|sources| {
            sources
                .iter()
                .map(|source| (source.id.clone(), json!(source.result_count)))
                .collect::<serde_json::Map<String, Value>>()
        })
        .unwrap_or_default();
    let source_ids = output
        .sources
        .as_ref()
        .map(|sources| {
            sources
                .iter()
                .map(|source| source.id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Err(error) = sqlx::query(
        "UPDATE search_logs SET status='completed',result_count=$1,has_results=$2,source_result_counts_json=$3,source_ids_json=$4,completed_at=now(),outcome_recorded=true WHERE id=$5",
    )
    .bind(output.total as i32)
    .bind(output.total > 0)
    .bind(Value::Object(source_result_counts))
    .bind(json!(source_ids))
    .bind(log_id)
    .execute(&state.pool)
    .await
    {
        tracing::warn!(%error, log_id, "search log completion update failed");
    }
}

async fn fail_search_log(state: &AppState, log_id: i64) {
    if let Err(error) = sqlx::query(
        "UPDATE search_logs SET status='failed',completed_at=now() WHERE id=$1 AND status='started'",
    )
    .bind(log_id)
    .execute(&state.pool)
    .await
    {
        tracing::warn!(%error, log_id, "search log failure update failed");
    }
}

pub async fn search_json(
    State(state): State<Arc<AppState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = admin_only(&headers, &state).await?;
    let ip = crate::security::client_ip(&headers, remote, &state.security);
    let mut req = SearchRequest {
        kw: q.get("kw").cloned().unwrap_or_default(),
        channels: q
            .get("channels")
            .map(|x| x.split(',').map(str::to_owned).collect()),
        source_ids: None,
        conc: None,
    };
    if !valid_search_keyword(&req.kw) {
        return Err(ApiError::BadRequest(
            "kw must contain 1 to 100 characters".into(),
        ));
    }
    let policy = crate::policy::load(&state.pool).await?;
    resolve_custom_channels(&state, &session, &mut req, &policy).await?;
    crate::security::authorize_search_rate(&state.redis, &state.security, &session, ip, &policy)
        .await?;
    let permit = crate::security::acquire_search_permit(
        &state.redis,
        &state.security,
        &session,
        policy.search_timeout_ms.div_ceil(1000).saturating_add(30),
    )
    .await?;
    let search_log_id = create_search_log(&state, &session, &req, ip).await;
    let result = run_search(&state, req.clone(), true, &policy).await;
    permit.release().await;
    let out = match result {
        Ok(output) => output,
        Err(error) => {
            if let Some(log_id) = search_log_id {
                fail_search_log(&state, log_id).await;
            }
            return Err(error);
        }
    };
    if let Some(log_id) = search_log_id {
        complete_search_log(&state, log_id, &out).await;
    }
    let (results, sources) = project_output(&state, &session, &req, &out).await?;
    Ok(Json(
        json!({"code":0,"message":"success","data":{"contractVersion":2,"total":out.total,"results":results,"sources":sources,"searchLogId":search_log_id}}),
    ))
}

async fn project_output(
    state: &AppState,
    session: &crate::auth::Session,
    req: &SearchRequest,
    out: &SearchResponse,
) -> Result<(Vec<Value>, Vec<Value>), ApiError> {
    let metas = out.sources.as_deref().unwrap_or_default();
    let live_count: usize = metas.iter().map(|m| m.results.len()).sum();
    let local_count = out.results.len().saturating_sub(live_count);
    let mut results =
        crate::link_resolution::project(state, session, req, None, &out.results[..local_count])
            .await?;
    let mut sources = vec![];
    for source in metas {
        let items =
            crate::link_resolution::project(state, session, req, Some(&source.id), &source.results)
                .await?;
        results.extend(items.iter().cloned());
        sources.push(json!({"id":source.id,"name":crate::resource_clean::clean_field(&source.name),"priority":source.priority,"status":source.status,"resultCount":items.len(),"elapsedMs":source.elapsed_ms,"transformMs":source.transform_ms,"proxyNodes":[],"results":items}));
    }
    Ok((results, sources))
}
#[cfg(test)]
fn search_json_payload(out: SearchResponse, search_log_id: Option<i64>) -> Value {
    json!({"code":0,"message":"success","data":{"total":out.total,"results":out.results,"sources":out.sources.unwrap_or_default(),"searchLogId":search_log_id}})
}
const SEARCH_SSE_INTERVAL_MS: u64 = 16;

fn sse_start_payload(search_log_id: Option<i64>) -> Value {
    json!({
        "intervalMs": SEARCH_SSE_INTERVAL_MS,
        "contractVersion": 2,
        "searchLogId": search_log_id,
    })
}

#[cfg(test)]
fn sse_result_payload(results: Vec<SearchResult>) -> Value {
    json!({"results": results})
}

fn sse_complete_payload(total: usize) -> Value {
    json!({"total": total})
}

fn encode_sse_event(id: u64, event: &str, data: Value) -> String {
    format!("id: {id}\nevent: {event}\ndata: {data}\n\n")
}

async fn push_sse_event(
    sender: &mpsc::Sender<String>,
    event_id: &mut u64,
    event: &str,
    data: Value,
) -> Result<(), mpsc::error::SendError<String>> {
    *event_id += 1;
    sender.send(encode_sse_event(*event_id, event, data)).await
}

fn sse_response(body: Body) -> Response {
    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, no-transform"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
}

pub async fn search_sse(
    State(state): State<Arc<AppState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SearchRequest>,
) -> Result<Response, ApiError> {
    let session = state.auth().session(&headers).await?;
    let ip = crate::security::client_ip(&headers, remote, &state.security);
    let mut req = req;
    if !valid_search_keyword(&req.kw) {
        return Err(ApiError::BadRequest(
            "kw must contain 1 to 100 characters".into(),
        ));
    }
    let policy = crate::policy::load(&state.pool).await?;
    resolve_custom_channels(&state, &session, &mut req, &policy).await?;
    crate::security::authorize_search_rate(&state.redis, &state.security, &session, ip, &policy)
        .await?;
    let permit = crate::security::acquire_search_permit(
        &state.redis,
        &state.security,
        &session,
        policy.search_timeout_ms.div_ceil(1000).saturating_add(30),
    )
    .await?;
    let search_log_id = create_search_log(&state, &session, &req, ip).await;
    let sources = match load_sources(&state, req.source_ids.as_ref(), req.channels.as_ref()).await {
        Ok(sources) => sources,
        Err(error) => {
            if let Some(log_id) = search_log_id {
                fail_search_log(&state, log_id).await;
            }
            return Err(error);
        }
    };
    let cache_key = if sources.local_channels.is_empty() && req.channels.is_none() {
        Some(search_cache_key(&state, &req).await?)
    } else {
        None
    };
    if let Some(output) = match cache_key.as_deref() {
        Some(key) => get_cached_search(&state, key, &policy).await,
        None => None,
    } {
        permit.release().await;
        if let Some(log_id) = search_log_id {
            complete_search_log(&state, log_id, &output).await;
        }
        let mut event_id = 0;
        let mut encoded = String::new();
        event_id += 1;
        encoded.push_str(&encode_sse_event(
            event_id,
            "start",
            sse_start_payload(search_log_id),
        ));
        if !output.results.is_empty() {
            event_id += 1;
            encoded.push_str(&encode_sse_event(
                event_id,
                "result",
                json!({"contractVersion":2,"results":project_output(&state,&session,&req,&output).await?.0}),
            ));
        }
        event_id += 1;
        encoded.push_str(&encode_sse_event(
            event_id,
            "complete",
            sse_complete_payload(output.total),
        ));
        return Ok(sse_response(Body::from(encoded)));
    }
    let keyword = req.kw.trim().to_owned();
    let concurrency = req.conc.unwrap_or(policy.default_concurrency);
    let worker_state = state.as_ref().clone();
    let (sender, mut receiver) = mpsc::channel::<String>(1);

    tokio::spawn(async move {
        let _permit = permit;
        let mut event_id = 0;
        if push_sse_event(
            &sender,
            &mut event_id,
            "start",
            sse_start_payload(search_log_id),
        )
        .await
        .is_err()
        {
            if let Some(log_id) = search_log_id {
                fail_search_log(&worker_state, log_id).await;
            }
            return;
        }

        let executions = source_execution_stream(
            worker_state.clone(),
            sources,
            keyword,
            concurrency,
            policy.clone(),
        );
        let mut all = Vec::new();
        let mut metas = Vec::new();
        let mut last_result_sent_at: Option<Instant> = None;
        futures::pin_mut!(executions);
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(policy.search_timeout_ms);

        loop {
            let next = match tokio::time::timeout_at(deadline, executions.next()).await {
                Ok(next) => next,
                Err(_) => {
                    if let Some(log_id) = search_log_id {
                        fail_search_log(&worker_state, log_id).await;
                    }
                    let _ = push_sse_event(
                        &sender,
                        &mut event_id,
                        "error",
                        json!({"message": "搜索执行超时"}),
                    )
                    .await;
                    return;
                }
            };
            let Some(value) = next else {
                break;
            };
            let (meta, items) = match value {
                Ok(v) => v,
                Err(_e) => {
                    if let Some(id) = search_log_id {
                        fail_search_log(&worker_state, id).await;
                    }
                    let _ = push_sse_event(
                        &sender,
                        &mut event_id,
                        "error",
                        json!({"message":"搜索执行失败，请稍后重试"}),
                    )
                    .await;
                    return;
                }
            };
            let succeeded = meta.as_ref().is_none_or(|meta| meta.status == "success");
            let source_id = meta.as_ref().map(|m| m.id.clone());
            let local_empty = meta.is_none() && items.is_empty();
            all.extend(items.iter().cloned());
            if let Some(meta) = meta {
                metas.push(meta);
            }
            if !succeeded || local_empty {
                continue;
            }

            if let Some(last_sent_at) = last_result_sent_at {
                let minimum_interval = Duration::from_millis(SEARCH_SSE_INTERVAL_MS);
                if let Some(remaining) = minimum_interval.checked_sub(last_sent_at.elapsed()) {
                    tokio::time::sleep(remaining).await;
                }
            }
            let projected = match crate::link_resolution::project(
                &worker_state,
                &session,
                &req,
                source_id.as_deref(),
                &items,
            )
            .await
            {
                Ok(v) => v,
                Err(_) => {
                    let _ = push_sse_event(
                        &sender,
                        &mut event_id,
                        "error",
                        json!({"message":"链接引用暂不可用，请重试搜索"}),
                    )
                    .await;
                    return;
                }
            };
            if push_sse_event(
                &sender,
                &mut event_id,
                "result",
                json!({"contractVersion":2,"results":projected}),
            )
            .await
            .is_err()
            {
                if let Some(log_id) = search_log_id {
                    fail_search_log(&worker_state, log_id).await;
                }
                return;
            }
            last_result_sent_at = Some(Instant::now());
        }

        let output = finalize_search(all, metas, true);
        if let Some(cache_key) = cache_key {
            cache_search(&worker_state, cache_key, output.clone(), &policy).await;
        }
        if let Some(log_id) = search_log_id {
            complete_search_log(&worker_state, log_id, &output).await;
        }
        let _ = push_sse_event(
            &sender,
            &mut event_id,
            "complete",
            sse_complete_payload(output.total),
        )
        .await;
    });

    let stream = async_stream::stream! {
        while let Some(event) = receiver.recv().await {
            yield Ok::<_, std::convert::Infallible>(event);
        }
    };
    Ok(sse_response(Body::from_stream(stream)))
}

pub async fn source_probe(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let id = body
        .get("sourceId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("sourceId is required".into()))?;
    let kw = body.get("kw").and_then(Value::as_str).unwrap_or("test");
    let row=sqlx::query("SELECT id,name,description,url,method,format,priority,enabled,request_json,transform FROM resource_sources WHERE id=$1").bind(id).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::NotFound("Unknown source".into()))?;
    let source = Source {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        url: row.get("url"),
        method: row.get("method"),
        format: row.get("format"),
        priority: row.get("priority"),
        enabled: row.get("enabled"),
        request: row.get("request_json"),
        transform: row.get("transform"),
    };
    let started = Instant::now();
    let policy = crate::policy::load(&state.pool).await?;
    let (meta, results) = execute_source(&state, &source, kw, &policy).await;
    Ok(Json(
        json!({"sourceId":id,"checkedAt":chrono::Utc::now(),"state":if meta.status=="success"{"available"}else{"error"},"message":meta.status,"elapsedMs":started.elapsed().as_millis(),"httpStatus":null,"traces":[],"raw":"","rawTruncated":false,"results":results}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Link;

    fn result(id: &str, name: &str) -> SearchResult {
        SearchResult {
            id: id.into(),
            name: name.into(),
            description: None,
            datetime: None,
            cloud_types: vec!["quark".into()],
            links: vec![Link {
                r#type: "quark".into(),
                url: "https://pan.quark.cn/s/same-share".into(),
                password: None,
            }],
            tags: None,
            images: None,
        }
    }

    #[test]
    fn search_keeps_local_first_and_leaves_duplicates_to_clients() {
        let local = result("local", "采集标题");
        let live = result("live", "外部标题");
        let output = finalize_search(vec![local, live.clone(), live], vec![], true);
        assert_eq!(output.total, 3);
        assert_eq!(output.results[0].id, "local");
        assert_eq!(output.results[1].id, "live");
        assert_eq!(output.results[2].id, "live");
        let payload = search_json_payload(output, None);
        assert_eq!(payload["data"]["results"].as_array().unwrap().len(), 3);
        assert_eq!(payload["data"]["total"], 3);
        assert_eq!(payload["data"]["sources"], json!([]));
    }

    #[test]
    fn local_only_json_has_flat_results_without_source_metadata() {
        let payload = search_json_payload(
            finalize_search(vec![result("local", "采集标题")], vec![], true),
            Some(7),
        );
        assert_eq!(payload["data"]["total"], 1);
        assert_eq!(payload["data"]["searchLogId"], 7);
        assert_eq!(payload["data"]["sources"], json!([]));
        assert_eq!(payload["data"]["results"][0]["name"], "采集标题");
        for key in [
            "priority",
            "sourceId",
            "proxyNodes",
            "transformMs",
            "elapsedMs",
        ] {
            assert!(payload["data"]["results"][0].get(key).is_none());
        }
    }

    #[tokio::test]
    async fn custom_scope_validates_only_submitted_channels_without_resource_io() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        let state = AppState::new(pool, crate::redis_store::RedisStore::disconnected());
        let session = crate::auth::Session {
            token: "unit-test".into(),
            user_id: Some(1),
        };
        let mut req:SearchRequest=serde_json::from_value(json!({"kw":"x","channels":["@Example_Channel","https://t.me/s/another"],"source_ids":["ignore-system"]})).unwrap();
        resolve_custom_channels(
            &state,
            &session,
            &mut req,
            &crate::policy::UserPolicy::default(),
        )
        .await
        .unwrap();
        assert_eq!(req.channels.unwrap(), vec!["another", "example_channel"]);
        assert!(req.source_ids.is_none());
        let mut invalid: SearchRequest = serde_json::from_value(
            json!({"kw":"x","channels":["https://example.com/not-a-channel"]}),
        )
        .unwrap();
        assert!(
            resolve_custom_channels(
                &state,
                &session,
                &mut invalid,
                &crate::policy::UserPolicy::default()
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn execution_returns_local_batch_before_polling_live_sources() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(500))
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        let state = AppState::new(pool, crate::redis_store::RedisStore::disconnected());
        let sources = SearchSources {
            local_channels: vec![],
            live_sources: vec![Source {
                id: "live".into(),
                name: "live".into(),
                description: "".into(),
                url: "http://127.0.0.1:1/live".into(),
                method: "GET".into(),
                format: "json".into(),
                priority: 0,
                enabled: true,
                request: None,
                transform: "".into(),
            }],
        };
        let stream = source_execution_stream(
            state,
            sources,
            "test".into(),
            1,
            crate::policy::UserPolicy::default(),
        );
        futures::pin_mut!(stream);
        let (meta, results) = tokio::time::timeout(Duration::from_millis(100), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(meta.is_none());
        assert!(results.is_empty());
    }

    #[test]
    fn sse_events_use_real_line_breaks() {
        let event = encode_sse_event(3, "complete", json!({"total": 1}));
        assert_eq!(event, "id: 3\nevent: complete\ndata: {\"total\":1}\n\n");
        assert!(!event.contains("\\n"));
    }
    #[test]
    fn sse_payload_contract_matches_main_without_source_identity() {
        let start = sse_start_payload(Some(42));
        assert_eq!(start["intervalMs"], SEARCH_SSE_INTERVAL_MS);
        assert_eq!(start["searchLogId"], 42);
        assert_eq!(start.as_object().map(serde_json::Map::len), Some(3));
        assert_eq!(start["contractVersion"], 2);

        let result = sse_result_payload(Vec::new());
        assert!(result["results"].is_array());
        assert_eq!(result.as_object().map(serde_json::Map::len), Some(1));
        assert!(result.get("sourceId").is_none());
        assert!(result.get("plugin").is_none());

        let complete = sse_complete_payload(7);
        assert_eq!(complete["total"], 7);
        assert_eq!(complete.as_object().map(serde_json::Map::len), Some(1));
        assert!(complete.get("searchLogId").is_none());
    }
    #[test]
    fn search_json_contract_matches_public_api_shape() {
        let result = SearchResult {
            id: "result-1".into(),
            name: "demo".into(),
            description: None,
            datetime: Some("2026-09-29 12:00:00".into()),
            cloud_types: vec!["quark".into()],
            links: vec![Link {
                r#type: "quark".into(),
                url: "https://pan.quark.cn/s/demo".into(),
                password: None,
            }],
            tags: None,
            images: None,
        };
        let payload = search_json_payload(
            SearchResponse {
                total: 1,
                results: vec![result.clone()],
                sources: Some(vec![SourceMeta {
                    id: "pansearch".into(),
                    name: "PanSearch".into(),
                    priority: 0,
                    status: "success".into(),
                    result_count: 1,
                    elapsed_ms: 20,
                    transform_ms: Some(2),
                    proxy_nodes: vec![json!({"nodeId":"edge-1","status":"success"})],
                    results: vec![result],
                }]),
            },
            Some(42),
        );
        assert_eq!(payload["code"], 0);
        assert_eq!(payload["message"], "success");
        assert_eq!(payload["data"]["total"], 1);
        assert_eq!(payload["data"]["searchLogId"], 42);
        assert_eq!(payload["data"]["results"][0]["id"], "result-1");
        assert!(payload["data"]["results"][0].get("priority").is_none());
        let source = &payload["data"]["sources"][0];
        for key in [
            "id",
            "name",
            "priority",
            "status",
            "resultCount",
            "elapsedMs",
            "transformMs",
            "proxyNodes",
            "results",
        ] {
            assert!(source.get(key).is_some(), "missing field: {key}");
        }
    }
}
