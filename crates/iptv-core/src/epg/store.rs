//! EPG tables (C3): `epg_sources`, `epg_channels`, `epg_programs`.
//!
//! Ingestion writes channels under a staging key (`<url>\u{1}staging`, with
//! its own hidden `epg_sources` row, `origin = 'staging'`, `enabled = 0`) and
//! programmes into the connection's temp table [`STAGE_TABLE`], in
//! transactions of [`BATCH`] rows, then [`commit_staging`] swaps both in for
//! the real url inside one transaction. Readers never see a half-imported
//! feed, and a failed import leaves the previous data untouched.

use super::search::SwapUpkeep;
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

/// Swaps staging in for `url` in one transaction: old rows deleted, staged
/// channels re-keyed, staged programmes copied in, staging row removed,
/// status `ok` with counts, fetch time and etag. Returns the programmes
/// stored. [`STAGE_TABLE`] is left to the caller (`ingest_reader` closes
/// the temp database; dropping the table would first walk its pages).
///
/// A guide search index that matched the table still matches it after the
/// swap, kept in step inside this transaction ([`SwapUpkeep`]): the feed's
/// old entries and search rows go before its programmes and the new ones
/// are written after the copy, or the whole index is written again when
/// that costs less. A stale one stays marked stale and is rebuilt after the
/// swap (C5). So does one whose upkeep failed ([`index_step`]): the index
/// never fails the swap.
pub fn commit_staging(
    conn: &mut Connection,
    url: &str,
    etag: Option<&str>,
    channels: u64,
) -> CoreResult<u64> {
    let key = staging_key(url);
    super::search::register_fold(conn)?;
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut upkeep = swap_upkeep(&tx, url)?;
    if let Some(u) = upkeep {
        if !index_step(&mut tx, |c| super::search::unindex_before_swap(c, url, u))? {
            upkeep = None;
        }
    }
    tx.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [url])?;
    tx.execute("DELETE FROM epg_channels WHERE epg_url = ?1", [url])?;
    // A feed that lists a slot twice (same channel and start) keeps the
    // first: the old rows of `url` are gone, so the unique index from
    // migration 0007 only meets the feed's own repeats, and copying in
    // rowid (feed) order makes the later one the no-op instead of an error
    // that would abort the import.
    let programs = tx.execute(
        &format!(
            "INSERT OR IGNORE INTO epg_programs(epg_url, channel_id, start, stop, title, description, category, icon)
             SELECT ?1, channel_id, start, stop, title, description, category, icon
             FROM {STAGE_TABLE} ORDER BY rowid"
        ),
        [url],
    )? as u64;
    tx.execute(
        "UPDATE epg_channels SET epg_url = ?1 WHERE epg_url = ?2",
        params![url, key],
    )?;
    tx.execute("DELETE FROM epg_sources WHERE url = ?1", [&key])?;
    let kept = match upkeep {
        Some(u) => index_step(&mut tx, |c| super::search::index_after_swap(c, url, u))?,
        None => false,
    };
    if !kept {
        // The guide search index was stale already, or its upkeep failed:
        // rebuilt after the swap, starting from 'delete-all'.
        super::search::invalidate_index(&tx)?;
    }
    tx.execute(
        "UPDATE epg_sources SET status = 'ok', error = NULL, last_fetch_at = ?2, channel_count = ?3,
         program_count = ?4, etag = ?5 WHERE url = ?1",
        params![url, now_rfc3339(), channels as i64, programs as i64, etag],
    )?;
    tx.commit()?;
    Ok(programs)
}

/// Runs one guide search index step of a swap under a savepoint and says
/// whether it held. The index is only a cache of the programme table: a step
/// that fails (a corrupt FTS5 index answers its per-row `'delete'` with
/// SQLITE_CORRUPT_VTAB) is rolled back and logged, and the swap goes on with
/// the index marked stale (RB-F review). Failing the swap instead failed
/// every later refresh of the feed, and with the per-feed upkeep chosen on
/// each one, nothing rebuilt the index any more. When SQLite rolled the whole
/// transaction back (a full disk, an I/O error), the error is returned.
fn index_step(
    tx: &mut rusqlite::Transaction<'_>,
    step: impl FnOnce(&Connection) -> CoreResult<()>,
) -> CoreResult<bool> {
    let result = (|| {
        let sp = tx.savepoint()?;
        step(&sp)?;
        sp.commit()?;
        CoreResult::Ok(())
    })();
    match result {
        Ok(()) => Ok(true),
        Err(e) if tx.is_autocommit() => Err(e),
        Err(e) => {
            tracing::warn!(error = %e, "could not keep the guide search index in step; it is rebuilt after the swap");
            Ok(false)
        }
    }
}

/// How the swap of `url` keeps the guide search index in step: `None` while
/// the index is stale, else [`SwapUpkeep::choose`] on the feed's stored
/// programme count, the staged rows (the rowids of [`STAGE_TABLE`] count up
/// from one) and the other feeds' stored counts. The counts
/// (`program_count`) only steer the cost: either upkeep leaves the index a
/// rebuild would write.
fn swap_upkeep(conn: &Connection, url: &str) -> CoreResult<Option<SwapUpkeep>> {
    if !super::search::index_ready(conn)? {
        return Ok(None);
    }
    let (old, others): (i64, i64) = conn.query_row(
        "SELECT coalesce(sum(program_count) FILTER (WHERE url = ?1), 0),
                coalesce(sum(program_count) FILTER (WHERE url <> ?1), 0)
         FROM epg_sources WHERE origin <> ?2",
        params![url, STAGING_ORIGIN],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let new: i64 = conn.query_row(
        &format!("SELECT coalesce(max(rowid), 0) FROM {STAGE_TABLE}"),
        [],
        |r| r.get(0),
    )?;
    Ok(Some(SwapUpkeep::choose(old, new, others)))
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
pub fn prune(conn: &Connection, keep: &[ConfiguredUrl]) -> CoreResult<usize> {
    let keep: HashSet<&str> = keep.iter().map(|c| c.url.as_str()).collect();
    let stale: Vec<String> = {
        let mut stmt = conn.prepare("SELECT url FROM epg_sources WHERE origin <> ?1")?;
        let rows = stmt.query_map([STAGING_ORIGIN], |r| r.get::<_, String>(0))?;
        rows.filter_map(Result::ok)
            .filter(|u| !keep.contains(u.as_str()))
            .collect()
    };
    if !stale.is_empty() {
        // Before the deletes: a failure part-way leaves the index marked stale.
        super::search::invalidate_index(conn)?;
    }
    for url in &stale {
        conn.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [url])?;
        conn.execute("DELETE FROM epg_sources WHERE url = ?1", [url])?;
    }
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

    /// Stages `progs` for `url` and swaps them in; returns the search index
    /// upkeep the swap chose (`None`: the index was stale).
    fn refresh(
        conn: &mut Connection,
        url: &str,
        progs: &[(&str, i64, &str)],
    ) -> Option<SwapUpkeep> {
        let key = begin_staging(conn, url).unwrap();
        {
            let mut w = StagingWriter::new(conn, key);
            for (channel, start, title) in progs {
                w.push_programme(prog(channel, *start, title)).unwrap();
            }
            w.flush().unwrap();
        }
        let upkeep = swap_upkeep(conn, url).unwrap();
        commit_staging(conn, url, None, 0).unwrap();
        upkeep
    }

    type Terms = Vec<(String, i64, String, i64)>;
    type SearchRows = Vec<(i64, i64, i64, i64, String)>;
    type IndexState = (Terms, Vec<(i64, Vec<u8>)>, Vec<u8>, SearchRows);

    /// Everything guide search reads of its index: each term instance
    /// (term, rowid, column, offset), each row's token count, the totals
    /// record, and the search rows.
    fn index_state(conn: &Connection) -> IndexState {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_terms USING fts5vocab(main, epg_programs_fts, instance)",
        )
        .unwrap();
        let terms = conn
            .prepare("SELECT term, doc, col, offset FROM temp.fts_terms ORDER BY 1, 2, 3, 4")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let sizes = conn
            .prepare("SELECT id, sz FROM epg_programs_fts_docsize ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let totals = conn
            .query_row(
                "SELECT block FROM epg_programs_fts_data WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let rows = conn
            .prepare("SELECT id, start, stop, feed, channel_id FROM epg_search_rows ORDER BY id")
            .unwrap()
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        (terms, sizes, totals, rows)
    }

    /// The index kept by the swaps is the index a full rebuild writes.
    fn assert_matches_a_rebuild(conn: &mut Connection, step: &str) {
        assert!(super::super::search::index_ready(conn).unwrap(), "{step}");
        let kept = index_state(conn);
        assert!(!kept.0.is_empty() || kept.3.is_empty(), "{step}");
        super::super::search::rebuild_index(conn).unwrap();
        assert_eq!(index_state(conn), kept, "{step}");
    }

    /// R2-1: a swap keeps a matching guide search index matching in its own
    /// transaction, feed by feed (old entries removed with the titles folded
    /// as they were indexed, new ones added) or, when the other feeds hold
    /// too few programmes, by writing it all again; either way the result is
    /// exactly what a rebuild writes (terms, token counts, totals and search
    /// rows), through several swaps in a row, with case, diacritics, Greek,
    /// Vietnamese, punctuation and repeated slots. A stale index stays stale
    /// for the rebuild.
    #[test]
    fn swaps_keep_the_search_index_feed_by_feed() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        for url in ["a", "b", "c"] {
            conn.execute("INSERT INTO epg_sources(url) VALUES (?1)", [url])
                .unwrap();
        }
        let titles = |tag: &str| -> Vec<String> {
            [
                "Café Society",
                "CAFE SOCIETY",
                "Ελληνικά ΕΙΔΗΣΕΙΣ",
                "Thời sự",
                "Le Journal-de 20h!",
                "news",
            ]
            .iter()
            .map(|t| format!("{t} {tag}"))
            .collect()
        };
        let feed =
            |tag: &str, channels: &[&'static str], n: i64| -> Vec<(&'static str, i64, String)> {
                let t = titles(tag);
                let mut out = Vec::new();
                for ch in channels {
                    for i in 0..n {
                        out.push((
                            *ch,
                            1_800_000_000 + i * 1800,
                            t[i as usize % t.len()].clone(),
                        ));
                    }
                }
                out
            };
        let swap = |conn: &mut Connection, url: &str, progs: &[(&'static str, i64, String)]| {
            let progs: Vec<(&str, i64, &str)> =
                progs.iter().map(|(c, s, t)| (*c, *s, t.as_str())).collect();
            refresh(conn, url, &progs)
        };
        use SwapUpkeep::{Feed, Whole};
        assert_eq!(swap(&mut conn, "a", &feed("alpha", &["x", "y"], 8)), None);
        assert_eq!(swap(&mut conn, "b", &feed("beta", &["x", "z"], 6)), None);
        assert!(!super::super::search::index_ready(&conn).unwrap());
        super::super::search::rebuild_index(&mut conn).unwrap();

        // A new feed (5 against 28 elsewhere), a feed replaced by other
        // titles with a repeated slot (12 -> 5 against 21), then a feed
        // emptied while the others hold too few (16 -> 0 against 9).
        assert_eq!(swap(&mut conn, "c", &feed("gamma", &["y"], 5)), Some(Feed));
        let mut beta = feed("Δέλτα", &["x"], 4);
        beta.push(("x", 1_800_000_000, "Repeat ignored".into()));
        assert_eq!(swap(&mut conn, "b", &beta), Some(Feed));
        assert_matches_a_rebuild(&mut conn, "feed by feed");
        assert_eq!(swap(&mut conn, "a", &[]), Some(Whole));
        assert_matches_a_rebuild(&mut conn, "feed emptied");

        // The only feed with programmes, then a second one back.
        assert_eq!(swap(&mut conn, "c", &[]), Some(Whole));
        assert_eq!(
            swap(&mut conn, "b", &feed("Ωμέγα", &["x", "y"], 7)),
            Some(Whole)
        );
        assert_matches_a_rebuild(&mut conn, "only feed");
        assert_eq!(swap(&mut conn, "a", &feed("again", &["x"], 3)), Some(Feed));
        assert_eq!(swap(&mut conn, "c", &feed("more", &["z"], 4)), Some(Feed));
        assert_matches_a_rebuild(&mut conn, "feeds back");

        // A stale index stays stale.
        super::super::search::invalidate_index(&conn).unwrap();
        assert_eq!(swap(&mut conn, "c", &feed("late", &["z"], 2)), None);
        assert!(!super::super::search::index_ready(&conn).unwrap());
    }

    /// RB-F review: a failed index upkeep step no longer fails the swap. It
    /// is rolled back, the new programmes are stored and the index is marked
    /// stale for the rebuild after the swap, which leaves it as a rebuild
    /// writes it, before the swap (feed entries not removed) or after it
    /// (new entries not added), on either upkeep path.
    #[test]
    fn a_failed_index_upkeep_still_swaps_the_programmes_in() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        for url in ["a", "b", "c"] {
            conn.execute("INSERT INTO epg_sources(url) VALUES (?1)", [url])
                .unwrap();
        }
        let feed = |tag: &'static str, n: i64| -> Vec<(&'static str, i64, &'static str)> {
            (0..n)
                .map(|i| ("x", 1_800_000_000 + i * 1800, tag))
                .collect()
        };
        for url in ["a", "b", "c"] {
            refresh(&mut conn, url, &feed("Café news", 6));
        }
        let fail_on = |conn: &Connection, event: &str| {
            conn.execute_batch(&format!(
                "CREATE TRIGGER broken_index BEFORE {event} ON epg_search_rows
                 BEGIN SELECT RAISE(ABORT, 'broken index'); END;"
            ))
            .unwrap();
        };
        let mend = |conn: &mut Connection, step: &str| {
            conn.execute_batch("DROP TRIGGER broken_index;").unwrap();
            assert!(!super::super::search::index_ready(conn).unwrap(), "{step}");
            super::super::search::rebuild_index(conn).unwrap();
            assert_matches_a_rebuild(conn, step);
        };
        let titles = |conn: &Connection, url: &str| -> Vec<String> {
            conn.prepare("SELECT title FROM epg_programs WHERE epg_url = ?1")
                .unwrap()
                .query_map([url], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        super::super::search::rebuild_index(&mut conn).unwrap();

        use SwapUpkeep::{Feed, Whole};
        fail_on(&conn, "DELETE");
        assert_eq!(refresh(&mut conn, "a", &feed("Δέλτα", 4)), Some(Feed));
        assert_eq!(titles(&conn, "a"), ["Δέλτα"; 4]);
        mend(&mut conn, "failed before the swap");

        fail_on(&conn, "INSERT");
        assert_eq!(refresh(&mut conn, "b", &feed("Ωμέγα", 3)), Some(Feed));
        assert_eq!(titles(&conn, "b"), ["Ωμέγα"; 3]);
        mend(&mut conn, "failed after the swap");

        fail_on(&conn, "INSERT");
        assert_eq!(refresh(&mut conn, "c", &feed("Thời sự", 40)), Some(Whole));
        assert_eq!(titles(&conn, "c").len(), 40);
        let status: (String, i64) = conn
            .query_row(
                "SELECT status, program_count FROM epg_sources WHERE url = 'c'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, ("ok".to_string(), 40));
        mend(&mut conn, "whole index failed");
    }

    /// R2-1: a feed's search rows are deleted through
    /// `idx_epg_search_rows_feed` (migration 0028), not a scan of every
    /// feed's rows. The `epg_programs` reads are in the `db` index test.
    #[test]
    fn feed_search_rows_are_deleted_through_their_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "EXPLAIN QUERY PLAN {}",
                super::super::search::UNINDEX_ROWS_SQL
            ))
            .unwrap();
        let plan: Vec<String> = stmt
            .query_map(["u"], |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter().any(|d| d.contains("idx_epg_search_rows_feed")),
            "{plan:?}"
        );
        assert!(plan.iter().all(|d| !d.starts_with("SCAN")), "{plan:?}");
    }

    /// R2-1: a feed's own entries are replaced only when the other feeds
    /// hold more than `old + new / 2` programmes.
    #[test]
    fn swap_upkeep_replaces_a_feed_only_when_the_others_outweigh_it() {
        use SwapUpkeep::{Feed, Whole};
        let n = 200_000;
        assert_eq!(SwapUpkeep::choose(n, n, 0), Whole, "one feed");
        assert_eq!(SwapUpkeep::choose(n, n, n), Whole, "two equal feeds");
        assert_eq!(SwapUpkeep::choose(n, n, 2 * n), Feed, "three equal feeds");
        assert_eq!(SwapUpkeep::choose(0, n, n / 2), Whole, "a big new feed");
        assert_eq!(SwapUpkeep::choose(0, n, n), Feed, "a new feed");
        assert_eq!(SwapUpkeep::choose(n, 0, n), Whole, "emptied, others as big");
        assert_eq!(SwapUpkeep::choose(n, 0, n + 1), Feed);
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
