use sqlx::{PgPool, Postgres, QueryBuilder};
use std::{
    collections::HashMap,
    future::Future,
    hash::Hash,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// Coalesce each key independently; the registry lock never covers database I/O.
type CachedValue<V> = Arc<Mutex<Option<(Instant, V)>>>;
struct StatsCache<K, V> {
    entries: Mutex<HashMap<K, CachedValue<V>>>,
}

impl<K, V> Default for StatsCache<K, V> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone, V: Clone> StatsCache<K, V> {
    async fn load<E, F, Fut>(&self, key: K, ttl: Duration, loader: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        let entry = {
            let mut entries = self.entries.lock().await;
            if let Some(entry) = entries.get(&key) {
                entry.clone()
            } else {
                // Keep in-flight keys so waiters still share their refresh.
                if entries.len() >= 64 {
                    let idle = entries
                        .iter()
                        .find(|(_, entry)| Arc::strong_count(entry) == 1)
                        .map(|(key, _)| key.clone());
                    if let Some(idle) = idle {
                        entries.remove(&idle);
                    }
                }
                let entry = Arc::new(Mutex::new(None));
                // Above the bound, an unmatched key loads without being retained.
                if entries.len() < 64 {
                    entries.insert(key, entry.clone());
                }
                entry
            }
        };
        let mut cached = entry.lock().await;
        if let Some((expires, value)) = cached.as_ref() {
            if *expires > Instant::now() {
                return Ok(value.clone());
            }
        }
        // Cancellation/errors leave this key retryable and release its lock.
        let value = loader().await?;
        *cached = Some((Instant::now() + ttl, value.clone()));
        Ok(value)
    }

    async fn clear(&self) {
        // Detach old in-flight loads: they cannot repopulate the new registry.
        self.entries.lock().await.clear();
    }
}

#[derive(Clone, Debug, PartialEq, Eq, sqlx::FromRow)]
pub struct ChannelCounts {
    pub id: String,
    pub resource_count: i64,
    pub today_resource_count: i64,
}

#[derive(Clone, sqlx::FromRow)]
pub struct MonitorCounts {
    pub resources: i64,
    pub catalog: i64,
    pub valid: i64,
    pub invalid: i64,
    pub errors: i64,
    pub check_due: i64,
    pub check_failing: i64,
    pub check_unknown: i64,
}

#[derive(Default)]
pub struct AdminStats {
    monitor_counts: StatsCache<(), MonitorCounts>,
    cloud_types: StatsCache<(), Vec<String>>,
    resource_totals: StatsCache<(String, String), i64>,
    channel_counts: StatsCache<Vec<String>, HashMap<String, ChannelCounts>>,
}

/// Optional predicates are omitted instead of hiding indexed conditions behind OR.
pub(crate) fn resource_filters<'a>(
    query: &mut QueryBuilder<'a, Postgres>,
    needle: &'a str,
    cloud_type: &'a str,
) {
    query.push(" WHERE true");
    if !needle.is_empty() {
        query
            .push(" AND name ILIKE ")
            .push_bind(format!("%{needle}%"));
    }
    if !cloud_type.is_empty() {
        query
            .push(" AND EXISTS(SELECT 1 FROM resource_links l WHERE l.resource_id=managed_resources.id AND l.provider=")
            .push_bind(cloud_type).push(")");
    }
}

impl AdminStats {
    pub async fn channels(
        &self,
        pool: &PgPool,
        ids: &[String],
    ) -> Result<HashMap<String, ChannelCounts>, sqlx::Error> {
        let mut ids = ids.to_vec();
        ids.sort();
        ids.dedup();
        self.channel_counts
            .load(ids.clone(), Duration::from_secs(30), || async {
                let rows =
                    sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
                        .bind(&ids)
                        .fetch_all(pool)
                        .await?;
                Ok(rows.into_iter().map(|row| (row.id.clone(), row)).collect())
            })
            .await
    }

    pub async fn monitor(&self, pool: &PgPool) -> Result<MonitorCounts, sqlx::Error> {
        self.monitor_counts.load((), Duration::from_secs(30), || async {
            sqlx::query_as::<_, MonitorCounts>(
                "SELECT (SELECT count(*) FROM managed_resources WHERE origin='telegram' AND enabled) resources,
                 count(*) catalog,
                 count(*) FILTER(WHERE validity=1 AND valid_until>now()) valid,
                 count(*) FILTER(WHERE validity=0 AND valid_until>now()) invalid,
                 count(*) FILTER(WHERE validity=-1 AND last_error_code IS NOT NULL) errors,
                 count(*) FILTER(WHERE provider IN('baidu','quark') AND next_check_at<=now()) check_due,
                 count(*) FILTER(WHERE provider IN('baidu','quark') AND failure_count>0) check_failing,
                 count(*) FILTER(WHERE provider IN('baidu','quark') AND validity=-1) check_unknown
                 FROM resource_links"
            ).fetch_one(pool).await
        }).await
    }

    pub async fn cloud_types(&self, pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
        self.cloud_types.load((), Duration::from_secs(30), || async {
            sqlx::query_scalar("SELECT DISTINCT provider AS cloud_type FROM resource_links WHERE resource_id IS NOT NULL AND provider<>'' ORDER BY provider")
                .fetch_all(pool).await
        }).await
    }

    pub async fn resource_total(
        &self,
        pool: &PgPool,
        needle: &str,
        cloud_type: &str,
    ) -> Result<i64, sqlx::Error> {
        self.resource_totals
            .load(
                (needle.to_owned(), cloud_type.to_owned()),
                Duration::from_secs(30),
                || async {
                    let mut query = QueryBuilder::new("SELECT count(*) FROM managed_resources");
                    resource_filters(&mut query, needle, cloud_type);
                    query.build_query_scalar().fetch_one(pool).await
                },
            )
            .await
    }

    pub async fn invalidate(&self) {
        self.monitor_counts.clear().await;
        self.cloud_types.clear().await;
        self.resource_totals.clear().await;
        self.channel_counts.clear().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn concurrent_refreshes_share_one_successful_load() {
        let cache = Arc::new(StatsCache::<(), usize>::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..12 {
            let cache = cache.clone();
            let calls = calls.clone();
            tasks.spawn(async move {
                cache
                    .load((), Duration::from_secs(30), || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        Ok::<_, ()>(42)
                    })
                    .await
                    .unwrap()
            });
        }
        while let Some(result) = tasks.join_next().await {
            assert_eq!(result.unwrap(), 42);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn errors_expiry_and_invalidation_allow_refresh() {
        let cache = StatsCache::<(), usize>::default();
        assert_eq!(
            cache
                .load((), Duration::from_secs(30), || async {
                    Err::<usize, _>("offline")
                })
                .await,
            Err("offline")
        );
        assert_eq!(
            cache
                .load((), Duration::from_secs(30), || async { Ok::<_, ()>(1) })
                .await
                .unwrap(),
            1
        );
        cache.clear().await;
        assert_eq!(
            cache
                .load((), Duration::ZERO, || async { Ok::<_, ()>(2) })
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            cache
                .load((), Duration::from_secs(30), || async { Ok::<_, ()>(3) })
                .await
                .unwrap(),
            3
        );
    }

    #[tokio::test]
    async fn distinct_pages_are_isolated_and_cache_is_bounded() {
        let cache = StatsCache::<usize, usize>::default();
        for key in 0..100 {
            assert_eq!(
                cache
                    .load(key, Duration::from_secs(30), || async { Ok::<_, ()>(key) })
                    .await
                    .unwrap(),
                key
            );
        }
        assert!(cache.entries.lock().await.len() <= 64);
    }

    #[tokio::test]
    async fn slow_key_does_not_block_other_keys_or_cached_hits() {
        let cache = Arc::new(StatsCache::<usize, usize>::default());
        cache
            .load(1, Duration::from_secs(30), || async { Ok::<_, ()>(10) })
            .await
            .unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let slow_cache = cache.clone();
        let slow = tokio::spawn(async move {
            slow_cache
                .load(2, Duration::from_secs(30), || async {
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok::<_, ()>(20)
                })
                .await
                .unwrap()
        });
        started_rx.await.unwrap();
        let fast = tokio::time::timeout(Duration::from_secs(1), async {
            assert_eq!(
                cache
                    .load(1, Duration::from_secs(30), || async {
                        panic!("cached value must be reused");
                        #[allow(unreachable_code)]
                        Ok::<_, ()>(0)
                    })
                    .await
                    .unwrap(),
                10
            );
            assert_eq!(
                cache
                    .load(3, Duration::from_secs(30), || async { Ok::<_, ()>(30) })
                    .await
                    .unwrap(),
                30
            );
        })
        .await;
        release_tx.send(()).unwrap();
        assert_eq!(slow.await.unwrap(), 20);
        fast.expect("an unrelated slow query must not block cache access");
    }

    #[tokio::test]
    async fn invalidation_during_load_cannot_restore_old_value() {
        let cache = Arc::new(StatsCache::<(), usize>::default());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let old_cache = cache.clone();
        let old = tokio::spawn(async move {
            old_cache
                .load((), Duration::from_secs(30), || async {
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok::<_, ()>(1)
                })
                .await
                .unwrap()
        });
        started_rx.await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), cache.clear())
            .await
            .unwrap();
        assert_eq!(
            cache
                .load((), Duration::from_secs(30), || async { Ok::<_, ()>(2) })
                .await
                .unwrap(),
            2
        );
        release_tx.send(()).unwrap();
        assert_eq!(old.await.unwrap(), 1);
        assert_eq!(
            cache
                .load((), Duration::from_secs(30), || async { Ok::<_, ()>(3) })
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn cancelled_load_leaves_the_key_retryable() {
        let cache = Arc::new(StatsCache::<(), usize>::default());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let old_cache = cache.clone();
        let old = tokio::spawn(async move {
            old_cache
                .load((), Duration::from_secs(30), || async {
                    started_tx.send(()).unwrap();
                    std::future::pending::<Result<usize, ()>>().await
                })
                .await
        });
        started_rx.await.unwrap();
        old.abort();
        let _ = old.await;
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(1),
                cache.load((), Duration::from_secs(30), || async { Ok::<_, ()>(7) })
            )
            .await
            .unwrap()
            .unwrap(),
            7
        );
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
    async fn channel_counts_read_resources_and_survive_task_cleanup() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let ch = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO crawl_channels(id,name) VALUES($1,$1)")
            .bind(&ch)
            .execute(&mut *tx)
            .await
            .unwrap();
        for (id, enabled) in [("visible", true), ("disabled", false)] {
            sqlx::query("INSERT INTO managed_resources(id,name,enabled,source_channel_ids) VALUES($1,$1,$2,ARRAY[$3::text])")
                .bind(format!("{ch}_{id}")).bind(enabled).bind(&ch).execute(&mut *tx).await.unwrap();
        }
        let visible = format!("{ch}_visible");
        sqlx::query("INSERT INTO crawl_message_tasks(channel_id,message_id,status,resource_ids) VALUES($1,1,'parsed',ARRAY[$2::text]),($1,2,'parsed',ARRAY[$2::text]),($1,3,'failed','{}')")
            .bind(&ch).bind(&visible).execute(&mut *tx).await.unwrap();
        let ids = vec![ch.clone()];
        let row = sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
            .bind(&ids)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!((row.resource_count, row.today_resource_count), (1, 1));
        sqlx::query("DELETE FROM crawl_message_tasks WHERE channel_id=$1")
            .bind(&ch)
            .execute(&mut *tx)
            .await
            .unwrap();
        let row = sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
            .bind(&ids)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!((row.resource_count, row.today_resource_count), (1, 0));
        sqlx::query("UPDATE managed_resources SET enabled=false WHERE id=$1")
            .bind(&visible)
            .execute(&mut *tx)
            .await
            .unwrap();
        let row = sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
            .bind(&ids)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(row.resource_count, 0);
        tx.rollback().await.unwrap();
    }
}
