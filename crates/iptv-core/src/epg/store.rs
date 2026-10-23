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

/// Swaps staging in for `url` in one transaction: old rows deleted, staged
/// channels re-keyed, staged programmes copied in, staging row removed,
/// status `ok` with counts, fetch time and etag. Returns the programmes
/// stored. [`STAGE_TABLE`] is left to the caller (`ingest_reader` closes
/// the temp database; dropping the table would first walk its pages).
pub fn commit_staging(
    conn: &mut Connection,
    url: &str,
    etag: Option<&str>,
    channels: u64,
) -> CoreResult<u64> {
    let key = staging_key(url);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
    // The guide search index no longer matches (rebuilt after the swap, C5).
    super::search::invalidate_index(&tx)?;
    tx.execute(
        "UPDATE epg_sources SET status = 'ok', error = NULL, last_fetch_at = ?2, channel_count = ?3,
         program_count = ?4, etag = ?5 WHERE url = ?1",
        params![url, now_rfc3339(), channels as i64, programs as i64, etag],
    )?;
    tx.commit()?;
    Ok(programs)
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
        let title: String = conn
            .query_row(
                "SELECT title FROM epg_programs WHERE epg_url = ?1 AND channel_id = 'a' AND start = 1000",
                [url],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, "First");
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
