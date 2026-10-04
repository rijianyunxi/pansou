use crate::{
    app::AppState,
    error::ApiError,
    models::{SearchRequest, SearchResponse},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(super) async fn search_cache_key(
    state: &AppState,
    req: &SearchRequest,
) -> Result<String, ApiError> {
    let revision = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
        "SELECT COALESCE(MAX(updated_at),to_timestamp(0)) FROM resource_sources",
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

pub(super) async fn get_cached_search(
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

pub(super) async fn cache_search(
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
