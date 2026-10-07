//! Session-bound continuation tokens. Loading another page is the same search,
//! so it does not add a search-log row or increment a hot keyword's score.
use super::*;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
pub struct PageRequest {
    #[serde(flatten)]
    pub search: SearchRequest,
    pub cursor: Option<String>,
    #[serde(rename = "cloudType")]
    pub cloud_type: Option<String>,
    #[serde(rename = "searchContext")]
    pub search_context: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    subject: String,
    scope: String,
    anchor: Value,
    log_id: Option<i64>,
    loaded: usize,
    #[serde(default)]
    cloud_type: Option<String>,
    #[serde(default)]
    context: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Context {
    subject: String,
    scope: String,
    log_id: Option<i64>,
}

pub(super) fn validate_cloud_type(value: Option<&str>) -> Result<(), ApiError> {
    if let Some(value) = value {
        if ![
            "baidu",
            "quark",
            "guangya",
            "aliyun",
            "uc",
            "mobile",
            "tianyi",
            "115",
            "123",
            "jianguoyun",
            "lanzou",
            "xunlei",
            "magnet",
            "others",
        ]
        .contains(&value)
        {
            return Err(ApiError::BadRequest("无效网盘类型".into()));
        }
    }
    Ok(())
}

async fn read<T: serde::de::DeserializeOwned>(
    state: &AppState,
    namespace: &str,
    token: &str,
) -> Result<T, ApiError> {
    uuid::Uuid::parse_str(token)
        .map_err(|_| ApiError::BadRequest("分页参数无效，请重新搜索".into()))?;
    let raw: Option<String> = state
        .redis
        .connection()?
        .get(format!("pansou:{namespace}:v1:{token}"))
        .await
        .map_err(|_| ApiError::Unavailable("分页暂不可用".into()))?;
    serde_json::from_str(&raw.ok_or_else(|| ApiError::Gone("分页已过期，请重新搜索".into()))?)
        .map_err(|_| ApiError::Internal("分页数据异常".into()))
}

async fn save(
    state: &AppState,
    namespace: &str,
    value: &impl Serialize,
) -> Result<String, ApiError> {
    let token = uuid::Uuid::new_v4().to_string();
    let _: () = state
        .redis
        .connection()?
        .set_ex(
            format!("pansou:{namespace}:v1:{token}"),
            serde_json::to_string(value).map_err(|_| ApiError::Internal("分页编码失败".into()))?,
            1800,
        )
        .await
        .map_err(|_| ApiError::Unavailable("分页暂不可用".into()))?;
    Ok(token)
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn scope(req: &SearchRequest, channels: &[String]) -> String {
    let mut channels = channels.to_vec();
    channels.sort();
    channels.dedup();
    let mut sources = req.source_ids.clone().unwrap_or_default();
    sources.sort();
    sources.dedup();
    digest(&json!([req.kw.trim().to_lowercase(), channels, sources]).to_string())
}

async fn page_data(
    state: &AppState,
    session: &crate::auth::Session,
    req: &SearchRequest,
    channels: &[String],
    token: Option<&str>,
    cloud_type: Option<&str>,
    context_token: Option<&str>,
    ip: std::net::IpAddr,
) -> Result<(Value, usize), ApiError> {
    let subject = digest(&session.token);
    let scope = scope(req, channels);
    validate_cloud_type(cloud_type)?;
    let previous = if let Some(token) = token {
        let cursor: Cursor = read(state, "search-page", token).await?;
        if cursor.subject != subject
            || cursor.scope != scope
            || cursor.cloud_type.as_deref() != cloud_type
        {
            return Err(ApiError::BadRequest(
                "分页不属于当前搜索或网盘，请重新搜索".into(),
            ));
        }
        Some(cursor)
    } else {
        None
    };
    let context_token =
        context_token.or_else(|| previous.as_ref().and_then(|c| c.context.as_deref()));
    let context = if let Some(token) = context_token {
        let context: Context = read(state, "search-context", token).await?;
        if context.subject != subject
            || context.scope != scope
            || previous
                .as_ref()
                .is_some_and(|c| c.log_id != context.log_id)
        {
            return Err(ApiError::BadRequest(
                "搜索上下文不属于当前搜索，请重新搜索".into(),
            ));
        }
        Some(context)
    } else {
        None
    };
    let log_id = if let Some(c) = &previous {
        c.log_id
    } else if let Some(c) = &context {
        c.log_id
    } else {
        create_search_log(state, session, req, ip).await
    };
    let search_context = match context_token {
        Some(token) => token.to_owned(),
        None => {
            save(
                state,
                "search-context",
                &Context {
                    subject: subject.clone(),
                    scope: scope.clone(),
                    log_id,
                },
            )
            .await?
        }
    };
    let anchor = previous.as_ref().map(|c| &c.anchor).unwrap_or(&Value::Null);
    let mut page =
        match crate::local_index::page(state, channels, &req.kw, anchor, cloud_type).await {
            Ok(page) => page,
            Err(error) => {
                if previous.is_none() {
                    if let Some(id) = log_id {
                        fail_search_log(state, id).await;
                    }
                }
                return Err(error);
            }
        };
    page.results.truncate(
        crate::local_index::MAX_RESULTS.saturating_sub(previous.as_ref().map_or(0, |c| c.loaded)),
    );
    let projected =
        crate::link_resolution::project(state, session, req, None, &page.results).await?;
    let total = projected.len();
    let loaded = previous.as_ref().map_or(0, |c| c.loaded) + total;
    let next_cursor = if let Some(anchor) = page
        .next
        .filter(|_| loaded < crate::local_index::MAX_RESULTS)
    {
        let token = save(
            state,
            "search-page",
            &Cursor {
                subject,
                scope,
                anchor,
                log_id,
                loaded,
                cloud_type: cloud_type.map(str::to_owned),
                context: Some(search_context.clone()),
            },
        )
        .await?;
        Some(token)
    } else {
        None
    };
    // Idempotent cursor retries must not double-count returned rows.
    if let Some(id) = log_id {
        sqlx::query("UPDATE search_logs SET status='completed',result_count=GREATEST(COALESCE(result_count,0),$1),has_results=has_results OR $2,completed_at=now(),outcome_recorded=true WHERE id=$3")
            .bind(loaded as i32).bind(total>0).bind(id).execute(&state.pool).await?;
    }
    Ok((
        json!({"total":total,"pageSize":crate::local_index::PAGE_SIZE,"hasMore":next_cursor.is_some(),"nextCursor":next_cursor,"searchContext":search_context,"searchLogId":log_id,"results":crate::link_resolution::compact(projected)}),
        loaded,
    ))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn respond(
    state: &AppState,
    session: &crate::auth::Session,
    req: &SearchRequest,
    channels: &[String],
    token: Option<&str>,
    cloud_type: Option<&str>,
    context_token: Option<&str>,
    ip: std::net::IpAddr,
    headers: &HeaderMap,
    permit: crate::security::SearchPermit,
) -> Result<Response, ApiError> {
    // Resolve the first page before returning headers so auth/scope/expiry failures
    // remain normal HTTP errors. Later pages are pulled only while the body is read.
    let (mut data, mut loaded) = page_data(
        state,
        session,
        req,
        channels,
        token,
        cloud_type,
        context_token,
        ip,
    )
    .await?;
    if headers
        .get(header::ACCEPT)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| {
            h.split(',')
                .any(|v| v.trim().starts_with("application/json"))
        })
    {
        permit.release().await;
        let mut response = Json(json!({"code":0,"message":"success","data":data})).into_response();
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Accept"));
        return Ok(response);
    }
    let state = state.clone();
    let session = session.clone();
    let req = req.clone();
    let channels = channels.to_vec();
    let cloud_type = cloud_type.map(str::to_owned);
    let stream = async_stream::stream! {
        let _permit = permit;
        let mut id = 1;
        yield Ok::<_, std::convert::Infallible>(encode_sse_event(id,"start",json!({"searchLogId":data["searchLogId"],"searchContext":data["searchContext"],"intervalMs":500})));
        loop {
            let cursor = data["nextCursor"].as_str().map(str::to_owned);
            let context = data["searchContext"].as_str().map(str::to_owned);
            id += 1;
            yield Ok(encode_sse_event(id,"result",json!({"results":data["results"].take(),"nextCursor":cursor})));
            if cursor.is_none() {
                id += 1;
                yield Ok(encode_sse_event(id,"complete",json!({"total":loaded})));
                break;
            }
            // Start the delay after the preceding result has been yielded,
            // rather than timing from the start of its database query.
            tokio::time::sleep(Duration::from_millis(500)).await;
            match page_data(&state,&session,&req,&channels,cursor.as_deref(),cloud_type.as_deref(),context.as_deref(),ip).await {
                Ok((next,total)) => { data = next; loaded = total; }
                Err(error) => {
                    id += 1;
                    yield Ok(encode_sse_event(id,"error",json!({"message":error.to_string()})));
                    break;
                }
            }
        }
    };
    let mut response = sse_response(Body::from_stream(stream));
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Accept"));
    Ok(response)
}
