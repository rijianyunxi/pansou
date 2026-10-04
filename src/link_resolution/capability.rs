//! Resolve private snapshots and revalidate their session/source/resource scope.
use super::{Snapshot, fingerprint, subject};
use crate::{app::AppState, auth::Session, error::ApiError, models::Link};
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

pub(super) async fn authorize(
    state: &AppState,
    session: &Session,
    snapshot: &Snapshot,
) -> Result<(), ApiError> {
    let policy = crate::policy::load(&state.pool).await?;
    authorize_with_policy(state, session, snapshot, &policy).await
}

async fn authorize_with_policy(
    state: &AppState,
    session: &Session,
    snapshot: &Snapshot,
    policy: &crate::policy::UserPolicy,
) -> Result<(), ApiError> {
    if snapshot.subject != subject(session) {
        return Err(ApiError::Forbidden("引用不属于当前会话".into()));
    }
    if snapshot.expires_at <= Utc::now() {
        return Err(ApiError::Gone("引用已过期，请重新搜索".into()));
    }
    let mut request = snapshot.request.clone();
    crate::handlers::search::resolve_custom_channels(state, session, &mut request, policy).await?;
    if request.channels.is_some() {
        let source = snapshot
            .source
            .as_deref()
            .and_then(|s| s.strip_prefix("custom:"));
        if !source.is_some_and(|s| request.channels.as_ref().unwrap().iter().any(|c| c == s)) {
            return Err(ApiError::Forbidden("频道引用范围不符".into()));
        }
        return Ok(());
    }
    let sources = crate::handlers::search::load_sources(
        state,
        request.source_ids.as_ref(),
        request.channels.as_ref(),
    )
    .await?;
    if let Some(source) = &snapshot.source {
        if !sources.live_sources.iter().any(|s| &s.id == source) {
            return Err(ApiError::Forbidden("来源已停用或不可访问".into()));
        }
        let revision: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT updated_at FROM resource_sources WHERE id=$1 AND enabled")
                .bind(source)
                .fetch_optional(&state.pool)
                .await?;
        if revision != snapshot.source_revision {
            return Err(ApiError::Conflict(
                "LINK_CHANGED：来源配置已改变，请重新搜索".into(),
            ));
        }
    } else {
        let rows=sqlx::query("SELECT r.enabled,r.deleted_at,r.manual_override,r.links_json,o.result_json FROM managed_resources r LEFT JOIN resource_occurrences o ON o.resource_id=r.id AND o.channel_id=ANY($2) LEFT JOIN source_messages m ON m.channel_id=o.channel_id AND m.message_id=o.message_id WHERE r.id=$1 AND (r.origin<>'telegram' OR m.parse_status='parsed')")
            .bind(&snapshot.resource_id).bind(&sources.local_channels).fetch_all(&state.pool).await?;
        if rows.is_empty() {
            return Err(ApiError::NotFound("资源不存在或频道权限已改变".into()));
        }
        let allowed = rows.iter().any(|r| {
            if !r.get::<bool, _>("enabled")
                || r.get::<Option<DateTime<Utc>>, _>("deleted_at").is_some()
            {
                return false;
            }
            let value = if r.get::<bool, _>("manual_override") {
                r.get::<Value, _>("links_json")
            } else {
                r.get::<Option<Value>, _>("result_json")
                    .map(|v| v["links"].clone())
                    .unwrap_or_else(|| r.get("links_json"))
            };
            let current = serde_json::from_value::<Vec<Link>>(value).unwrap_or_default();
            let mut expected: Vec<_> = snapshot.links.values().map(fingerprint).collect();
            expected.sort();
            expected.dedup();
            let mut actual: Vec<_> = current.iter().map(fingerprint).collect();
            actual.sort();
            actual.dedup();
            expected == actual
        });
        if !allowed {
            return Err(ApiError::Conflict(
                "LINK_CHANGED：资源已下架或链接已变化，请重新搜索".into(),
            ));
        }
    }
    Ok(())
}
pub(super) async fn snapshot(
    state: &AppState,
    session: &Session,
    result_ref: &str,
) -> Result<Snapshot, ApiError> {
    let snapshot = read_snapshot(state, result_ref).await?;
    authorize(state, session, &snapshot).await?;
    Ok(snapshot)
}

pub(super) async fn snapshot_with_policy(
    state: &AppState,
    session: &Session,
    result_ref: &str,
    policy: &crate::policy::UserPolicy,
) -> Result<Snapshot, ApiError> {
    let snapshot = read_snapshot(state, result_ref).await?;
    authorize_with_policy(state, session, &snapshot, policy).await?;
    Ok(snapshot)
}

async fn read_snapshot(state: &AppState, result_ref: &str) -> Result<Snapshot, ApiError> {
    Uuid::parse_str(result_ref.strip_prefix("custom:").unwrap_or(result_ref))
        .map_err(|_| ApiError::BadRequest("resultRef 格式无效".into()))?;
    let value: Option<String> = state
        .redis
        .connection()?
        .get(format!("pansou:link-ref:v2:{result_ref}"))
        .await
        .map_err(|_| ApiError::Unavailable("链接引用暂不可用".into()))?;
    let snapshot: Snapshot = serde_json::from_str(
        &value.ok_or_else(|| ApiError::Gone("引用已过期，请重新搜索".into()))?,
    )
    .map_err(|_| ApiError::Unavailable("链接引用不可用".into()))?;
    Ok(snapshot)
}
