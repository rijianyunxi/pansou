use crate::{app::AppState, error::ApiError, models::SearchResult, resource_clean};
use redis::AsyncCommands;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;

pub async fn query(
    state: &AppState,
    channels: &[String],
    keyword: &str,
) -> Result<Vec<SearchResult>, ApiError> {
    if channels.is_empty() {
        return Ok(vec![]);
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='5000ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL work_mem='64MB'")
        .execute(&mut *tx)
        .await?;
    let revision = sqlx::query_scalar::<_, i64>(
        "SELECT revision FROM config_revisions WHERE scope='local-index'",
    )
    .fetch_one(&mut *tx)
    .await?;
    let keyword = keyword.trim().to_lowercase();
    let mut channel_scope = channels.to_vec();
    channel_scope.sort();
    channel_scope.dedup();
    let identity = json!({"match":"name-only-v2","kw":keyword,"channels":channel_scope,"revision":revision,"limit":200});
    let key = format!(
        "pansou:local-search:{:x}",
        Sha256::digest(identity.to_string().as_bytes())
    );
    let mut cached = None;
    if let Ok(mut conn) = state.redis.connection() {
        cached = conn.get::<_, Option<String>>(&key).await.ok().flatten();
    }
    let rows: Vec<Value> = if let Some(rows) = cached.and_then(|s| serde_json::from_str(&s).ok()) {
        rows
    } else {
        let gram = resource_clean::grams(&keyword)
            .into_iter()
            .find(|s| s.chars().count() == keyword.chars().count().min(2));
        let rows = match gram.as_ref() {
            // gram 命中时从 resource_grams 反查资源,避免全量扫描 occurrences
            Some(g) => sqlx::query(include_str!("queries/telegram_search_gram.sql"))
                .bind(&keyword)
                .bind(g)
                .bind(channels)
                .fetch_all(&mut *tx)
                .await?,
            None => sqlx::query(include_str!("queries/telegram_search.sql"))
                .bind(&keyword)
                .bind(&gram)
                .bind(channels)
                .fetch_all(&mut *tx)
                .await?,
        };
        let values = rows
            .into_iter()
            .map(|r| r.get::<Value, _>("item"))
            .collect::<Vec<_>>();
        if let Ok(mut conn) = state.redis.connection() {
            let ttl = if values.is_empty() { 10 } else { 60 };
            let _: Result<(), _> = conn
                .set_ex(&key, serde_json::to_string(&values).unwrap(), ttl)
                .await;
        }
        values
    };
    tx.commit().await?;
    rows.into_iter()
        .map(|row| serde_json::from_value::<SearchResult>(row).map(resource_clean::normalize))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| ApiError::Internal(e.to_string()))
}
