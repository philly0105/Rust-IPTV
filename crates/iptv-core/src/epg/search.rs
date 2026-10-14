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
//! - [`rebuild_index`] runs `'rebuild'` and sets the marker in one
//!   transaction: after each refresh, after `epg.clearAll`, after a prune,
//!   and once in the background at startup when the marker is missing and
//!   programmes exist (an upgraded database, or a crash between a swap and
//!   its rebuild);
//! - [`search`] reads the index only while the marker is present and falls
//!   back to a scan of the time window otherwise, so results are never
//!   stale and rowids reused by later inserts never point a hit at the
//!   wrong programme.
//!
//! Both paths match the same way: every word of the query (letters and
//! digits, case and diacritics folded) must start a word of the title.

use super::resolve::{self, ChannelDirectory};
use super::store::STAGING_ORIGIN;
use super::{query, runtime};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, EpgProgram, ItemRef};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// `app_state` key present while `epg_programs_fts` matches `epg_programs`.
pub const INDEX_MARKER: &str = "epg_search_index";
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
/// Candidates gathered before parental filtering while hide mode is on (it
/// can drop any number of channels, so the first `limit` are not enough).
pub const MAX_CANDIDATES: usize = 2_000;

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

/// True when the index matches the programme table.
pub fn index_ready(conn: &Connection) -> CoreResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM app_state WHERE key = ?1",
            [INDEX_MARKER],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Rebuilds the whole index from `epg_programs` and marks it ready, in one
/// write transaction.
pub fn rebuild_index(conn: &mut Connection) -> CoreResult<()> {
    let started = std::time::Instant::now();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO epg_programs_fts(epg_programs_fts) VALUES('rebuild')",
        [],
    )?;
    tx.execute(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, 'ready', CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [INDEX_MARKER],
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

/// Lowercase without diacritics ("Café" -> "cafe").
pub fn fold(s: &str) -> String {
    crate::tmdb::normalize::strip_diacritics(&s.to_lowercase())
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

type ChannelMap = HashMap<String, Vec<Arc<SourceChannel>>>;

/// The source's visible channels by the guide channel id each resolves to:
/// manual mapping (`NULL` = none), then `items.epg_channel_id` (known to
/// the guide, case-insensitive, or with programmes), then the exact
/// normalized name. Channels hidden by a channel edit are left out.
fn source_channels(
    conn: &Connection,
    dir: &ChannelDirectory,
    source_id: &str,
) -> CoreResult<ChannelMap> {
    let hidden = crate::channeledit::hidden_set(conn, source_id)?;
    let manual: HashMap<(String, String), Option<String>> = {
        let mut stmt = conn.prepare(
            "SELECT content_type, item_id, epg_channel_id FROM epg_channel_map WHERE source_id = ?1",
        )?;
        let rows = stmt.query_map([source_id], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let mut stmt = conn.prepare(
        "SELECT content_type, item_id, title, number, logo_url, category_id, epg_channel_id
         FROM items WHERE source_id = ?1 AND content_type IN ('live', 'radio')",
    )?;
    let rows = stmt.query_map([source_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut with_programmes: HashMap<String, bool> = HashMap::new();
    let mut out = ChannelMap::new();
    for row in rows {
        let (ct_raw, item_id, title, number, logo_url, category_id, item_epg) = row?;
        let Ok(content_type) = ct_raw.parse::<ContentType>() else {
            continue;
        };
        if hidden.contains(&(content_type, item_id.clone())) {
            continue;
        }
        let channel: Option<String> = match manual.get(&(ct_raw, item_id.clone())) {
            Some(m) => m
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            None => {
                let mut found = None;
                if let Some(id) = item_epg.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    if let Some(canonical) = dir.find_id(id) {
                        found = Some(canonical.to_string());
                    } else {
                        let has = match with_programmes.get(id) {
                            Some(h) => *h,
                            None => {
                                let h = resolve::has_programmes(conn, id)?;
                                with_programmes.insert(id.to_string(), h);
                                h
                            }
                        };
                        if has {
                            found = Some(id.to_string());
                        }
                    }
                }
                found.or_else(|| dir.find_name_exact(&title).map(str::to_owned))
            }
        };
        let Some(channel) = channel else { continue };
        out.entry(channel)
            .or_default()
            .push(Arc::new(SourceChannel {
                item_ref: ItemRef::new(source_id, content_type, item_id),
                name: title,
                number,
                logo_url: logo_url.filter(|s| !s.trim().is_empty()),
                category_id,
            }));
    }
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

/// Collects candidates in (start, channel number) order: at least `want`
/// of them when there are, plus every other one starting at the same time
/// as the last (so the tie order by channel number is complete). Returns
/// whether the index was used.
fn candidates(
    conn: &Connection,
    dir: &ChannelDirectory,
    q: &Query,
    want: usize,
) -> CoreResult<(Vec<Candidate>, bool)> {
    let channels = source_channels(conn, dir, &q.source_id)?;
    if channels.is_empty() || q.words.is_empty() {
        return Ok((Vec::new(), false));
    }
    let used_index = index_ready(conn)?;
    let mut rows: Vec<ProgrammeRow> = Vec::new();
    if used_index {
        let mut stmt = conn.prepare_cached(FTS_SQL)?;
        let mut it = stmt.query(params![
            fts_expression(&q.words),
            q.from,
            q.to,
            STAGING_ORIGIN
        ])?;
        let mut kept = 0usize;
        let mut cut: Option<i64> = None;
        // A slot listed by two feeds counts once.
        let mut slots: HashSet<(String, i64)> = HashSet::new();
        while let Some(r) = it.next()? {
            let row = map_row(r)?;
            if cut.is_some_and(|c| row.start > c) {
                break;
            }
            let Some(list) = channels.get(&row.channel_id) else {
                continue;
            };
            if slots.insert((row.channel_id.clone(), row.start)) {
                kept += list.len();
            }
            if kept >= want && cut.is_none() {
                cut = Some(row.start);
            }
            rows.push(row);
        }
    } else {
        let mut stmt = conn.prepare_cached(SCAN_SQL)?;
        let it = stmt.query_map(params![q.from, q.to, STAGING_ORIGIN], map_row)?;
        for row in it {
            let row = row?;
            if channels.contains_key(&row.channel_id) && title_matches(&row.title, &q.words) {
                rows.push(row);
            }
        }
        rows.sort_by_key(|r| (r.start, r.feed));
    }
    let mut seen: HashSet<(String, i64)> = HashSet::new();
    let mut out: Vec<Candidate> = Vec::new();
    for row in rows {
        let row = Arc::new(row);
        if let Some(list) = channels.get(&row.channel_id) {
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

/// Reads descriptions, categories and icons, and applies custom channel
/// names (C2).
fn finish(conn: &Connection, found: Vec<Candidate>) -> CoreResult<Vec<GuideSearchHit>> {
    let mut details = conn
        .prepare_cached("SELECT description, category, icon FROM epg_programs WHERE rowid = ?1")?;
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    let mut out = Vec::with_capacity(found.len());
    for c in found {
        type Details = (Option<String>, Option<String>, Option<String>);
        let (description, category, icon): Details = details
            .query_row([c.row.rowid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?
            .unwrap_or((None, None, None));
        let key = c.channel.item_ref.key();
        let custom = match names.get(&key) {
            Some(n) => n.clone(),
            None => {
                let n = crate::channeledit::custom_name(conn, &c.channel.item_ref)?;
                names.insert(key, n.clone());
                n
            }
        };
        out.push(GuideSearchHit {
            item_ref: c.channel.item_ref.clone(),
            channel_name: custom.unwrap_or_else(|| c.channel.name.clone()),
            channel_number: c.channel.number,
            logo_url: c.channel.logo_url.clone(),
            category_id: Some(c.channel.category_id.clone()).filter(|s| !s.is_empty()),
            program: EpgProgram {
                channel_id: c.row.channel_id.clone(),
                start: query::to_rfc3339(c.row.start),
                end: query::to_rfc3339(c.row.stop),
                title: c.row.title.clone(),
                description: description.filter(|s| !s.trim().is_empty()),
                category: category.filter(|s| !s.trim().is_empty()),
                icon: icon.filter(|s| !s.trim().is_empty()),
            },
        });
    }
    Ok(out)
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
    let hide = crate::parental::hide_filter(state).await?.is_some();
    let limit = q.limit;
    let want = if hide {
        MAX_CANDIDATES.max(limit)
    } else {
        limit
    };
    let rt = runtime(state);
    let started = std::time::Instant::now();
    let (mut found, used_index) = state
        .db_call(move |c| {
            ensure_source(c, &q.source_id)?;
            let dir = resolve::directory(c, &rt)?;
            candidates(c, &dir, &q, want)
        })
        .await?;
    if hide && !found.is_empty() {
        let mut seen = HashSet::new();
        let items: Vec<(ItemRef, Option<String>)> = found
            .iter()
            .filter(|c| seen.insert(c.channel.item_ref.clone()))
            .map(|c| {
                (
                    c.channel.item_ref.clone(),
                    Some(c.channel.category_id.clone()).filter(|s| !s.is_empty()),
                )
            })
            .collect();
        let hidden: HashSet<ItemRef> = crate::parental::hidden(state, items)
            .await?
            .into_iter()
            .collect();
        found.retain(|c| !hidden.contains(&c.channel.item_ref));
    }
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
