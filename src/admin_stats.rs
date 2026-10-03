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
    pub failed_count: i64,
    pub resource_count: i64,
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
    resource_totals: StatsCache<(String, String), i64>,
}

/// Optional predicates are omitted instead of hiding indexed conditions behind OR.
pub(crate) fn resource_filters<'a>(
    query: &mut QueryBuilder<'a, Postgres>,
    needle: &'a str,
    cloud_type: &'a str,
) {
    query.push(" WHERE deleted_at IS NULL");
    if !needle.is_empty() {
        query
            .push(" AND name ILIKE ")
            .push_bind(format!("%{needle}%"));
    }
    if !cloud_type.is_empty() {
        query
            .push(" AND resource_cloud_types(links_json) ? ")
            .push_bind(cloud_type);
    }
}

impl AdminStats {
    pub async fn channels(
        &self,
        pool: &PgPool,
        ids: &[String],
    ) -> Result<HashMap<String, ChannelCounts>, sqlx::Error> {
        // Incremental counts survive restarts and need no cold cache refresh.
        let rows = sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
            .bind(ids)
            .fetch_all(pool)
            .await?;
        Ok(rows.into_iter().map(|row| (row.id.clone(), row)).collect())
    }

    pub async fn monitor(&self, pool: &PgPool) -> Result<MonitorCounts, sqlx::Error> {
        self.monitor_counts.load((), Duration::from_secs(30), || async {
            sqlx::query_as::<_, MonitorCounts>(
                "SELECT (SELECT count(*) FROM managed_resources WHERE origin='telegram' AND enabled AND deleted_at IS NULL) resources,
                 count(*) catalog,
                 count(*) FILTER(WHERE validity=1 AND valid_until>now()) valid,
                 count(*) FILTER(WHERE validity=0 AND valid_until>now()) invalid,
                 count(*) FILTER(WHERE validity=-1 AND last_error_code IS NOT NULL) errors,
                 count(*) FILTER(WHERE provider IN('baidu','quark') AND next_check_at<=now()) check_due,
                 count(*) FILTER(WHERE provider IN('baidu','quark') AND failure_count>0) check_failing,
                 count(*) FILTER(WHERE provider IN('baidu','quark') AND validity=-1) check_unknown
                 FROM link_catalog"
            ).fetch_one(pool).await
        }).await
    }

    pub async fn resource_total(
        &self,
        pool: &PgPool,
        needle: &str,
        cloud_type: &str,
    ) -> Result<i64, sqlx::Error> {
        // The metadata counter is also the exact total for a provider-only filter.
        // Counting hundreds of thousands of matching JSON rows is unnecessary.
        if needle.is_empty() && !cloud_type.is_empty() {
            return sqlx::query_scalar(
                "SELECT COALESCE((SELECT resource_count FROM resource_cloud_type_counts WHERE cloud_type=$1),0)",
            )
            .bind(cloud_type)
            .fetch_one(pool)
            .await;
        }
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
        self.resource_totals.clear().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    async fn assert_channel_counts(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, ids: &[String]) {
        let mut actual =
            sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
                .bind(ids)
                .fetch_all(&mut **tx)
                .await
                .unwrap();
        let mut expected =
            sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries_recompute.sql"))
                .bind(ids)
                .fetch_all(&mut **tx)
                .await
                .unwrap();
        actual.sort_by(|a, b| a.id.cmp(&b.id));
        expected.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(actual, expected);
    }

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
    async fn concurrent_channel_statistics_updates_do_not_lose_counts() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let prefix = uuid::Uuid::new_v4().simple().to_string();
        let channel = format!("concurrent_{prefix}");
        let resource = format!("resource_{prefix}");
        sqlx::query("INSERT INTO crawl_channels(id,name) VALUES($1,$1)")
            .bind(&channel)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO managed_resources(id,name,origin) VALUES($1,$1,'telegram')")
            .bind(&resource)
            .execute(&pool)
            .await
            .unwrap();
        let mut tasks = tokio::task::JoinSet::new();
        for message in 1..=12i64 {
            let pool = pool.clone();
            let channel = channel.clone();
            let resource = resource.clone();
            tasks.spawn(async move {
                let mut tx = pool.begin().await.unwrap();
                sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_hash,parse_version,parse_status) VALUES($1,$2,'fixture','fixture','parsed')")
                    .bind(&channel).bind(message).execute(&mut *tx).await.unwrap();
                sqlx::query("INSERT INTO resource_occurrences(channel_id,message_id,resource_id,result_json) VALUES($1,$2,$3,'{}')")
                    .bind(&channel).bind(message).bind(&resource).execute(&mut *tx).await.unwrap();
                tx.commit().await.unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        let stats = AdminStats::default();
        let ids = vec![channel.clone()];
        let counts = stats.channels(&pool, &ids).await.unwrap();
        assert_eq!(
            (
                counts[&channel].failed_count,
                counts[&channel].resource_count
            ),
            (0, 1)
        );
        for message in 1..=12i64 {
            let pool = pool.clone();
            let channel = channel.clone();
            tasks.spawn(async move {
                let mut tx = pool.begin().await.unwrap();
                if message % 2 == 0 {
                    sqlx::query("DELETE FROM resource_occurrences WHERE channel_id=$1 AND message_id=$2")
                        .bind(&channel).bind(message).execute(&mut *tx).await.unwrap();
                    sqlx::query("DELETE FROM source_messages WHERE channel_id=$1 AND message_id=$2")
                        .bind(&channel).bind(message).execute(&mut *tx).await.unwrap();
                } else {
                    sqlx::query("UPDATE source_messages SET parse_status='failed' WHERE channel_id=$1 AND message_id=$2")
                        .bind(&channel).bind(message).execute(&mut *tx).await.unwrap();
                }
                tx.commit().await.unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        let counts = stats.channels(&pool, &ids).await.unwrap();
        assert_eq!(
            (
                counts[&channel].failed_count,
                counts[&channel].resource_count
            ),
            (6, 0)
        );
        let mut tx = pool.begin().await.unwrap();
        assert_channel_counts(&mut tx, &ids).await;
        sqlx::query("DELETE FROM resource_occurrences WHERE channel_id=$1")
            .bind(&channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM source_messages WHERE channel_id=$1")
            .bind(&channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM crawl_channels WHERE id=$1")
            .bind(&channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM managed_resources WHERE id=$1")
            .bind(&resource)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
    async fn message_status_counters_track_inserts_flips_and_deletes() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let prefix = uuid::Uuid::new_v4().simple().to_string();
        let channel = format!("status_counts_{prefix}");
        sqlx::query("INSERT INTO crawl_channels(id,name) VALUES($1,$1)")
            .bind(&channel)
            .execute(&pool)
            .await
            .unwrap();
        let counts = || async {
            let r = sqlx::query("SELECT message_count,parsed_count,empty_count,failed_count FROM channel_statistics WHERE channel_id=$1")
                .bind(&channel)
                .fetch_one(&pool)
                .await
                .unwrap();
            (
                r.get::<i64, _>("message_count"),
                r.get::<i64, _>("parsed_count"),
                r.get::<i64, _>("empty_count"),
                r.get::<i64, _>("failed_count"),
            )
        };
        for (id, status) in [(1i64, "parsed"), (2, "empty"), (3, "failed"), (4, "parsed")] {
            sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_hash,parse_version,parse_status) VALUES($1,$2,'fixture','fixture',$3)")
                .bind(&channel).bind(id).bind(status).execute(&pool).await.unwrap();
        }
        assert_eq!(counts().await, (4, 2, 1, 1));
        sqlx::query(
            "UPDATE source_messages SET parse_status='failed' WHERE channel_id=$1 AND message_id=1",
        )
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(counts().await, (4, 1, 1, 2));
        sqlx::query("DELETE FROM source_messages WHERE channel_id=$1 AND message_id=2")
            .bind(&channel)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(counts().await, (3, 1, 0, 2));
        sqlx::query("DELETE FROM source_messages WHERE channel_id=$1")
            .bind(&channel)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(counts().await, (0, 0, 0, 0));
        sqlx::query("DELETE FROM crawl_channels WHERE id=$1")
            .bind(&channel)
            .execute(&pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
    async fn channel_counts_preserve_visibility_and_deduplication() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let prefix = uuid::Uuid::new_v4().simple().to_string();
        let channel = format!("stats_{prefix}");
        let empty = format!("empty_{prefix}");
        for id in [&channel, &empty] {
            sqlx::query("INSERT INTO crawl_channels(id,name) VALUES($1,$1)")
                .bind(id)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        for (id, status) in [
            (1i64, "parsed"),
            (2, "parsed"),
            (3, "empty"),
            (4, "failed"),
            (5, "empty"),
        ] {
            sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_hash,parse_version,parse_status) VALUES($1,$2,'fixture','fixture',$3)")
                .bind(&channel).bind(id).bind(status).execute(&mut *tx).await.unwrap();
        }
        let visible = format!("visible_{prefix}");
        let disabled = format!("disabled_{prefix}");
        let deleted = format!("deleted_{prefix}");
        for (id, enabled, hidden) in [
            (&visible, true, false),
            (&disabled, false, false),
            (&deleted, true, true),
        ] {
            sqlx::query("INSERT INTO managed_resources(id,name,enabled,deleted_at) VALUES($1,$1,$2,CASE WHEN $3 THEN now() ELSE NULL END)")
                .bind(id).bind(enabled).bind(hidden).execute(&mut *tx).await.unwrap();
        }
        for (message, resource) in [
            (1i64, &visible),
            (2, &visible),
            (3, &visible),
            (1, &disabled),
            (1, &deleted),
        ] {
            sqlx::query("INSERT INTO resource_occurrences(channel_id,message_id,resource_id,result_json) VALUES($1,$2,$3,'{}')")
                .bind(&channel).bind(message).bind(resource).execute(&mut *tx).await.unwrap();
        }
        let ids = vec![channel.clone(), empty.clone()];
        assert_channel_counts(&mut tx, &ids).await;
        let rows = sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        let populated = rows.iter().find(|r| r.id == channel).unwrap();
        assert_eq!((populated.failed_count, populated.resource_count), (1, 1));
        let vacant = rows.iter().find(|r| r.id == empty).unwrap();
        assert_eq!((vacant.failed_count, vacant.resource_count), (0, 0));
        sqlx::query("UPDATE managed_resources SET enabled=false WHERE id=$1")
            .bind(&visible)
            .execute(&mut *tx)
            .await
            .unwrap();
        let rows = sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            rows.iter()
                .find(|r| r.id == channel)
                .unwrap()
                .resource_count,
            0
        );
        assert_channel_counts(&mut tx, &ids).await;
        // Re-enable and restore visibility without refreshing an API cache.
        sqlx::query("UPDATE managed_resources SET enabled=true,deleted_at=NULL WHERE id=ANY($1)")
            .bind([visible.clone(), disabled.clone(), deleted.clone()])
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_channel_counts(&mut tx, &ids).await;

        // Reparse failures retain occurrences, but stop counting their resources.
        for status in ["failed", "parsed", "empty", "parsed"] {
            sqlx::query(
                "UPDATE source_messages SET parse_status=$2 WHERE channel_id=$1 AND message_id=1",
            )
            .bind(&channel)
            .bind(status)
            .execute(&mut *tx)
            .await
            .unwrap();
            assert_channel_counts(&mut tx, &ids).await;
        }
        // Last-seen updates and duplicate occurrence upserts must not add counts.
        sqlx::query("UPDATE source_messages SET last_seen_at=now() WHERE channel_id=$1")
            .bind(&channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO resource_occurrences(channel_id,message_id,resource_id,result_json) VALUES($1,1,$2,'{}') ON CONFLICT(channel_id,message_id,resource_id) DO UPDATE SET result_json=excluded.result_json")
            .bind(&channel).bind(&visible).execute(&mut *tx).await.unwrap();
        assert_channel_counts(&mut tx, &ids).await;

        // Moving an occurrence to another message/channel adjusts both sides.
        sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_hash,parse_version,parse_status) VALUES($1,1,'fixture','fixture','parsed')")
            .bind(&empty).execute(&mut *tx).await.unwrap();
        sqlx::query("UPDATE resource_occurrences SET channel_id=$2 WHERE channel_id=$1 AND message_id=1 AND resource_id=$3")
            .bind(&channel).bind(&empty).bind(&visible).execute(&mut *tx).await.unwrap();
        assert_channel_counts(&mut tx, &ids).await;
        sqlx::query("UPDATE resource_occurrences SET resource_id=$3 WHERE channel_id=$1 AND message_id=1 AND resource_id=$2")
            .bind(&empty).bind(&visible).bind(&disabled).execute(&mut *tx).await.unwrap();
        assert_channel_counts(&mut tx, &ids).await;

        // Message removal follows the existing FK: remove occurrences first.
        sqlx::query("DELETE FROM resource_occurrences WHERE channel_id=$1 AND message_id=1")
            .bind(&channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM source_messages WHERE channel_id=$1 AND message_id=1")
            .bind(&channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_channel_counts(&mut tx, &ids).await;
        // A physical resource deletion cascades to occurrences in both channels.
        sqlx::query("DELETE FROM managed_resources WHERE id=$1")
            .bind(&disabled)
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_channel_counts(&mut tx, &ids).await;
        sqlx::query("DELETE FROM resource_occurrences WHERE channel_id=$1")
            .bind(&channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_channel_counts(&mut tx, &ids).await;
        sqlx::query("DELETE FROM source_messages WHERE channel_id=ANY($1)")
            .bind(&ids)
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_channel_counts(&mut tx, &ids).await;
        // Rolling back a data change must also roll back its derived statistics.
        sqlx::query("SAVEPOINT stats_rollback")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_hash,parse_version,parse_status) VALUES($1,99,'fixture','fixture','parsed')")
            .bind(&channel).execute(&mut *tx).await.unwrap();
        sqlx::query("ROLLBACK TO SAVEPOINT stats_rollback")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_channel_counts(&mut tx, &ids).await;
        tx.rollback().await.unwrap();
    }
}
