use super::{
    cache::{cache_search, get_cached_search, search_cache_key},
    execution::{execute_custom, execute_source},
    sources::{SearchSources, load_sources},
};
use crate::{
    app::AppState,
    error::ApiError,
    models::{SearchRequest, SearchResponse, SearchResult, SourceMeta},
};
use futures::StreamExt;
use std::time::Duration;

pub(super) fn source_execution_stream(
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

pub(super) fn finalize_search(
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

pub(super) async fn run_search(
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
