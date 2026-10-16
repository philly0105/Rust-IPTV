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
//! - [`rebuild_index`] empties the index, indexes every title as [`fold`]
//!   folds it, and sets the marker to [`INDEX_VERSION`] in one
//!   transaction: after each refresh, after `epg.clearAll`, after a prune,
//!   and once in the background at startup when the marker is missing or
//!   from an older version and programmes exist (an upgraded database, or
//!   a crash between a swap and its rebuild);
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
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, EpgProgram, ItemRef};
use crate::parental::Hide;
use crate::state::AppState;
use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// `app_state` key present while `epg_programs_fts` matches `epg_programs`.
pub const INDEX_MARKER: &str = "epg_search_index";
/// Marker value of an index of [`fold`]ed titles. A marker with any other
/// value (`ready`: raw titles, before the fold) counts as missing.
pub const INDEX_VERSION: &str = "folded-1";
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
/// Times in `program` are raw guide times, as in `epg.programs`.
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

/// Marks the index stale. Call inside the transaction that deletes or
/// re-keys programmes.
pub fn invalidate_index(conn: &Connection) -> CoreResult<()> {
    conn.execute("DELETE FROM app_state WHERE key = ?1", [INDEX_MARKER])?;
    Ok(())
}

/// True when the index matches the programme table and holds folded titles.
pub fn index_ready(conn: &Connection) -> CoreResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM app_state WHERE key = ?1 AND value = ?2",
            [INDEX_MARKER, INDEX_VERSION],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Rebuilds the whole index from `epg_programs` and marks it ready, in one
/// write transaction. Titles are indexed as [`fold`] folds them (not with
/// `'rebuild'`, which would index the raw titles of the content table), so
/// the index and the scan agree on every script; queries are folded the
/// same way before they reach the tokenizer.
pub fn rebuild_index(conn: &mut Connection) -> CoreResult<()> {
    let started = std::time::Instant::now();
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
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO epg_programs_fts(epg_programs_fts) VALUES('delete-all')",
        [],
    )?;
    tx.execute(
        &format!(
            "INSERT INTO epg_programs_fts(rowid, title) SELECT rowid, {FOLD_SQL_FUNCTION}(title) FROM epg_programs"
        ),
        [],
    )?;
    tx.execute(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [INDEX_MARKER, INDEX_VERSION],
    )?;
    tx.commit()?;
    tracing::debug!(
        ms = started.elapsed().as_millis() as u64,
        "guide search index rebuilt"
    );
    Ok(())
}

/// Rebuilds the index when it is stale. With `only_if_programmes`, an empty
/// guide is left alone (nothing to index; startup must not write for
/// nothing). Returns whether a rebuild ran. Holds the long-write guard so
/// user writes wait for it instead of failing.
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
    let _long = crate::db::long_write();
    rebuild_index(conn)?;
    Ok(true)
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
pub fn spawn_startup_build(state: &Arc<AppState>) {
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        let Some(state) = weak.upgrade() else { return };
        match state.db_call(|c| ensure_index(c, true)).await {
            Ok(true) => tracing::info!("guide search index built"),
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "could not build the guide search index"),
        }
    });
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

/// One live or radio channel of the searched source.
#[derive(Debug, Clone)]
struct SourceChannel {
    item_ref: ItemRef,
    name: String,
    number: Option<i64>,
    logo_url: Option<String>,
    category_id: String,
}

type ChannelMap = HashMap<Arc<str>, Vec<Arc<SourceChannel>>>;

/// Channel resolutions that depend only on the guide, kept on the EPG
/// runtime and reused by every search until its generation moves (a
/// refresh, a clear, a prune, a url enabled or disabled). Without it each
/// search probed `epg_programs` once per unknown `epg_channel_id` and
/// normalized every unmatched channel name: about 140 ms at 50k channels.
/// The channels themselves are read on every search that has hits, so
/// catalog changes, channel edits and parental locks apply at once.
#[derive(Default)]
pub(crate) struct SearchMemo {
    generation: u64,
    /// Trimmed `items.epg_channel_id` -> the guide channel it names (known
    /// to the guide, case-insensitive, or with programmes), else `None`.
    ids: HashMap<String, Option<Arc<str>>>,
    /// Channel title -> the guide channel with that exact normalized name.
    names: HashMap<String, Option<Arc<str>>>,
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
        if self.ids.len() + self.names.len() > MEMO_CAP {
            self.ids.clear();
            self.names.clear();
        }
        *rt.search_memo.lock() = self;
    }

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

    fn by_name(&mut self, dir: &ChannelDirectory, title: &str) -> Option<Arc<str>> {
        if let Some(found) = self.names.get(title) {
            return found.clone();
        }
        let found: Option<Arc<str>> = dir.find_name_exact(title).map(Into::into);
        self.names.insert(title.to_string(), found.clone());
        found
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
        Ok(self.by_name(dir, title))
    }
}

/// Text column `idx` without copying it.
fn text<'r>(r: &'r rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<Option<&'r str>> {
    r.get_ref(idx)?.as_str_or_null().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

/// The source's visible channels by the guide channel id each resolves to:
/// manual mapping (`NULL` = none), then `items.epg_channel_id` (known to
/// the guide, case-insensitive, or with programmes), then the exact
/// normalized name. Channels hidden by a channel edit are left out, and so,
/// while hide mode is on, are locked and adult channels: in SQL, so they
/// never take a candidate slot from a visible channel. With `wanted` (the
/// guide channels of the matching programmes), every channel is still
/// resolved (a name can lead to any guide channel) but only those on a
/// wanted one are copied out of their row.
fn source_channels(
    conn: &Connection,
    rt: &EpgRuntime,
    dir: &ChannelDirectory,
    source_id: &str,
    hide: Option<Hide>,
    wanted: Option<&HashSet<&str>>,
) -> CoreResult<ChannelMap> {
    // Manual mappings of live and radio channels, by item id.
    let mut manual: [HashMap<String, Option<String>>; 2] = Default::default();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT content_type, item_id, epg_channel_id FROM epg_channel_map WHERE source_id = ?1",
        )?;
        let rows = stmt.query_map([source_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (ct, item_id, epg) = row?;
            match ct.parse::<ContentType>() {
                Ok(ContentType::Live) => manual[0].insert(item_id, epg),
                Ok(ContentType::Radio) => manual[1].insert(item_id, epg),
                _ => None,
            };
        }
    }
    let mut memo = SearchMemo::take(rt, dir.generation());
    let mut out = ChannelMap::new();
    for (content_type, manual) in [ContentType::Live, ContentType::Radio]
        .into_iter()
        .zip(&manual)
    {
        let mut sql = String::from(
            "SELECT i.item_id, i.title, i.epg_channel_id, i.number, i.logo_url, i.category_id
             FROM items i WHERE i.source_id = ?1 AND i.content_type = ?2",
        );
        sql.push_str(&crate::channeledit::scoped(
            conn,
            source_id,
            content_type,
            "?1",
            "?2",
        )?);
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
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut rows = stmt.query(params![source_id, content_type.as_str()])?;
        while let Some(r) = rows.next()? {
            // Borrowed: most channels resolve to no wanted guide channel.
            let item_id = text(r, 0)?.unwrap_or_default();
            let title = text(r, 1)?.unwrap_or_default();
            let resolved: Option<Arc<str>>;
            let channel: Option<&str> = match manual.get(item_id) {
                Some(m) => m.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                None => {
                    let item_epg = text(r, 2)?;
                    resolved = memo.resolve(conn, dir, item_epg, title)?;
                    resolved.as_deref()
                }
            };
            let Some(channel) = channel.filter(|c| wanted.is_none_or(|w| w.contains(c))) else {
                continue;
            };
            let logo_url: Option<String> = r.get(4)?;
            let entry = Arc::new(SourceChannel {
                item_ref: ItemRef::new(source_id, content_type, item_id),
                name: title.to_owned(),
                number: r.get(3)?,
                logo_url: logo_url.filter(|s| !s.trim().is_empty()),
                category_id: r.get(5)?,
            });
            match out.get_mut(channel) {
                Some(list) => list.push(entry),
                None => {
                    out.insert(channel.into(), vec![entry]);
                }
            }
        }
    }
    memo.put_back(rt);
    Ok(out)
}

/// A matching programme row.
#[derive(Debug, Clone)]
struct ProgrammeRow {
    rowid: i64,
    channel_id: String,
    start: i64,
    stop: i64,
    title: String,
    /// `epg_sources.rowid`: the first configured feed wins a duplicate slot.
    feed: i64,
}

/// A programme on one channel, before details are read.
#[derive(Debug, Clone)]
struct Candidate {
    row: Arc<ProgrammeRow>,
    channel: Arc<SourceChannel>,
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProgrammeRow> {
    Ok(ProgrammeRow {
        rowid: r.get(0)?,
        channel_id: r.get(1)?,
        start: r.get(2)?,
        stop: r.get(3)?,
        title: r.get(4)?,
        feed: r.get(5)?,
    })
}

/// The index statement: the FTS match drives the join, each hit reads its
/// programme by rowid and its feed by url.
pub const FTS_SQL: &str = "SELECT p.rowid, p.channel_id, p.start, p.stop, p.title, s.rowid
     FROM epg_programs_fts f
     CROSS JOIN epg_programs p ON p.rowid = f.rowid
     CROSS JOIN epg_sources s ON s.url = p.epg_url
     WHERE epg_programs_fts MATCH ?1 AND p.stop > ?2 AND p.start < ?3
       AND s.enabled = 1 AND s.origin <> ?4
     ORDER BY p.start, s.rowid";

/// The fallback statement: every programme overlapping the window (on the
/// `stop` index); titles are matched in Rust with the same folding.
pub const SCAN_SQL: &str = "SELECT p.rowid, p.channel_id, p.start, p.stop, p.title, s.rowid
     FROM epg_programs p JOIN epg_sources s ON s.url = p.epg_url
     WHERE p.stop > ?1 AND p.start < ?2 AND s.enabled = 1 AND s.origin <> ?3";

fn hit_order(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.row
        .start
        .cmp(&b.row.start)
        .then_with(|| {
            a.channel
                .number
                .unwrap_or(i64::MAX)
                .cmp(&b.channel.number.unwrap_or(i64::MAX))
        })
        .then_with(|| {
            a.channel
                .name
                .to_lowercase()
                .cmp(&b.channel.name.to_lowercase())
        })
        .then_with(|| a.channel.item_ref.cmp(&b.channel.item_ref))
}

/// Collects candidates in (start, channel number) order: at least the limit
/// of them when there are, plus every other one starting at the same time
/// as the last (so the tie order by channel number is complete). Returns
/// whether the index was used.
///
/// With the index, the matching programmes are read first and only the
/// source's channels on their guide channels are kept: a query without
/// hits never reads the channels, one with hits copies out only those it
/// needs. The scan reads the channels first so it folds only the titles of
/// guide channels the source has.
fn candidates(
    conn: &Connection,
    rt: &EpgRuntime,
    dir: &ChannelDirectory,
    q: &Query,
    hide: Option<Hide>,
) -> CoreResult<(Vec<Candidate>, bool)> {
    let want = q.limit;
    if q.words.is_empty() {
        return Ok((Vec::new(), false));
    }
    let used_index = index_ready(conn)?;
    let mut rows: Vec<ProgrammeRow> = Vec::new();
    let channels = if used_index {
        // Ordered by (start, feed) in SQL: the statement sorts every hit
        // before the first row comes out, so reading them all costs little.
        let mut stmt = conn.prepare_cached(FTS_SQL)?;
        let it = stmt.query_map(
            params![fts_expression(&q.words), q.from, q.to, STAGING_ORIGIN],
            map_row,
        )?;
        for row in it {
            rows.push(row?);
        }
        if rows.is_empty() {
            return Ok((Vec::new(), true));
        }
        let wanted: HashSet<&str> = rows.iter().map(|r| r.channel_id.as_str()).collect();
        let channels = source_channels(conn, rt, dir, &q.source_id, hide, Some(&wanted))?;
        // Stop after the start time at which the limit is reached.
        let mut end = rows.len();
        let mut kept = 0usize;
        let mut cut: Option<i64> = None;
        // A slot listed by two feeds counts once.
        let mut slots: HashSet<(&str, i64)> = HashSet::new();
        for (i, row) in rows.iter().enumerate() {
            if cut.is_some_and(|c| row.start > c) {
                end = i;
                break;
            }
            let Some(list) = channels.get(row.channel_id.as_str()) else {
                continue;
            };
            if slots.insert((row.channel_id.as_str(), row.start)) {
                kept += list.len();
            }
            if kept >= want && cut.is_none() {
                cut = Some(row.start);
            }
        }
        drop((wanted, slots));
        rows.truncate(end);
        channels
    } else {
        let channels = source_channels(conn, rt, dir, &q.source_id, hide, None)?;
        if channels.is_empty() {
            return Ok((Vec::new(), false));
        }
        let mut stmt = conn.prepare_cached(SCAN_SQL)?;
        let it = stmt.query_map(params![q.from, q.to, STAGING_ORIGIN], map_row)?;
        for row in it {
            let row = row?;
            if channels.contains_key(row.channel_id.as_str()) && title_matches(&row.title, &q.words)
            {
                rows.push(row);
            }
        }
        rows.sort_by_key(|r| (r.start, r.feed));
        channels
    };
    let mut seen: HashSet<(String, i64)> = HashSet::new();
    let mut out: Vec<Candidate> = Vec::new();
    for row in rows {
        let row = Arc::new(row);
        if let Some(list) = channels.get(row.channel_id.as_str()) {
            for ch in list {
                if seen.insert((ch.item_ref.key(), row.start)) {
                    out.push(Candidate {
                        row: row.clone(),
                        channel: ch.clone(),
                    });
                }
            }
        }
    }
    out.sort_by(hit_order);
    // The scan read the whole window; keep what the index path would.
    if !used_index && out.len() > want {
        let last = out[want - 1].row.start;
        out.retain(|c| c.row.start <= last);
    }
    Ok((out, used_index))
}

/// Reads descriptions, categories and icons, applies custom channel names
/// (C2), and moves each hit by its channel's `tvg-shift` as the grid does
/// (L1-core-11).
fn finish(conn: &Connection, found: Vec<Candidate>) -> CoreResult<Vec<GuideSearchHit>> {
    let mut details = conn
        .prepare_cached("SELECT description, category, icon FROM epg_programs WHERE rowid = ?1")?;
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    let mut shifts: HashMap<String, i64> = HashMap::new();
    let mut out = Vec::with_capacity(found.len());
    for c in found {
        type Details = (Option<String>, Option<String>, Option<String>);
        let (description, category, icon): Details = details
            .query_row([c.row.rowid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?
            .unwrap_or((None, None, None));
        let key = c.channel.item_ref.key();
        let shift = match shifts.get(&key) {
            Some(s) => *s,
            None => {
                let s = query::item_shift(conn, &c.channel.item_ref)?;
                shifts.insert(key.clone(), s);
                s
            }
        };
        let custom = match names.get(&key) {
            Some(n) => n.clone(),
            None => {
                let n = crate::channeledit::custom_name(conn, &c.channel.item_ref)?;
                names.insert(key, n.clone());
                n
            }
        };
        out.push((
            c.row.start + shift,
            GuideSearchHit {
                item_ref: c.channel.item_ref.clone(),
                channel_name: custom.unwrap_or_else(|| c.channel.name.clone()),
                channel_number: c.channel.number,
                logo_url: c.channel.logo_url.clone(),
                category_id: Some(c.channel.category_id.clone()).filter(|s| !s.is_empty()),
                program: EpgProgram {
                    channel_id: c.row.channel_id.clone(),
                    start: query::to_rfc3339(c.row.start + shift),
                    end: query::to_rfc3339(c.row.stop + shift),
                    title: c.row.title.clone(),
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
    // Hide mode drops locked and adult channels in the channel query itself.
    let hide = crate::parental::hide_filter(state).await?;
    let limit = q.limit;
    let rt = runtime(state);
    let started = std::time::Instant::now();
    let (mut found, used_index) = state
        .db_call(move |c| {
            ensure_source(c, &q.source_id)?;
            let dir = resolve::directory(c, &rt)?;
            candidates(c, &rt, &dir, &q, hide)
        })
        .await?;
    found.truncate(limit);
    let hits = state.db_call(move |c| finish(c, found)).await?;
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
}
