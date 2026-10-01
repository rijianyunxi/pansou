use sqlx::PgPool;
use std::{
    collections::HashMap,
    future::Future,
    hash::Hash,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// Coalesce concurrent refreshes and bound cached page/filter combinations.
struct StatsCache<K, V> {
    entries: Mutex<HashMap<K, (Instant, V)>>,
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
        let mut entries = self.entries.lock().await;
        entries.retain(|_, (expires, _)| *expires > Instant::now());
        if let Some((_, value)) = entries.get(&key) {
            return Ok(value.clone());
        }
        // Hold the lock through loading: polling tabs must not stampede PostgreSQL.
        // Failed/cancelled loads never insert a cache entry.
        let value = loader().await?;
        if entries.len() >= 64 {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, (expires, _))| *expires)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(key, (Instant::now() + ttl, value.clone()));
        Ok(value)
    }

    async fn clear(&self) {
        self.entries.lock().await.clear();
    }
}

#[derive(Clone, sqlx::FromRow)]
pub struct ChannelCounts {
    pub id: String,
    pub message_count: i64,
    pub resource_count: i64,
}

#[derive(Clone, sqlx::FromRow)]
pub struct MonitorCounts {
    pub resources: i64,
    pub catalog: i64,
    pub valid: i64,
    pub invalid: i64,
    pub errors: i64,
}

#[derive(Default)]
pub struct AdminStats {
    channel_counts: StatsCache<Vec<String>, Vec<ChannelCounts>>,
    monitor_counts: StatsCache<(), MonitorCounts>,
}

impl AdminStats {
    pub async fn channels(
        &self,
        pool: &PgPool,
        ids: &[String],
    ) -> Result<HashMap<String, ChannelCounts>, sqlx::Error> {
        let mut key = ids.to_vec();
        key.sort();
        key.dedup();
        let rows = self
            .channel_counts
            .load(key.clone(), Duration::from_secs(30), || async {
                sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
                    .bind(&key)
                    .fetch_all(pool)
                    .await
            })
            .await?;
        Ok(rows.into_iter().map(|row| (row.id.clone(), row)).collect())
    }

    pub async fn monitor(&self, pool: &PgPool) -> Result<MonitorCounts, sqlx::Error> {
        self.monitor_counts.load((), Duration::from_secs(60), || async {
            sqlx::query_as::<_, MonitorCounts>(
                "SELECT (SELECT count(*) FROM managed_resources WHERE origin='telegram' AND enabled AND deleted_at IS NULL) resources,
                 count(*) catalog,
                 count(*) FILTER(WHERE validity=1 AND valid_until>now()) valid,
                 count(*) FILTER(WHERE validity=0 AND valid_until>now()) invalid,
                 count(*) FILTER(WHERE validity=-1 AND last_error_code IS NOT NULL) errors
                 FROM link_catalog"
            ).fetch_one(pool).await
        }).await
    }

    pub async fn invalidate(&self) {
        self.channel_counts.clear().await;
        self.monitor_counts.clear().await;
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
            sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_html,raw_hash,parse_version,parse_status) VALUES($1,$2,'','fixture','fixture',$3)")
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
        let rows = sqlx::query_as::<_, ChannelCounts>(include_str!("sql/channel_summaries.sql"))
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        let populated = rows.iter().find(|r| r.id == channel).unwrap();
        assert_eq!((populated.message_count, populated.resource_count), (5, 1));
        let vacant = rows.iter().find(|r| r.id == empty).unwrap();
        assert_eq!((vacant.message_count, vacant.resource_count), (0, 0));
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
        tx.rollback().await.unwrap();
    }
}
