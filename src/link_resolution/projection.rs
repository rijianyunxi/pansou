//! Build public search results and persist session-bound capabilities.
use super::{FACT_COLUMNS, Fact, REF_SECONDS, Snapshot, aggregate, fingerprint, keyed, subject};
use crate::{
    app::AppState,
    auth::Session,
    error::ApiError,
    models::{Link, SearchRequest, SearchResult},
    resource_clean,
};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

fn clean(value: &str, links: &[Link]) -> String {
    let mut value = resource_clean::clean_field(value);
    for link in links {
        value = value.replace(&link.url, "");
        if let Some(password) = &link.password {
            if !password.is_empty() {
                value = value.replace(password, "");
            }
        }
    }
    // Also remove scheme-less, encoded and HTML-decoded share-address tokens.
    value
        .split_whitespace()
        .filter(|token| {
            !token.contains("/s/")
                && !token.contains("%2F")
                && !token.contains("%2f")
                && !token.contains("pan.")
        })
        .collect::<Vec<_>>()
        .join(" ")
}
pub(crate) async fn project(
    state: &AppState,
    session: &Session,
    req: &SearchRequest,
    source: Option<&str>,
    results: &[SearchResult],
) -> Result<Vec<Value>, ApiError> {
    let custom = req.channels.is_some();
    let source_revision = if let Some(id) = source.filter(|_| !custom) {
        sqlx::query_scalar("SELECT updated_at FROM resource_sources WHERE id=$1 AND enabled")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
    } else {
        None
    };
    let fingerprints: Vec<_> = results
        .iter()
        .flat_map(|r| r.links.iter().map(fingerprint))
        .collect();
    let rows = if custom {
        vec![]
    } else {
        sqlx::query(&format!(
        "SELECT input_fingerprint,{FACT_COLUMNS} FROM link_catalog WHERE input_fingerprint=ANY($1)"
    ))
    .bind(&fingerprints)
    .fetch_all(&state.pool)
    .await?
    };
    let facts: HashMap<String, Fact> = rows
        .iter()
        .map(|r| Ok((r.try_get("input_fingerprint")?, sqlx::FromRow::from_row(r)?)))
        .collect::<Result<_, sqlx::Error>>()?;
    let mut pipe = redis::pipe();
    let expires_at = Utc::now() + chrono::Duration::seconds(REF_SECONDS as i64);
    let mut projected = vec![];
    for result in results {
        let result_ref = if custom {
            format!("custom:{}", Uuid::new_v4())
        } else {
            Uuid::new_v4().to_string()
        };
        let mut private = HashMap::new();
        let mut keys = vec![];
        let links: Vec<_> = result.links.iter().map(|link| {
            let link_ref = Uuid::new_v4().to_string();
            private.insert(link_ref.clone(), link.clone());
            let key = keyed(&session.token, &resource_clean::link_identity(&link.url)); keys.push(key.clone());
            let fact = facts.get(&fingerprint(link));
            json!({"linkRef":link_ref,"linkKey":key,"type":clean(&link.r#type,&result.links),"validity":fact.map_or(-1,Fact::current),"checkedAt":fact.and_then(|f| f.checked_at),"stale":fact.is_some_and(Fact::stale)})
        }).collect();
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            keys.push(format!("empty:{}:{}", source.unwrap_or("local"), result.id));
        }
        let snapshot = Snapshot {
            subject: subject(session),
            request: req.clone(),
            source: source.map(str::to_owned),
            source_revision,
            resource_id: result.id.clone(),
            links: private,
            expires_at,
        };
        pipe.cmd("SETEX")
            .arg(format!("pansou:link-ref:v2:{result_ref}"))
            .arg(REF_SECONDS)
            .arg(
                serde_json::to_string(&snapshot)
                    .map_err(|_| ApiError::Internal("引用编码失败".into()))?,
            )
            .ignore();
        projected.push(json!({"id":keyed(&session.token,&format!("{}:{}",source.unwrap_or("local"),result.id)),"resultRef":result_ref,"dedupKey":keyed(&session.token,&keys.join(":")),"name":clean(&result.name,&result.links),"description":result.description.as_ref().map(|v|clean(v,&result.links)),"datetime":result.datetime.as_ref().map(|v|clean(v,&result.links)),"cloud_types":links.iter().map(|l|l["type"].clone()).collect::<Vec<_>>(),"validity":aggregate(links.iter().map(|l| l["validity"].as_i64().unwrap_or(-1) as i16)),"links":links,"images":[],"refsExpireAt":expires_at}));
    }
    if !results.is_empty() {
        let _: () = pipe
            .query_async(&mut state.redis.connection()?)
            .await
            .map_err(|_| ApiError::Unavailable("链接引用暂不可用".into()))?;
    }
    Ok(projected)
}
