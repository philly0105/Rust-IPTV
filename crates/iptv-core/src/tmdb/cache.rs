//! Two-level TMDB cache with in-flight coalescing.
//!
//! Lookups go: bounded in-memory LRU -> SQLite `tmdb_cache` (C3) -> one
//! upstream fetch per key no matter how many callers ask at once. The fetch
//! runs in its own task, so the cache is filled even when the RPC that
//! started it is dropped (the user navigated away).
//!
//! A row is one of:
//! - positive: `payload_json` set (details, season, person, trending) or
//!   only `tmdb_id` set (a title -> id match),
//! - negative: both NULL (no confident match, or a 404 id), kept for
//!   `NEGATIVE_TTL` so misses do not hit TMDB on every page view.
//!
//! The TTL is decided at write time and stored in `expires_at`.

use super::config::MEMORY_CACHE_CAPACITY;
use crate::db::DbPool;
use crate::error::{CoreError, CoreResult};
use chrono::{DateTime, SecondsFormat, Utc};
use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use futures::future::{BoxFuture, FutureExt, Shared};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

/// What a fetch produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Fetched {
    pub tmdb_id: Option<i64>,
    pub payload: Option<Value>,
}

impl Fetched {
    pub fn negative() -> Self {
        Self {
            tmdb_id: None,
            payload: None,
        }
    }
    pub fn id(tmdb_id: i64) -> Self {
        Self {
            tmdb_id: Some(tmdb_id),
            payload: None,
        }
    }
    pub fn payload(tmdb_id: Option<i64>, payload: Value) -> Self {
        Self {
            tmdb_id,
            payload: Some(payload),
        }
    }
    pub fn is_negative(&self) -> bool {
        self.tmdb_id.is_none() && self.payload.is_none()
    }
}

/// A cached row.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub tmdb_id: Option<i64>,
    pub payload: Option<Arc<Value>>,
    pub expires_at: DateTime<Utc>,
}

impl CacheEntry {
    fn is_fresh(&self, now: DateTime<Utc>) -> bool {
        self.expires_at > now
    }
    pub fn is_negative(&self) -> bool {
        self.tmdb_id.is_none() && self.payload.is_none()
    }
}

/// TTLs for one lookup.
#[derive(Debug, Clone, Copy)]
pub struct Ttl {
    pub positive: Duration,
    pub negative: Duration,
}

type SharedResult = Result<CacheEntry, Arc<CoreError>>;
type InFlight = Shared<BoxFuture<'static, SharedResult>>;

/// Small LRU: map + monotonically increasing use stamp. Eviction scans for
/// the oldest stamp, O(capacity) = O(300), only when full.
struct Lru {
    cap: usize,
    tick: u64,
    map: HashMap<String, (CacheEntry, u64)>,
}

impl Lru {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            tick: 0,
            map: HashMap::with_capacity(cap + 1),
        }
    }
    fn get(&mut self, key: &str) -> Option<CacheEntry> {
        self.tick += 1;
        let tick = self.tick;
        let slot = self.map.get_mut(key)?;
        slot.1 = tick;
        Some(slot.0.clone())
    }
    fn put(&mut self, key: String, entry: CacheEntry) {
        self.tick += 1;
        if !self.map.contains_key(&key) && self.map.len() >= self.cap {
            if let Some(oldest) = self
                .map
                .iter()
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| k.clone())
            {
                self.map.remove(&oldest);
            }
        }
        self.map.insert(key, (entry, self.tick));
    }
    fn remove(&mut self, key: &str) {
        self.map.remove(key);
    }
    fn clear(&mut self) {
        self.map.clear();
    }
    fn len(&self) -> usize {
        self.map.len()
    }
}

pub struct TmdbCache {
    lru: parking_lot::Mutex<Lru>,
    in_flight: DashMap<String, InFlight>,
}

fn mem_key(media: &str, key: &str) -> String {
    format!("{media}\u{1f}{key}")
}

/// Rebuilds an owned error from a shared one (CoreError is not Clone).
pub fn clone_error(e: &CoreError) -> CoreError {
    match e {
        CoreError::NotFound(m) => CoreError::NotFound(m.clone()),
        CoreError::Invalid(m) => CoreError::Invalid(m.clone()),
        CoreError::Network(m) => CoreError::Network(m.clone()),
        CoreError::Auth(m) => CoreError::Auth(m.clone()),
        CoreError::Timeout(m) => CoreError::Timeout(m.clone()),
        CoreError::Conflict(m) => CoreError::Conflict(m.clone()),
        CoreError::Unsupported(m) => CoreError::Unsupported(m.clone()),
        CoreError::Io(io) => CoreError::Io(std::io::Error::new(io.kind(), io.to_string())),
        other => CoreError::Other(anyhow::anyhow!("{other}")),
    }
}

fn ts(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

impl Default for TmdbCache {
    fn default() -> Self {
        Self::new(MEMORY_CACHE_CAPACITY)
    }
}

impl TmdbCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            lru: parking_lot::Mutex::new(Lru::new(capacity.max(1))),
            in_flight: DashMap::new(),
        }
    }

    /// Entries currently held in memory.
    pub fn memory_len(&self) -> usize {
        self.lru.lock().len()
    }

    /// Drops the in-memory layer only (SQLite rows stay).
    pub fn clear_memory(&self) {
        self.lru.lock().clear();
    }

    /// Reads a fresh row from SQLite; stale or unreadable rows are misses.
    fn read_db(db: &DbPool, media: &str, key: &str) -> CoreResult<Option<CacheEntry>> {
        let conn = db.get()?;
        let row: Option<(Option<i64>, Option<String>, String)> = conn
            .query_row(
                "SELECT tmdb_id, payload_json, expires_at FROM tmdb_cache WHERE media_type = ?1 AND lookup_key = ?2",
                rusqlite::params![media, key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((tmdb_id, payload, expires)) = row else {
            return Ok(None);
        };
        let Some(expires_at) = parse_ts(&expires) else {
            return Ok(None);
        };
        if expires_at <= Utc::now() {
            return Ok(None);
        }
        let payload = match payload {
            None => None,
            Some(text) => match serde_json::from_str::<Value>(&text) {
                Ok(v) => Some(Arc::new(v)),
                Err(err) => {
                    tracing::warn!(media, %err, "unreadable tmdb cache row; refetching");
                    return Ok(None);
                }
            },
        };
        Ok(Some(CacheEntry {
            tmdb_id,
            payload,
            expires_at,
        }))
    }

    fn write_db(
        db: &DbPool,
        media: &str,
        key: &str,
        fetched: &Fetched,
        ttl: Duration,
    ) -> CoreResult<CacheEntry> {
        let now = Utc::now();
        let expires_at = now + chrono::Duration::from_std(ttl).unwrap_or(chrono::Duration::days(1));
        let payload_text = fetched
            .payload
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = db.get()?;
        conn.execute(
            "INSERT INTO tmdb_cache (media_type, lookup_key, tmdb_id, payload_json, fetched_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(media_type, lookup_key) DO UPDATE SET
               tmdb_id = excluded.tmdb_id, payload_json = excluded.payload_json,
               fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
            rusqlite::params![media, key, fetched.tmdb_id, payload_text, ts(now), ts(expires_at)],
        )?;
        Ok(CacheEntry {
            tmdb_id: fetched.tmdb_id,
            payload: fetched.payload.clone().map(Arc::new),
            expires_at,
        })
    }

    fn memory_get(&self, mk: &str) -> Option<CacheEntry> {
        let mut lru = self.lru.lock();
        match lru.get(mk) {
            Some(e) if e.is_fresh(Utc::now()) => Some(e),
            Some(_) => {
                lru.remove(mk);
                None
            }
            None => None,
        }
    }

    /// Returns the cached entry for `(media, key)` or runs `fetch` once for
    /// all concurrent callers, stores the result with the matching TTL, and
    /// returns it. Fetch errors are shared with every waiter and not cached.
    pub async fn get_or_fetch<F, Fut>(
        self: &Arc<Self>,
        db: &DbPool,
        media: &'static str,
        key: String,
        ttl: Ttl,
        fetch: F,
    ) -> CoreResult<CacheEntry>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = CoreResult<Fetched>> + Send + 'static,
    {
        let mk = mem_key(media, &key);
        if let Some(hit) = self.memory_get(&mk) {
            return Ok(hit);
        }

        let shared = match self.in_flight.entry(mk.clone()) {
            Entry::Occupied(e) => e.get().clone(),
            Entry::Vacant(v) => {
                let this = Arc::clone(self);
                let db = db.clone();
                let task_mk = mk.clone();
                let job = async move {
                    let result = this.load(db, media, key, ttl, fetch).await;
                    if let Ok(entry) = &result {
                        this.lru.lock().put(task_mk.clone(), entry.clone());
                    }
                    this.in_flight.remove(&task_mk);
                    result
                };
                let handle = tokio::spawn(job);
                let fut: BoxFuture<'static, SharedResult> = async move {
                    match handle.await {
                        Ok(Ok(entry)) => Ok(entry),
                        Ok(Err(err)) => Err(Arc::new(err)),
                        Err(join) => Err(Arc::new(CoreError::from(join))),
                    }
                }
                .boxed();
                let shared = fut.shared();
                v.insert(shared.clone());
                shared
            }
        };
        shared.await.map_err(|e| clone_error(&e))
    }

    async fn load<F, Fut>(
        &self,
        db: DbPool,
        media: &'static str,
        key: String,
        ttl: Ttl,
        fetch: F,
    ) -> CoreResult<CacheEntry>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = CoreResult<Fetched>>,
    {
        let (db2, key2) = (db.clone(), key.clone());
        let from_db =
            tokio::task::spawn_blocking(move || Self::read_db(&db2, media, &key2)).await?;
        match from_db {
            Ok(Some(hit)) => return Ok(hit),
            Ok(None) => {}
            // A broken cache must not break enrichment; fall through to the network.
            Err(err) => tracing::warn!(media, error = %err, "tmdb cache read failed"),
        }
        let fetched = fetch().await?;
        let ttl = if fetched.is_negative() {
            ttl.negative
        } else {
            ttl.positive
        };
        let written = tokio::task::spawn_blocking(move || {
            Self::write_db(&db, media, &key, &fetched, ttl).map_err(|e| Box::new((e, fetched, ttl)))
        })
        .await?;
        match written {
            Ok(entry) => Ok(entry),
            Err(failed) => {
                let (err, fetched, ttl) = *failed;
                tracing::warn!(media, error = %err, "tmdb cache write failed; serving uncached");
                Ok(CacheEntry {
                    tmdb_id: fetched.tmdb_id,
                    payload: fetched.payload.map(Arc::new),
                    expires_at: Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default(),
                })
            }
        }
    }

    /// Deletes every row and the memory layer.
    pub async fn clear(&self, db: &DbPool) -> CoreResult<u64> {
        self.clear_memory();
        let db = db.clone();
        let n = tokio::task::spawn_blocking(move || -> CoreResult<u64> {
            let conn = db.get()?;
            Ok(conn.execute("DELETE FROM tmdb_cache", [])? as u64)
        })
        .await??;
        Ok(n)
    }

    /// Deletes expired rows; returns how many.
    pub async fn purge_expired(db: &DbPool) -> CoreResult<u64> {
        let db = db.clone();
        tokio::task::spawn_blocking(move || -> CoreResult<u64> {
            let conn = db.get()?;
            Ok(conn.execute(
                "DELETE FROM tmdb_cache WHERE expires_at <= ?1",
                [ts(Utc::now())],
            )? as u64)
        })
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: i64) -> CacheEntry {
        CacheEntry {
            tmdb_id: Some(n),
            payload: None,
            expires_at: Utc::now() + chrono::Duration::days(1),
        }
    }

    #[test]
    fn lru_evicts_least_recently_used() {
        let mut lru = Lru::new(2);
        lru.put("a".into(), entry(1));
        lru.put("b".into(), entry(2));
        assert!(lru.get("a").is_some());
        lru.put("c".into(), entry(3));
        assert!(lru.get("b").is_none(), "b was least recently used");
        assert!(lru.get("a").is_some());
        assert!(lru.get("c").is_some());
        lru.put("a".into(), entry(4));
        assert_eq!(lru.len(), 2);
        assert_eq!(lru.get("a").unwrap().tmdb_id, Some(4));
    }

    #[test]
    fn errors_clone_by_kind() {
        assert!(
            matches!(clone_error(&CoreError::Auth("x".into())), CoreError::Auth(m) if m == "x")
        );
        assert!(clone_error(&CoreError::Network("n".into())).is_retryable());
    }

    #[test]
    fn fetched_kinds() {
        assert!(Fetched::negative().is_negative());
        assert!(!Fetched::id(1).is_negative());
        assert!(!Fetched::payload(None, Value::Null).is_negative());
    }
}
