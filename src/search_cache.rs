use crate::models::SearchResponse;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone)]
struct CacheEntry {
    value: SearchResponse,
    expires_at: Instant,
    size: usize,
    sequence: u64,
}

#[derive(Default)]
pub struct SearchCache {
    entries: HashMap<String, CacheEntry>,
    total_size: usize,
    sequence: u64,
}

impl SearchCache {
    pub fn get(&mut self, key: &str, max_bytes: usize) -> Option<SearchResponse> {
        self.prune_expired();
        self.evict_to_limit(max_bytes);
        let entry = self.entries.get_mut(key)?;
        self.sequence = self.sequence.saturating_add(1);
        entry.sequence = self.sequence;
        Some(entry.value.clone())
    }

    pub fn set(&mut self, key: String, value: SearchResponse, ttl: Duration, max_bytes: usize) {
        self.prune_expired();
        self.evict_to_limit(max_bytes);
        let size = key.len()
            + serde_json::to_vec(&value)
                .map(|encoded| encoded.len())
                .unwrap_or(0)
            + 64;
        if size > max_bytes {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.total_size = self.total_size.saturating_sub(previous.size);
        }
        while self.total_size.saturating_add(size) > max_bytes {
            if !self.evict_oldest() {
                break;
            }
        }
        self.sequence = self.sequence.saturating_add(1);
        self.total_size = self.total_size.saturating_add(size);
        self.entries.insert(
            key,
            CacheEntry {
                value,
                expires_at: Instant::now() + ttl,
                size,
                sequence: self.sequence,
            },
        );
    }

    fn prune_expired(&mut self) {
        let now = Instant::now();
        let expired = self
            .entries
            .iter()
            .filter_map(|(key, entry)| (entry.expires_at <= now).then_some(key.clone()))
            .collect::<Vec<_>>();
        for key in expired {
            if let Some(entry) = self.entries.remove(&key) {
                self.total_size = self.total_size.saturating_sub(entry.size);
            }
        }
    }

    fn evict_to_limit(&mut self, max_bytes: usize) {
        while self.total_size > max_bytes {
            if !self.evict_oldest() {
                self.total_size = 0;
                break;
            }
        }
    }

    fn evict_oldest(&mut self) -> bool {
        let Some(key) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.sequence)
            .map(|(key, _)| key.clone())
        else {
            return false;
        };
        if let Some(entry) = self.entries.remove(&key) {
            self.total_size = self.total_size.saturating_sub(entry.size);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SearchResponse;

    fn response(total: usize) -> SearchResponse {
        SearchResponse {
            total,
            results: vec![],
            sources: Some(vec![]),
        }
    }

    #[test]
    fn cache_returns_values_before_expiry() {
        let mut cache = SearchCache::default();
        cache.set("key".into(), response(3), Duration::from_secs(1), 1024);
        assert_eq!(cache.get("key", 1024).map(|value| value.total), Some(3));
    }

    #[test]
    fn cache_enforces_the_memory_limit() {
        let mut cache = SearchCache::default();
        cache.set("first".into(), response(1), Duration::from_secs(30), 150);
        cache.set("second".into(), response(2), Duration::from_secs(30), 150);
        assert!(cache.total_size <= 150);
    }
}
