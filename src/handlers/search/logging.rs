use crate::{
    app::AppState,
    models::{SearchRequest, SearchResponse},
};
use serde_json::{Value, json};

pub(super) async fn create_search_log(
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
    // Both JSON and SSE (including cache hits) record one accepted search here.
    // Full search history is retained here; the database trims the hot shortlist.
    // Take the lock before the statement snapshot so an evicted term can recover
    // its historical score even when concurrent searches are accepted.
    let result = async {
        let mut tx = state.pool.begin().await?;
        crate::hot_search::lock(&mut tx).await?;
        let id = sqlx::query_scalar::<_, i64>(include_str!("../../queries/create_search_log.sql"))
            .bind(&session.token)
            .bind(session.user_id)
            .bind(keyword)
            .bind(ip.to_string())
            .bind(scope)
            .bind(json!(channels))
            .bind(json!(source_ids))
            .bind(keyword.to_lowercase())
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(id)
    }
    .await;
    result
        .map_err(|error| tracing::warn!(%error, "search log create failed"))
        .ok()
}

pub(super) async fn complete_search_log(state: &AppState, log_id: i64, output: &SearchResponse) {
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

pub(super) async fn fail_search_log(state: &AppState, log_id: i64) {
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
