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
    /// The portal category the row was listed under. Stalker titles are not
    /// in `items`, so parental controls find their category here.
    pub category_id: Option<String>,
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
    /// Bulk `get_epg_info` answer per source id (shared, indexed by channel,
    /// dropped once no row asks for it; see [`playback::BulkEpgEntry`]).
    pub bulk_epg: DashMap<String, playback::BulkEpgEntry>,
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
            bulk_epg: DashMap::new(),
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

    /// Drops the season plans of a source (after a resync). Listed rows
    /// stay: details and playback of a title opened before the resync keep
    /// working. So do the page sizes (R5-6): `vod::list_page` corrects a
    /// wrong one from the next answer, and dropping them only cost the next
    /// grid page a second portal wave.
    pub fn forget_listings(&self, source_id: &str) {
        self.plans.remove_prefix(&format!("{source_id}|"));
    }

    /// Drops everything cached in memory for a source (it was removed, or
    /// now points at another portal). See [`forget_source`] for the
    /// persisted rows.
    pub fn forget_source(&self, source_id: &str) {
        let prefix = format!("{source_id}|");
        self.items.remove_prefix(&prefix);
        self.forget_listings(source_id);
        self.page_sizes.retain(|k, _| !k.starts_with(&prefix));
        self.bulk_epg.remove(source_id);
    }
}

/// Forgets every row remembered for a source, in memory and in
/// `stalker_items`. Called when the source is removed, replaced by a backup,
/// or its portal URL or MAC changes, so details and playback never use a
/// row (command, stream and poster URLs) listed by another portal.
pub async fn forget_source(state: &AppState, source_id: &str) {
    let rt = Runtime::get(state);
    rt.forget_source(source_id);
    let sid = source_id.to_string();
    let res = state
        .db_call(move |conn| {
            ensure_items_table(&rt, conn)?;
            conn.execute("DELETE FROM stalker_items WHERE source_id = ?1", [&sid])?;
            Ok(())
        })
        .await;
    if let Err(err) = res {
        tracing::warn!(error = %err, "could not drop cached Stalker rows");
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
  category_id TEXT,
  PRIMARY KEY (source_id, content_type, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stalker_items_touched ON stalker_items(source_id, touched_at);";

fn ensure_items_table(rt: &Runtime, conn: &rusqlite::Connection) -> CoreResult<()> {
    if !rt.table_ready.load(Ordering::Acquire) {
        create_items_table(conn)?;
        rt.table_ready.store(true, Ordering::Release);
    }
    Ok(())
}

/// True when `stalker_items` exists with its `category_id` column, so SQL
/// that reads a Stalker title's category can run (the table is created on
/// demand, and builds before parental controls made it without the column).
pub fn items_have_categories(conn: &rusqlite::Connection) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('stalker_items') WHERE name = 'category_id')",
        )?
        .query_row([], |r| r.get(0))?)
}

/// Creates `stalker_items`, or brings one an older build made up to date:
/// `category_id` is added and filled from the row's own `category_id` field,
/// else from the catalog category with the remembered name.
fn create_items_table(conn: &rusqlite::Connection) -> CoreResult<()> {
    conn.execute_batch(ITEMS_DDL)?;
    if items_have_categories(conn)? {
        return Ok(());
    }
    if let Err(err) = conn.execute_batch("ALTER TABLE stalker_items ADD COLUMN category_id TEXT;") {
        // Another connection added it first.
        if items_have_categories(conn)? {
            return Ok(());
        }
        return Err(err.into());
    }
    conn.execute_batch(
        "UPDATE stalker_items SET category_id = COALESCE(
           CASE WHEN json_valid(raw_json)
                THEN NULLIF(CAST(json_extract(raw_json, '$.category_id') AS TEXT), '') END,
           (SELECT c.category_id FROM categories c
             WHERE c.source_id = stalker_items.source_id
               AND c.content_type = stalker_items.content_type
               AND c.name = stalker_items.category_name
             ORDER BY c.position LIMIT 1))
         WHERE category_id IS NULL;",
    )?;
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
        .db_write(move |conn| write_items(&rt, conn, &rows))
        .await;
    if let Err(err) = res {
        tracing::warn!(error = %err, "could not persist Stalker rows");
    }
}

/// [`persist_items`] in the background: a movie or series page does not
/// wait for the write while an import holds the write lock (DB-1). The rows
/// are in the runtime's memory already.
pub fn spawn_persist_items(state: &AppState, rows: Vec<(ItemRef, CachedItem)>) {
    if rows.is_empty() {
        return;
    }
    let rt = Runtime::get(state);
    state
        .writer()
        .spawn("Stalker rows", move |conn| write_items(&rt, conn, &rows));
}

fn write_items(
    rt: &Runtime,
    conn: &mut rusqlite::Connection,
    rows: &[(ItemRef, CachedItem)],
) -> CoreResult<()> {
    ensure_items_table(rt, conn)?;
    let now = chrono::Utc::now().timestamp_millis();
    let tx = conn.transaction()?;
    let mut sources: Vec<String> = Vec::new();
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO stalker_items (source_id, content_type, item_id, raw_json, category_name, touched_at, category_id)
             SELECT id, ?2, ?3, ?4, ?5, ?6, ?7 FROM sources WHERE id = ?1
             ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
               raw_json = excluded.raw_json,
               category_name = COALESCE(excluded.category_name, stalker_items.category_name),
               category_id = COALESCE(excluded.category_id, stalker_items.category_id),
               touched_at = excluded.touched_at",
        )?;
        for (r, item) in rows {
            stmt.execute(rusqlite::params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                item.raw.to_string(),
                item.category_name,
                now,
                item.category_id
            ])?;
            if !sources.contains(&r.source_id) {
                sources.push(r.source_id.clone());
            }
        }
    }
    // Rows of titles the user saved (favorites, history, continue
    // watching, My List) are kept past the cap: parental controls
    // read their category from here.
    for sid in &sources {
        tx.execute(
            "DELETE FROM stalker_items WHERE source_id = ?1 AND touched_at < (
               SELECT touched_at FROM stalker_items WHERE source_id = ?1
               ORDER BY touched_at DESC LIMIT 1 OFFSET ?2)
             AND NOT EXISTS (SELECT 1 FROM favorites u WHERE u.source_id = stalker_items.source_id AND u.content_type = stalker_items.content_type AND u.item_id = stalker_items.item_id)
             AND NOT EXISTS (SELECT 1 FROM recent u WHERE u.source_id = stalker_items.source_id AND u.content_type = stalker_items.content_type AND u.item_id = stalker_items.item_id)
             AND NOT EXISTS (SELECT 1 FROM playback_positions u WHERE u.source_id = stalker_items.source_id AND u.content_type = stalker_items.content_type AND u.item_id = stalker_items.item_id)
             AND NOT EXISTS (SELECT 1 FROM watchlist u WHERE u.source_id = stalker_items.source_id AND u.content_type = stalker_items.content_type AND u.item_id = stalker_items.item_id)",
            rusqlite::params![sid, PERSISTED_ROWS_CAP],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// A row remembered in memory or, failing that, in `stalker_items`.
pub async fn cached_item(state: &AppState, r: &ItemRef) -> Option<CachedItem> {
    let rt = Runtime::get(state);
    if let Some(hit) = rt.items.get(&r.key()) {
        return Some(hit);
    }
    let r2 = r.clone();
    let rt2 = rt.clone();
    let row: Option<(String, Option<String>, Option<String>)> = state
        .db_call(move |conn| {
            use rusqlite::OptionalExtension;
            ensure_items_table(&rt2, conn)?;
            Ok(conn
                .query_row(
                    "SELECT raw_json, category_name, category_id FROM stalker_items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                    rusqlite::params![r2.source_id, r2.content_type.as_str(), r2.item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?)
        })
        .await
        .ok()
        .flatten();
    let (raw, category_name, category_id) = row?;
    let item = CachedItem {
        raw: serde_json::from_str(&raw).ok()?,
        category_name,
        category_id,
    };
    rt.remember(r, item.clone());
    Some(item)
}

/// Registers the stalker importer (amendment A1) and creates the runtime.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let rt = Runtime::get(&state);
    // Up to date before a parental filter reads a Stalker title's category.
    if let Err(err) = state.db_call(move |c| ensure_items_table(&rt, c)).await {
        tracing::warn!(error = %err, "could not prepare the Stalker row cache");
    }
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

    /// R5-6: a resync kept dropping the learned page sizes, so the first
    /// grid page after every sync went out in two waves. Only a source
    /// that is forgotten (removed, or pointed at another portal) drops them.
    #[test]
    fn a_resync_keeps_page_sizes_and_forgetting_the_source_drops_them() {
        let rt = Runtime::default();
        rt.page_sizes.insert("s1|vod".into(), 14);
        rt.page_sizes.insert("s2|vod".into(), 20);
        rt.plans.insert("s1|series|7".into(), Arc::new(Vec::new()));
        rt.forget_listings("s1");
        assert!(!rt.plans.contains_key("s1|series|7"));
        assert_eq!(rt.page_sizes.get("s1|vod").map(|v| *v), Some(14));
        rt.forget_source("s1");
        assert!(!rt.page_sizes.contains_key("s1|vod"));
        assert_eq!(rt.page_sizes.get("s2|vod").map(|v| *v), Some(20));
    }
}
