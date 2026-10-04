use crate::{app::AppState, error::ApiError, models::SearchResult, resource_clean};
use redis::AsyncCommands;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// One in-flight cache fill per keyword/scope; weak entries do not retain responses.
#[derive(Default)]
pub struct SearchLocks {
    entries: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl SearchLocks {
    async fn for_key(&self, key: &str) -> Arc<Mutex<()>> {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, value| value.strong_count() > 0);
        if let Some(lock) = entries.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        entries.insert(key.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

fn search_grams(keyword: &str) -> Vec<String> {
    let grams = resource_clean::grams(keyword);
    let longest = grams.iter().map(|g| g.chars().count()).max().unwrap_or(0);
    // Every selected gram is necessary for a substring match. A few intersections
    // reduce common-prefix candidates without probing every character of long input.
    grams
        .into_iter()
        .filter(|g| g.chars().count() == longest)
        .take(8)
        .collect()
}

/// Pick the entry gram by index rarity. Entry choice never changes the result
/// (every candidate gram is still required), but a rare entry keeps the plan on
/// index scans while a common one (e.g. a frequent bigram) degrades to hashing
/// over the whole occurrences table.
fn rarest_gram(grams: &[String], counts: &HashMap<String, i64>) -> String {
    grams
        .iter()
        .min_by_key(|g| counts.get(*g).copied().unwrap_or(0))
        .expect("grams is non-empty")
        .clone()
}

/// Counts come from an index-only scan, cheap next to a mis-planned join. A
/// gram missing from the table counts as zero: entering through it returns an
/// empty result, which is the correct answer and the fastest one. On query
/// error fall back to the caller-supplied default (the previous byte-order
/// choice).
async fn pick_entry_gram(
    tx: &mut sqlx::PgConnection,
    grams: &[String],
    fallback: String,
) -> String {
    let counts: HashMap<String, i64> = match sqlx::query!(
        "SELECT gram, count(*) AS \"n!\" FROM resource_grams WHERE gram = ANY($1) GROUP BY gram",
        grams,
    )
    .fetch_all(tx)
    .await
    {
        Ok(rows) => rows.into_iter().map(|row| (row.gram, row.n)).collect(),
        Err(_) => return fallback,
    };
    rarest_gram(grams, &counts)
}

fn cache_key(keyword: &str, channels: &[String], revision: i64) -> String {
    let identity = json!({"match":"name-only-v3-projection","kw":keyword,"channels":channels,"revision":revision,"limit":200});
    format!(
        "pansou:local-search:{:x}",
        Sha256::digest(identity.to_string().as_bytes())
    )
}

async fn cached(state: &AppState, key: &str) -> Option<Vec<Value>> {
    let mut connection = state.redis.connection().ok()?;
    let raw = tokio::time::timeout(
        Duration::from_millis(250),
        connection.get::<_, Option<String>>(key),
    )
    .await
    .ok()?
    .ok()??;
    serde_json::from_str(&raw).ok()
}

fn results(rows: Vec<Value>) -> Result<Vec<SearchResult>, ApiError> {
    rows.into_iter()
        .map(|row| serde_json::from_value::<SearchResult>(row).map(resource_clean::normalize))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| ApiError::Internal(e.to_string()))
}

async fn revision(state: &AppState) -> Result<i64, ApiError> {
    Ok(
        sqlx::query_scalar!("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&state.pool)
            .await?,
    )
}

/// Phase timings for one local query; zero means that phase was skipped.
#[derive(Default, Clone, Copy)]
struct LocalSearchTiming {
    lock_ms: u64,
    slot_ms: u64,
    sql_ms: u64,
}

/// One line per local query, so the phase breakdown is visible in production
/// logs without attaching a profiler. Timings are wall-clock and include any
/// queueing, so `cache` is what distinguishes the three exit paths.
fn log_local_search(
    keyword: &str,
    channels: usize,
    cache: &'static str,
    started: Instant,
    timing: LocalSearchTiming,
    rows: usize,
) {
    tracing::info!(
        keyword,
        channels,
        cache,
        lock_ms = timing.lock_ms,
        slot_ms = timing.slot_ms,
        sql_ms = timing.sql_ms,
        total_ms = started.elapsed().as_millis() as u64,
        rows,
        "local search"
    );
}

pub async fn query(
    state: &AppState,
    channels: &[String],
    keyword: &str,
) -> Result<Vec<SearchResult>, ApiError> {
    let started = Instant::now();
    let keyword = keyword.trim().to_lowercase();
    if channels.is_empty() {
        return Ok(vec![]);
    }
    let mut scope = channels.to_vec();
    scope.sort();
    scope.dedup();
    let key = cache_key(&keyword, &scope, revision(state).await?);
    if let Some(rows) = cached(state, &key).await {
        log_local_search(
            &keyword,
            scope.len(),
            "hit",
            started,
            LocalSearchTiming::default(),
            rows.len(),
        );
        return results(rows);
    }
    // Coalesce before acquiring a scarce DB execution slot. Revision changes do
    // not split the lock for the same keyword/scope.
    let lock = state
        .local_search_locks
        .for_key(&cache_key(&keyword, &scope, 0))
        .await;
    let lock_started = Instant::now();
    let _refresh = tokio::time::timeout(Duration::from_secs(6), lock.lock())
        .await
        .map_err(|_| ApiError::Unavailable("本地搜索繁忙，请稍后重试".into()))?;
    let lock_ms = lock_started.elapsed().as_millis() as u64;
    let key = cache_key(&keyword, &scope, revision(state).await?);
    if let Some(rows) = cached(state, &key).await {
        log_local_search(
            &keyword,
            scope.len(),
            "hit-after-lock",
            started,
            LocalSearchTiming {
                lock_ms,
                ..Default::default()
            },
            rows.len(),
        );
        return results(rows);
    }
    let slot_started = Instant::now();
    let _slot = tokio::time::timeout(Duration::from_secs(2), state.local_search_slots.acquire())
        .await
        .map_err(|_| ApiError::Unavailable("本地搜索繁忙，请稍后重试".into()))?
        .map_err(|_| ApiError::Unavailable("本地搜索正在关闭".into()))?;
    let slot_ms = slot_started.elapsed().as_millis() as u64;
    let sql_started = Instant::now();
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    // These are transaction-local: parallel hash allocation cannot exhaust
    // Docker /dev/shm, and bounded narrow rows do not need 64MB per node.
    sqlx::query("SET LOCAL statement_timeout='5000ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL work_mem='16MB'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL max_parallel_workers_per_gather=0")
        .execute(&mut *tx)
        .await?;
    let snapshot_revision: i64 =
        sqlx::query_scalar!("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await?;
    let grams = search_grams(&keyword);
    let rows = if grams.is_empty() {
        sqlx::query_file_scalar!(
            "src/queries/telegram_search.sql",
            keyword,
            None::<&str>,
            &scope,
        )
        .fetch_all(&mut *tx)
        .await?
    } else {
        let entry = pick_entry_gram(&mut tx, &grams, grams[0].clone()).await;
        let required: Vec<String> = grams.iter().filter(|g| *g != &entry).cloned().collect();
        sqlx::query_file_scalar!(
            "src/queries/telegram_search_gram.sql",
            keyword,
            entry,
            &scope,
            &required,
        )
        .fetch_all(&mut *tx)
        .await?
    };
    let values = rows
        .into_iter()
        .map(|item| item.ok_or_else(|| ApiError::Internal("资源搜索投影为空".into())))
        .collect::<Result<Vec<Value>, ApiError>>()?;
    tx.commit().await?;
    let sql_ms = sql_started.elapsed().as_millis() as u64;
    drop(_slot);
    // Result/version were read from one snapshot. Redis is never awaited while
    // the SQL transaction/connection is held, even during a cache fill.
    if let Ok(mut connection) = state.redis.connection() {
        let key = cache_key(&keyword, &scope, snapshot_revision);
        let ttl = if values.is_empty() { 10 } else { 60 };
        let serialized =
            serde_json::to_string(&values).map_err(|e| ApiError::Internal(e.to_string()))?;
        let _ = tokio::time::timeout(
            Duration::from_millis(250),
            connection.set_ex::<_, _, ()>(&key, serialized, ttl),
        )
        .await;
    }
    log_local_search(
        &keyword,
        scope.len(),
        "miss",
        started,
        LocalSearchTiming {
            lock_ms,
            slot_ms,
            sql_ms,
        },
        values.len(),
    );
    results(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grams_handle_separated_letters_and_symbols_without_losing_matches() {
        assert!(search_grams("!!!").is_empty());
        assert_eq!(search_grams("a !!! b"), vec!["a", "b"]);
        assert_eq!(search_grams("三体"), vec!["三体"]);
        assert!(
            search_grams("电影 资料")
                .iter()
                .all(|g| g.chars().count() == 2)
        );
        assert!(search_grams("abcdefghijklmnopqrstuvwxyz").len() <= 8);
    }

    #[test]
    fn entry_gram_is_the_rarest_and_ties_keep_order() {
        let grams = vec!["地球".to_string(), "流浪".to_string(), "浪地".to_string()];
        let counts = HashMap::from([
            ("地球".to_string(), 60_000),
            ("流浪".to_string(), 900),
            ("浪地".to_string(), 12),
        ]);
        assert_eq!(rarest_gram(&grams, &counts), "浪地");

        // A gram absent from the index matches nothing: fastest correct entry.
        let counts = HashMap::from([("地球".to_string(), 60_000)]);
        assert_eq!(rarest_gram(&grams, &counts), "流浪");

        let counts = HashMap::from([
            ("地球".to_string(), 60_000),
            ("流浪".to_string(), 900),
            ("浪地".to_string(), 900),
        ]);
        assert_eq!(rarest_gram(&grams, &counts), "流浪");
    }

    #[tokio::test]
    async fn fill_locks_are_shared_only_while_in_use() {
        let locks = SearchLocks::default();
        let first = locks.for_key("same").await;
        let second = locks.for_key("same").await;
        assert!(Arc::ptr_eq(&first, &second));
        drop(first);
        drop(second);
        let _other = locks.for_key("other").await;
        assert_eq!(locks.entries.lock().await.len(), 1);
    }

    #[test]
    fn local_search_log_exposes_every_phase_and_the_cache_outcome() {
        use std::io::Write;
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone, Default)]
        struct Capture(Arc<std::sync::Mutex<Vec<u8>>>);
        impl Write for Capture {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Capture {
            type Writer = Capture;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            log_local_search(
                "兰香如故",
                9,
                "miss",
                Instant::now(),
                LocalSearchTiming {
                    lock_ms: 1,
                    slot_ms: 2,
                    sql_ms: 3,
                },
                42,
            );
        });

        let output = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        for expected in [
            "local search",
            "keyword=\"兰香如故\"",
            "channels=9",
            "cache=\"miss\"",
            "lock_ms=1",
            "slot_ms=2",
            "sql_ms=3",
            "rows=42",
        ] {
            assert!(output.contains(expected), "missing {expected} in {output}");
        }
    }
}
