use super::common::admin_only;
use crate::{
    app::AppState,
    error::ApiError,
    models::{SearchRequest, SearchResponse, Source},
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
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

mod cache;
mod execution;
mod health;
mod logging;
mod orchestration;
mod sources;

#[cfg(test)]
use crate::models::{SearchResult, SourceMeta};
use cache::{cache_search, get_cached_search, search_cache_key};
use execution::execute_source;
use logging::{complete_search_log, create_search_log, fail_search_log};
use orchestration::{finalize_search, run_search, source_execution_stream};
pub(crate) use sources::load_sources;

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
        return Err(ApiError::Forbidden("未登录不可使用".into()));
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
        &policy,
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
        &policy,
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
    let source = sqlx::query_as::<_, Source>(
        "SELECT id,name,description,url,method,format,priority,enabled,request_json AS request,transform FROM resource_sources WHERE id=$1",
    ).bind(id).fetch_optional(&state.pool).await?
        .ok_or_else(|| ApiError::NotFound("Unknown source".into()))?;
    let started = Instant::now();
    let policy = crate::policy::load(&state.pool).await?;
    let (meta, results) = execute_source(&state, &source, kw, &policy).await;
    Ok(Json(
        json!({"sourceId":id,"checkedAt":chrono::Utc::now(),"state":if meta.status=="success"{"available"}else{"error"},"message":meta.status,"elapsedMs":started.elapsed().as_millis(),"httpStatus":null,"traces":[],"raw":"","rawTruncated":false,"results":results}),
    ))
}

#[cfg(test)]
mod tests;
