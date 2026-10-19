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
//!   folds it, refills `epg_search_rows` (each programme's start, stop,
//!   feed and guide channel by rowid, migration 0019: the hits are read
//!   there instead of in the wide programme rows), and sets the marker to
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
/// Marker value of an index of [`fold`]ed titles with its
/// `epg_search_rows`. A marker with any other value (`ready`: raw titles,
/// before the fold; `folded-1`: before the search rows) counts as missing.
pub const INDEX_VERSION: &str = "folded-2";
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
    tx.execute("DELETE FROM epg_search_rows", [])?;
    tx.execute(
        "INSERT INTO epg_search_rows(id, start, stop, feed, channel_id)
         SELECT p.rowid, p.start, p.stop, s.rowid, p.channel_id
         FROM epg_programs p JOIN epg_sources s ON s.url = p.epg_url",
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
/// while hide mode is on, are locked and adult channels: in SQL, so they
/// never take a candidate slot from a visible channel.
fn source_channels(
    conn: &Connection,
    rt: &EpgRuntime,
    dir: &ChannelDirectory,
    source_id: &str,
    hide: Option<Hide>,
) -> CoreResult<SourceChannels> {
    let mut memo = SearchMemo::take(rt, dir.generation());
    let mut out = SourceChannels::default();
    for content_type in [ContentType::Live, ContentType::Radio] {
        let manual: HashMap<i64, Option<String>> = conn
            .prepare_cached(MANUAL_SQL)?
            .query_map(params![source_id, content_type.as_str()], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        let mut sql = String::from(CHANNELS_SQL);
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
            let rowid: i64 = r.get(0)?;
            let guide: Option<Arc<str>> = match manual.get(&rowid) {
                Some(m) => m
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(Arc::from),
                // Borrowed: the memo answers most channels without a copy.
                None => memo.resolve(conn, dir, text(r, 2)?, text(r, 1)?.unwrap_or_default())?,
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
    }
    memo.put_back(rt);
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
    channel: Arc<SourceChannel>,
}

/// The index statement: the title index's hits in the window, each with
/// its search row by rowid (`epg_search_rows`, alias `p`: start, stop, feed
/// and guide channel, a narrow row instead of the programme's). Unordered:
/// [`candidates`] drops the hits of disabled feeds and of guide channels
/// the source does not have, and sorts the rest.
pub const FTS_SQL: &str = "SELECT p.id, p.channel_id, p.start, p.stop, p.feed
     FROM epg_programs_fts f
     CROSS JOIN epg_search_rows p ON p.id = f.rowid
     WHERE epg_programs_fts MATCH ?1 AND p.stop > ?2 AND p.start < ?3";

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

/// The first `limit` candidates in (start, channel number, name, ref)
/// order. Returns whether the index was used.
///
/// With the index, the matching programmes are found first: a query
/// without hits never reads the channels. Otherwise the scan reads the
/// channels first so it folds only the titles of guide channels the source
/// has. Either way the hits are walked in (start, feed) order up to the
/// start time at which the limit is reached (every channel of a guide
/// channel counts), and only the channels that can make the result are
/// read beyond the channel scan.
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
    let mut hits: Vec<Hit> = Vec::new();
    let channels = if used_index {
        let mut stmt = conn.prepare_cached(FTS_SQL)?;
        let mut rows = stmt.query(params![fts_expression(&q.words), q.from, q.to])?;
        let Some(first) = rows.next()? else {
            return Ok((Vec::new(), true));
        };
        let feeds = search_feeds(conn)?;
        let channels = source_channels(conn, rt, dir, &q.source_id, hide)?;
        let hit = |r: &rusqlite::Row<'_>| -> CoreResult<Option<Hit>> {
            let feed: i64 = r.get(4)?;
            if !feeds.contains(&feed) {
                return Ok(None);
            }
            let Some(&guide) = channels.by_guide.get(text(r, 1)?.unwrap_or_default()) else {
                return Ok(None);
            };
            Ok(Some(Hit {
                rowid: r.get(0)?,
                start: r.get(2)?,
                stop: r.get(3)?,
                feed,
                guide,
            }))
        };
        hits.extend(hit(first)?);
        while let Some(r) = rows.next()? {
            hits.extend(hit(r)?);
        }
        channels
    } else {
        let channels = source_channels(conn, rt, dir, &q.source_id, hide)?;
        if channels.guides.is_empty() {
            return Ok((Vec::new(), false));
        }
        let mut stmt = conn.prepare_cached(SCAN_SQL)?;
        let mut rows = stmt.query(params![q.from, q.to, STAGING_ORIGIN])?;
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
        channels
    };
    hits.sort_unstable_by_key(|h| (h.start, h.feed));
    // Stop after the start time at which the limit is reached; a slot
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
        if kept >= want && cut.is_none() {
            cut = Some(h.start);
        }
    }
    hits.truncate(end);
    // Each channel of each kept programme's guide channel, once per start
    // (the first feed's programme wins).
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    let mut pairs: Vec<(Hit, ChannelKey)> = Vec::new();
    for h in &hits {
        for ch in &channels.guides[h.guide].1 {
            if seen.insert((ch.rowid, h.start)) {
                pairs.push((*h, *ch));
            }
        }
    }
    // By (start, number), the first `want` and every pair tied with the
    // last of them: only those can be among the first `want` once names and
    // refs break the ties.
    let prefix = |p: &(Hit, ChannelKey)| (p.0.start, p.1.number.unwrap_or(i64::MAX));
    pairs.sort_unstable_by_key(prefix);
    if pairs.len() > want {
        let last = prefix(&pairs[want - 1]);
        let n = pairs.partition_point(|p| prefix(p) <= last);
        pairs.truncate(n);
    }
    let mut stmt = conn.prepare_cached(
        "SELECT item_id, title, logo_url, category_id FROM items WHERE rowid = ?1",
    )?;
    let mut read: HashMap<i64, Arc<SourceChannel>> = HashMap::new();
    let mut out: Vec<Candidate> = Vec::with_capacity(pairs.len());
    for (h, ch) in pairs {
        let channel = match read.get(&ch.rowid) {
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
                let c = Arc::new(c);
                read.insert(ch.rowid, c.clone());
                c
            }
        };
        out.push(Candidate {
            rowid: h.rowid,
            channel_id: channels.guides[h.guide].0.clone(),
            start: h.start,
            stop: h.stop,
            channel,
        });
    }
    out.sort_by(hit_order);
    out.truncate(want);
    Ok((out, used_index))
}

/// Reads titles, descriptions, categories and icons, applies custom channel
/// names (C2), and moves each hit by its channel's `tvg-shift` as the grid
/// does (L1-core-11).
fn finish(conn: &Connection, found: Vec<Candidate>) -> CoreResult<Vec<GuideSearchHit>> {
    let mut details = conn.prepare_cached(
        "SELECT title, description, category, icon FROM epg_programs WHERE rowid = ?1",
    )?;
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    let mut shifts: HashMap<String, i64> = HashMap::new();
    let mut source_shifts: HashMap<String, i64> = HashMap::new();
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
        let shift = match shifts.get(&key) {
            Some(s) => *s,
            None => {
                let r = &c.channel.item_ref;
                let source = query::cached_source_shift(conn, &mut source_shifts, &r.source_id)?;
                let s = query::item_shift_with(conn, r, source)?;
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
            c.start + shift,
            GuideSearchHit {
                item_ref: c.channel.item_ref.clone(),
                channel_name: custom.unwrap_or_else(|| c.channel.name.clone()),
                channel_number: c.channel.number,
                logo_url: c.channel.logo_url.clone(),
                category_id: Some(c.channel.category_id.clone()).filter(|s| !s.is_empty()),
                program: EpgProgram {
                    channel_id: c.channel_id.to_string(),
                    start: query::to_rfc3339(c.start + shift),
                    end: query::to_rfc3339(c.stop + shift),
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
    // Hide mode drops locked and adult channels in the channel query itself.
    let hide = crate::parental::hide_filter(state).await?;
    let rt = runtime(state);
    let started = std::time::Instant::now();
    let (hits, used_index) = state
        .db_call(move |c| {
            ensure_source(c, &q.source_id)?;
            let dir = resolve::directory(c, &rt)?;
            // One read snapshot: a guide refresh that commits between the
            // statements cannot hand a hit's rowid to another programme.
            let tx = c.transaction()?;
            let (found, used_index) = candidates(&tx, &rt, &dir, &q, hide)?;
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
