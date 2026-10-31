//! EPG tables (C3): `epg_sources`, `epg_channels`, `epg_programs`.
//!
//! Ingestion writes channels under a staging key (`<url>\u{1}staging`, with
//! its own hidden `epg_sources` row, `origin = 'staging'`, `enabled = 0`) and
//! programmes into the connection's temp table [`STAGE_TABLE`], in
//! transactions of [`BATCH`] rows, then [`commit_staging`] swaps both in for
//! the real url inside one transaction. Readers never see a half-imported
//! feed, and a failed import leaves the previous data untouched.

use super::xmltv::{XmltvChannel, XmltvProgramme};
use crate::db::now_rfc3339;
use crate::error::CoreResult;
use crate::model::{EpgFetchStatus, EpgLinks, EpgOrigin, EpgSourceStatus, RequestHeaders};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::{HashMap, HashSet};

/// Rows per write transaction during ingestion.
pub const BATCH: usize = 2000;
/// Suffix of the staging key.
pub const STAGING_SUFFIX: &str = "\u{1}staging";
/// `epg_sources.origin` of staging rows.
pub const STAGING_ORIGIN: &str = "staging";
/// Temp table holding the programmes of the import running on a connection.
pub const STAGE_TABLE: &str = "temp.epg_stage";

/// Staging key for `url`.
pub fn staging_key(url: &str) -> String {
    format!("{url}{STAGING_SUFFIX}")
}

/// One configured EPG URL with where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguredUrl {
    pub url: String,
    pub origin: EpgOrigin,
    pub source_id: Option<String>,
    /// Headers of the owning source (m3u / stalker), applied to the download.
    pub headers: RequestHeaders,
}

/// Merges `settings.epgUrls` (origin settings) with every source's detected and
/// manual urls minus its disabled urls (origin source). First occurrence wins:
/// settings before sources, sources in `position` order. Blank entries are
/// dropped; urls are trimmed.
pub fn configured_urls(
    conn: &Connection,
    settings_urls: &[String],
) -> CoreResult<Vec<ConfiguredUrl>> {
    let mut out: Vec<ConfiguredUrl> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for u in settings_urls {
        let u = u.trim();
        if !u.is_empty() && seen.insert(u.to_string()) {
            out.push(ConfiguredUrl {
                url: u.to_string(),
                origin: EpgOrigin::Settings,
                source_id: None,
                headers: RequestHeaders::default(),
            });
        }
    }
    let mut stmt = conn.prepare_cached(
        "SELECT id, config_json, epg_json FROM sources ORDER BY position, created_at, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (id, config_json, epg_json) = row?;
        let links: EpgLinks = serde_json::from_str(&epg_json).unwrap_or_default();
        let headers = serde_json::from_str::<serde_json::Value>(&config_json)
            .ok()
            .and_then(|v| v.get("headers").cloned())
            .and_then(|h| serde_json::from_value::<RequestHeaders>(h).ok())
            .unwrap_or_default();
        let disabled: HashSet<&str> = links.disabled_urls.iter().map(|s| s.trim()).collect();
        for u in links.detected_urls.iter().chain(links.manual_urls.iter()) {
            let u = u.trim();
            if u.is_empty() || disabled.contains(u) || !seen.insert(u.to_string()) {
                continue;
            }
            out.push(ConfiguredUrl {
                url: u.to_string(),
                origin: EpgOrigin::Source,
                source_id: Some(id.clone()),
                headers: headers.clone(),
            });
        }
    }
    Ok(out)
}

/// Ids of every source that lists `url` (detected or manual, not disabled),
/// in `position` order. [`configured_urls`] keeps only the first of them.
pub fn sources_listing(conn: &Connection, url: &str) -> CoreResult<Vec<String>> {
    let url = url.trim();
    let mut stmt =
        conn.prepare_cached("SELECT id, epg_json FROM sources ORDER BY position, created_at, id")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, epg_json) = row?;
        let links: EpgLinks = serde_json::from_str(&epg_json).unwrap_or_default();
        let listed = links
            .detected_urls
            .iter()
            .chain(links.manual_urls.iter())
            .any(|u| u.trim() == url);
        if listed && !links.disabled_urls.iter().any(|u| u.trim() == url) {
            out.push(id);
        }
    }
    Ok(out)
}

/// Stored state of one `epg_sources` row.
#[derive(Debug, Clone, Default)]
pub struct SourceRow {
    pub enabled: bool,
    pub last_fetch_at: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub channel_count: i64,
    pub program_count: i64,
    pub etag: Option<String>,
}

/// Reads the `epg_sources` row of `url`.
pub fn source_row(conn: &Connection, url: &str) -> CoreResult<Option<SourceRow>> {
    Ok(conn
        .query_row(
            "SELECT enabled, last_fetch_at, status, error, channel_count, program_count, etag
             FROM epg_sources WHERE url = ?1",
            [url],
            |r| {
                Ok(SourceRow {
                    enabled: r.get::<_, i64>(0)? != 0,
                    last_fetch_at: r.get(1)?,
                    status: r.get(2)?,
                    error: r.get(3)?,
                    channel_count: r.get(4)?,
                    program_count: r.get(5)?,
                    etag: r.get(6)?,
                })
            },
        )
        .optional()?)
}

/// Status list for `epg.sources`: every configured url joined with its row
/// (missing rows read as idle, enabled, empty).
pub fn list_status(
    conn: &Connection,
    configured: &[ConfiguredUrl],
) -> CoreResult<Vec<EpgSourceStatus>> {
    let mut rows: HashMap<String, SourceRow> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT url, enabled, last_fetch_at, status, error, channel_count, program_count, etag
             FROM epg_sources WHERE origin <> ?1",
        )?;
        let it = stmt.query_map([STAGING_ORIGIN], |r| {
            Ok((
                r.get::<_, String>(0)?,
                SourceRow {
                    enabled: r.get::<_, i64>(1)? != 0,
                    last_fetch_at: r.get(2)?,
                    status: r.get(3)?,
                    error: r.get(4)?,
                    channel_count: r.get(5)?,
                    program_count: r.get(6)?,
                    etag: r.get(7)?,
                },
            ))
        })?;
        for row in it {
            let (url, sr) = row?;
            rows.insert(url, sr);
        }
    }
    Ok(configured
        .iter()
        .map(|c| {
            let row = rows.remove(&c.url);
            let row = row.unwrap_or(SourceRow {
                enabled: true,
                status: "idle".into(),
                ..Default::default()
            });
            EpgSourceStatus {
                url: c.url.clone(),
                last_fetch_at: row.last_fetch_at,
                status: row.status.parse().unwrap_or(EpgFetchStatus::Idle),
                program_count: row.program_count,
                channel_count: row.channel_count,
                error: row.error,
                enabled: row.enabled,
                origin: c.origin,
                source_id: c.source_id.clone(),
            }
        })
        .collect())
}

/// Inserts the row of `c` if missing and refreshes its origin / source id.
pub fn ensure_row(conn: &Connection, c: &ConfiguredUrl) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO epg_sources(url, origin, source_id) VALUES (?1, ?2, ?3)
         ON CONFLICT(url) DO UPDATE SET origin = excluded.origin, source_id = excluded.source_id",
        params![c.url, c.origin.as_str(), c.source_id],
    )?;
    Ok(())
}

/// Sets `enabled` on the row of `c` (creating it).
pub fn set_enabled(conn: &Connection, c: &ConfiguredUrl, enabled: bool) -> CoreResult<()> {
    ensure_row(conn, c)?;
    conn.execute(
        "UPDATE epg_sources SET enabled = ?2 WHERE url = ?1",
        params![c.url, enabled as i64],
    )?;
    Ok(())
}

/// Sets the fetch status. `error` replaces the stored error (`None` clears it).
pub fn set_status(
    conn: &Connection,
    url: &str,
    status: EpgFetchStatus,
    error: Option<&str>,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE epg_sources SET status = ?2, error = ?3 WHERE url = ?1",
        params![url, status.as_str(), error],
    )?;
    Ok(())
}

/// Marks a 304: data unchanged, fetch time refreshed.
pub fn mark_not_modified(conn: &Connection, url: &str) -> CoreResult<()> {
    conn.execute(
        "UPDATE epg_sources SET status = 'ok', error = NULL, last_fetch_at = ?2 WHERE url = ?1",
        params![url, now_rfc3339()],
    )?;
    Ok(())
}

/// Removes staging rows of `url` (cascade deletes its staged channels and
/// programmes) and this connection's [`STAGE_TABLE`].
pub fn discard_staging(conn: &Connection, url: &str) -> CoreResult<()> {
    let key = staging_key(url);
    let deleted = conn.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [&key])?;
    conn.execute("DELETE FROM epg_sources WHERE url = ?1", [&key])?;
    conn.execute_batch(&format!("DROP TABLE IF EXISTS {STAGE_TABLE}"))?;
    if deleted > 0 {
        // A rebuild may have indexed them (guide search, C5).
        super::search::invalidate_index(conn)?;
    }
    Ok(())
}

/// Clears any previous staging for `url`, creates a fresh staging row and
/// an empty [`STAGE_TABLE`]. The caller decides where temp tables live:
/// `ingest::ingest_reader` puts them on disk (`temp_store=FILE`).
pub fn begin_staging(conn: &Connection, url: &str) -> CoreResult<String> {
    discard_staging(conn, url)?;
    let key = staging_key(url);
    conn.execute(
        "INSERT INTO epg_sources(url, enabled, origin, status) VALUES (?1, 0, ?2, 'fetching')",
        params![key, STAGING_ORIGIN],
    )?;
    conn.execute_batch(&format!(
        "CREATE TABLE {STAGE_TABLE} (channel_id TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL,
         title TEXT NOT NULL, description TEXT, category TEXT, icon TEXT)"
    ))?;
    Ok(key)
}

/// Buffers channels and programmes and writes them to staging in
/// transactions of [`BATCH`] rows.
pub struct StagingWriter<'c> {
    conn: &'c mut Connection,
    key: String,
    channels: Vec<XmltvChannel>,
    programmes: Vec<XmltvProgramme>,
    /// Distinct channels written.
    pub channel_count: u64,
    /// Programmes staged, repeated slots included ([`commit_staging`]
    /// returns the count stored).
    pub program_count: u64,
}

impl<'c> StagingWriter<'c> {
    pub fn new(conn: &'c mut Connection, key: String) -> Self {
        Self {
            conn,
            key,
            channels: Vec::with_capacity(256),
            programmes: Vec::with_capacity(BATCH),
            channel_count: 0,
            program_count: 0,
        }
    }

    pub fn push_channel(&mut self, c: XmltvChannel) -> CoreResult<()> {
        self.channels.push(c);
        if self.channels.len() >= BATCH {
            self.flush()?;
        }
        Ok(())
    }

    /// Adds a programme; returns true when a batch was committed.
    pub fn push_programme(&mut self, p: XmltvProgramme) -> CoreResult<bool> {
        self.programmes.push(p);
        if self.programmes.len() >= BATCH {
            self.flush()?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Writes everything buffered: channels in one transaction, programmes
    /// in another.
    pub fn flush(&mut self) -> CoreResult<()> {
        if !self.channels.is_empty() {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut ch = tx.prepare_cached(
                    "INSERT OR IGNORE INTO epg_channels(epg_url, channel_id, display_name, icon) VALUES (?1, ?2, ?3, ?4)",
                )?;
                for c in self.channels.drain(..) {
                    self.channel_count +=
                        ch.execute(params![self.key, c.id, c.display_name, c.icon])? as u64;
                }
            }
            tx.commit()?;
        }
        if !self.programmes.is_empty() {
            // P2-EPGRS-1: programmes go to the temp table, which has no
            // index and is never logged in the WAL. Staging them in
            // `epg_programs` under the staging key wrote every row and its
            // three index entries once, then the swap rewrote every row and
            // its slot index entry to re-key it, and the WAL carried both
            // into the checkpoint. On a 216k-programme feed that was 3.3-4.6
            // s of a 5.6-7.0 s ingest (Colab, 2 vCPUs); now 1.2-1.8 s. A
            // deferred transaction writes only the temp database, so this
            // takes no lock on the main one.
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Deferred)?;
            {
                let mut pr = tx.prepare_cached(&format!(
                    "INSERT INTO {STAGE_TABLE}(channel_id, start, stop, title, description, category, icon)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
                ))?;
                for p in self.programmes.drain(..) {
                    pr.execute(params![
                        p.channel,
                        p.start,
                        p.stop,
                        p.title,
                        p.description,
                        p.category,
                        p.icon
                    ])?;
                    self.program_count += 1;
                }
            }
            tx.commit()?;
        }
        Ok(())
    }
}

/// Index of [`STAGE_TABLE`] by slot, for matching stored programmes.
const STAGE_SLOT_INDEX: &str = "temp.epg_stage_slot";
/// Rowids of the stored programmes a swap replaces or drops.
const GONE_TABLE: &str = "temp.epg_gone";
/// A swap replaces only the programmes that changed while they are at most
/// this share (percent) of every stored programme; past it, it copies the
/// whole feed and rebuilds the search index. Matching costs a probe per
/// stored programme of the feed, and each changed one is deleted, inserted
/// and taken out of the index and put back. With every n-th title of a
/// 176k-programme feed edited (`epg_refresh_perf`), the diff held the
/// write lock 0.9-1.0 s against the copy's 1.2-1.3 s at a quarter, about
/// as long at a third to a half with 15-40% more WAL, and up to 1.4x as
/// long when every title changed. The copy also re-indexes every other
/// feed, so the share is of all of them: a small feed that changes
/// completely next to large ones is still diffed.
const MAX_DIFF_PERCENT: i64 = 25;

/// Swaps staging in for `url` in one transaction: staged programmes in
/// place of the stored ones, staged channels re-keyed, staging row removed,
/// status `ok` with counts, fetch time and etag. Returns the programmes
/// stored. [`STAGE_TABLE`] is left to the caller (`ingest_reader` closes
/// the temp database; dropping the table would first walk its pages).
///
/// A refresh 12 h after the last one changes a few percent of a feed: the
/// window moves on and a few listings are edited. The swap then deletes
/// and inserts only the programmes that changed and updates the guide
/// search index for them ([`diff_programmes`]). Deleting and copying the
/// whole feed, then rebuilding the index of every feed, held the write lock
/// and wrote the WAL for every programme.
pub fn commit_staging(
    conn: &mut Connection,
    url: &str,
    etag: Option<&str>,
    channels: u64,
) -> CoreResult<u64> {
    let key = staging_key(url);
    let slots_indexed = index_staged_slots(conn, url)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let programs = match diff_programmes(&tx, url, slots_indexed)? {
        Some(n) => n,
        None => replace_programmes(&tx, url)?,
    };
    tx.execute("DELETE FROM epg_channels WHERE epg_url = ?1", [url])?;
    tx.execute(
        "UPDATE epg_channels SET epg_url = ?1 WHERE epg_url = ?2",
        params![url, key],
    )?;
    tx.execute("DELETE FROM epg_sources WHERE url = ?1", [&key])?;
    tx.execute(
        "UPDATE epg_sources SET status = 'ok', error = NULL, last_fetch_at = ?2, channel_count = ?3,
         program_count = ?4, etag = ?5 WHERE url = ?1",
        params![url, now_rfc3339(), channels as i64, programs as i64, etag],
    )?;
    tx.commit()?;
    Ok(programs)
}

/// Indexes the staged programmes by slot when the swap may diff them
/// against stored ones: the search index can be updated in place and
/// `url` has programmes. Runs before the swap's transaction and writes only
/// the temp database, so it takes no lock on the main one.
fn index_staged_slots(conn: &Connection, url: &str) -> CoreResult<bool> {
    let stored = conn
        .prepare_cached("SELECT 1 FROM epg_programs WHERE epg_url = ?1 LIMIT 1")?
        .query_row([url], |_| Ok(()))
        .optional()?
        .is_some();
    if !stored || !super::search::can_update_in_place(conn)? {
        return Ok(false);
    }
    conn.execute_batch(&format!(
        "CREATE INDEX IF NOT EXISTS {STAGE_SLOT_INDEX} ON epg_stage(channel_id, start)"
    ))?;
    Ok(true)
}

/// Copies the staged programmes in, in rowid (feed) order. A feed that
/// lists a slot twice (same channel and start) keeps the first: the unique
/// index from migration 0007 makes the later one a no-op instead of an
/// error that would abort the import. The stored rows of `url` left at this
/// point (none, or those [`diff_programmes`] kept) each equal the first
/// staged row of their slot, so they turn that row into a no-op as well.
fn copy_staged(tx: &Connection, url: &str) -> CoreResult<u64> {
    Ok(tx.execute(
        &format!(
            "INSERT OR IGNORE INTO epg_programs(epg_url, channel_id, start, stop, title, description, category, icon)
             SELECT ?1, channel_id, start, stop, title, description, category, icon
             FROM {STAGE_TABLE} ORDER BY rowid"
        ),
        [url],
    )? as u64)
}

/// The whole feed: every stored programme of `url` deleted, every staged
/// one copied in. The guide search index no longer matches; `ingest_reader`
/// rebuilds it after the swap (C5).
fn replace_programmes(tx: &Connection, url: &str) -> CoreResult<u64> {
    tx.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [url])?;
    let programs = copy_staged(tx, url)?;
    super::search::invalidate_index(tx)?;
    Ok(programs)
}

/// The stored programmes of `url` that the staged feed dropped or changed:
/// those whose slot is not staged, or whose first staged row for the slot
/// (the one [`copy_staged`] keeps) differs in any column. `?2` caps the
/// count.
const GONE_SQL: &str = "SELECT p.rowid FROM epg_programs p
     WHERE p.epg_url = ?1 AND NOT EXISTS (
       SELECT 1 FROM temp.epg_stage s
       WHERE s.rowid = (SELECT min(rowid) FROM temp.epg_stage
                        WHERE channel_id = p.channel_id AND start = p.start)
         AND s.stop = p.stop AND s.title = p.title AND s.description IS p.description
         AND s.category IS p.category AND s.icon IS p.icon)
     LIMIT ?2";

/// Replaces only the stored programmes of `url` the staged feed dropped or
/// changed, and keeps the guide search index in step: those programmes
/// leave the index and are deleted, the staged ones are copied in (the
/// unchanged slots are no-ops), and the new rows are indexed. Unchanged
/// programmes keep their rows and rowids. Returns the programmes stored,
/// or `None`, having changed nothing that the copy does not redo, when the
/// whole feed should be copied instead: the index cannot be updated in
/// place, the staged slots were not indexed, the index does not track the
/// feed's rows, or more changed than [`MAX_DIFF_PERCENT`] allows.
fn diff_programmes(tx: &Connection, url: &str, slots_indexed: bool) -> CoreResult<Option<u64>> {
    if !super::search::can_update_in_place(tx)? {
        return Ok(None);
    }
    let (stored, all): (i64, i64) = tx.query_row(
        "SELECT (SELECT count(*) FROM epg_programs WHERE epg_url = ?1),
                (SELECT coalesce(sum(program_count), 0) FROM epg_sources WHERE origin <> ?2)",
        params![url, STAGING_ORIGIN],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut gone = 0;
    if stored > 0 {
        if !slots_indexed {
            return Ok(None);
        }
        let most = all.max(stored) * MAX_DIFF_PERCENT / 100;
        tx.execute_batch(&format!(
            "DROP TABLE IF EXISTS {GONE_TABLE}; CREATE TABLE {GONE_TABLE}(id INTEGER PRIMARY KEY);"
        ))?;
        gone = tx.execute(
            &format!("INSERT INTO {GONE_TABLE}(id) {GONE_SQL}"),
            params![url, most + 1],
        )? as i64;
        let diff =
            gone <= most && (gone == 0 || super::search::unindex(tx, GONE_TABLE, gone as u64)?);
        if diff {
            tx.execute(
                &format!("DELETE FROM epg_programs WHERE rowid IN (SELECT id FROM {GONE_TABLE})"),
                [],
            )?;
        }
        tx.execute_batch(&format!("DROP TABLE {GONE_TABLE}"))?;
        if !diff {
            return Ok(None);
        }
    }
    let last: i64 = tx.query_row(
        "SELECT coalesce(max(rowid), 0) FROM epg_programs",
        [],
        |r| r.get(0),
    )?;
    let added = copy_staged(tx, url)?;
    super::search::index_after(tx, last, added)?;
    Ok(Some((stored - gone) as u64 + added))
}

/// Boot cleanup: drops leftover staging rows and resets `fetching` (a crash
/// mid-import) to `idle`.
pub fn cleanup_on_boot(conn: &Connection) -> CoreResult<()> {
    let keys: Vec<String> = {
        let mut stmt = conn.prepare("SELECT url FROM epg_sources WHERE origin = ?1")?;
        let rows = stmt.query_map([STAGING_ORIGIN], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for key in keys {
        if conn.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [&key])? > 0 {
            super::search::invalidate_index(conn)?;
        }
        conn.execute("DELETE FROM epg_sources WHERE url = ?1", [&key])?;
    }
    conn.execute(
        "UPDATE epg_sources SET status = 'idle' WHERE status = 'fetching'",
        [],
    )?;
    Ok(())
}

/// Deletes rows (and their data) for urls no longer configured. Returns how many were removed.
pub fn prune(conn: &mut Connection, keep: &[ConfiguredUrl]) -> CoreResult<usize> {
    let keep: HashSet<&str> = keep.iter().map(|c| c.url.as_str()).collect();
    let stale: Vec<String> = {
        let mut stmt = conn.prepare("SELECT url FROM epg_sources WHERE origin <> ?1")?;
        let rows = stmt.query_map([STAGING_ORIGIN], |r| r.get::<_, String>(0))?;
        rows.filter_map(Result::ok)
            .filter(|u| !keep.contains(u.as_str()))
            .collect()
    };
    if stale.is_empty() {
        return Ok(0);
    }
    // The index marker goes in the same transaction as the programmes. As
    // separate writes, a rebuild on another connection (after a refresh)
    // could run between them and mark an index that still holds the pruned
    // programmes as matching; refreshes that update the index in place
    // would then keep their entries, and give their rowids to new rows.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    super::search::invalidate_index(&tx)?;
    for url in &stale {
        tx.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [url])?;
        tx.execute("DELETE FROM epg_sources WHERE url = ?1", [url])?;
    }
    tx.commit()?;
    Ok(stale.len())
}

/// `epg.clearAll`: deletes every stored programme and guide channel in one
/// transaction and resets each configured url's status (idle, zero counts, no
/// error, no etag so the next refresh downloads the full feed). Urls,
/// enabled flags, `last_fetch_at` (so the scheduler does not immediately
/// re-download) and manual channel mappings are kept. Staging rows of a
/// refresh that is running right now are left alone. Returns the number of
/// programmes deleted.
pub fn clear_all(conn: &mut Connection) -> CoreResult<usize> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let live = "SELECT url FROM epg_sources WHERE origin <> ?1";
    let programs = tx.execute(
        &format!("DELETE FROM epg_programs WHERE epg_url IN ({live})"),
        [STAGING_ORIGIN],
    )?;
    tx.execute(
        &format!("DELETE FROM epg_channels WHERE epg_url IN ({live})"),
        [STAGING_ORIGIN],
    )?;
    tx.execute(
        "UPDATE epg_sources SET status = 'idle', error = NULL, etag = NULL, channel_count = 0,
         program_count = 0 WHERE origin <> ?1",
        [STAGING_ORIGIN],
    )?;
    super::search::invalidate_index(&tx)?;
    tx.commit()?;
    Ok(programs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prog(channel: &str, start: i64, title: &str) -> XmltvProgramme {
        XmltvProgramme {
            channel: channel.into(),
            start,
            stop: start + 1800,
            title: title.into(),
            description: None,
            category: None,
            icon: None,
        }
    }

    fn count(conn: &Connection, url: &str) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM epg_programs WHERE epg_url = ?1",
            [url],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// B8-parsers D20 / B9-D37: a feed listing a slot twice stored both rows.
    /// The repeat is now ignored (first wins, as the queries showed), it is
    /// not counted, and it never aborts the batch.
    #[test]
    fn duplicate_programmes_are_stored_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        let url = "http://e/g.xml";
        conn.execute("INSERT INTO epg_sources(url) VALUES (?1)", [url])
            .unwrap();
        let key = begin_staging(&conn, url).unwrap();
        {
            let mut w = StagingWriter::new(&mut conn, key);
            w.push_programme(prog("a", 1000, "First")).unwrap();
            w.push_programme(prog("a", 1000, "Repeat")).unwrap();
            w.push_programme(prog("a", 1000, "First")).unwrap();
            w.push_programme(prog("a", 2800, "Next")).unwrap();
            w.push_programme(prog("b", 1000, "Other channel")).unwrap();
            w.flush().unwrap();
            // A repeat in a later batch is ignored too.
            w.push_programme(prog("a", 2800, "Late repeat")).unwrap();
            w.flush().unwrap();
        }
        let n = commit_staging(&mut conn, url, None, 0).unwrap();
        assert_eq!(n, 3);
        assert_eq!(count(&conn, url), 3);
        let stored: i64 = conn
            .query_row(
                "SELECT program_count FROM epg_sources WHERE url = ?1",
                [url],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, 3);
        let title = |start: i64| -> String {
            conn.query_row(
                "SELECT title FROM epg_programs WHERE epg_url = ?1 AND channel_id = 'a' AND start = ?2",
                params![url, start],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(title(1000), "First");
        assert_eq!(title(2800), "Next");
    }

    use crate::epg::search;

    fn guide(urls: &[&str]) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        for url in urls {
            conn.execute("INSERT INTO epg_sources(url) VALUES (?1)", [url])
                .unwrap();
        }
        conn
    }

    /// Stages `progs` for `url` and swaps them in. Returns the programmes
    /// stored and whether the search index was kept in step (not marked
    /// stale), then brings the index up to date as `ingest_reader` does.
    fn refresh(conn: &mut Connection, url: &str, progs: &[XmltvProgramme]) -> (u64, bool) {
        let key = begin_staging(conn, url).unwrap();
        {
            let mut w = StagingWriter::new(conn, key);
            for p in progs {
                w.push_programme(p.clone()).unwrap();
            }
            w.flush().unwrap();
        }
        let n = commit_staging(conn, url, None, 0).unwrap();
        let in_place = search::index_ready(conn).unwrap();
        search::refresh_index(conn);
        assert!(search::index_ready(conn).unwrap());
        let stored: i64 = conn
            .query_row(
                "SELECT program_count FROM epg_sources WHERE url = ?1",
                [url],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((stored, count(conn, url)), (n as i64, n as i64));
        (n, in_place)
    }

    /// `(channel, start)` -> (rowid, title) of the stored programmes of `url`.
    fn rows(conn: &Connection, url: &str) -> HashMap<(String, i64), (i64, String)> {
        conn.prepare("SELECT channel_id, start, rowid, title FROM epg_programs WHERE epg_url = ?1")
            .unwrap()
            .query_map([url], |r| {
                Ok(((r.get(0)?, r.get(1)?), (r.get(2)?, r.get(3)?)))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    type Terms = Vec<(String, i64, i64)>;
    type SearchRows = Vec<(i64, i64, i64, i64, String)>;

    /// Every token instance the title index holds, as FTS5 reads it back,
    /// and every search row.
    fn index_snapshot(conn: &Connection) -> (Terms, SearchRows) {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_terms
             USING fts5vocab(main, epg_programs_fts, instance)",
        )
        .unwrap();
        let terms = conn
            .prepare("SELECT term, doc, offset FROM temp.fts_terms ORDER BY doc, offset")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let rows = conn
            .prepare("SELECT id, start, stop, feed, channel_id FROM epg_search_rows ORDER BY id")
            .unwrap()
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        (terms, rows)
    }

    /// The index kept in step row by row is consistent and equals what a
    /// rebuild makes of the same table.
    fn assert_index_matches_a_rebuild(conn: &mut Connection) {
        conn.execute(
            "INSERT INTO epg_programs_fts(epg_programs_fts) VALUES('integrity-check')",
            [],
        )
        .unwrap();
        let kept = index_snapshot(conn);
        assert_eq!(kept.1.len() as i64, count_all(conn));
        search::invalidate_index(conn).unwrap();
        search::rebuild_index(conn).unwrap();
        assert_eq!(index_snapshot(conn), kept);
    }

    fn count_all(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM epg_programs", [], |r| r.get(0))
            .unwrap()
    }

    /// Rowids of the programmes whose title matches `query` through the index.
    fn matches(conn: &Connection, query: &str) -> Vec<i64> {
        conn.prepare(
            "SELECT rowid FROM epg_programs_fts WHERE epg_programs_fts MATCH ?1 ORDER BY rowid",
        )
        .unwrap()
        .query_map([search::fts_expression(&search::words(query))], |r| {
            r.get(0)
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// Two channels, 48 half-hour slots each, starting at `from`.
    fn day(from: i64, to: i64) -> Vec<XmltvProgramme> {
        let mut out = Vec::new();
        for (ch, name) in [("a", "Show"), ("b", "Film")] {
            for i in from..to {
                out.push(prog(ch, i * 1800, &format!("{name} {i}")));
            }
        }
        out
    }

    /// A refresh 12 h later: the window moves on, a title and a
    /// description change, and a slot is listed twice with the stored row
    /// second. Only those programmes are replaced; the rest keep their rows,
    /// the other feed's index is left alone, and the index ends up as a
    /// rebuild would make it.
    #[test]
    fn a_refresh_replaces_only_the_programmes_that_changed() {
        let mut conn = guide(&["u", "other"]);
        let other = vec![prog("x", 0, "Other News"), prog("x", 1800, "Other Film")];
        refresh(&mut conn, "other", &other);
        let other_feed: i64 = conn
            .query_row(
                "SELECT rowid FROM epg_sources WHERE url = 'other'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let of_other = |conn: &Connection| -> SearchRows {
            let rows = index_snapshot(conn).1;
            rows.into_iter().filter(|r| r.3 == other_feed).collect()
        };
        let other_rows = of_other(&conn);
        assert_eq!(other_rows.len(), 2);
        assert_eq!(refresh(&mut conn, "u", &day(0, 48)), (96, true));
        let before = rows(&conn, "u");

        let mut next = day(4, 52);
        let slot = |next: &[XmltvProgramme], ch: &str, start: i64| {
            next.iter()
                .position(|p| p.channel == ch && p.start == start)
                .unwrap()
        };
        let i = slot(&next, "a", 30 * 1800);
        next[i].title = "Show 30 moved".into();
        let i = slot(&next, "a", 31 * 1800);
        next[i].description = Some("Now with notes".into());
        let i = slot(&next, "b", 40 * 1800);
        next.insert(i, prog("b", 40 * 1800, "Film 40 changed"));
        assert_eq!(refresh(&mut conn, "u", &next), (96, true));

        let after = rows(&conn, "u");
        let changed = [("a", 30), ("a", 31), ("b", 40)];
        let newest = before.values().map(|v| v.0).max().unwrap();
        for ((ch, start), (rowid, title)) in &after {
            let slot = start / 1800;
            if slot >= 48 || changed.contains(&(ch.as_str(), slot)) {
                assert!(*rowid > newest, "{ch} {slot} is a new row");
            } else {
                assert_eq!(before[&(ch.clone(), *start)], (*rowid, title.clone()));
            }
        }
        assert!(!after.contains_key(&("a".to_string(), 0)), "dropped");
        assert_eq!(after[&("b".to_string(), 40 * 1800)].1, "Film 40 changed");
        assert_eq!(of_other(&conn), other_rows, "the other feed is left alone");
        assert_eq!(matches(&conn, "film 40 changed").len(), 1);
        assert_eq!(
            matches(&conn, "moved"),
            vec![after[&("a".to_string(), 30 * 1800)].0]
        );
        assert!(matches(&conn, "show 0").is_empty());
        let other_ids: Vec<i64> = other_rows.iter().map(|r| r.0).collect();
        assert_eq!(matches(&conn, "other"), other_ids);
        assert_index_matches_a_rebuild(&mut conn);
    }

    /// When most of the stored guide changes, the swap copies the whole
    /// feed and the index is rebuilt. A small feed that changes completely
    /// next to a large one is still diffed: the copy would re-index both.
    #[test]
    fn a_refresh_that_changes_most_of_the_guide_copies_the_feed() {
        let renamed = |progs: Vec<XmltvProgramme>| -> Vec<XmltvProgramme> {
            progs
                .into_iter()
                .map(|mut p| {
                    p.title = format!("Renamed {}", p.title);
                    p
                })
                .collect()
        };
        let mut conn = guide(&["u"]);
        refresh(&mut conn, "u", &day(0, 48));
        assert_eq!(refresh(&mut conn, "u", &renamed(day(0, 48))), (96, false));
        assert_eq!(matches(&conn, "renamed").len(), 96);

        let mut conn = guide(&["big", "small"]);
        refresh(&mut conn, "big", &day(0, 300));
        refresh(&mut conn, "small", &day(0, 10));
        assert_eq!(
            refresh(&mut conn, "small", &renamed(day(0, 10))),
            (20, true)
        );
        assert_eq!(matches(&conn, "renamed").len(), 20);
        assert_index_matches_a_rebuild(&mut conn);
    }

    /// Titles leave the index folded as they went in: Greek with its tonos
    /// and Vietnamese, which the FTS5 tokenizer alone would not fold.
    #[test]
    fn edited_non_latin_titles_leave_the_index() {
        let mut conn = guide(&["u"]);
        let mut progs = day(0, 10);
        progs[0].title = "Ελληνικά Νέα".into();
        progs[1].title = "Thời sự".into();
        refresh(&mut conn, "u", &progs);
        assert_eq!(matches(&conn, "ελληνικα").len(), 1);
        progs[0].title = "Αθλητικά".into();
        progs[1].title = "Tin tức".into();
        assert_eq!(refresh(&mut conn, "u", &progs), (20, true));
        assert!(matches(&conn, "ελληνικα").is_empty());
        assert!(matches(&conn, "thoi su").is_empty());
        assert_eq!(matches(&conn, "αθλητικα").len(), 1);
        assert_eq!(matches(&conn, "tin tuc").len(), 1);
        assert_index_matches_a_rebuild(&mut conn);
    }

    /// After [`search::MAX_IN_PLACE_UPDATES`] in-place updates the next
    /// refresh copies the feed, and the rebuild starts the count again.
    #[test]
    fn in_place_updates_give_way_to_a_rebuild() {
        let mut conn = guide(&["u"]);
        refresh(&mut conn, "u", &day(0, 48));
        let updates = |conn: &Connection| -> Option<i64> {
            conn.query_row(
                "SELECT CAST(value AS INTEGER) FROM app_state WHERE key = ?1",
                [search::IN_PLACE_KEY],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
        };
        assert_eq!(updates(&conn), None);
        assert!(refresh(&mut conn, "u", &day(1, 49)).1);
        assert_eq!(updates(&conn), Some(1));
        conn.execute(
            "UPDATE app_state SET value = ?2 WHERE key = ?1",
            params![search::IN_PLACE_KEY, search::MAX_IN_PLACE_UPDATES - 1],
        )
        .unwrap();
        assert!(refresh(&mut conn, "u", &day(2, 50)).1);
        assert_eq!(updates(&conn), Some(search::MAX_IN_PLACE_UPDATES));
        assert_eq!(refresh(&mut conn, "u", &day(3, 51)), (96, false));
        assert_eq!(updates(&conn), None);
        assert!(refresh(&mut conn, "u", &day(4, 52)).1);
    }

    /// A stored programme the index does not track (written around the
    /// swap) cannot be taken out of it: the refresh copies the feed instead,
    /// and the rebuild sets the index right.
    #[test]
    fn a_programme_missing_from_the_index_sends_the_refresh_to_a_copy() {
        let mut conn = guide(&["u"]);
        refresh(&mut conn, "u", &day(0, 48));
        conn.execute(
            "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('u', 'c', 0, 1800, 'Stray')",
            [],
        )
        .unwrap();
        assert_eq!(refresh(&mut conn, "u", &day(1, 49)), (96, false));
        assert!(matches(&conn, "stray").is_empty());
        assert_index_matches_a_rebuild(&mut conn);
    }

    /// Programmes deleted while the index still counted them leave their
    /// search rows above the stored rowids, where the next refresh's new
    /// rows go. That refresh has the index rebuilt instead of failing on
    /// the search rows' key (and every refresh after it the same way).
    #[test]
    fn search_rows_left_above_the_programmes_send_the_refresh_to_a_rebuild() {
        let mut conn = guide(&["u", "gone"]);
        refresh(&mut conn, "u", &day(0, 48));
        refresh(&mut conn, "gone", &day(0, 48));
        conn.execute("DELETE FROM epg_programs WHERE epg_url = 'gone'", [])
            .unwrap();
        assert!(search::index_ready(&conn).unwrap());
        assert_eq!(refresh(&mut conn, "u", &day(4, 52)), (96, false));
        assert_eq!(matches(&conn, "film 50").len(), 1);
        assert_index_matches_a_rebuild(&mut conn);
    }

    /// A swap that fails part-way (the process stopped, the disk full)
    /// leaves the stored programmes, their rowids, the index and its marker
    /// as they were; the next refresh updates them in place as usual.
    #[test]
    fn a_failed_swap_leaves_the_guide_and_its_index_as_they_were() {
        let mut conn = guide(&["u"]);
        refresh(&mut conn, "u", &day(0, 48));
        let before = (rows(&conn, "u"), index_snapshot(&conn));
        conn.execute_batch(
            "CREATE TEMP TRIGGER fail_swap BEFORE INSERT ON epg_search_rows
             BEGIN SELECT RAISE(ABORT, 'stopped'); END",
        )
        .unwrap();
        let key = begin_staging(&conn, "u").unwrap();
        {
            let mut w = StagingWriter::new(&mut conn, key);
            for p in day(4, 52) {
                w.push_programme(p).unwrap();
            }
            w.flush().unwrap();
        }
        assert!(commit_staging(&mut conn, "u", None, 0).is_err());
        assert!(search::index_ready(&conn).unwrap());
        assert_eq!((rows(&conn, "u"), index_snapshot(&conn)), before);
        conn.execute_batch("DROP TRIGGER fail_swap").unwrap();
        assert_index_matches_a_rebuild(&mut conn);
        assert_eq!(refresh(&mut conn, "u", &day(4, 52)), (96, true));
        assert_index_matches_a_rebuild(&mut conn);
    }

    /// Two feeds listing the same channels and slots: refreshing one
    /// replaces only its own programmes and search rows.
    #[test]
    fn feeds_sharing_channels_are_refreshed_apart() {
        let mut conn = guide(&["u", "v"]);
        refresh(&mut conn, "u", &day(0, 48));
        refresh(&mut conn, "v", &day(0, 48));
        let v_rows = rows(&conn, "v");
        let v_feed: i64 = conn
            .query_row("SELECT rowid FROM epg_sources WHERE url = 'v'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let of_v = |conn: &Connection| -> SearchRows {
            let rows = index_snapshot(conn).1;
            rows.into_iter().filter(|r| r.3 == v_feed).collect()
        };
        let v_index = of_v(&conn);
        assert_eq!(v_index.len(), 96);
        let mut next = day(4, 52);
        next[10].title = "Show 14 moved".into();
        assert_eq!(refresh(&mut conn, "u", &next), (96, true));
        assert_eq!(rows(&conn, "v"), v_rows);
        assert_eq!(of_v(&conn), v_index);
        assert_eq!(matches(&conn, "show 14").len(), 2);
        assert_eq!(matches(&conn, "moved").len(), 1);
        assert_eq!(matches(&conn, "show 0").len(), 1, "v keeps its slot");
        assert_index_matches_a_rebuild(&mut conn);
    }

    /// A prune removes the index marker and the programmes of the urls no
    /// longer configured in one transaction: a rebuild on another
    /// connection cannot run between the two and mark an index that still
    /// holds the pruned programmes as matching. A failure part-way keeps
    /// both.
    #[test]
    fn a_prune_is_one_transaction() {
        let mut conn = guide(&["a", "b", "keep"]);
        for url in ["a", "b", "keep"] {
            refresh(&mut conn, url, &day(0, 4));
        }
        let keep = [ConfiguredUrl {
            url: "keep".into(),
            origin: EpgOrigin::Settings,
            source_id: None,
            headers: RequestHeaders::default(),
        }];
        conn.execute_batch(
            "CREATE TEMP TRIGGER fail_prune BEFORE DELETE ON epg_sources WHEN old.url = 'b'
             BEGIN SELECT RAISE(ABORT, 'stopped'); END",
        )
        .unwrap();
        assert!(prune(&mut conn, &keep).is_err());
        assert!(search::index_ready(&conn).unwrap());
        assert_eq!((count(&conn, "a"), count(&conn, "b")), (8, 8));
        conn.execute_batch("DROP TRIGGER fail_prune").unwrap();
        assert_eq!(prune(&mut conn, &keep).unwrap(), 2);
        assert!(!search::index_ready(&conn).unwrap());
        assert_eq!((count(&conn, "a"), count(&conn, "b")), (0, 0));
        assert_eq!(count(&conn, "keep"), 8);
    }

    /// The diff's statements read the stored programmes through the slot
    /// index and each staged and replaced row by its key.
    #[test]
    fn the_diff_reads_through_indexes() {
        let conn = guide(&["u"]);
        begin_staging(&conn, "u").unwrap();
        conn.execute_batch(&format!(
            "CREATE INDEX {STAGE_SLOT_INDEX} ON epg_stage(channel_id, start);
             CREATE TABLE {GONE_TABLE}(id INTEGER PRIMARY KEY);"
        ))
        .unwrap();
        search::register_fold(&conn).unwrap();
        let plan = |sql: &str| -> Vec<String> {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let args = vec![rusqlite::types::Null; stmt.parameter_count()];
            stmt.query_map(rusqlite::params_from_iter(args), |r| r.get(3))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let gone = plan(GONE_SQL);
        for want in [
            "SEARCH p USING INDEX idx_epg_programs_slot (epg_url=?)",
            "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
            "SEARCH temp.epg_stage USING COVERING INDEX epg_stage_slot (channel_id=? AND start=?)",
        ] {
            assert!(gone.iter().any(|d| d == want), "{want}: {gone:?}");
        }
        for (sql, want) in [
            (
                "DELETE FROM epg_programs WHERE rowid IN (SELECT id FROM temp.epg_gone)",
                "SEARCH epg_programs USING INTEGER PRIMARY KEY (rowid=?)",
            ),
            (
                "DELETE FROM epg_search_rows WHERE id IN (SELECT id FROM temp.epg_gone)",
                "SEARCH epg_search_rows USING INTEGER PRIMARY KEY (rowid=?)",
            ),
            (
                "SELECT p.title FROM temp.epg_gone g CROSS JOIN epg_programs p ON p.rowid = g.id",
                "SEARCH p USING INTEGER PRIMARY KEY (rowid=?)",
            ),
            (
                "SELECT p.rowid FROM epg_programs p JOIN epg_sources s ON s.url = p.epg_url WHERE p.rowid > ?1",
                "SEARCH p USING INTEGER PRIMARY KEY (rowid>?)",
            ),
            (
                "SELECT EXISTS (SELECT 1 FROM epg_search_rows WHERE id > ?1)",
                "SEARCH epg_search_rows USING INTEGER PRIMARY KEY (rowid>?)",
            ),
        ] {
            let plan = plan(sql);
            assert!(plan.iter().any(|d| d == want), "{sql}: {plan:?}");
        }
    }

    /// Migration 0007 drops the cached guide (which may hold duplicates from
    /// older builds), adds the unique index and resets the fetch state so the
    /// next refresh refills it.
    #[test]
    fn migration_0007_clears_the_cached_guide_and_adds_the_unique_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        for m in crate::db::MIGRATIONS.iter().filter(|m| m.version < 7) {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
                [m.version],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO epg_sources(url, last_fetch_at, etag, program_count) VALUES ('u', '2026-01-01T00:00:00Z', 'e', 5)",
            [],
        )
        .unwrap();
        for (ch, start, title) in [
            ("a", 1000, "First"),
            ("a", 1000, "Repeat"),
            ("a", 1000, "Repeat"),
            ("a", 2800, "Next"),
            ("b", 1000, "Other"),
        ] {
            conn.execute(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('u', ?1, ?2, ?3, ?4)",
                params![ch, start, start + 1800, title],
            )
            .unwrap();
        }
        crate::db::migrate(&mut conn).unwrap();
        assert_eq!(count(&conn, "u"), 0);
        let fetch: (Option<String>, Option<String>, i64) = conn
            .query_row(
                "SELECT last_fetch_at, etag, program_count FROM epg_sources WHERE url = 'u'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(fetch, (None, None, 0), "the next refresh refetches");
        conn.execute(
            "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('u', 'a', 1000, 1, 'First')",
            [],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('u', 'a', 1000, 1, 'x')",
            [],
        );
        assert!(
            dup.is_err(),
            "the unique index rejects a plain duplicate insert"
        );
    }
}
