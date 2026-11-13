//! `epg.search` (Run 2 C5): programme titles of the guide, mapped to the
//! channels of one source.
//!
//! Titles are indexed by `epg_programs_fts`, an external-content FTS5 table
//! over `epg_programs` (migration 0015). The index is not kept in step row
//! by row: ingestion writes millions of rows through staging and swaps them
//! in with a few bulk statements, so triggers would double the cost of every
//! refresh. Instead the whole index is rebuilt after each change, and an
//! `app_state` marker ([`INDEX_MARKER`]) says whether it matches the table:
//!
//! - every statement that deletes or swaps programmes removes the marker in
//!   the same transaction (`store::commit_staging`, `clear_all`, `prune`,
//!   and the staging cleanups when they deleted rows);
//! - [`rebuild_index`] empties the index, refills `epg_search_rows` (each
//!   programme's rowid, start, stop, feed and guide channel, migration
//!   0019: the hits are read there instead of in the wide programme rows)
//!   numbered in (start, feed) order, indexes every title as [`fold`] folds
//!   it under its search row's id (migration 0028: a search reads its hits
//!   in start order and stops once settled), and sets the marker to
//!   [`INDEX_VERSION`] in one transaction: after each refresh, after
//!   `epg.clearAll`, after a prune, and once in the background at startup
//!   when the marker is missing or from an older version and programmes
//!   exist (an upgraded database, or a crash between a swap and its
//!   rebuild);
//! - [`search`] reads the index only while the marker holds the current
//!   version and falls back to a scan of the time window otherwise, so
//!   results are never stale and rowids reused by later inserts never
//!   point a hit at the wrong programme.
//!
//! Both paths match the same way: every word of the query (letters and
//! digits, case and diacritics folded) must start a word of the title.
//! The index holds Rust-folded titles because the FTS5 tokenizer's own
//! diacritic removal covers Latin letters only: it keeps the Greek tonos,
//! so "Ελληνικά" would not find "ελληνικα" through the index while the scan
//! found it.

use super::ingest::EpgRuntime;
use super::resolve::{self, ChannelDirectory};
use super::store::STAGING_ORIGIN;
use super::{query, runtime};
use crate::catalog::quality::QualityFilter;
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, EpgProgram, ItemRef};
use crate::parental::Hide;
use crate::state::AppState;
use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// `app_state` key present while one set of index tables ([`IndexSet`])
/// matches `epg_programs`; its value names the set.
pub const INDEX_MARKER: &str = "epg_search_index";
/// Marker value while the first set (`epg_programs_fts` of [`fold`]ed
/// titles with its `epg_search_rows`, both numbered in search order,
/// migration 0028) is current. A marker with any value but this and
/// [`INDEX_VERSION_B`] (`ready`: raw titles, before the fold; `folded-1`:
/// before the search rows; `folded-2`: by programme rowid) counts as
/// missing.
pub const INDEX_VERSION: &str = "ordered-1";
/// Marker value while the second set (`epg_programs_fts_b`,
/// `epg_search_rows_b`, migration 0029) is current.
pub const INDEX_VERSION_B: &str = "ordered-1b";
/// `app_state` key with a random value that every transaction which deletes
/// or swaps programmes replaces as it removes the marker
/// ([`invalidate_index`]): a build reads it with the programmes it indexes
/// and makes its set current only while it still holds that value.
const GUIDE_STAMP_KEY: &str = "epg_search_guide";
/// Rows the first write transaction of a build copies; each later one is
/// sized from the one before to take about [`CHUNK_TARGET`].
const FIRST_CHUNK: i64 = 8_192;
/// Write lock time each transaction of a build aims at.
const CHUNK_TARGET: std::time::Duration = std::time::Duration::from_millis(25);
/// Builds started again after the guide changed under them before one
/// gives up (the change's own rebuild follows it).
const BUILD_ATTEMPTS: usize = 3;
/// `app_state` key with the longest programme of the search rows, in
/// seconds: hits are read from that long before the window, so a
/// programme on air at its start is not missed.
const LONGEST_KEY: &str = "epg_search_longest";
/// SQL function [`rebuild_index`] registers to fold titles while indexing.
const FOLD_SQL_FUNCTION: &str = "epg_search_fold";
/// Query length bounds, in characters after trimming.
pub const MIN_QUERY_CHARS: usize = 2;
pub const MAX_QUERY_CHARS: usize = 100;
/// Result count: default and maximum.
pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 200;
/// Default window length from `from`.
pub const DEFAULT_SPAN_SECS: i64 = 14 * 86_400;
/// Longest window accepted.
pub const MAX_SPAN_SECS: i64 = 16 * 86_400;
/// Memoized channel resolutions above this count are dropped (bounds the
/// memory of a guide with very many unknown ids).
const MEMO_CAP: usize = 500_000;
/// Catalog keys ([`CatalogKeys`]) kept in all; past this the other
/// catalogs are dropped when one is loaded (about 60 bytes a key).
const KEYS_CAP: usize = 1_000_000;
/// A catalog row read through its key ([`SEEK_SQL`]) costs about this many
/// rows of the plain channel walk; past that share the walk is cheaper.
const SEEK_COST: usize = 4;

/// `epg.search` arguments.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchRequest {
    pub source_id: String,
    pub query: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
}

/// One `epg.search` result: a programme on one channel of the source.
/// Times in `program` are moved by the channel's guide shift, as in
/// `epg.programs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSearchHit {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub channel_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_number: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    pub program: EpgProgram,
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

/// [`FTS_SQL`] over one set of tables.
macro_rules! fts_sql {
    ($fts:literal, $rows:literal) => {
        concat!(
            "SELECT p.id, p.prog, p.channel_id, p.start, p.stop, p.feed
     FROM ",
            $fts,
            " f
     CROSS JOIN ",
            $rows,
            " p ON p.id = f.rowid
     WHERE ",
            $fts,
            " MATCH ?1 AND f.rowid >= ?2 AND f.rowid < ?3 AND p.stop > ?4
     ORDER BY f.rowid LIMIT ?5"
        )
    };
}

/// One of the two sets of index tables. Searches read the set the marker
/// names while a build fills the other one, which then becomes current
/// (migration 0029).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexSet {
    /// `epg_programs_fts` and `epg_search_rows`.
    A,
    /// `epg_programs_fts_b` and `epg_search_rows_b`.
    B,
}

impl IndexSet {
    fn marker(self) -> &'static str {
        match self {
            Self::A => INDEX_VERSION,
            Self::B => INDEX_VERSION_B,
        }
    }

    /// The title index.
    pub fn fts(self) -> &'static str {
        match self {
            Self::A => "epg_programs_fts",
            Self::B => "epg_programs_fts_b",
        }
    }

    /// The search rows.
    pub fn rows(self) -> &'static str {
        match self {
            Self::A => "epg_search_rows",
            Self::B => "epg_search_rows_b",
        }
    }

    fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }

    /// [`FTS_SQL`] over this set.
    fn fts_sql(self) -> &'static str {
        match self {
            Self::A => FTS_SQL,
            Self::B => FTS_SQL_B,
        }
    }
}

/// Marks the index stale. Call inside the transaction that deletes or
/// re-keys programmes: it also replaces the guide stamp, so a build that
/// read the programmes before this change does not make its set current.
pub fn invalidate_index(conn: &Connection) -> CoreResult<()> {
    conn.prepare_cached("DELETE FROM app_state WHERE key = ?1")?
        .execute([INDEX_MARKER])?;
    conn.prepare_cached(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, random(), CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )?
    .execute([GUIDE_STAMP_KEY])?;
    Ok(())
}

/// The set that matches the programme table, if any.
pub fn current_set(conn: &Connection) -> CoreResult<Option<IndexSet>> {
    let value: Option<String> = conn
        .prepare_cached("SELECT value FROM app_state WHERE key = ?1")?
        .query_row([INDEX_MARKER], |r| r.get(0))
        .optional()?;
    Ok(match value.as_deref() {
        Some(INDEX_VERSION) => Some(IndexSet::A),
        Some(INDEX_VERSION_B) => Some(IndexSet::B),
        _ => None,
    })
}

/// True when the index matches the programme table and holds folded titles.
pub fn index_ready(conn: &Connection) -> CoreResult<bool> {
    Ok(current_set(conn)?.is_some())
}

fn guide_stamp(conn: &Connection) -> CoreResult<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT value FROM app_state WHERE key = ?1")?
        .query_row([GUIDE_STAMP_KEY], |r| r.get(0))
        .optional()?)
}

/// One build at a time per database file: two would fill the same set.
fn build_lock(conn: &Connection) -> Arc<parking_lot::Mutex<()>> {
    static LOCKS: std::sync::LazyLock<
        parking_lot::Mutex<HashMap<String, Arc<parking_lot::Mutex<()>>>>,
    > = std::sync::LazyLock::new(Default::default);
    let key = conn.path().unwrap_or_default().to_string();
    LOCKS.lock().entry(key).or_default().clone()
}

/// Empties one set of index tables.
fn empty_set(conn: &Connection, set: IndexSet) -> CoreResult<()> {
    let fts = set.fts();
    conn.execute_batch(&format!(
        "INSERT INTO {fts}({fts}) VALUES('delete-all'); DELETE FROM {};",
        set.rows()
    ))?;
    Ok(())
}

fn set_is_empty(conn: &Connection, set: IndexSet) -> CoreResult<bool> {
    Ok(conn
        .query_row(&format!("SELECT 1 FROM {} LIMIT 1", set.rows()), [], |_| {
            Ok(())
        })
        .optional()?
        .is_none())
}

/// Rebuilds the whole index from `epg_programs` and marks it ready. Titles
/// are indexed as [`fold`] folds them (not with `'rebuild'`, which would
/// index the raw titles of the content table), so the index and the scan
/// agree on every script; queries are folded the same way before they
/// reach the tokenizer.
///
/// The set searches do not read is filled in short write transactions
/// ([`CHUNK_TARGET`]) that let other writers in between them
/// (`db::hand_over`), from one sort of the programmes taken in a read
/// transaction, and the last of them makes it current. When the guide
/// changed since that sort (the guide stamp moved: a refresh committed,
/// the guide was cleared or pruned), the build starts again from a new
/// sort, up to [`BUILD_ATTEMPTS`] times; searches scan meanwhile, since the
/// change removed the marker. The set read before is emptied afterwards.
pub fn rebuild_index(conn: &mut Connection) -> CoreResult<()> {
    let lock = build_lock(conn);
    let _one = lock.lock();
    build(conn).map(|_| ())
}

/// [`rebuild_index`] with the build lock held. Returns whether a set was
/// made current.
fn build(conn: &mut Connection) -> CoreResult<bool> {
    conn.create_scalar_function(
        FOLD_SQL_FUNCTION,
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let title = ctx
                .get_raw(0)
                .as_str_or_null()
                .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
            Ok(title.map(fold))
        },
    )?;
    // The sort goes through a temporary file behind the temporary
    // database's small page cache, whatever the connection's setting (a
    // refresh already set it): the startup build of a large guide held
    // about 70 MB of sorted rows in memory, for no measured gain in time.
    // Restoring the setting closes the temporary database.
    let temp_store: i64 = conn.query_row("PRAGMA temp_store", [], |r| r.get(0))?;
    if temp_store != 1 {
        conn.execute_batch("PRAGMA temp_store=FILE")?;
    }
    let mut result = Ok(false);
    for _ in 0..BUILD_ATTEMPTS {
        result = build_once(conn);
        // Never left behind on a pooled connection, also when the build
        // failed part-way.
        let _ = conn.execute("DROP TABLE IF EXISTS temp.epg_search_sorted", []);
        if !matches!(result, Ok(false)) {
            break;
        }
        tracing::debug!("the guide changed during the guide search index build");
    }
    if temp_store != 1 {
        conn.execute_batch(&format!("PRAGMA temp_store={temp_store}"))?;
    }
    if matches!(result, Ok(false)) {
        tracing::warn!("the guide kept changing during the guide search index build; search scans until the next one");
    }
    result
}

/// Statement that copies rows `?1 <= rowid < ?2` of the sorted programmes
/// into a set's search rows.
fn copy_rows_sql(set: IndexSet) -> String {
    format!(
        "INSERT INTO {}(id, prog, start, stop, feed, channel_id)
         SELECT rowid, prog, start, stop, feed, channel_id FROM temp.epg_search_sorted
         WHERE rowid >= ?1 AND rowid < ?2",
        set.rows()
    )
}

/// Statement that indexes the titles of rows `?1 <= rowid < ?2` of the
/// sorted programmes in a set's title index.
fn copy_titles_sql(set: IndexSet) -> String {
    format!(
        "INSERT INTO {}(rowid, title) SELECT rowid, title FROM temp.epg_search_sorted
         WHERE rowid >= ?1 AND rowid < ?2",
        set.fts()
    )
}

/// One build; false when the guide changed before the set was made current
/// (nothing was made current then).
fn build_once(conn: &mut Connection) -> CoreResult<bool> {
    let started = std::time::Instant::now();
    // One sort of the programmes in search order, titles folded on the
    // way; its rowids (1, 2, ...) become the search rows' ids and the
    // index's rowids, which the index takes fastest in ascending order. A
    // read transaction: it writes the temporary database only, so it takes
    // no write lock, and the guide stamp read with it says which guide it
    // saw.
    let (stamp, target, count, longest) = {
        let tx = conn.transaction()?;
        let stamp = guide_stamp(&tx)?;
        let target = match current_set(&tx)? {
            Some(set) => set.other(),
            // No set is read: build into an empty one when there is one,
            // so emptying the stale one waits until the end.
            None if !set_is_empty(&tx, IndexSet::A)? && set_is_empty(&tx, IndexSet::B)? => {
                IndexSet::B
            }
            None => IndexSet::A,
        };
        tx.execute("DROP TABLE IF EXISTS temp.epg_search_sorted", [])?;
        tx.execute(
            &format!(
                "CREATE TEMP TABLE epg_search_sorted AS
                 SELECT p.rowid AS prog, p.start AS start, p.stop AS stop, s.rowid AS feed,
                        p.channel_id AS channel_id, {FOLD_SQL_FUNCTION}(p.title) AS title
                 FROM epg_programs p JOIN epg_sources s ON s.url = p.epg_url
                 ORDER BY p.start, s.rowid, p.rowid"
            ),
            [],
        )?;
        let (count, longest): (i64, i64) = tx.query_row(
            "SELECT coalesce(max(rowid), 0), coalesce(max(stop - start), 0) FROM temp.epg_search_sorted",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.commit()?;
        (stamp, target, count, longest)
    };
    let sorted = started.elapsed();
    let (copy_rows, copy_titles) = (copy_rows_sql(target), copy_titles_sql(target));
    let _handing = crate::db::handing_over();
    let mut chunk = first_chunk();
    let mut lo = 1i64;
    let mut chunks = 0usize;
    let mut longest_chunk = std::time::Duration::ZERO;
    loop {
        let began = std::time::Instant::now();
        let hi = lo.saturating_add(chunk);
        let last = hi > count;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if guide_stamp(&tx)? != stamp {
            return Ok(false);
        }
        if lo == 1 && !set_is_empty(&tx, target)? {
            empty_set(&tx, target)?;
        }
        tx.prepare_cached(&copy_rows)?.execute([lo, hi])?;
        tx.prepare_cached(&copy_titles)?.execute([lo, hi])?;
        if last {
            tx.execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![LONGEST_KEY, longest.to_string()],
            )?;
            tx.execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                [INDEX_MARKER, target.marker()],
            )?;
        }
        tx.commit()?;
        chunks += 1;
        let took = began.elapsed();
        longest_chunk = longest_chunk.max(took);
        #[cfg(test)]
        tests::after_chunk(chunks)?;
        if last {
            break;
        }
        lo = hi;
        // Sized from the last one, at most twice as large.
        let scaled = chunk as f64 * CHUNK_TARGET.as_secs_f64() / took.as_secs_f64().max(1e-4);
        chunk = (scaled as i64).min(chunk.saturating_mul(2)).max(1_024);
        #[cfg(test)]
        if let Some(n) = tests::CHUNK_OVERRIDE.with(|c| c.get()) {
            chunk = n;
        }
        crate::db::hand_over(began);
    }
    // The set searches read before: emptied, so the file does not hold two
    // indexes and the next build starts from empty tables. A search still
    // reading it keeps its snapshot.
    let other = target.other();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !set_is_empty(&tx, other)? {
        empty_set(&tx, other)?;
    }
    tx.commit()?;
    tracing::debug!(
        ms = started.elapsed().as_millis() as u64,
        sort_ms = sorted.as_millis() as u64,
        rows = count,
        chunks,
        longest_chunk_ms = longest_chunk.as_millis() as u64,
        "guide search index rebuilt"
    );
    Ok(true)
}

fn first_chunk() -> i64 {
    #[cfg(test)]
    if let Some(n) = tests::CHUNK_OVERRIDE.with(|c| c.get()) {
        return n;
    }
    FIRST_CHUNK
}

/// Rebuilds the index when it is stale. With `only_if_programmes`, an empty
/// guide is left alone (nothing to index; startup must not write for
/// nothing). Returns whether a rebuild ran and made the index current. A
/// build already running for this database is waited for, and when it
/// left the index current nothing more is done (two refreshes back to
/// back rebuild once after the second when the first build saw it come
/// in). Holds the long-write guard so user writes wait for its
/// transactions instead of failing.
pub fn ensure_index(conn: &mut Connection, only_if_programmes: bool) -> CoreResult<bool> {
    if index_ready(conn)? {
        return Ok(false);
    }
    if only_if_programmes {
        let any: Option<i64> = conn
            .query_row("SELECT 1 FROM epg_programs LIMIT 1", [], |r| r.get(0))
            .optional()?;
        if any.is_none() {
            return Ok(false);
        }
    }
    let lock = build_lock(conn);
    let _one = lock.lock();
    if index_ready(conn)? {
        return Ok(false);
    }
    let _long = crate::db::long_write();
    build(conn)
}

/// [`ensure_index`] for the write paths (refresh, clear, prune): a failure
/// is logged and leaves search on its fallback; it never fails the caller.
pub fn refresh_index(conn: &mut Connection) {
    if let Err(e) = ensure_index(conn, false) {
        tracing::warn!(error = %e, "could not rebuild the guide search index; search scans until the next refresh");
    }
}

/// Startup: builds a missing index in the background when the guide has
/// programmes (a database upgraded to 0015, or an interrupted rebuild).
/// Then loads what the first search would otherwise load: the channel
/// directory and every source's catalog keys ([`spawn_warm_guide`],
/// [`spawn_warm_catalog`]).
pub fn spawn_startup_build(state: &Arc<AppState>) {
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        let Some(state) = weak.upgrade() else { return };
        match state.db_call(|c| ensure_index(c, true)).await {
            Ok(true) => tracing::info!("guide search index built"),
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "could not build the guide search index"),
        }
        warm_guide(&state).await;
        let sources = state
            .db_call(|c| {
                Ok(c.prepare("SELECT id FROM sources ORDER BY position")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?)
            })
            .await
            .unwrap_or_default();
        for id in sources {
            warm_catalog(&state, id).await;
        }
    });
}

/// After the guide changed (a refresh, a clear, a prune, a feed enabled or
/// disabled): loads the channel directory and its reverse lookups in the
/// background, which the first search after the change would otherwise
/// load (most of its time). A search meanwhile waits for this load rather
/// than starting its own.
pub fn spawn_warm_guide(state: &Arc<AppState>) {
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        if let Some(state) = weak.upgrade() {
            warm_guide(&state).await;
        }
    });
}

async fn warm_guide(state: &AppState) {
    let rt = runtime(state);
    let warmed = state
        .db_call(move |c| {
            let dir = resolve::directory(c, &rt)?;
            // Builds the reverse lookups too.
            dir.ids_of("");
            Ok(())
        })
        .await;
    if let Err(e) = warmed {
        tracing::debug!(error = %e, "could not load the guide channel directory ahead");
    }
}

/// After a source's catalog was written: reads its catalog keys
/// ([`CatalogKeys`]) in the background, which the source's first guide
/// search would otherwise read (normalizing every channel name it has not
/// seen: about 110 ms for a new 200k-channel catalog in release). Cheap
/// when they are current.
pub fn spawn_warm_catalog(state: &Arc<AppState>, source_id: &str) {
    let weak = Arc::downgrade(state);
    let id = source_id.to_string();
    tokio::spawn(async move {
        if let Some(state) = weak.upgrade() {
            warm_catalog(&state, id).await;
        }
    });
}

async fn warm_catalog(state: &AppState, source_id: String) {
    let rt = runtime(state);
    let warmed = state
        .db_call(move |c| {
            // Keys and stamp from one snapshot, as a search reads them.
            let tx = c.transaction()?;
            for content_type in [ContentType::Live, ContentType::Radio] {
                catalog_keys(&tx, &rt, &source_id, content_type)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await;
    if let Err(e) = warmed {
        tracing::debug!(error = %e, "could not read catalog keys ahead");
    }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/// Lowercase without diacritics ("Café" -> "cafe", "Ελληνικά" ->
/// "ελληνικα", "Thời sự" -> "thoi su"), final sigma as sigma.
pub fn fold(s: &str) -> String {
    // Most guide titles: one pass, one allocation (the index rebuild folds
    // every title).
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    let mut out = crate::tmdb::normalize::strip_diacritics(&s.to_lowercase());
    if out.contains('ς') {
        out = out.replace('ς', "σ");
    }
    out
}

/// Words of `s` after [`fold`]: runs of letters and digits.
pub fn words(s: &str) -> Vec<String> {
    fold(s)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// True when every query word starts some word of `title`.
pub fn title_matches(title: &str, query_words: &[String]) -> bool {
    if query_words.is_empty() {
        return false;
    }
    let title_words = words(title);
    query_words
        .iter()
        .all(|q| title_words.iter().any(|w| w.starts_with(q.as_str())))
}

/// FTS5 expression for the query words: each a quoted prefix term, all
/// required.
pub fn fts_expression(query_words: &[String]) -> String {
    query_words
        .iter()
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Validated arguments.
#[derive(Debug, Clone)]
struct Query {
    source_id: String,
    words: Vec<String>,
    from: i64,
    to: i64,
    limit: usize,
}

fn validate(req: SearchRequest, now: i64) -> CoreResult<Query> {
    let text = req.query.trim();
    let chars = text.chars().count();
    if !(MIN_QUERY_CHARS..=MAX_QUERY_CHARS).contains(&chars) {
        return Err(CoreError::invalid(format!(
            "query must be {MIN_QUERY_CHARS} to {MAX_QUERY_CHARS} characters"
        )));
    }
    let source_id = req.source_id.trim().to_string();
    if source_id.is_empty() {
        return Err(CoreError::invalid("sourceId is required"));
    }
    let from = match req.from.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(s) => query::parse_time(s, "from")?,
        None => now,
    };
    let to = match req.to.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(s) => query::parse_time(s, "to")?,
        None => from + DEFAULT_SPAN_SECS,
    };
    if to <= from {
        return Err(CoreError::invalid("to must be after from"));
    }
    if to - from > MAX_SPAN_SECS {
        return Err(CoreError::invalid(
            "the search window may span at most 16 days",
        ));
    }
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(CoreError::invalid(format!(
            "limit must be between 1 and {MAX_LIMIT}"
        )));
    }
    Ok(Query {
        source_id,
        words: words(text),
        from,
        to,
        limit: limit as usize,
    })
}

/// One live or radio channel of the searched source, as the channel scan
/// reads it: enough to count and order candidates. The rest of the row is
/// read only for the channels that can make the result ([`SourceChannel`]).
#[derive(Debug, Clone, Copy)]
struct ChannelKey {
    rowid: i64,
    content_type: ContentType,
    number: Option<i64>,
}

/// The source's visible channels by the guide channel id each resolves to.
#[derive(Default)]
struct SourceChannels {
    by_guide: HashMap<Arc<str>, usize>,
    /// Guide channel id and its channels, indexed by `by_guide`'s values.
    guides: Vec<(Arc<str>, Vec<ChannelKey>)>,
}

/// A channel of the result.
#[derive(Debug, Clone)]
struct SourceChannel {
    item_ref: ItemRef,
    name: String,
    /// `name` lowercased once, for [`hit_order`].
    sort_name: String,
    number: Option<i64>,
    logo_url: Option<String>,
    category_id: String,
}

/// Channel resolutions that depend only on the guide, kept on the EPG
/// runtime and reused by every search until its generation moves (a
/// refresh, a clear, a prune, a url enabled or disabled). Without it each
/// search probed `epg_programs` once per unknown `epg_channel_id` and
/// normalized every unmatched channel name: about 140 ms at 50k channels.
/// The channels themselves are read on every search that has hits (an
/// index-only scan of `idx_items_guide`), so catalog changes, channel edits
/// and parental locks apply at once.
///
/// The resolutions are kept per source and channel type, sorted the way
/// the channel scan returns its rows (`epg_channel_id`, then title), and
/// the scan walks the list alongside ([`ResolvedList::find`]). Before, two
/// hash maps keyed by id and by title cost two lookups in large tables for
/// every channel, most of a search's time at 200k channels.
#[derive(Default)]
pub(crate) struct SearchMemo {
    generation: u64,
    /// Per (source id, channel type).
    lists: HashMap<(String, ContentType), ResolvedList>,
}

/// One distinct (`epg_channel_id`, title) pair of a source's channels and
/// the guide channel it resolves to without a manual mapping.
struct Resolved {
    epg: Option<Box<str>>,
    title: Box<str>,
    guide: Option<Arc<str>>,
}

/// A row's memo key: its `epg_channel_id` as stored and its title. Tuples
/// order `None` (SQL NULL) first and text by bytes, as SQLite orders the
/// BINARY-collated columns of `idx_items_guide`.
type ResolvedKey<'a> = (Option<&'a str>, &'a str);

impl Resolved {
    fn key(&self) -> ResolvedKey<'_> {
        (self.epg.as_deref(), &self.title)
    }
}

/// The resolutions of one source and type, sorted by key, distinct.
#[derive(Default)]
struct ResolvedList {
    entries: Vec<Resolved>,
}

impl ResolvedList {
    /// The entry for `key`. `cursor` follows a scan in key order, so a hit
    /// costs a comparison or two with the entries after the last one; a row
    /// out of that order falls back to a binary search.
    fn find(&self, cursor: &mut usize, key: ResolvedKey<'_>) -> Option<&Resolved> {
        let entries = &self.entries;
        while *cursor < entries.len() && entries[*cursor].key() < key {
            *cursor += 1;
        }
        if let Some(e) = entries.get(*cursor) {
            if e.key() == key {
                return Some(e);
            }
        }
        entries
            .binary_search_by(|e| e.key().cmp(&key))
            .ok()
            .map(|i| &entries[i])
    }

    /// Adds the entries a scan resolved afresh, keeping the list sorted and
    /// distinct.
    fn merge(&mut self, added: Vec<Resolved>) {
        if added.is_empty() {
            return;
        }
        self.entries.extend(added);
        // Two sorted runs when the scan came in key order.
        self.entries.sort_by(|a, b| a.key().cmp(&b.key()));
        self.entries.dedup_by(|a, b| a.key() == b.key());
    }
}

impl SearchMemo {
    /// Takes the runtime's memo, or a fresh one when `generation` moved on.
    /// Concurrent searches each work on their own (one starts empty).
    fn take(rt: &EpgRuntime, generation: u64) -> Self {
        let memo = std::mem::take(&mut *rt.search_memo.lock());
        if memo.generation == generation {
            memo
        } else {
            Self {
                generation,
                ..Self::default()
            }
        }
    }

    fn put_back(mut self, rt: &EpgRuntime) {
        if self.lists.values().map(|l| l.entries.len()).sum::<usize>() > MEMO_CAP {
            self.lists.clear();
        }
        *rt.search_memo.lock() = self;
    }
}

/// Resolves the channels the memo does not hold yet, within one scan: each
/// unknown `epg_channel_id` is probed once.
#[derive(Default)]
struct FreshResolver {
    /// Trimmed `items.epg_channel_id` -> the guide channel it names (known
    /// to the guide, case-insensitive, or with programmes), else `None`.
    ids: HashMap<String, Option<Arc<str>>>,
}

impl FreshResolver {
    fn by_id(
        &mut self,
        conn: &Connection,
        dir: &ChannelDirectory,
        id: &str,
    ) -> CoreResult<Option<Arc<str>>> {
        if let Some(found) = self.ids.get(id) {
            return Ok(found.clone());
        }
        let found: Option<Arc<str>> = match dir.find_id(id) {
            Some(canonical) => Some(canonical.into()),
            None if resolve::has_programmes(conn, id)? => Some(id.into()),
            None => None,
        };
        self.ids.insert(id.to_string(), found.clone());
        Ok(found)
    }

    /// The guide channel of a channel without a manual mapping: its
    /// `epg_channel_id` when that resolves, else its exact normalized name.
    fn resolve(
        &mut self,
        conn: &Connection,
        dir: &ChannelDirectory,
        item_epg: Option<&str>,
        title: &str,
    ) -> CoreResult<Option<Arc<str>>> {
        if let Some(id) = item_epg.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(found) = self.by_id(conn, dir, id)? {
                return Ok(Some(found));
            }
        }
        Ok(dir.find_name_exact(title).map(Into::into))
    }
}

/// Text column `idx` without copying it.
fn text<'r>(r: &'r rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<Option<&'r str>> {
    r.get_ref(idx)?.as_str_or_null().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

/// Manual mappings of one source and channel type, by item rowid.
const MANUAL_SQL: &str = "SELECT h.rowid, m.epg_channel_id FROM epg_channel_map m
     CROSS JOIN items h ON h.source_id = m.source_id AND h.content_type = m.content_type AND h.item_id = m.item_id
     WHERE m.source_id = ?1 AND m.content_type = ?2";

/// The channels of one source and type, from `idx_items_guide` alone (the
/// literal `IN` lets the planner use that partial index).
pub const CHANNELS_SQL: &str = "SELECT i.rowid, i.title, i.epg_channel_id, i.number FROM items i
     WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.content_type IN ('live', 'radio')";

/// The source's visible channels by the guide channel id each resolves to:
/// manual mapping (`NULL` = none), then `items.epg_channel_id` (known to
/// the guide, case-insensitive, or with programmes), then the exact
/// normalized name. Channels hidden by a channel edit are left out, and so,
/// while hide mode is on, are locked and adult channels, and with `quality`
/// the live channels the Live TV quality filter hides: in SQL, so they never
/// take a candidate slot from a visible channel.
fn source_channels(
    conn: &Connection,
    rt: &EpgRuntime,
    dir: &ChannelDirectory,
    source_id: &str,
    hide: Option<Hide>,
    quality: Option<QualityFilter>,
) -> CoreResult<SourceChannels> {
    let mut memo = SearchMemo::take(rt, dir.generation());
    let mut fresh = FreshResolver::default();
    let mut out = SourceChannels::default();
    for content_type in [ContentType::Live, ContentType::Radio] {
        let manual: HashMap<i64, Option<String>> = conn
            .prepare_cached(MANUAL_SQL)?
            .query_map(params![source_id, content_type.as_str()], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        let mut sql = String::from(CHANNELS_SQL);
        sql.push_str(&visible_clauses(
            conn,
            source_id,
            content_type,
            hide,
            quality,
        )?);
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut rows = stmt.query(params![source_id, content_type.as_str()])?;
        let list_key = (source_id.to_string(), content_type);
        let known = memo.lists.remove(&list_key).unwrap_or_default();
        let mut cursor = 0usize;
        let mut added: Vec<Resolved> = Vec::new();
        while let Some(r) = rows.next()? {
            let rowid: i64 = r.get(0)?;
            let guide: Option<Arc<str>> = match manual.get(&rowid) {
                Some(m) => m
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(Arc::from),
                // Borrowed: the memo answers most channels without a copy.
                None => {
                    let key = (text(r, 2)?, text(r, 1)?.unwrap_or_default());
                    match known.find(&mut cursor, key) {
                        Some(e) => e.guide.clone(),
                        // Rows with the same key come one after another.
                        None => match added.last().filter(|e| e.key() == key) {
                            Some(e) => e.guide.clone(),
                            None => {
                                let guide = fresh.resolve(conn, dir, key.0, key.1)?;
                                added.push(Resolved {
                                    epg: key.0.map(Into::into),
                                    title: key.1.into(),
                                    guide: guide.clone(),
                                });
                                guide
                            }
                        },
                    }
                }
            };
            let Some(guide) = guide else {
                continue;
            };
            let key = ChannelKey {
                rowid,
                content_type,
                number: r.get(3)?,
            };
            match out.by_guide.get(&guide) {
                Some(&i) => out.guides[i].1.push(key),
                None => {
                    out.by_guide.insert(guide.clone(), out.guides.len());
                    out.guides.push((guide, vec![key]));
                }
            }
        }
        let mut known = known;
        known.merge(added);
        memo.lists.insert(list_key, known);
    }
    memo.put_back(rt);
    Ok(out)
}

/// The `AND` clauses that leave out the channels a search must not show:
/// hidden by a channel edit, locked or adult while hide mode is on, and
/// with `quality` the live channels the Live TV quality filter hides, for
/// statements over `items i` with the source id and type as `?1` and `?2`.
fn visible_clauses(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    hide: Option<Hide>,
    quality: Option<QualityFilter>,
) -> CoreResult<String> {
    let mut sql = crate::channeledit::scoped(conn, source_id, content_type, "?1", "?2")?;
    if let Some(h) = hide {
        sql.push_str(&crate::parental::filter::scoped(
            conn,
            source_id,
            content_type,
            h,
            "?1",
            "?2",
        )?);
    }
    // `quality` is the last column of idx_items_guide: the scan stays
    // index-only. Radio is never filtered.
    if content_type == ContentType::Live {
        sql.push_str(&crate::catalog::quality::live_clause(quality, "i"));
    }
    Ok(sql)
}

// ---------------------------------------------------------------------------
// Catalog keys: the channels of the guide channels with hits
// ---------------------------------------------------------------------------

/// Writes a new stamp for the catalog keys of one source and type
/// (migration 0027). Writers that suspend the per-row triggers call it in
/// the transaction that rewrote the rows.
pub fn touch_catalog_stamp(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<()> {
    conn.prepare_cached(
        "INSERT INTO guide_catalog_stamp (source_id, content_type, stamp) VALUES (?1, ?2, random())
         ON CONFLICT (source_id, content_type) DO UPDATE SET stamp = excluded.stamp",
    )?
    .execute(params![source_id, content_type.as_str()])?;
    Ok(())
}

/// The stored stamp of one source and type; `None` while it has none (no
/// row was ever written for it, or the source was removed).
fn catalog_stamp(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<Option<i64>> {
    Ok(conn
        .prepare_cached(
            "SELECT stamp FROM guide_catalog_stamp WHERE source_id = ?1 AND content_type = ?2",
        )?
        .query_row(params![source_id, content_type.as_str()], |r| r.get(0))
        .optional()?)
}

fn key_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// The entries of a sorted `(hash, key)` list with hash `h`.
fn with_hash(list: &[(u64, u32)], h: u64) -> impl Iterator<Item = u32> + '_ {
    let start = list.partition_point(|e| e.0 < h);
    list[start..]
        .iter()
        .take_while(move |e| e.0 == h)
        .map(|e| e.1)
}

/// One distinct key of [`CatalogKeys`]: offsets into its text.
#[derive(Debug, Clone, Copy)]
struct KeyEntry {
    /// `epg_channel_id` (start, end); `None` for SQL NULL.
    epg: Option<(u32, u32)>,
    title: (u32, u32),
    /// Rows of the catalog with this key.
    rows: u32,
    /// Hash of `normalize_name(title)`; `None` when that is empty. Carried
    /// over from the previous list for the keys it had, since normalizing
    /// is most of the cost of a load.
    name: Option<u64>,
}

/// Every distinct (`epg_channel_id`, title) pair of one source and type,
/// with or without a manual mapping or a channel edit, as stored under
/// `stamp`. What a key resolves to depends on the guide alone, so the
/// list lives across guide changes and is read again only when the stamp
/// moves (migration 0027: any write that adds, removes or re-keys a row).
/// Lookups go the other way round from a channel scan, from a guide
/// channel to its keys: by the lowercased id ([`ChannelDirectory::find_id`]
/// and channels with programmes) and by the normalized title
/// ([`ChannelDirectory::find_name_exact`]), both kept as hashes and checked
/// against the key's own text.
struct CatalogKeys {
    stamp: Option<i64>,
    text: String,
    /// Sorted the way the channel scan returns its rows ([`ResolvedKey`]).
    keys: Vec<KeyEntry>,
    /// (hash of the trimmed, lowercased `epg_channel_id`, key), sorted.
    by_id: Vec<(u64, u32)>,
    /// (hash of `normalize_name(title)`, key), sorted.
    by_name: Vec<(u64, u32)>,
    /// Rows of the catalog.
    rows: usize,
}

/// Every key of one source and type, in key order (`idx_items_guide`).
const KEYS_SQL: &str = "SELECT i.epg_channel_id, i.title FROM items i
     WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.content_type IN ('live', 'radio')
     ORDER BY i.epg_channel_id, i.title";

impl CatalogKeys {
    fn load(
        conn: &Connection,
        source_id: &str,
        content_type: ContentType,
        stamp: Option<i64>,
        previous: Option<&CatalogKeys>,
    ) -> CoreResult<Self> {
        let mut out = Self {
            stamp,
            text: String::new(),
            keys: Vec::new(),
            by_id: Vec::new(),
            by_name: Vec::new(),
            rows: 0,
        };
        let mut stmt = conn.prepare_cached(KEYS_SQL)?;
        let mut rows = stmt.query(params![source_id, content_type.as_str()])?;
        while let Some(r) = rows.next()? {
            out.rows += 1;
            let key = (text(r, 0)?, text(r, 1)?.unwrap_or_default());
            if let Some(last) = out.keys.last_mut() {
                let e = *last;
                if out_key(&out.text, &e) == key {
                    last.rows += 1;
                    continue;
                }
            }
            let mut span = |s: &str| {
                let start = out.text.len() as u32;
                out.text.push_str(s);
                (start, out.text.len() as u32)
            };
            let epg = key.0.map(&mut span);
            let title = span(key.1);
            out.keys.push(KeyEntry {
                epg,
                title,
                rows: 1,
                name: None,
            });
        }
        // SQLite orders TEXT by bytes, as `str` does; a mixed-type column
        // would not, so sort anyway (a sorted list costs one pass).
        if !out.keys.windows(2).all(|w| out.key(&w[0]) < out.key(&w[1])) {
            let text = &out.text;
            out.keys
                .sort_by(|a, b| out_key(text, a).cmp(&out_key(text, b)));
            let mut merged: Vec<KeyEntry> = Vec::with_capacity(out.keys.len());
            for e in out.keys.drain(..) {
                match merged.last_mut() {
                    Some(last) if out_key(text, last) == out_key(text, &e) => last.rows += e.rows,
                    _ => merged.push(e),
                }
            }
            out.keys = merged;
        }
        // A refresh mostly writes the keys it had: walk the previous list
        // alongside for their name hashes.
        let mut cursor = 0usize;
        for (i, e) in out.keys.iter_mut().enumerate() {
            let (epg, title) = out_key(&out.text, e);
            if let Some(id) = epg.map(str::trim).filter(|s| !s.is_empty()) {
                out.by_id.push((key_hash(&id.to_lowercase()), i as u32));
            }
            e.name = match previous.and_then(|p| Some((p, p.find(&mut cursor, (epg, title))?))) {
                Some((p, at)) => p.keys[at].name,
                None => {
                    let name = resolve::normalize_name(title);
                    (!name.is_empty()).then(|| key_hash(&name))
                }
            };
            if let Some(h) = e.name {
                out.by_name.push((h, i as u32));
            }
        }
        out.by_id.sort_unstable();
        out.by_name.sort_unstable();
        out.text.shrink_to_fit();
        Ok(out)
    }

    fn key(&self, e: &KeyEntry) -> ResolvedKey<'_> {
        out_key(&self.text, e)
    }

    /// Index of `key`; `cursor` follows a scan in key order, as
    /// [`ResolvedList::find`] does.
    fn find(&self, cursor: &mut usize, key: ResolvedKey<'_>) -> Option<usize> {
        let keys = &self.keys;
        while *cursor < keys.len() && self.key(&keys[*cursor]) < key {
            *cursor += 1;
        }
        if keys.get(*cursor).is_some_and(|e| self.key(e) == key) {
            return Some(*cursor);
        }
        keys.binary_search_by(|e| self.key(e).cmp(&key)).ok()
    }

    /// The keys that resolve to each of `guides` without a manual mapping,
    /// as [`FreshResolver::resolve`] would: (key index, index in `guides`).
    /// `programmes` answers [`resolve::has_programmes`] for ids that are
    /// not among `guides` (each of those has programmes: it has hits).
    fn resolving_to(
        &self,
        dir: &ChannelDirectory,
        guides: &[Arc<str>],
        programmes: &mut dyn FnMut(&str) -> CoreResult<bool>,
    ) -> CoreResult<Vec<(u32, usize)>> {
        let in_guides: HashSet<&str> = guides.iter().map(|g| &**g).collect();
        let trimmed_id = |k: u32| {
            self.key(&self.keys[k as usize])
                .0
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let mut out = Vec::new();
        for (gi, g) in guides.iter().enumerate() {
            // An id the directory knows (case-insensitively) as `g`.
            for lower in dir.ids_of(g) {
                for k in with_hash(&self.by_id, key_hash(lower)) {
                    if trimmed_id(k).is_some_and(|id| id.to_lowercase() == *lower) {
                        out.push((k, gi));
                    }
                }
            }
            // `g` itself when the directory does not know it: it has
            // programmes.
            if dir.find_id(g).is_none() {
                for k in with_hash(&self.by_id, key_hash(&g.to_lowercase())) {
                    if trimmed_id(k) == Some(&**g) {
                        out.push((k, gi));
                    }
                }
            }
            // The exact normalized name, for keys whose id resolves to
            // nothing.
            for name in dir.names_of(g) {
                for k in with_hash(&self.by_name, key_hash(name)) {
                    let title = self.key(&self.keys[k as usize]).1;
                    if resolve::normalize_name(title) != *name {
                        continue;
                    }
                    if let Some(id) = trimmed_id(k) {
                        if dir.find_id(id).is_some() || in_guides.contains(id) || programmes(id)? {
                            continue;
                        }
                    }
                    out.push((k, gi));
                }
            }
        }
        Ok(out)
    }
}

fn out_key<'a>(text: &'a str, e: &KeyEntry) -> ResolvedKey<'a> {
    (
        e.epg.map(|(s, t)| &text[s as usize..t as usize]),
        &text[e.title.0 as usize..e.title.1 as usize],
    )
}

/// Catalog keys by source and type, and [`resolve::has_programmes`]
/// answers for the current guide generation. Kept on the EPG runtime; the
/// lock is held only to look up or store, never while reading the database.
#[derive(Default)]
pub(crate) struct KeysMemo {
    catalogs: HashMap<(String, ContentType), Arc<CatalogKeys>>,
    generation: u64,
    programmes: HashMap<Box<str>, bool>,
}

/// The catalog keys of one source and type as of `stamp`: the memo's, or
/// read now (inside the caller's read transaction, so the keys and the
/// stamp describe the same rows).
fn catalog_keys(
    conn: &Connection,
    rt: &EpgRuntime,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<Arc<CatalogKeys>> {
    let stamp = catalog_stamp(conn, source_id, content_type)?;
    let id = (source_id.to_string(), content_type);
    if let Some(k) = rt.search_keys.lock().catalogs.get(&id) {
        if k.stamp == stamp {
            return Ok(k.clone());
        }
    }
    let previous = rt.search_keys.lock().catalogs.get(&id).cloned();
    let keys = Arc::new(CatalogKeys::load(
        conn,
        source_id,
        content_type,
        stamp,
        previous.as_deref(),
    )?);
    drop(previous);
    let mut memo = rt.search_keys.lock();
    let held: usize = memo
        .catalogs
        .iter()
        .filter(|(k, _)| **k != id)
        .map(|(_, c)| c.keys.len())
        .sum();
    if held + keys.keys.len() > KEYS_CAP {
        memo.catalogs.clear();
    }
    memo.catalogs.insert(id, keys.clone());
    Ok(keys)
}

/// [`resolve::has_programmes`], remembered for the guide generation.
fn has_programmes_memo(
    conn: &Connection,
    rt: &EpgRuntime,
    generation: u64,
    id: &str,
) -> CoreResult<bool> {
    {
        let mut memo = rt.search_keys.lock();
        if memo.generation != generation {
            memo.generation = generation;
            memo.programmes.clear();
        }
        if let Some(&found) = memo.programmes.get(id) {
            return Ok(found);
        }
    }
    let found = resolve::has_programmes(conn, id)?;
    let mut memo = rt.search_keys.lock();
    if memo.generation == generation && memo.programmes.len() < MEMO_CAP {
        memo.programmes.insert(id.into(), found);
    }
    Ok(found)
}

/// The channels of every key in `keys` (a JSON array of `[epg_channel_id,
/// title]`), by their position in it: index seeks on `idx_items_guide`.
/// The visibility clauses follow; `CROSS JOIN` keeps the list outside.
pub const SEEK_SQL: &str = "SELECT k.key, i.rowid, i.number FROM json_each(?3) k CROSS JOIN items i
     WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.content_type IN ('live', 'radio')
       AND i.epg_channel_id IS (k.value ->> 0) AND i.title = (k.value ->> 1)";

/// The rows of `?3` (a JSON array of rowids), by their position in it, for
/// the channels mapped by hand; the visibility clauses follow.
pub const MAPPED_SQL: &str = "SELECT k.key, i.rowid, i.number FROM json_each(?3) k CROSS JOIN items i
     WHERE i.rowid = k.value AND i.source_id = ?1 AND i.content_type = ?2 AND i.content_type IN ('live', 'radio')";

/// Finds the source's visible channels of guide channels, a few guide
/// channels at a time (those of each batch of hits), by the guide channel
/// each resolves to, as [`source_channels`] would but without resolving
/// every channel of the source: the catalog keys ([`CatalogKeys`]) give the
/// keys of those guide channels, and only their rows are read (index
/// seeks), until the rows read that way would come to a large share of
/// the source; then the source's visible channels are walked once and
/// kept by key for the rest of the search. Manual mappings win as there.
struct ChannelFinder<'a> {
    source_id: &'a str,
    types: Vec<TypeChannels>,
}

/// [`ChannelFinder`]'s state for one channel type.
struct TypeChannels {
    content_type: ContentType,
    /// Manual mappings by item rowid (`None`: no guide).
    manual: HashMap<i64, Option<String>>,
    keys: Arc<CatalogKeys>,
    /// [`visible_clauses`] for this type.
    visible: String,
    /// Rows asked for by key so far.
    sought: usize,
    walked: Option<Walked>,
}

/// The visible channels of one type, read in one walk.
struct Walked {
    /// (key index, rowid, number), sorted by key index.
    by_key: Vec<(u32, i64, Option<i64>)>,
    /// Channels mapped by hand, and any whose key the list lacks, by the
    /// guide channel they resolve to.
    other: HashMap<Box<str>, Vec<(i64, Option<i64>)>>,
}

impl<'a> ChannelFinder<'a> {
    fn new(
        conn: &Connection,
        rt: &EpgRuntime,
        source_id: &'a str,
        hide: Option<Hide>,
        quality: Option<QualityFilter>,
    ) -> CoreResult<Self> {
        let mut types = Vec::new();
        for content_type in [ContentType::Live, ContentType::Radio] {
            let keys = catalog_keys(conn, rt, source_id, content_type)?;
            if keys.keys.is_empty() {
                continue;
            }
            let manual = conn
                .prepare_cached(MANUAL_SQL)?
                .query_map(params![source_id, content_type.as_str()], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect::<Result<_, _>>()?;
            types.push(TypeChannels {
                content_type,
                manual,
                keys,
                visible: visible_clauses(conn, source_id, content_type, hide, quality)?,
                sought: 0,
                walked: None,
            });
        }
        Ok(Self { source_id, types })
    }

    /// The channels of each of `guides` (guide channels with hits; see
    /// [`CatalogKeys::resolving_to`]), in that order.
    fn find(
        &mut self,
        conn: &Connection,
        rt: &EpgRuntime,
        dir: &ChannelDirectory,
        guides: &[Arc<str>],
    ) -> CoreResult<Vec<Vec<ChannelKey>>> {
        let index: HashMap<&str, usize> =
            guides.iter().enumerate().map(|(i, g)| (&**g, i)).collect();
        let mut found: Vec<Vec<ChannelKey>> = vec![Vec::new(); guides.len()];
        let mut programmes = |id: &str| has_programmes_memo(conn, rt, dir.generation(), id);
        let source_id = self.source_id;
        for tc in &mut self.types {
            let content_type = tc.content_type;
            let keys = tc.keys.clone();
            let pairs = keys.resolving_to(dir, guides, &mut programmes)?;
            let mut push = |guide: usize, rowid: i64, number: Option<i64>| {
                found[guide].push(ChannelKey {
                    rowid,
                    content_type,
                    number,
                });
            };
            let wanted: usize = pairs
                .iter()
                .map(|&(k, _)| keys.keys[k as usize].rows as usize)
                .sum();
            tc.sought += wanted;
            let walk = tc.sought.saturating_mul(SEEK_COST) > keys.rows;
            #[cfg(test)]
            let walk = tests::FORCE_SEEK
                .with(|f| f.get())
                .map_or(walk, |seek| !seek);
            if walk && tc.walked.is_none() {
                tc.walked = Some(walk_channels(conn, dir, source_id, tc)?);
            }
            if let Some(w) = &tc.walked {
                for &(k, gi) in &pairs {
                    let start = w.by_key.partition_point(|e| e.0 < k);
                    for &(_, rowid, number) in w.by_key[start..].iter().take_while(|e| e.0 == k) {
                        push(gi, rowid, number);
                    }
                }
                for (gi, g) in guides.iter().enumerate() {
                    for &(rowid, number) in w.other.get(&**g).into_iter().flatten() {
                        push(gi, rowid, number);
                    }
                }
                continue;
            }
            let visible = &tc.visible;
            if !pairs.is_empty() {
                let list: Vec<ResolvedKey<'_>> = pairs
                    .iter()
                    .map(|&(k, _)| keys.key(&keys.keys[k as usize]))
                    .collect();
                let list = serde_json::to_string(&list)?;
                let mut stmt = conn.prepare_cached(&format!("{SEEK_SQL}{visible}"))?;
                let mut rows = stmt.query(params![source_id, content_type.as_str(), list])?;
                while let Some(r) = rows.next()? {
                    let at = r.get::<_, i64>(0)? as usize;
                    let rowid: i64 = r.get(1)?;
                    if !tc.manual.contains_key(&rowid) {
                        push(pairs[at].1, rowid, r.get(2)?);
                    }
                }
            }
            let mapped: Vec<(i64, usize)> = tc
                .manual
                .iter()
                .filter_map(|(rowid, m)| {
                    let g = m.as_deref().map(str::trim)?;
                    index.get(g).map(|&gi| (*rowid, gi))
                })
                .collect();
            if !mapped.is_empty() {
                let list =
                    serde_json::to_string(&mapped.iter().map(|m| m.0).collect::<Vec<i64>>())?;
                let mut stmt = conn.prepare_cached(&format!("{MAPPED_SQL}{visible}"))?;
                let mut rows = stmt.query(params![source_id, content_type.as_str(), list])?;
                while let Some(r) = rows.next()? {
                    let at = r.get::<_, i64>(0)? as usize;
                    push(mapped[at].1, r.get(1)?, r.get(2)?);
                }
            }
        }
        Ok(found)
    }
}

/// One walk of the visible channels of `tc`'s type, kept by key.
fn walk_channels(
    conn: &Connection,
    dir: &ChannelDirectory,
    source_id: &str,
    tc: &TypeChannels,
) -> CoreResult<Walked> {
    let mut out = Walked {
        by_key: Vec::new(),
        other: HashMap::new(),
    };
    let mut stmt = conn.prepare_cached(&format!("{CHANNELS_SQL}{}", tc.visible))?;
    let mut rows = stmt.query(params![source_id, tc.content_type.as_str()])?;
    let mut cursor = 0usize;
    let mut fresh = FreshResolver::default();
    while let Some(r) = rows.next()? {
        let rowid: i64 = r.get(0)?;
        let number: Option<i64> = r.get(3)?;
        let guide: Option<Box<str>> = match tc.manual.get(&rowid) {
            Some(m) => m
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(Into::into),
            None => {
                let key = (text(r, 2)?, text(r, 1)?.unwrap_or_default());
                match tc.keys.find(&mut cursor, key) {
                    Some(k) => {
                        out.by_key.push((k as u32, rowid, number));
                        continue;
                    }
                    // Not under the stamp just read: cannot happen inside
                    // one read transaction, but resolve it.
                    None => fresh
                        .resolve(conn, dir, key.0, key.1)?
                        .map(|g| Box::from(&*g)),
                }
            }
        };
        if let Some(g) = guide {
            out.other.entry(g).or_default().push((rowid, number));
        }
    }
    out.by_key.sort_unstable_by_key(|e| e.0);
    Ok(out)
}

/// The source's visible channels on `guides` in one [`ChannelFinder::find`].
/// Guide channels without a visible channel are left out.
#[cfg(test)]
fn channels_on(
    conn: &Connection,
    rt: &EpgRuntime,
    dir: &ChannelDirectory,
    source_id: &str,
    hide: Option<Hide>,
    quality: Option<QualityFilter>,
    guides: &[Arc<str>],
) -> CoreResult<SourceChannels> {
    let mut finder = ChannelFinder::new(conn, rt, source_id, hide, quality)?;
    let found = finder.find(conn, rt, dir, guides)?;
    let mut out = SourceChannels::default();
    for (g, channels) in guides.iter().zip(found) {
        if !channels.is_empty() {
            out.by_guide.insert(g.clone(), out.guides.len());
            out.guides.push((g.clone(), channels));
        }
    }
    Ok(out)
}

/// The enabled, non-staging feeds (`epg_sources.rowid`).
fn search_feeds(conn: &Connection) -> CoreResult<HashSet<i64>> {
    let feeds = conn
        .prepare_cached("SELECT rowid FROM epg_sources WHERE enabled = 1 AND origin <> ?1")?
        .query_map([STAGING_ORIGIN], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(feeds)
}

/// A matching programme on a guide channel the source has.
#[derive(Debug, Clone, Copy)]
struct Hit {
    rowid: i64,
    start: i64,
    stop: i64,
    /// `epg_sources.rowid`: the first configured feed wins a duplicate slot.
    feed: i64,
    /// Index into [`SourceChannels::guides`].
    guide: usize,
}

/// A programme on one channel, before details are read.
#[derive(Debug, Clone)]
struct Candidate {
    rowid: i64,
    channel_id: Arc<str>,
    start: i64,
    stop: i64,
    /// The channel's guide shift in seconds (`query::item_shift`).
    shift: i64,
    channel: Arc<SourceChannel>,
}

/// The index statement: the title index's hits among the search rows
/// `?2 <= id < ?3` that end after `?4`, in id order, which is (start, feed)
/// order (migration 0028), at most `?5` of them; each with its search row
/// (`epg_search_rows`, alias `p`: programme rowid, start, stop, feed and
/// guide channel, a narrow row instead of the programme's). [`candidates`]
/// reads them in batches and stops once its result is settled.
pub const FTS_SQL: &str = fts_sql!("epg_programs_fts", "epg_search_rows");
/// [`FTS_SQL`] over the second set of tables ([`IndexSet::B`]).
pub const FTS_SQL_B: &str = fts_sql!("epg_programs_fts_b", "epg_search_rows_b");

/// Hits the first batch of the index statement reads; each later batch
/// reads twice as many as the one before.
const FIRST_BATCH: i64 = 512;

/// The fallback statement: every programme overlapping the window (on the
/// `stop` index); titles are matched in Rust with the same folding.
pub const SCAN_SQL: &str = "SELECT p.rowid, p.channel_id, p.start, p.stop, p.title, s.rowid
     FROM epg_programs p JOIN epg_sources s ON s.url = p.epg_url
     WHERE p.stop > ?1 AND p.start < ?2 AND s.enabled = 1 AND s.origin <> ?3";

fn hit_order(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.start
        .cmp(&b.start)
        .then_with(|| {
            a.channel
                .number
                .unwrap_or(i64::MAX)
                .cmp(&b.channel.number.unwrap_or(i64::MAX))
        })
        .then_with(|| a.channel.sort_name.cmp(&b.channel.sort_name))
        .then_with(|| a.channel.item_ref.cmp(&b.channel.item_ref))
}

/// The id after the last search row, and the first search row whose start
/// is at or after `t` (`last + 1` when none): ids follow start order
/// (migration 0028), so a binary search over them finds it.
fn search_rows_from(conn: &Connection, set: IndexSet, last: i64, t: i64) -> CoreResult<i64> {
    let mut probe = conn.prepare_cached(&format!(
        "SELECT start FROM {} WHERE id >= ?1 ORDER BY id LIMIT 1",
        set.rows()
    ))?;
    let (mut lo, mut hi) = (1i64, last + 1);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let start: Option<i64> = probe.query_row([mid], |r| r.get(0)).optional()?;
        if start.is_none_or(|s| s >= t) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok(lo)
}

/// Where a hit's guide channel stands while a batch is read.
#[derive(Clone, Copy)]
enum Slot {
    /// Index into [`SourceChannels::guides`].
    Known(usize),
    /// New in this batch: index into its new guide channels.
    New(usize),
}

/// Reads the index's hits in (start, feed) order, a batch at a time, and
/// the source's channels of each guide channel as it first shows up.
struct IndexReader<'a> {
    /// The current set of index tables.
    set: IndexSet,
    fts: String,
    /// The next search row id to read, and the first one past the window.
    next: i64,
    end: i64,
    /// Hits must end after this.
    from: i64,
    batch: i64,
    feeds: Option<HashSet<i64>>,
    /// Guide channel -> its index in [`SourceChannels::guides`], or `None`
    /// when the source has no visible channel on it.
    slots: HashMap<Box<str>, Option<usize>>,
    source_id: &'a str,
    hide: Option<Hide>,
    quality: Option<QualityFilter>,
    finder: Option<ChannelFinder<'a>>,
}

impl IndexReader<'_> {
    fn exhausted(&self) -> bool {
        self.next >= self.end
    }

    /// Reads the next batch: its hits on guide channels with a visible
    /// channel go to the end of `hits`, and those channels to `channels`.
    fn more(
        &mut self,
        conn: &Connection,
        rt: &EpgRuntime,
        dir: &ChannelDirectory,
        hits: &mut Vec<Hit>,
        channels: &mut SourceChannels,
    ) -> CoreResult<()> {
        if self.exhausted() {
            return Ok(());
        }
        let mut raw: Vec<(i64, i64, i64, i64, Slot)> = Vec::new();
        let mut fresh: Vec<Arc<str>> = Vec::new();
        let mut fresh_at: HashMap<Box<str>, usize> = HashMap::new();
        let mut read = 0i64;
        let mut last_id = self.next;
        {
            let mut stmt = conn.prepare_cached(self.set.fts_sql())?;
            let mut rows = stmt.query(params![
                self.fts, self.next, self.end, self.from, self.batch
            ])?;
            while let Some(r) = rows.next()? {
                read += 1;
                last_id = r.get(0)?;
                let feed: i64 = r.get(5)?;
                let feeds = match &self.feeds {
                    Some(f) => f,
                    None => self.feeds.insert(search_feeds(conn)?),
                };
                if !feeds.contains(&feed) {
                    continue;
                }
                let id = text(r, 2)?.unwrap_or_default();
                let slot = match self.slots.get(id) {
                    Some(Some(i)) => Slot::Known(*i),
                    Some(None) => continue,
                    None => match fresh_at.get(id) {
                        Some(&j) => Slot::New(j),
                        None => {
                            fresh_at.insert(id.into(), fresh.len());
                            fresh.push(id.into());
                            Slot::New(fresh.len() - 1)
                        }
                    },
                };
                raw.push((r.get(1)?, r.get(3)?, r.get(4)?, feed, slot));
            }
        }
        self.next = if read < self.batch {
            self.end
        } else {
            last_id + 1
        };
        self.batch = self.batch.saturating_mul(2);
        let mut placed: Vec<Option<usize>> = vec![None; fresh.len()];
        if !fresh.is_empty() {
            let finder = match &mut self.finder {
                Some(f) => f,
                None => self.finder.insert(ChannelFinder::new(
                    conn,
                    rt,
                    self.source_id,
                    self.hide,
                    self.quality,
                )?),
            };
            let found = finder.find(conn, rt, dir, &fresh)?;
            for ((g, list), at) in fresh.iter().zip(found).zip(placed.iter_mut()) {
                if !list.is_empty() {
                    channels.by_guide.insert(g.clone(), channels.guides.len());
                    channels.guides.push((g.clone(), list));
                    *at = Some(channels.guides.len() - 1);
                }
                self.slots.insert((&**g).into(), *at);
            }
        }
        for (rowid, start, stop, feed, slot) in raw {
            let guide = match slot {
                Slot::Known(i) => Some(i),
                Slot::New(j) => placed[j],
            };
            if let Some(guide) = guide {
                hits.push(Hit {
                    rowid,
                    start,
                    stop,
                    feed,
                    guide,
                });
            }
        }
        Ok(())
    }
}

fn first_batch() -> i64 {
    #[cfg(test)]
    if let Some(b) = tests::FIRST_BATCH_OVERRIDE.with(|f| f.get()) {
        return b;
    }
    FIRST_BATCH
}

/// The longest programme of the search rows, in seconds; unknown reads as
/// longer than any guide.
fn longest_programme(conn: &Connection) -> CoreResult<i64> {
    let value: Option<String> = conn
        .prepare_cached("SELECT value FROM app_state WHERE key = ?1")?
        .query_row([LONGEST_KEY], |r| r.get(0))
        .optional()?;
    Ok(value.and_then(|v| v.parse().ok()).unwrap_or(i64::MAX / 4))
}

/// The first `limit` candidates in (start, channel number, name, ref)
/// order. Returns whether the index was used.
///
/// With the index, the matching programmes are read in (start, feed) order
/// from the longest programme's length before the window, in batches, and
/// the channels of each guide channel are read as it first shows up: a
/// query without hits never reads the channels, and the reading stops once
/// the result is settled. Otherwise the scan reads the channels first so
/// it folds only the titles of guide channels the source has. Either way
/// the hits are walked in (start, feed) order up to the start time at which
/// the limit is reached (every channel of a guide channel counts), and only
/// the channels that can make the result are read beyond that.
///
/// The window is read on the guide's clock: moved back by `source_secs`,
/// the source's guide shift, which moves every channel of the source alike
/// (so the start order holds too). A channel's own shift or `tvg-shift`
/// differs per channel: it is read with the channel, for the pairs in
/// (start, number) order, and a pair it moves out of the window is skipped.
/// When that leaves fewer than `limit`, the walk goes on to later starts.
fn candidates(
    conn: &Connection,
    rt: &EpgRuntime,
    dir: &ChannelDirectory,
    q: &Query,
    hide: Option<Hide>,
    quality: Option<QualityFilter>,
    source_secs: i64,
) -> CoreResult<(Vec<Candidate>, bool)> {
    let want = q.limit;
    if q.words.is_empty() {
        return Ok((Vec::new(), false));
    }
    let (from, to) = (q.from - source_secs, q.to - source_secs);
    let set = current_set(conn)?;
    let used_index = set.is_some();
    let mut hits: Vec<Hit> = Vec::new();
    let mut reader: Option<IndexReader<'_>> = None;
    let mut channels = if let Some(set) = set {
        let last: i64 = conn
            .prepare_cached(&format!("SELECT coalesce(max(id), 0) FROM {}", set.rows()))?
            .query_row([], |r| r.get(0))?;
        let longest = longest_programme(conn)?;
        let mut r = IndexReader {
            set,
            fts: fts_expression(&q.words),
            next: search_rows_from(conn, set, last, from.saturating_sub(longest))?,
            end: search_rows_from(conn, set, last, to)?,
            from,
            batch: first_batch(),
            feeds: None,
            slots: HashMap::new(),
            source_id: &q.source_id,
            hide,
            quality,
            finder: None,
        };
        let mut channels = SourceChannels::default();
        r.more(conn, rt, dir, &mut hits, &mut channels)?;
        if hits.is_empty() && r.exhausted() {
            return Ok((Vec::new(), true));
        }
        reader = Some(r);
        channels
    } else {
        let channels = source_channels(conn, rt, dir, &q.source_id, hide, quality)?;
        if channels.guides.is_empty() {
            return Ok((Vec::new(), false));
        }
        let mut stmt = conn.prepare_cached(SCAN_SQL)?;
        let mut rows = stmt.query(params![from, to, STAGING_ORIGIN])?;
        while let Some(r) = rows.next()? {
            let Some(&guide) = channels.by_guide.get(text(r, 1)?.unwrap_or_default()) else {
                continue;
            };
            if !title_matches(text(r, 4)?.unwrap_or_default(), &q.words) {
                continue;
            }
            hits.push(Hit {
                rowid: r.get(0)?,
                start: r.get(2)?,
                stop: r.get(3)?,
                feed: r.get(5)?,
                guide,
            });
        }
        hits.sort_unstable_by_key(|h| (h.start, h.feed));
        channels
    };
    let prefix = |p: &(Hit, ChannelKey)| (p.0.start, p.1.number.unwrap_or(i64::MAX));
    let mut stmt = conn.prepare_cached(
        "SELECT item_id, title, logo_url, category_id FROM items WHERE rowid = ?1",
    )?;
    // Each channel read once, with its guide shift.
    let mut read: HashMap<i64, (Arc<SourceChannel>, i64)> = HashMap::new();
    let mut target = want;
    let mut out = loop {
        // Stop after the start time at which `target` is reached; a slot
        // listed by two feeds counts once.
        let mut end = hits.len();
        let mut kept = 0usize;
        let mut cut: Option<i64> = None;
        let mut slots: HashSet<(usize, i64)> = HashSet::new();
        for (i, h) in hits.iter().enumerate() {
            if cut.is_some_and(|c| h.start > c) {
                end = i;
                break;
            }
            if slots.insert((h.guide, h.start)) {
                kept += channels.guides[h.guide].1.len();
            }
            if kept >= target && cut.is_none() {
                cut = Some(h.start);
            }
        }
        // Not settled before the hits read so far run out: read on.
        if end == hits.len() {
            if let Some(r) = reader.as_mut().filter(|r| !r.exhausted()) {
                r.more(conn, rt, dir, &mut hits, &mut channels)?;
                continue;
            }
        }
        // Each channel of each kept programme's guide channel, once per start
        // (the first feed's programme wins).
        let mut seen: HashSet<(i64, i64)> = HashSet::new();
        let mut pairs: Vec<(Hit, ChannelKey)> = Vec::new();
        for h in &hits[..end] {
            for ch in &channels.guides[h.guide].1 {
                if seen.insert((ch.rowid, h.start)) {
                    pairs.push((*h, *ch));
                }
            }
        }
        // By (start, number), the first `want` inside the window and every
        // pair tied with the last of them: only those can be among the first
        // `want` once names and refs break the ties.
        pairs.sort_unstable_by_key(prefix);
        let mut chosen: Vec<Candidate> = Vec::with_capacity(want);
        let mut last: Option<(i64, i64)> = None;
        for p in &pairs {
            let key = prefix(p);
            if chosen.len() >= want && last.is_some_and(|l| key > l) {
                break;
            }
            let (h, ch) = *p;
            let (channel, shift) = match read.get(&ch.rowid) {
                Some(c) => c.clone(),
                None => {
                    let found = stmt
                        .query_row([ch.rowid], |r| {
                            let item_id: String = r.get(0)?;
                            let name: String = r.get(1)?;
                            let logo_url: Option<String> = r.get(2)?;
                            Ok(SourceChannel {
                                item_ref: ItemRef::new(&q.source_id, ch.content_type, item_id),
                                sort_name: name.to_lowercase(),
                                name,
                                number: ch.number,
                                logo_url: logo_url.filter(|s| !s.trim().is_empty()),
                                category_id: r.get(3)?,
                            })
                        })
                        .optional()?;
                    let Some(c) = found else { continue };
                    let shift = query::item_shift_with(conn, &c.item_ref, source_secs)?;
                    let c = (Arc::new(c), shift);
                    read.insert(ch.rowid, c.clone());
                    c
                }
            };
            // The channel's own shift or `tvg-shift` can move it out.
            if h.stop + shift <= q.from || h.start + shift >= q.to {
                continue;
            }
            last = Some(key);
            chosen.push(Candidate {
                rowid: h.rowid,
                channel_id: channels.guides[h.guide].0.clone(),
                start: h.start,
                stop: h.stop,
                shift,
                channel,
            });
        }
        if chosen.len() >= want || end == hits.len() {
            break chosen;
        }
        // Every pair was looked at: walk on for as many more as are missing.
        target = kept + want - chosen.len();
    };
    out.sort_by(hit_order);
    out.truncate(want);
    Ok((out, used_index))
}

/// Reads titles, descriptions, categories and icons, applies custom channel
/// names (C2), and moves each hit by its channel's guide shift as the grid
/// does (L1-core-11): the source's shift plus the channel's own shift or
/// `tvg-shift`, read by [`candidates`].
fn finish(conn: &Connection, found: Vec<Candidate>) -> CoreResult<Vec<GuideSearchHit>> {
    let mut details = conn.prepare_cached(
        "SELECT title, description, category, icon FROM epg_programs WHERE rowid = ?1",
    )?;
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    let mut out = Vec::with_capacity(found.len());
    for c in found {
        type Details = (String, Option<String>, Option<String>, Option<String>);
        let Some((title, description, category, icon)): Option<Details> = details
            .query_row([c.rowid], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?
        else {
            continue;
        };
        let key = c.channel.item_ref.key();
        let (start, stop) = (c.start + c.shift, c.stop + c.shift);
        let custom = match names.get(&key) {
            Some(n) => n.clone(),
            None => {
                let n = crate::channeledit::custom_name(conn, &c.channel.item_ref)?;
                names.insert(key, n.clone());
                n
            }
        };
        out.push((
            start,
            GuideSearchHit {
                item_ref: c.channel.item_ref.clone(),
                channel_name: custom.unwrap_or_else(|| c.channel.name.clone()),
                channel_number: c.channel.number,
                logo_url: c.channel.logo_url.clone(),
                category_id: Some(c.channel.category_id.clone()).filter(|s| !s.is_empty()),
                program: EpgProgram {
                    channel_id: c.channel_id.to_string(),
                    start: query::to_rfc3339(start),
                    end: query::to_rfc3339(stop),
                    title,
                    description: description.filter(|s| !s.trim().is_empty()),
                    category: category.filter(|s| !s.trim().is_empty()),
                    icon: icon.filter(|s| !s.trim().is_empty()),
                },
            },
        ));
    }
    // A shift can move a hit past others: keep start order (stable, so the
    // channel-number order of equal starts stays).
    out.sort_by_key(|(start, _)| *start);
    Ok(out.into_iter().map(|(_, hit)| hit).collect())
}

fn ensure_source(conn: &Connection, source_id: &str) -> CoreResult<()> {
    let exists = conn
        .query_row("SELECT 1 FROM sources WHERE id = ?1", [source_id], |_| {
            Ok(())
        })
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(CoreError::NotFound(format!("source {source_id} not found")))
    }
}

/// `epg.search`: programmes whose title matches `query`, overlapping the
/// window, on the source's visible channels; ordered by start, then
/// channel number.
pub async fn search(state: &AppState, req: SearchRequest) -> CoreResult<Vec<GuideSearchHit>> {
    let q = validate(req, chrono::Utc::now().timestamp())?;
    // Hide mode drops locked and adult channels in the channel query itself,
    // and the Live TV quality filter the live channels it hides.
    let hide = crate::parental::hide_filter(state).await?;
    let quality = crate::catalog::rpc::quality_filter(state);
    let rt = runtime(state);
    let started = std::time::Instant::now();
    let (hits, used_index) = state
        .db_call(move |c| {
            ensure_source(c, &q.source_id)?;
            let dir = resolve::directory(c, &rt)?;
            // One read snapshot: a guide refresh that commits between the
            // statements cannot hand a hit's rowid to another programme.
            let tx = c.transaction()?;
            let source_secs = query::source_shift(&tx, &q.source_id)?;
            let (found, used_index) = candidates(&tx, &rt, &dir, &q, hide, quality, source_secs)?;
            let hits = finish(&tx, found)?;
            tx.commit()?;
            Ok((hits, used_index))
        })
        .await?;
    tracing::debug!(
        hits = hits.len(),
        index = used_index,
        ms = started.elapsed().as_millis() as u64,
        "guide search"
    );
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        /// Overrides the choice between reading by key and walking the
        /// source in [`channels_on`].
        pub(super) static FORCE_SEEK: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
        /// Overrides [`FIRST_BATCH`].
        pub(super) static FIRST_BATCH_OVERRIDE: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
        /// Rows per write transaction of an index build.
        pub(super) static CHUNK_OVERRIDE: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
        /// Runs after each committed transaction of an index build on this
        /// thread, with its number; an error ends the build there.
        static AFTER_CHUNK: std::cell::RefCell<Option<ChunkHook>> =
            const { std::cell::RefCell::new(None) };
    }

    type ChunkHook = Box<dyn FnMut(usize) -> CoreResult<()>>;

    pub(super) fn after_chunk(n: usize) -> CoreResult<()> {
        AFTER_CHUNK.with(|h| match h.borrow_mut().as_mut() {
            Some(f) => f(n),
            None => Ok(()),
        })
    }

    fn w(s: &str) -> Vec<String> {
        words(s)
    }

    #[test]
    fn folds_case_and_diacritics() {
        assert_eq!(fold("Café Über"), "cafe uber");
        // Greek tonos and final sigma, Vietnamese (Latin Extended Additional).
        assert_eq!(fold("Ελληνικά ΕΙΔΗΣΕΙΣ"), "ελληνικα ειδησεισ");
        assert_eq!(fold("Thời sự"), "thoi su");
        assert_eq!(w("Ας"), w("ασ"));
        assert_eq!(
            w("  Le Journal-de 20h! "),
            vec!["le", "journal", "de", "20h"]
        );
    }

    #[test]
    fn every_query_word_must_start_a_title_word() {
        assert!(title_matches("Le Café des Sports", &w("cafe")));
        assert!(title_matches("Le Café des Sports", &w("SPO caf")));
        assert!(!title_matches("Le Café des Sports", &w("afe")));
        assert!(!title_matches("Le Café des Sports", &w("cafe news")));
        assert!(!title_matches("anything", &[]));
    }

    #[test]
    fn fts_expression_uses_prefix_terms() {
        assert_eq!(fts_expression(&w("Café news")), "\"cafe\"* \"news\"*");
        assert_eq!(fts_expression(&w("Ελλ")), "\"ελλ\"*");
    }

    #[test]
    fn validates_arguments() {
        let base = SearchRequest {
            source_id: "s".into(),
            query: "news".into(),
            ..Default::default()
        };
        let now = 1_800_000_000;
        let q = validate(base.clone(), now).unwrap();
        assert_eq!((q.from, q.to, q.limit), (now, now + DEFAULT_SPAN_SECS, 50));
        for bad in [
            SearchRequest {
                query: " a ".into(),
                ..base.clone()
            },
            SearchRequest {
                query: "x".repeat(101),
                ..base.clone()
            },
            SearchRequest {
                limit: Some(0),
                ..base.clone()
            },
            SearchRequest {
                limit: Some(201),
                ..base.clone()
            },
            SearchRequest {
                from: Some(query::to_rfc3339(now)),
                to: Some(query::to_rfc3339(now)),
                ..base.clone()
            },
            SearchRequest {
                from: Some(query::to_rfc3339(now)),
                to: Some(query::to_rfc3339(now + MAX_SPAN_SECS + 1)),
                ..base.clone()
            },
            SearchRequest {
                from: Some("soon".into()),
                ..base.clone()
            },
        ] {
            assert!(
                matches!(validate(bad.clone(), now), Err(CoreError::Invalid(_))),
                "{bad:?}"
            );
        }
        let ok = SearchRequest {
            from: Some(query::to_rfc3339(now)),
            to: Some(query::to_rfc3339(now + MAX_SPAN_SECS)),
            limit: Some(200),
            ..base
        };
        assert!(validate(ok, now).is_ok());
    }

    fn resolved(epg: Option<&str>, title: &str, guide: Option<&str>) -> Resolved {
        Resolved {
            epg: epg.map(Into::into),
            title: title.into(),
            guide: guide.map(Into::into),
        }
    }

    /// The list is found in scan order with a moving cursor, out of order by
    /// binary search, and a merge keeps it sorted and distinct, NULL ids
    /// first as SQLite orders them.
    #[test]
    fn resolved_list_follows_the_scan_and_merges_sorted() {
        let mut list = ResolvedList::default();
        list.merge(vec![
            resolved(None, "Zed", None),
            resolved(Some("a.uk"), "A", Some("a.uk")),
            resolved(Some("b.uk"), "B", None),
        ]);
        list.merge(vec![
            resolved(None, "Alpha", Some("alpha")),
            resolved(Some("a.uk"), "A", Some("a.uk")),
            resolved(Some("c.uk"), "C", Some("c.uk")),
        ]);
        let keys: Vec<_> = list.entries.iter().map(|e| e.key()).collect();
        assert_eq!(
            keys,
            [
                (None, "Alpha"),
                (None, "Zed"),
                (Some("a.uk"), "A"),
                (Some("b.uk"), "B"),
                (Some("c.uk"), "C"),
            ]
        );
        let guide = |cursor: &mut usize, key: ResolvedKey<'_>| {
            list.find(cursor, key)
                .map(|e| e.guide.as_deref().map(str::to_string))
        };
        let mut cursor = 0;
        assert_eq!(guide(&mut cursor, (None, "Zed")), Some(None));
        assert_eq!(cursor, 1);
        // The same key again: the cursor stays.
        assert_eq!(guide(&mut cursor, (None, "Zed")), Some(None));
        assert_eq!(cursor, 1);
        // A key the list lacks, between two entries.
        assert_eq!(guide(&mut cursor, (Some("a"), "A")), None);
        assert_eq!(
            guide(&mut cursor, (Some("c.uk"), "C")),
            Some(Some("c.uk".into()))
        );
        // Out of order: found behind the cursor.
        assert_eq!(
            guide(&mut cursor, (None, "Alpha")),
            Some(Some("alpha".into()))
        );
        assert_eq!(guide(&mut cursor, (Some("d.uk"), "D")), None);
    }

    /// A warm memo gives the same channels as resolving every row afresh,
    /// also after the catalog changes under it (renamed, re-keyed, added and
    /// removed channels).
    #[test]
    fn memoized_source_channels_match_fresh_resolution() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}');
             INSERT INTO epg_sources(url, enabled, origin) VALUES ('u', 1, 'settings');
             INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES
               ('u', 'BBCOne.uk', 'BBC One'), ('u', 'itv.uk', 'ITV 1'), ('u', 'news.uk', 'News 24');
             INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES
               ('u', 'undeclared', 0, 60, 'x');",
        )
        .unwrap();
        let insert = |c: &Connection, id: &str, title: &str, epg: Option<&str>| {
            c.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id, number)
                 VALUES ('s', 'live', ?1, 'g', ?2, ?3, ?4)",
                params![id, title, epg, id.len() as i64],
            )
            .unwrap();
        };
        for (id, title, epg) in [
            ("1", "BBC One HD", Some("bbcone.uk")),
            ("2", "BBC One", None),
            ("3", "UK: ITV 1", Some("nope.uk")),
            ("4", "ITV 1", Some("nope.uk")),
            ("5", "Something", Some("undeclared")),
            ("6", "Something", Some("other")),
            ("7", "News 24", Some("")),
            ("8", "Zed", None),
            ("9", "News 24", Some(" itv.uk ")),
        ] {
            insert(&conn, id, title, epg);
        }
        let rt = EpgRuntime::default();
        let dir = resolve::directory(&conn, &rt).unwrap();
        type Shape = Vec<(String, Vec<i64>)>;
        let sorted = |by: HashMap<String, Vec<i64>>| -> Shape {
            let mut v: Shape = by
                .into_iter()
                .map(|(g, mut ids)| {
                    ids.sort_unstable();
                    (g, ids)
                })
                .collect();
            v.sort();
            v
        };
        let fresh = |conn: &Connection| -> Shape {
            let mut f = FreshResolver::default();
            let mut by: HashMap<String, Vec<i64>> = HashMap::new();
            let mut stmt = conn
                .prepare("SELECT rowid, epg_channel_id, title FROM items WHERE source_id = 's'")
                .unwrap();
            let rows: Vec<(i64, Option<String>, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            for (rowid, epg, title) in rows {
                if let Some(g) = f.resolve(conn, &dir, epg.as_deref(), &title).unwrap() {
                    by.entry(g.to_string()).or_default().push(rowid);
                }
            }
            sorted(by)
        };
        let scan = |conn: &Connection| -> Shape {
            let out = source_channels(conn, &rt, &dir, "s", None, None).unwrap();
            sorted(
                out.guides
                    .into_iter()
                    .map(|(g, keys)| (g.to_string(), keys.iter().map(|k| k.rowid).collect()))
                    .collect(),
            )
        };
        // The other way round, from guide channels to their channels,
        // reading them by key and walking the source; plus a guide channel
        // none of them is on.
        let by_guides = |conn: &Connection, want: &Shape, seek: bool| -> Shape {
            let mut guides: Vec<Arc<str>> = want.iter().map(|(g, _)| g.as_str().into()).collect();
            guides.push("nobody.uk".into());
            FORCE_SEEK.with(|f| f.set(Some(seek)));
            let out = channels_on(conn, &rt, &dir, "s", None, None, &guides).unwrap();
            FORCE_SEEK.with(|f| f.set(None));
            sorted(
                out.guides
                    .into_iter()
                    .map(|(g, keys)| (g.to_string(), keys.iter().map(|k| k.rowid).collect()))
                    .collect(),
            )
        };
        let before = fresh(&conn);
        assert_eq!(before.len(), 4, "{before:?}");
        assert_eq!(scan(&conn), before, "cold memo");
        assert_eq!(scan(&conn), before, "warm memo");
        for seek in [true, false, true] {
            assert_eq!(
                by_guides(&conn, &before, seek),
                before,
                "by guide, seek {seek}"
            );
        }
        conn.execute_batch(
            "UPDATE items SET title = 'ITV 1' WHERE item_id = '8';
             UPDATE items SET epg_channel_id = 'news.uk' WHERE item_id = '6';
             DELETE FROM items WHERE item_id = '2';",
        )
        .unwrap();
        insert(&conn, "10", "BBC One", Some("missing"));
        insert(&conn, "11", "Aardvark", None);
        let after = fresh(&conn);
        assert_ne!(after, before, "the changes move channels");
        assert_eq!(scan(&conn), after, "after catalog changes");
        assert_eq!(scan(&conn), after, "warm again");
        for seek in [true, false] {
            assert_eq!(
                by_guides(&conn, &after, seek),
                after,
                "by guide after changes, seek {seek}"
            );
        }
    }

    /// The index path reads its hits in start order a batch at a time and
    /// stops once the result is settled. Whatever the batch size, and
    /// whether channels are read by key or by walking the source, it picks
    /// what the scan picks: programmes on air at the window's start (one
    /// began a day earlier), a second feed repeating slots, a disabled feed,
    /// guide channels with two channels, none, or one mapped by hand, and
    /// channel shifts that move hits out of the window, so the walk goes on.
    #[test]
    fn batched_index_reads_match_the_scan() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}');
             INSERT INTO epg_sources(url, enabled, origin) VALUES
               ('u1', 1, 'settings'), ('u2', 1, 'settings'), ('u3', 0, 'settings');",
        )
        .unwrap();
        let base = 1_800_000_000i64;
        const TITLES: [&str; 5] = ["World News", "Late News Hour", "Cooking", "News", "Film"];
        let program = |c: &Connection, url: &str, g: i64, start: i64, stop: i64, title: &str| {
            c.execute(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![url, format!("g{g}.tv"), start, stop, title],
            )
            .unwrap();
        };
        for g in 0..10i64 {
            conn.execute(
                "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES ('u1', ?1, ?2)",
                params![format!("g{g}.tv"), format!("Guide {g}")],
            )
            .unwrap();
            let mut t = base - 3 * 3600 + g * 600;
            let mut n = 0usize;
            while t < base + 2 * 86_400 {
                let len = [1800, 3600, 5400, 2700][(n + g as usize) % 4];
                program(&conn, "u1", g, t, t + len, TITLES[(n * 3 + g as usize) % 5]);
                if g < 3 && n.is_multiple_of(2) {
                    program(&conn, "u2", g, t, t + len, "News Repeat");
                }
                if n.is_multiple_of(3) {
                    program(&conn, "u3", g, t, t + len, "News Disabled");
                }
                t += len;
                n += 1;
            }
        }
        program(&conn, "u2", 9, base - 86_400, base + 3600, "News Marathon");
        let item = |c: &Connection,
                    id: &str,
                    title: &str,
                    epg: Option<&str>,
                    number: Option<i64>| {
            c.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id, number)
                 VALUES ('s', 'live', ?1, 'g', ?2, ?3, ?4)",
                params![id, title, epg, number],
            )
            .unwrap();
        };
        for (id, title, epg, number) in [
            ("i0", "Zero", Some("g0.tv"), Some(1)),
            ("i1", "G1 HD", Some("g1.tv"), Some(2)),
            ("i1b", "Guide 1", None, Some(3)),
            ("i2", "Two", Some("G2.TV"), None),
            ("i3", "Three", Some("g3.tv"), Some(4)),
            ("i4", "Four", Some("g4.tv"), Some(5)),
            ("i5", "Five", Some("g5.tv"), Some(6)),
            ("i6", "Six", Some("g6.tv"), Some(7)),
            ("i7", "Seven", Some("g7.tv"), Some(8)),
            ("i9", "Nine", Some("g9.tv"), Some(9)),
        ] {
            item(&conn, id, title, epg, number);
        }
        for n in 0..100 {
            item(
                &conn,
                &format!("f{n}"),
                &format!("Filler {n}"),
                Some(&format!("nope{n}")),
                Some(100 + n),
            );
        }
        conn.execute_batch(
            "INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES ('s', 'live', 'i3', 'g4.tv');
             INSERT INTO epg_channel_shift(source_id, content_type, item_id, shift_minutes) VALUES
               ('s', 'live', 'i5', -120), ('s', 'live', 'i6', 90);",
        )
        .unwrap();
        let rt = EpgRuntime::default();
        let dir = resolve::directory(&conn, &rt).unwrap();
        let mut cases = Vec::new();
        for query in ["news", "late news", "cooking", "film", "zzz"] {
            for (from, to) in [
                (base, base + 86_400),
                (base + 5_000, base + 9_000),
                (base - 7_200, base + 30 * 3600),
            ] {
                for limit in [1, 2, 5, 13, 40, 200] {
                    cases.push(Query {
                        source_id: "s".into(),
                        words: words(query),
                        from,
                        to,
                        limit,
                    });
                }
            }
        }
        type Found = Vec<(i64, String, i64, i64)>;
        let run = |conn: &Connection, q: &Query, index: bool| -> Found {
            let (found, used) = candidates(conn, &rt, &dir, q, None, None, 0).unwrap();
            assert_eq!(used, index);
            found
                .iter()
                .map(|c| {
                    (
                        c.rowid,
                        c.channel.item_ref.item_id.clone(),
                        c.start,
                        c.shift,
                    )
                })
                .collect()
        };
        let scanned: Vec<Found> = cases.iter().map(|q| run(&conn, q, false)).collect();
        assert!(
            scanned.iter().any(|f| f.len() >= 40),
            "some cases fill the limit"
        );
        assert!(
            scanned
                .iter()
                .flatten()
                .any(|f| f.1 == "i9" && f.2 == base - 86_400),
            "the marathon on air at the start is found"
        );
        rebuild_index(&mut conn).unwrap();
        for batch in [1, 2, 3, 7, 512] {
            for seek in [true, false] {
                FIRST_BATCH_OVERRIDE.with(|f| f.set(Some(batch)));
                FORCE_SEEK.with(|f| f.set(Some(seek)));
                for (q, want) in cases.iter().zip(&scanned) {
                    assert_eq!(
                        &run(&conn, q, true),
                        want,
                        "batch {batch}, seek {seek}: {q:?}"
                    );
                }
            }
        }
        FIRST_BATCH_OVERRIDE.with(|f| f.set(None));
        FORCE_SEEK.with(|f| f.set(None));
    }

    // -----------------------------------------------------------------------
    // Index builds in short transactions (migration 0029)
    // -----------------------------------------------------------------------

    /// Sets the hook run after each transaction of a build on this thread.
    fn on_chunk(f: impl FnMut(usize) -> CoreResult<()> + 'static) {
        AFTER_CHUNK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
    }

    fn no_hook() {
        AFTER_CHUNK.with(|h| *h.borrow_mut() = None);
        CHUNK_OVERRIDE.with(|c| c.set(None));
    }

    /// A file database with two feeds of 20 guide channels over two days
    /// (about 3,000 programmes) and a source with a channel on each.
    fn build_fixture() -> (tempfile::TempDir, crate::db::DbPool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open_and_migrate(&dir.path().join("t.db")).unwrap();
        let conn = pool.get().unwrap();
        conn.execute_batch(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}');
             INSERT INTO epg_sources(url, enabled, origin) VALUES ('u1', 1, 'settings'), ('u2', 1, 'settings');",
        )
        .unwrap();
        const TITLES: [&str; 4] = ["World News", "Cooking", "Late News", "Film"];
        for g in 0..20i64 {
            let id = format!("g{g}.tv");
            conn.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id, number)
                 VALUES ('s', 'live', ?1, 'c', ?2, ?1, ?3)",
                params![id, format!("Channel {g}"), g + 1],
            )
            .unwrap();
            for (url, step) in [("u1", 1800i64), ("u2", 3600)] {
                if url == "u2" && g % 2 == 1 {
                    continue;
                }
                conn.execute(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, ?2, ?2)",
                    params![url, id],
                )
                .unwrap();
                let mut t = BASE - 86_400;
                let mut n = 0usize;
                while t < BASE + 86_400 {
                    conn.execute(
                        "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![url, id, t, t + step, TITLES[(n + g as usize) % 4]],
                    )
                    .unwrap();
                    t += step;
                    n += 1;
                }
            }
        }
        (dir, pool)
    }

    const BASE: i64 = 1_800_000_000;

    type Found = Vec<(i64, String, i64)>;

    /// Candidates for a few queries, on the index when one is current.
    fn found(conn: &Connection) -> Vec<Found> {
        let rt = EpgRuntime::default();
        let dir = resolve::directory(conn, &rt).unwrap();
        ["news", "cooking", "late news", "breaking"]
            .iter()
            .map(|query| {
                let q = Query {
                    source_id: "s".into(),
                    words: words(query),
                    from: BASE - 7_200,
                    to: BASE + 40_000,
                    limit: 30,
                };
                let (found, _) = candidates(conn, &rt, &dir, &q, None, None, 0).unwrap();
                found
                    .iter()
                    .map(|c| (c.rowid, c.channel.item_ref.item_id.clone(), c.start))
                    .collect()
            })
            .collect()
    }

    /// What the scan finds now (the marker removed in a transaction rolled
    /// back after).
    fn scanned(conn: &Connection) -> Vec<Found> {
        let tx = conn.unchecked_transaction().unwrap();
        tx.execute("DELETE FROM app_state WHERE key = ?1", [INDEX_MARKER])
            .unwrap();
        let out = found(&tx);
        tx.rollback().unwrap();
        out
    }

    /// A refresh's swap: a feed's programmes replaced in one transaction
    /// that marks the index stale, as `store::commit_staging` does.
    fn swap_feed(conn: &mut Connection, url: &str, title: &str) {
        let tx = conn.transaction().unwrap();
        tx.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [url])
            .unwrap();
        for g in 0..20i64 {
            tx.execute(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![url, format!("g{g}.tv"), BASE + g * 60, BASE + 3600, title],
            )
            .unwrap();
        }
        invalidate_index(&tx).unwrap();
        tx.commit().unwrap();
    }

    fn temp_left(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM temp.sqlite_master WHERE name = 'epg_search_sorted'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A build commits in many short transactions. Between them another
    /// connection writes without waiting (the build holds no lock), and a
    /// search finds what the scan finds: on the set current before while a
    /// rebuild fills the other, on the scan while the marker is gone. Each
    /// build alternates the sets and empties the one read before.
    #[test]
    fn builds_in_short_transactions_while_searches_stay_right() {
        let (_dir, pool) = build_fixture();
        let mut conn = pool.get().unwrap();
        let other = std::rc::Rc::new(pool.get().unwrap());
        other.busy_timeout(std::time::Duration::ZERO).unwrap();
        let want = scanned(&conn);
        assert!(want[0].len() == 30 && want[3].is_empty(), "{want:?}");
        CHUNK_OVERRIDE.with(|c| c.set(Some(100)));
        let mut sets = Vec::new();
        for round in 0..3 {
            if round == 2 {
                invalidate_index(&conn).unwrap();
            }
            let before = current_set(&conn).unwrap();
            let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let (o, w, s) = (other.clone(), want.clone(), seen.clone());
            on_chunk(move |i| {
                // Fails at once if the build held the write lock.
                o.execute(
                    "INSERT INTO app_state(key, value) VALUES ('t', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [i as i64],
                )?;
                s.borrow_mut().push(current_set(&o)?);
                assert_eq!(found(&o), w, "chunk {i}");
                Ok(())
            });
            rebuild_index(&mut conn).unwrap();
            let now = current_set(&conn).unwrap().unwrap();
            let seen = seen.borrow();
            assert!(seen.len() > 20, "{} transactions", seen.len());
            // The set read before until the last transaction made the new
            // one current.
            assert!(seen[..seen.len() - 1].iter().all(|s| *s == before));
            assert_eq!(seen.last(), Some(&Some(now)));
            assert!(set_is_empty(&conn, now.other()).unwrap());
            assert!(!set_is_empty(&conn, now).unwrap());
            assert_eq!(found(&conn), want, "round {round}");
            assert_eq!(temp_left(&conn), 0);
            sets.push(now);
        }
        // From A to B and back; after the marker went, into the empty set.
        assert_eq!(sets, [IndexSet::A, IndexSet::B, IndexSet::A]);
        no_hook();
    }

    /// A guide refresh that commits while a build runs (the guide stamp
    /// moves): the build sees it at its next transaction and starts again
    /// from a new sort, so the set it makes current holds the new
    /// programmes. A guide that changes under every attempt leaves the
    /// marker unset (searches scan), and the next build indexes it.
    #[test]
    fn a_refresh_during_a_build_starts_it_again() {
        let (_dir, pool) = build_fixture();
        let mut conn = pool.get().unwrap();
        let other = std::rc::Rc::new(std::cell::RefCell::new(pool.get().unwrap()));
        rebuild_index(&mut conn).unwrap();
        CHUNK_OVERRIDE.with(|c| c.set(Some(200)));
        let swaps = std::rc::Rc::new(std::cell::Cell::new(0));
        let (o, s) = (other.clone(), swaps.clone());
        on_chunk(move |i| {
            if i == 3 && s.get() == 0 {
                s.set(1);
                swap_feed(&mut o.borrow_mut(), "u2", "Breaking News");
                // The change removed the marker: searches scan.
                assert_eq!(current_set(&o.borrow())?, None);
                assert_eq!(found(&o.borrow()), scanned(&o.borrow()));
            }
            Ok(())
        });
        invalidate_index(&conn).unwrap();
        assert!(ensure_index(&mut conn, false).unwrap());
        assert_eq!(swaps.get(), 1);
        let after = found(&conn);
        assert!(
            !after[3].is_empty(),
            "the refreshed feed's titles are found"
        );
        assert_eq!(after, scanned(&conn));

        // Changed under every attempt: given up, the marker stays unset.
        let (o, s) = (other.clone(), swaps.clone());
        on_chunk(move |i| {
            if i == 2 {
                s.set(s.get() + 1);
                let title = format!("Breaking {}", s.get());
                swap_feed(&mut o.borrow_mut(), "u2", &title);
            }
            Ok(())
        });
        rebuild_index(&mut conn).unwrap();
        assert_eq!(swaps.get(), 1 + BUILD_ATTEMPTS);
        assert!(!index_ready(&conn).unwrap());
        assert_eq!(temp_left(&conn), 0);
        let scan = found(&conn);
        no_hook();
        assert!(ensure_index(&mut conn, false).unwrap());
        assert_eq!(found(&conn), scan);
    }

    /// A build that stops part-way (interrupted, the app shut down): the set
    /// current before stays current and whole, or searches go on scanning
    /// when there was none; nothing is left in the temporary database, and
    /// the next build, also on a reopened database, indexes everything.
    #[test]
    fn a_build_stopped_part_way_changes_nothing_searches_read() {
        let (dir, pool) = build_fixture();
        let mut conn = pool.get().unwrap();
        // As a refresh sets it: the build keeps the temporary database
        // open (restoring another setting would close it).
        conn.execute_batch("PRAGMA temp_store=FILE").unwrap();
        let want = scanned(&conn);
        rebuild_index(&mut conn).unwrap();
        assert_eq!(current_set(&conn).unwrap(), Some(IndexSet::A));
        CHUNK_OVERRIDE.with(|c| c.set(Some(300)));
        let stop = |at: usize| {
            on_chunk(move |i| {
                if i == at {
                    Err(CoreError::Other(anyhow::anyhow!("interrupted")))
                } else {
                    Ok(())
                }
            })
        };
        stop(3);
        assert!(rebuild_index(&mut conn).is_err());
        assert_eq!(current_set(&conn).unwrap(), Some(IndexSet::A));
        assert!(!set_is_empty(&conn, IndexSet::B).unwrap(), "part-built");
        assert_eq!(found(&conn), want);
        assert_eq!(temp_left(&conn), 0);

        // Stale, then stopped again: searches scan.
        invalidate_index(&conn).unwrap();
        stop(2);
        assert!(ensure_index(&mut conn, false).is_err());
        assert!(!index_ready(&conn).unwrap());
        assert_eq!(found(&conn), want);

        // The app shut down there: reopened, the next build indexes it all.
        drop(conn);
        drop(pool);
        no_hook();
        let pool = crate::db::open_and_migrate(&dir.path().join("t.db")).unwrap();
        let mut conn = pool.get().unwrap();
        assert!(!index_ready(&conn).unwrap());
        assert_eq!(found(&conn), want);
        assert!(ensure_index(&mut conn, true).unwrap());
        assert_eq!(found(&conn), want);
        let set = current_set(&conn).unwrap().unwrap();
        assert!(set_is_empty(&conn, set.other()).unwrap());
    }

    /// After a guide change and a catalog write, the channel directory and
    /// the catalog keys are loaded in the background, current, before any
    /// search asks for them; a search then finds them loaded.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn guide_and_catalog_are_loaded_ahead_of_the_first_search() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        state
            .db_call(|c| {
                c.execute_batch(
                    "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}');
                     INSERT INTO epg_sources(url, enabled, origin) VALUES ('u1', 1, 'settings');
                     INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES ('u1', 'g1.tv', 'Guide One');
                     INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id)
                       VALUES ('s', 'live', 'i1', 'c', 'Guide One', NULL);",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let rt = runtime(&state);
        let wait = |done: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !done() {
                assert!(std::time::Instant::now() < deadline, "not loaded");
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        };
        for _ in 0..2 {
            rt.bump();
            spawn_warm_guide(&state);
            let generation = rt.generation();
            let names = || {
                rt.names.lock().as_ref().is_some_and(|d| {
                    d.generation() == generation && !d.names_of("g1.tv").is_empty()
                })
            };
            tokio::task::block_in_place(|| wait(&names));
        }
        let stamp = state
            .db_call(|c| catalog_stamp(c, "s", ContentType::Live))
            .await
            .unwrap();
        assert!(stamp.is_some());
        spawn_warm_catalog(&state, "s");
        let keys = || {
            rt.search_keys
                .lock()
                .catalogs
                .get(&("s".to_string(), ContentType::Live))
                .is_some_and(|k| k.stamp == stamp && k.keys.len() == 1 && k.by_name.len() == 1)
        };
        tokio::task::block_in_place(|| wait(&keys));
    }

    /// Two refreshes back to back: the second one's rebuild waits for the
    /// first's, which saw the second swap come in and indexed it; the
    /// second then finds the index current and builds nothing.
    #[test]
    fn back_to_back_refreshes_build_once_after_the_last() {
        let (_dir, pool) = build_fixture();
        let mut conn = pool.get().unwrap();
        rebuild_index(&mut conn).unwrap();
        CHUNK_OVERRIDE.with(|c| c.set(Some(200)));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let mut paused = false;
        on_chunk(move |i| {
            if i == 2 && !paused {
                paused = true;
                started_tx.send(()).unwrap();
                go_rx.recv().unwrap();
            }
            Ok(())
        });
        swap_feed(&mut pool.get().unwrap(), "u1", "First News");
        let second = std::thread::spawn({
            let pool = pool.clone();
            move || {
                started_rx.recv().unwrap();
                let mut c = pool.get().unwrap();
                swap_feed(&mut c, "u2", "Breaking Second");
                let (done_tx, done_rx) = std::sync::mpsc::channel();
                let waiter = std::thread::spawn(move || {
                    let r = ensure_index(&mut c, false).unwrap();
                    done_tx.send(()).unwrap();
                    r
                });
                // Waits for the first build.
                assert!(done_rx
                    .recv_timeout(std::time::Duration::from_millis(200))
                    .is_err());
                go_tx.send(()).unwrap();
                waiter.join().unwrap()
            }
        });
        assert!(ensure_index(&mut conn, false).unwrap());
        assert!(!second.join().unwrap(), "nothing left to build");
        no_hook();
        assert!(index_ready(&conn).unwrap());
        let after = found(&conn);
        assert!(!after[3].is_empty(), "the second refresh is indexed");
        assert_eq!(after, scanned(&conn));
    }
}
