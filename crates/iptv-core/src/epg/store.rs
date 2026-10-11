//! EPG tables (C3): `epg_sources`, `epg_channels`, `epg_programs`.
//!
//! Ingestion writes into a staging key (`<url>\u{1}staging`, with its own
//! hidden `epg_sources` row, `origin = 'staging'`, `enabled = 0`) in
//! transactions of [`BATCH`] rows, then [`commit_staging`] swaps it in for the
//! real url inside one transaction. Readers never see a half-imported feed,
//! and a failed import leaves the previous data untouched.

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

/// Removes staging rows of `url` (cascade deletes its staged channels and programmes).
pub fn discard_staging(conn: &Connection, url: &str) -> CoreResult<()> {
    let key = staging_key(url);
    conn.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [&key])?;
    conn.execute("DELETE FROM epg_sources WHERE url = ?1", [&key])?;
    Ok(())
}

/// Clears any previous staging for `url` and creates a fresh staging row.
pub fn begin_staging(conn: &Connection, url: &str) -> CoreResult<String> {
    discard_staging(conn, url)?;
    let key = staging_key(url);
    conn.execute(
        "INSERT INTO epg_sources(url, enabled, origin, status) VALUES (?1, 0, ?2, 'fetching')",
        params![key, STAGING_ORIGIN],
    )?;
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
    /// Programmes written.
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

    /// Writes everything buffered in one transaction.
    pub fn flush(&mut self) -> CoreResult<()> {
        if self.channels.is_empty() && self.programmes.is_empty() {
            return Ok(());
        }
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
            let mut pr = tx.prepare_cached(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title, description, category, icon)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for p in self.programmes.drain(..) {
                pr.execute(params![
                    self.key,
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
        Ok(())
    }
}

/// Swaps staging in for `url` in one transaction: old rows deleted, staged
/// rows re-keyed, staging row removed, status `ok` with counts, fetch time and etag.
pub fn commit_staging(
    conn: &mut Connection,
    url: &str,
    etag: Option<&str>,
    channels: u64,
    programs: u64,
) -> CoreResult<()> {
    let key = staging_key(url);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [url])?;
    tx.execute("DELETE FROM epg_channels WHERE epg_url = ?1", [url])?;
    tx.execute(
        "UPDATE epg_programs SET epg_url = ?1 WHERE epg_url = ?2",
        params![url, key],
    )?;
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
    Ok(())
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
        conn.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [&key])?;
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
    for url in &stale {
        conn.execute("DELETE FROM epg_programs WHERE epg_url = ?1", [url])?;
        conn.execute("DELETE FROM epg_sources WHERE url = ?1", [url])?;
    }
    Ok(stale.len())
}
