//! `stalker` module (SPEC C4 stalker): Stalker/Ministra portal support.
//!
//! - [`protocol`]: pure helpers (endpoint candidates, encoding, response
//!   classification, playback command resolution, lenient field readers).
//! - [`session`]: MAG headers, discovery, handshake/profile, token cache in
//!   `app_state` (`stalker_token:<sourceId>`), one re-handshake on auth failure.
//! - [`mapping`]: portal JSON -> catalog rows and model types.
//! - [`sync`]: the importer (live + radio into the catalog; VOD and series
//!   categories only, because VOD is paged live from the portal).
//! - [`vod`]: live-paged movies/series, details, season plans, search.
//! - [`playback`]: `create_link`, catch-up, short EPG, account info.
//!
//! Listed VOD/series rows are remembered in a small LRU in memory and in the
//! `stalker_items` table, so details and playback survive resyncs and
//! restarts. See `docs/architecture/stalker.md`.

pub mod mapping;
pub mod playback;
pub mod protocol;
pub mod rpc;
pub mod session;
mod sha1;
pub mod sync;
pub mod vod;

use crate::error::CoreResult;
use crate::model::ItemRef;
use crate::state::AppState;
use dashmap::DashMap;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// `AppState.extensions` key of the stalker runtime.
pub const RUNTIME_KEY: &str = "stalker";
/// Cap of the in-memory VOD item cache (entries); the least recently used
/// tenth is evicted when it is reached.
const ITEM_CACHE_CAP: usize = 5000;
/// Cap of cached season plans.
const PLAN_CACHE_CAP: usize = 500;
/// Rows kept per source in the persisted `stalker_items` table.
const PERSISTED_ROWS_CAP: i64 = 20_000;

/// A portal VOD/series row remembered from a listing, so details and
/// playback do not need to re-page the portal.
#[derive(Debug, Clone)]
pub struct CachedItem {
    pub raw: Value,
    pub category_name: Option<String>,
}

/// A small concurrent map with least-recently-used eviction.
pub struct Lru<V> {
    map: DashMap<String, (V, u64)>,
    tick: AtomicU64,
    cap: usize,
}

impl<V: Clone> Lru<V> {
    pub fn new(cap: usize) -> Self {
        Self {
            map: DashMap::new(),
            tick: AtomicU64::new(0),
            cap: cap.max(1),
        }
    }

    fn next_tick(&self) -> u64 {
        self.tick.fetch_add(1, Ordering::Relaxed)
    }

    /// The value under `key`, marking it as recently used.
    pub fn get(&self, key: &str) -> Option<V> {
        let t = self.next_tick();
        self.map.get_mut(key).map(|mut e| {
            e.1 = t;
            e.0.clone()
        })
    }

    pub fn insert(&self, key: String, value: V) {
        if self.map.len() >= self.cap && !self.map.contains_key(&key) {
            self.evict();
        }
        let t = self.next_tick();
        self.map.insert(key, (value, t));
    }

    /// Drops the least recently used tenth of the entries.
    fn evict(&self) {
        let mut ticks: Vec<(String, u64)> = self
            .map
            .iter()
            .map(|e| (e.key().clone(), e.value().1))
            .collect();
        ticks.sort_unstable_by_key(|(_, t)| *t);
        for (k, _) in ticks.into_iter().take((self.cap / 10).max(1)) {
            self.map.remove(&k);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    /// Drops every entry whose key starts with `prefix`.
    pub fn remove_prefix(&self, prefix: &str) {
        self.map.retain(|k, _| !k.starts_with(prefix));
    }
}

/// Process-wide stalker state.
pub struct Runtime {
    /// Session per source id.
    pub sessions: DashMap<String, Arc<tokio::sync::Mutex<session::SessionState>>>,
    /// Raw VOD/series rows keyed by `ItemRef::key()` (backed by `stalker_items`).
    pub items: Lru<CachedItem>,
    /// Season plans keyed by `ItemRef::key()`.
    pub plans: Lru<Arc<Vec<vod::SeasonPlan>>>,
    /// Portal page size keyed by `<sourceId>|<type>`.
    pub page_sizes: DashMap<String, i64>,
    /// `stalker_items` exists in this database.
    table_ready: AtomicBool,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            sessions: DashMap::new(),
            items: Lru::new(ITEM_CACHE_CAP),
            plans: Lru::new(PLAN_CACHE_CAP),
            page_sizes: DashMap::new(),
            table_ready: AtomicBool::new(false),
        }
    }
}

impl Runtime {
    /// The runtime singleton (created on first use).
    pub fn get(state: &AppState) -> Arc<Runtime> {
        state.ext_or_insert_with::<Runtime>(RUNTIME_KEY, || Arc::new(Runtime::default()))
    }

    pub fn remember(&self, r: &ItemRef, item: CachedItem) {
        self.items.insert(r.key(), item);
    }

    pub fn remember_plan(&self, r: &ItemRef, plan: Arc<Vec<vod::SeasonPlan>>) {
        self.plans.insert(r.key(), plan);
    }

    /// Drops the season plans and page sizes of a source (after a resync).
    /// Listed rows stay: details and playback of a title opened before the
    /// resync keep working.
    pub fn forget_listings(&self, source_id: &str) {
        let prefix = format!("{source_id}|");
        self.plans.remove_prefix(&prefix);
        self.page_sizes.retain(|k, _| !k.starts_with(&prefix));
    }

    /// Drops everything cached in memory for a source (it was removed; its
    /// `stalker_items` rows go with the `sources` row).
    pub fn forget_source(&self, source_id: &str) {
        self.items.remove_prefix(&format!("{source_id}|"));
        self.forget_listings(source_id);
    }
}

// ---------------------------------------------------------------------------
// Persisted row cache (`stalker_items`)
// ---------------------------------------------------------------------------

/// Created on demand (not a numbered migration, so the stalker slice owns
/// it). Rows go with their source through `ON DELETE CASCADE`.
const ITEMS_DDL: &str = "CREATE TABLE IF NOT EXISTS stalker_items (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  category_name TEXT,
  touched_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, content_type, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stalker_items_touched ON stalker_items(source_id, touched_at);";

fn ensure_items_table(rt: &Runtime, conn: &rusqlite::Connection) -> CoreResult<()> {
    if !rt.table_ready.load(Ordering::Acquire) {
        conn.execute_batch(ITEMS_DDL)?;
        rt.table_ready.store(true, Ordering::Release);
    }
    Ok(())
}

/// Persists listed rows (best effort: a failure only costs a later lookup).
/// Each source keeps its [`PERSISTED_ROWS_CAP`] most recently listed rows.
pub async fn persist_items(state: &AppState, rows: Vec<(ItemRef, CachedItem)>) {
    if rows.is_empty() {
        return;
    }
    let rt = Runtime::get(state);
    let res = state
        .db_call(move |conn| {
            ensure_items_table(&rt, conn)?;
            let now = chrono::Utc::now().timestamp_millis();
            let tx = conn.transaction()?;
            let mut sources: Vec<String> = Vec::new();
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO stalker_items (source_id, content_type, item_id, raw_json, category_name, touched_at)
                     SELECT id, ?2, ?3, ?4, ?5, ?6 FROM sources WHERE id = ?1
                     ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
                       raw_json = excluded.raw_json,
                       category_name = COALESCE(excluded.category_name, stalker_items.category_name),
                       touched_at = excluded.touched_at",
                )?;
                for (r, item) in &rows {
                    stmt.execute(rusqlite::params![
                        r.source_id,
                        r.content_type.as_str(),
                        r.item_id,
                        item.raw.to_string(),
                        item.category_name,
                        now
                    ])?;
                    if !sources.contains(&r.source_id) {
                        sources.push(r.source_id.clone());
                    }
                }
            }
            for sid in &sources {
                tx.execute(
                    "DELETE FROM stalker_items WHERE source_id = ?1 AND touched_at < (
                       SELECT touched_at FROM stalker_items WHERE source_id = ?1
                       ORDER BY touched_at DESC LIMIT 1 OFFSET ?2)",
                    rusqlite::params![sid, PERSISTED_ROWS_CAP],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await;
    if let Err(err) = res {
        tracing::warn!(error = %err, "could not persist Stalker rows");
    }
}

/// A row remembered in memory or, failing that, in `stalker_items`.
pub async fn cached_item(state: &AppState, r: &ItemRef) -> Option<CachedItem> {
    let rt = Runtime::get(state);
    if let Some(hit) = rt.items.get(&r.key()) {
        return Some(hit);
    }
    let r2 = r.clone();
    let rt2 = rt.clone();
    let row: Option<(String, Option<String>)> = state
        .db_call(move |conn| {
            use rusqlite::OptionalExtension;
            ensure_items_table(&rt2, conn)?;
            Ok(conn
                .query_row(
                    "SELECT raw_json, category_name FROM stalker_items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                    rusqlite::params![r2.source_id, r2.content_type.as_str(), r2.item_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        })
        .await
        .ok()
        .flatten();
    let (raw, category_name) = row?;
    let item = CachedItem {
        raw: serde_json::from_str(&raw).ok()?,
        category_name,
    };
    rt.remember(r, item.clone());
    Some(item)
}

/// Registers the stalker importer (amendment A1) and creates the runtime.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let _ = Runtime::get(&state);
    crate::sources::register_importer(&state, Arc::new(sync::StalkerImporter));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_the_least_recently_used() {
        let lru: Lru<u32> = Lru::new(10);
        for i in 0..10 {
            lru.insert(format!("k{i}"), i);
        }
        // Touch k0 so k1 becomes the oldest.
        assert_eq!(lru.get("k0"), Some(0));
        lru.insert("k10".into(), 10);
        assert_eq!(lru.len(), 10);
        assert!(lru.contains_key("k0"));
        assert!(!lru.contains_key("k1"));
        assert!(lru.contains_key("k10"));
        lru.remove_prefix("k1");
        assert!(!lru.contains_key("k10"));
        assert!(!lru.is_empty());
    }
}
