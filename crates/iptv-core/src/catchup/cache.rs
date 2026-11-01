//! Per-channel programme cache for provider guide calls (Xtream short EPG and
//! archive table).
//!
//! - keyed by `(source id, stream id)`;
//! - an answer is reused for `ttl`, or until everything in it has ended;
//! - concurrent requests for one key share a single provider call;
//! - provider calls across all keys are capped by a semaphore;
//! - errors are never cached, so the next request asks again;
//! - answers past the TTL are dropped, at each store and by
//!   [`ProgramCache::sweep`], and the cache holds at most `max_entries`
//!   answers and `max_programs` programmes, dropping the oldest first.

use crate::error::CoreResult;
use crate::model::EpgProgram;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};

pub type Key = (String, String);

struct Entry {
    programs: Arc<Vec<EpgProgram>>,
    at: Instant,
}

pub struct ProgramCache {
    entries: DashMap<Key, Entry>,
    /// One lock per key while a provider call is running.
    inflight: DashMap<Key, Arc<Mutex<()>>>,
    permits: Semaphore,
    ttl: Duration,
    max_entries: usize,
    /// Most programmes held across every answer ([`Self::with_max_programs`]).
    max_programs: usize,
    /// Reuse ends early once every programme in the answer has ended (now/next
    /// answers); off for archive tables, which are mostly past by design.
    expire_when_ended: bool,
}

fn end_secs(p: &EpgProgram) -> i64 {
    DateTime::parse_from_rfc3339(&p.end).map_or(0, |d| d.timestamp())
}

impl ProgramCache {
    pub fn new(
        ttl: Duration,
        concurrency: usize,
        max_entries: usize,
        expire_when_ended: bool,
    ) -> Self {
        Self {
            expire_when_ended,
            entries: DashMap::new(),
            inflight: DashMap::new(),
            permits: Semaphore::new(concurrency.max(1)),
            ttl,
            max_entries: max_entries.max(1),
            max_programs: usize::MAX,
        }
    }

    /// Caps the programmes held across every answer: an archive table can
    /// list thousands, so a count of answers alone does not bound memory.
    /// The newest answer stays even when it alone is over the cap.
    pub fn with_max_programs(mut self, max_programs: usize) -> Self {
        self.max_programs = max_programs.max(1);
        self
    }

    /// Drops every answer past the TTL at `at`: none is served again, and
    /// nothing else would free them once nobody asks.
    pub fn sweep(&self, at: Instant) {
        self.entries
            .retain(|_, e| at.saturating_duration_since(e.at) < self.ttl);
    }

    /// The cached answer when still usable at `now` (wall clock, for the
    /// "everything has ended" check) and `at` (monotonic, for the TTL).
    fn fresh(&self, key: &Key, at: Instant, now: DateTime<Utc>) -> Option<Arc<Vec<EpgProgram>>> {
        let e = self.entries.get(key)?;
        if at.saturating_duration_since(e.at) >= self.ttl {
            return None;
        }
        // An answer whose last programme has ended says nothing about now.
        let ended = self.expire_when_ended
            && !e.programs.is_empty()
            && e.programs.iter().all(|p| end_secs(p) <= now.timestamp());
        (!ended).then(|| e.programs.clone())
    }

    fn store(&self, key: Key, programs: Arc<Vec<EpgProgram>>, at: Instant) {
        self.sweep(at);
        if self.entries.len() >= self.max_entries && !self.entries.contains_key(&key) {
            self.remove_oldest(&key);
        }
        self.entries.insert(key.clone(), Entry { programs, at });
        if self.max_programs == usize::MAX {
            return;
        }
        let mut held: usize = self.entries.iter().map(|e| e.value().programs.len()).sum();
        while held > self.max_programs {
            match self.remove_oldest(&key) {
                Some(n) => held -= n,
                None => break,
            }
        }
    }

    /// Drops the oldest answer other than `keep`'s; returns its programme
    /// count. A full scan is fine at a few thousand answers.
    fn remove_oldest(&self, keep: &Key) -> Option<usize> {
        let oldest = self
            .entries
            .iter()
            .filter(|e| e.key() != keep)
            .min_by_key(|e| e.value().at)
            .map(|e| e.key().clone())?;
        self.entries.remove(&oldest).map(|(_, e)| e.programs.len())
    }

    /// Forgets every answer of a source (its credentials or catalog changed).
    pub fn forget_source(&self, source_id: &str) {
        self.entries.retain(|k, _| k.0 != source_id);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Cached programmes for `key`, else the result of `fetch` (stored on
    /// success). Callers for the same key wait for one `fetch`.
    pub async fn get_or_fetch<F, Fut>(&self, key: Key, fetch: F) -> CoreResult<Arc<Vec<EpgProgram>>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = CoreResult<Vec<EpgProgram>>>,
    {
        if let Some(p) = self.fresh(&key, Instant::now(), Utc::now()) {
            return Ok(p);
        }
        let lock = self
            .inflight
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let result = {
            let _guard = lock.lock().await;
            // Someone else may have fetched it while this call waited.
            if let Some(p) = self.fresh(&key, Instant::now(), Utc::now()) {
                Ok(p)
            } else {
                let _permit = self
                    .permits
                    .acquire()
                    .await
                    .expect("semaphore never closed");
                match fetch().await {
                    Ok(list) => {
                        let list = Arc::new(list);
                        self.store(key.clone(), list.clone(), Instant::now());
                        Ok(list)
                    }
                    Err(e) => Err(e),
                }
            }
        };
        // The last waiter removes the lock; a newer one is created on demand.
        self.inflight
            .remove_if(&key, |_, v| Arc::strong_count(v) <= 2);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn prog(end_in_secs: i64) -> EpgProgram {
        let now = Utc::now();
        EpgProgram {
            channel_id: "c".into(),
            start: (now - chrono::Duration::minutes(10)).to_rfc3339(),
            end: (now + chrono::Duration::seconds(end_in_secs)).to_rfc3339(),
            title: "T".into(),
            description: None,
            category: None,
            icon: None,
        }
    }

    fn key(s: &str, id: &str) -> Key {
        (s.into(), id.into())
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_fetch() {
        let cache = Arc::new(ProgramCache::new(Duration::from_secs(60), 3, 100, true));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let cache = cache.clone();
            let calls = calls.clone();
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_fetch(key("s", "1"), || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        Ok(vec![prog(600)])
                    })
                    .await
                    .unwrap()
                    .len()
            }));
        }
        for t in tasks {
            assert_eq!(t.await.unwrap(), 1);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cache.inflight.is_empty(), "locks are cleaned up");
    }

    #[tokio::test]
    async fn errors_are_not_cached_and_keys_are_separate() {
        let cache = ProgramCache::new(Duration::from_secs(60), 2, 100, true);
        let r = cache
            .get_or_fetch(key("s", "1"), || async { Err(CoreError::invalid("boom")) })
            .await;
        assert!(r.is_err());
        assert!(cache.is_empty());
        let a = cache
            .get_or_fetch(key("s", "1"), || async { Ok(vec![prog(600)]) })
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        // Same stream id on another source is another key.
        let b = cache
            .get_or_fetch(key("t", "1"), || async { Ok(vec![]) })
            .await
            .unwrap();
        assert!(b.is_empty());
        assert_eq!(cache.len(), 2);
        cache.forget_source("s");
        assert_eq!(cache.len(), 1);
    }

    #[tokio::test]
    async fn ttl_and_ended_answers_refetch() {
        let calls = AtomicUsize::new(0);
        let fetch = |end: i64| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { Ok(vec![prog(end)]) }
        };
        // Everything in the answer has ended: asked again.
        let cache = ProgramCache::new(Duration::from_secs(60), 1, 100, true);
        cache
            .get_or_fetch(key("s", "1"), || fetch(-5))
            .await
            .unwrap();
        cache
            .get_or_fetch(key("s", "1"), || fetch(600))
            .await
            .unwrap();
        cache
            .get_or_fetch(key("s", "1"), || fetch(600))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // An archive cache keeps a past-only answer.
        let cache = ProgramCache::new(Duration::from_secs(60), 1, 100, false);
        cache
            .get_or_fetch(key("s", "1"), || fetch(-5))
            .await
            .unwrap();
        cache
            .get_or_fetch(key("s", "1"), || fetch(-5))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        // A zero TTL never reuses.
        let cache = ProgramCache::new(Duration::ZERO, 1, 100, true);
        cache
            .get_or_fetch(key("s", "1"), || fetch(600))
            .await
            .unwrap();
        cache
            .get_or_fetch(key("s", "1"), || fetch(600))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn oldest_answer_is_evicted_at_capacity() {
        let cache = ProgramCache::new(Duration::from_secs(60), 1, 2, true);
        for id in ["1", "2", "3"] {
            cache
                .get_or_fetch(key("s", id), || async { Ok(vec![prog(600)]) })
                .await
                .unwrap();
        }
        assert_eq!(cache.len(), 2);
        assert!(!cache.entries.contains_key(&key("s", "1")));
    }

    fn table(n: usize) -> Arc<Vec<EpgProgram>> {
        Arc::new((0..n).map(|_| prog(600)).collect())
    }

    #[test]
    fn expired_answers_are_dropped() {
        let cache = ProgramCache::new(Duration::from_secs(60), 1, 100, false);
        let t0 = Instant::now();
        for id in ["1", "2", "3"] {
            cache.store(key("s", id), table(1), t0);
        }
        cache.sweep(t0 + Duration::from_secs(59));
        assert_eq!(cache.len(), 3);
        // The next answer stored after the TTL leaves only itself.
        cache.store(key("s", "4"), table(1), t0 + Duration::from_secs(61));
        assert_eq!(cache.len(), 1);
        assert!(cache.entries.contains_key(&key("s", "4")));
        // And the periodic sweep frees the rest once nobody asks again.
        cache.sweep(t0 + Duration::from_secs(200));
        assert!(cache.is_empty());
    }

    fn held(cache: &ProgramCache) -> usize {
        cache.entries.iter().map(|e| e.value().programs.len()).sum()
    }

    #[test]
    fn programme_budget_drops_the_oldest_tables() {
        let cache =
            ProgramCache::new(Duration::from_secs(1200), 2, 200, false).with_max_programs(10_000);
        let t0 = Instant::now();
        for i in 0..50 {
            cache.store(
                key("s", &i.to_string()),
                table(500),
                t0 + Duration::from_millis(i),
            );
            assert!(held(&cache) <= 10_000, "after table {i}");
        }
        assert_eq!(cache.len(), 20);
        assert!(cache.entries.contains_key(&key("s", "49")));
        assert!(cache.entries.contains_key(&key("s", "30")));
        assert!(!cache.entries.contains_key(&key("s", "29")));
        assert!(!cache.entries.contains_key(&key("s", "0")));
    }

    /// A table larger than the whole budget is kept on its own rather than
    /// dropped as it is stored (every visit would ask the panel again).
    #[tokio::test]
    async fn an_oversized_table_is_kept_alone() {
        let cache =
            ProgramCache::new(Duration::from_secs(60), 1, 200, false).with_max_programs(1000);
        let calls = AtomicUsize::new(0);
        let fetch = |n: usize| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { Ok(table(n).to_vec()) }
        };
        cache
            .get_or_fetch(key("s", "small"), || fetch(10))
            .await
            .unwrap();
        let big = cache
            .get_or_fetch(key("s", "big"), || fetch(5000))
            .await
            .unwrap();
        assert_eq!(big.len(), 5000);
        assert_eq!(cache.len(), 1, "the older answer made room");
        let again = cache
            .get_or_fetch(key("s", "big"), || fetch(5000))
            .await
            .unwrap();
        assert_eq!(again.len(), 5000);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "served from the cache");
    }
}
