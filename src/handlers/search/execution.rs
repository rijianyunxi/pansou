use super::health::{Observation, record_source_health, source_circuit_open};
use crate::{
    app::AppState,
    error::ApiError,
    models::{SearchResult, Source, SourceMeta},
    transform,
};
use futures::StreamExt;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

use crate::outbound::{
    encode_proxy_target, record_failure as record_proxy_failure,
    record_success as record_proxy_success,
};

pub(super) async fn execute_custom(
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
async fn execute_live(
    state: &AppState,
    source: &Source,
    kw: &str,
    policy: &crate::policy::UserPolicy,
    observation: &mut Observation,
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
            observation.error_category = Some("configuration");
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
            observation.error_category = Some("outbound");
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
        // Dimensions describe the final attempted request after any retries.
        *observation = Observation::default();
        observation.network = Some(false);
        observation.error_category = Some("network");
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
        observation.network = Some(true);
        let http_status = response.status().as_u16();
        observation.http = Some((200..300).contains(&http_status));
        observation.error_category = Some("http");
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
                observation.network = Some(false);
                observation.error_category = Some("network");
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
                observation.parsing = Some(true);
                observation.results = Some(!items.is_empty());
                observation.error_category = None;
                final_status = "success";
                final_items = items;
                final_transform_ms = Some(transform_started.elapsed().as_millis());
            }
            Err(error) => {
                observation.parsing = Some(false);
                observation.error_category = Some("parsing");
                tracing::warn!(source=%source.id,error=%error,"transform failed");
                final_status = "failed";
                final_transform_ms = Some(transform_started.elapsed().as_millis());
            }
        }
        break;
    }
    let elapsed_ms = started.elapsed().as_millis();
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

pub(super) async fn execute_source(
    state: &AppState,
    source: &Source,
    kw: &str,
    policy: &crate::policy::UserPolicy,
) -> (SourceMeta, Vec<SearchResult>) {
    let mut observation = Observation::default();
    let (meta, results) = execute_live(state, source, kw, policy, &mut observation).await;
    if meta.status != "skipped" {
        record_source_health(
            state,
            source,
            meta.status == "success",
            results.len(),
            meta.elapsed_ms,
            &observation,
            policy.circuit_breaker_max_failures,
        )
        .await;
    }
    (meta, results)
}
