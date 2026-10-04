//! Batched validity reads. Every result capability is authorized once per request.
use super::capability::snapshot_with_policy;
use super::{FACT_COLUMNS, Fact, LinkRef, aggregate, fingerprint, response};
use crate::{app::AppState, error::ApiError, models::Link};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use futures::{StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc};

async fn snapshots(
    state: &AppState,
    session: &crate::auth::Session,
    refs: impl Iterator<Item = String>,
) -> Result<HashMap<String, Result<super::Snapshot, u16>>, ApiError> {
    let refs: std::collections::HashSet<_> = refs.collect();
    if refs.is_empty() {
        return Ok(HashMap::new());
    }
    let policy = crate::policy::load(&state.pool).await?;
    Ok(stream::iter(refs.into_iter().map(|reference| {
        let policy = &policy;
        async move {
            let value = snapshot_with_policy(state, session, &reference, policy)
                .await
                .map_err(|e| e.status().as_u16());
            (reference, value)
        }
    }))
    .buffer_unordered(4)
    .collect()
    .await)
}

async fn facts(
    state: &AppState,
    links: impl Iterator<Item = &Link>,
) -> Result<HashMap<String, Fact>, ApiError> {
    let mut keys: Vec<_> = links.map(fingerprint).collect();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(&format!(
        "SELECT input_fingerprint,{FACT_COLUMNS} FROM link_catalog WHERE input_fingerprint=ANY($1)"
    ))
    .bind(keys)
    .fetch_all(&state.pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get("input_fingerprint")?,
                sqlx::FromRow::from_row(row)?,
            ))
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(Into::into)
}
fn public_fact(fact: Option<&Fact>, link: &Link, link_ref: &str) -> Value {
    let mut value = fact.map(Fact::public).unwrap_or_else(|| json!({"validity":-1,"checkedAt":null,"lastAttemptAt":null,"stale":false,"reasonCode":null,"createdAt":null,"checkStatus":"unchecked","checkMessage":null}));
    value["linkRef"] = json!(link_ref);
    value["type"] = json!(link.r#type);
    value
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusInput {
    items: Vec<LinkRef>,
}

pub async fn statuses(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<StatusInput>,
) -> Result<Response, ApiError> {
    let session = state.auth().session(&headers).await?;
    if input.items.len() > 50 {
        return Err(ApiError::BadRequest("每次最多50条".into()));
    }
    let snapshots = snapshots(
        &state,
        &session,
        input.items.iter().map(|item| item.result_ref.clone()),
    )
    .await?;
    let catalog = facts(
        &state,
        snapshots
            .values()
            .filter_map(|s| s.as_ref().ok())
            .flat_map(|s| s.links.values()),
    )
    .await?;
    let results: Vec<_> = input
        .items
        .iter()
        .map(|item| match &snapshots[&item.result_ref] {
            Ok(snap) => match snap.links.get(&item.link_ref) {
                Some(link) => public_fact(catalog.get(&fingerprint(link)), link, &item.link_ref),
                None => json!({"linkRef":item.link_ref,"errorCode":404}),
            },
            Err(code) => json!({"linkRef":item.link_ref,"errorCode":code}),
        })
        .collect();
    Ok(response(StatusCode::OK, json!({"items":results})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceStatusInput {
    result_refs: Vec<String>,
}

pub async fn resource_statuses(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<ResourceStatusInput>,
) -> Result<Response, ApiError> {
    let session = state.auth().session(&headers).await?;
    if input.result_refs.len() > 50 {
        return Err(ApiError::BadRequest("每次最多50条".into()));
    }
    let snapshots = snapshots(&state, &session, input.result_refs.iter().cloned()).await?;
    let catalog = facts(
        &state,
        snapshots
            .values()
            .filter_map(|s| s.as_ref().ok())
            .flat_map(|s| s.links.values()),
    )
    .await?;
    let results: Vec<_> = input.result_refs.iter().map(|reference| match &snapshots[reference] {
        Err(code) => json!({"resultRef":reference,"errorCode":code}),
        Ok(snap) => {
            let values: Vec<_> = snap.links.iter().map(|(key, link)| public_fact(catalog.get(&fingerprint(link)), link, key)).collect();
            json!({"resultRef":reference,"validity":aggregate(values.iter().map(|v|v["validity"].as_i64().unwrap_or(-1) as i16)),"checkedAt":values.iter().filter_map(|v|v["checkedAt"].as_str()).min()})
        }
    }).collect();
    Ok(response(StatusCode::OK, json!({"items":results})))
}
