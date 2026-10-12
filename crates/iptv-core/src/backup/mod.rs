//! `backup` module (B2): IPTVnator playlist backup manifest v1 (SPEC C15).
//!
//! The format is exactly the old app's `PlaylistBackupManifestV1`
//! (`libs/shared/interfaces/src/lib/playlist-backup.interface.ts`), so a file
//! exported by IPTVnator imports here and a file exported here imports there.
//!
//! - [`export()`] walks every source and writes one entry per source with its
//!   user state (favorites, recently viewed, hidden groups/categories, playback
//!   positions, VOD source pins) plus `settings.epgUrls`.
//! - [`import()`] validates the manifest, optionally wipes existing sources
//!   (`replace`), restores EPG URLs, recreates each source (m3u from the
//!   embedded `rawM3u` text, xtream/stalker by running their importer), and
//!   applies the user state by provider id. Anything that cannot be matched
//!   becomes a warning, never an error.
//!
//! When a portal is unreachable at import time, the source is kept with
//! `lastError` and its user state is parked in `app_state` under
//! `backup_pending:<sourceId>`; [`apply_pending_restore`] applies it after the
//! first successful refresh (and [`init`] retries at boot).
//!
//! See `docs/architecture/backup.md` for the field-by-field mapping.

mod export;
mod import;
pub mod rpc;

pub use export::{build_manifest, export};
pub use import::{apply_pending_restore, import};

use crate::error::{CoreError, CoreResult};
use crate::model::{
    EpgLinks, M3uSourceConfig, Source, SourceKind, StalkerSourceConfig, XtreamSourceConfig,
};
use crate::state::AppState;
use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use std::sync::Arc;

/// `kind` field of a v1 manifest.
pub const BACKUP_KIND: &str = "iptvnator-playlist-backup";
/// Supported manifest version.
pub const BACKUP_VERSION: i64 = 1;
/// `app_state` key prefix of parked user state.
pub const PENDING_PREFIX: &str = "backup_pending:";

/// Tsrust extension in an entry's `userState`: manual EPG mappings
/// (`[{contentType, itemId, epgChannelId}]`, `null` = explicitly unmapped).
pub const EXT_EPG_MAPPINGS: &str = "tsrustEpgMappings";
/// Tsrust extension in an M3U or Stalker entry's `userState`: playback
/// positions by catalog id (`[{contentType, itemId, episodeId?,
/// positionSeconds, durationSeconds?, updatedAt, watched?, snapshot?}]`).
pub const EXT_POSITIONS: &str = "tsrustPlaybackPositions";
/// Tsrust extension in a Stalker entry's `userState`: hidden categories
/// (`[{contentType, categoryId}]`).
pub const EXT_HIDDEN_CATEGORIES: &str = "tsrustHiddenCategories";
/// App-level settings carried in the manifest's `settings` object next to
/// `epgUrls` (a Tsrust extension; IPTVnator ignores unknown keys). Machine
/// specific values (player paths, folders) are deliberately not exported.
pub const APP_SETTING_KEYS: [&str; 5] = [
    "stripCountryPrefix",
    "epgOffsetMinutes",
    "playerReuseInstance",
    "showExternalBar",
    "vodMinRating",
];

/// `backup.import` mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Keep existing sources; entries matching an existing source (same URL /
    /// server + user / portal + MAC / identical M3U text) update it in place.
    #[default]
    Merge,
    /// Delete every existing source (and its user state) first.
    Replace,
}

/// `backup.import` result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Entries created or merged into an existing source.
    pub imported: i64,
    /// Entries skipped (invalid or duplicate inside the file).
    pub skipped: i64,
    /// Human-readable notes: unmatched items, unreachable portals, ...
    pub warnings: Vec<String>,
}

/// `backup.export` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// The manifest; empty when the core wrote it to `path`.
    pub json: String,
    pub file_name: String,
    /// Where the backup was written (desktop `backup.export` with `path`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

// ---------------------------------------------------------------------------
// Source rows (C3 `sources`), read and written directly so the backup does not
// depend on the sources module's internal API.
// ---------------------------------------------------------------------------

const SOURCE_COLS: &str = "id, kind, name, position, auto_refresh, created_at, updated_at, last_refresh_at, last_error, config_json, epg_json, last_error_code";

fn source_from_row(row: &Row<'_>) -> rusqlite::Result<(Source, String)> {
    let kind_s: String = row.get(1)?;
    let kind = SourceKind::from_str(&kind_s).unwrap_or(SourceKind::M3u);
    let config: String = row.get(9)?;
    let epg: String = row.get(10)?;
    let created_at: String = row.get(5)?;
    let ts = |v: Option<String>| v.map(|s| crate::db::to_rfc3339(&s));
    Ok((
        Source {
            id: row.get(0)?,
            kind,
            name: row.get(2)?,
            position: row.get(3)?,
            auto_refresh: row.get::<_, i64>(4)? != 0,
            created_at: crate::db::to_rfc3339(&created_at),
            updated_at: ts(row.get(6)?),
            last_refresh_at: ts(row.get(7)?),
            last_error: row.get(8)?,
            last_error_code: row
                .get::<_, Option<String>>(11)?
                .as_deref()
                .and_then(crate::error::RpcErrorCode::parse),
            channel_count: 0,
            movie_count: 0,
            series_count: 0,
            radio_count: 0,
            epg: serde_json::from_str::<EpgLinks>(&epg).unwrap_or_default(),
            m3u: None,
            xtream: None,
            stalker: None,
        },
        config,
    ))
}

fn attach_config(mut s: Source, config: &str) -> Source {
    match s.kind {
        SourceKind::M3u => s.m3u = serde_json::from_str::<M3uSourceConfig>(config).ok(),
        SourceKind::Xtream => s.xtream = serde_json::from_str::<XtreamSourceConfig>(config).ok(),
        SourceKind::Stalker => s.stalker = serde_json::from_str::<StalkerSourceConfig>(config).ok(),
    }
    s
}

/// Reads one source row with its parsed config (counts are left at 0).
pub(crate) fn load_source(conn: &Connection, id: &str) -> CoreResult<Option<Source>> {
    let row = conn
        .query_row(
            &format!("SELECT {SOURCE_COLS} FROM sources WHERE id = ?1"),
            [id],
            source_from_row,
        )
        .optional()?;
    Ok(row.map(|(s, cfg)| attach_config(s, &cfg)))
}

/// Every source, ordered like `sources.list`.
pub(crate) fn load_sources(conn: &Connection) -> CoreResult<Vec<Source>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SOURCE_COLS} FROM sources ORDER BY position ASC, created_at ASC, id ASC"
    ))?;
    let rows = stmt.query_map([], source_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        let (s, cfg) = row?;
        out.push(attach_config(s, &cfg));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Identity helpers (match the old app's fingerprints)
// ---------------------------------------------------------------------------

/// `normalizeUrlIdentity` of the old app: lowercase scheme and host, strip
/// trailing slashes from the path, keep query and fragment. Unparseable input
/// is trimmed and lowercased.
pub fn normalize_url_identity(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    match url::Url::parse(trimmed) {
        Ok(u) if u.has_host() => {
            let host = u.host_str().unwrap_or_default().to_ascii_lowercase();
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            let path = u.path();
            let path = if path == "/" {
                "/".to_string()
            } else {
                let t = path.trim_end_matches('/');
                if t.is_empty() {
                    "/".to_string()
                } else {
                    t.to_string()
                }
            };
            let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
            let frag = u.fragment().map(|f| format!("#{f}")).unwrap_or_default();
            format!("{}://{host}{port}{path}{query}{frag}", u.scheme())
        }
        _ => trimmed.to_lowercase(),
    }
}

/// Line endings normalized and trimmed (old app `canonicalizeM3u`).
pub fn canonical_m3u(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

/// Hex SHA-256.
pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub(crate) fn fp_m3u_url(url: &str) -> String {
    format!("m3u|url|{}", normalize_url_identity(url))
}
pub(crate) fn fp_m3u_raw(raw: &str) -> String {
    format!("m3u|raw|{}", sha256_hex(&canonical_m3u(raw)))
}
pub(crate) fn fp_xtream(server: &str, user: &str) -> String {
    format!("xtream|{}|{}", normalize_url_identity(server), user.trim())
}
pub(crate) fn fp_stalker(portal: &str, mac: &str) -> String {
    format!(
        "stalker|{}|{}",
        normalize_url_identity(portal),
        mac.trim().to_lowercase()
    )
}

/// Fingerprint of an existing source, as the importer computes it for entries.
pub(crate) fn source_fingerprint(
    conn: &Connection,
    data_dir: &std::path::Path,
    s: &Source,
) -> CoreResult<Option<String>> {
    Ok(match s.kind {
        SourceKind::Xtream => s
            .xtream
            .as_ref()
            .map(|x| fp_xtream(&x.server_url, &x.username)),
        SourceKind::Stalker => s
            .stalker
            .as_ref()
            .map(|x| fp_stalker(&x.portal_url, &x.mac_address)),
        SourceKind::M3u => match s.m3u.as_ref().and_then(|m| m.url.clone()) {
            Some(url) if !url.trim().is_empty() => Some(fp_m3u_url(&url)),
            _ => {
                crate::m3u::stored_text(conn, data_dir, &s.id)?.map(|(raw, _, _)| fp_m3u_raw(&raw))
            }
        },
    })
}

/// Guards backup database writes (and pending-restore application). Held
/// only around database work, never across a catalog sync, so a refresh or
/// `sources.add` that applies parked state waits milliseconds at most.
pub(crate) fn import_lock(state: &AppState) -> Arc<tokio::sync::Mutex<()>> {
    state.ext_or_insert_with("backup_import_lock", || {
        Arc::new(tokio::sync::Mutex::new(()))
    })
}

/// Serializes whole `backup.import` runs against each other (two imports of
/// the same file must not both create the same sources). Only imports take it.
pub(crate) fn run_lock(state: &AppState) -> Arc<tokio::sync::Mutex<()>> {
    state.ext_or_insert_with("backup_import_run_lock", || {
        Arc::new(tokio::sync::Mutex::new(()))
    })
}

/// Shorthand for an Invalid error.
pub(crate) fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Invalid(msg.into())
}

/// Applies parked user state for sources whose catalog has since been loaded.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let ids: Vec<String> = state
        .db_call(|c| {
            let mut stmt =
                c.prepare("SELECT key FROM app_state WHERE key LIKE 'backup_pending:%'")?;
            let keys = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(keys
                .filter_map(Result::ok)
                .filter_map(|k| k.strip_prefix(PENDING_PREFIX).map(str::to_string))
                .collect())
        })
        .await?;
    for id in ids {
        match apply_pending_restore(&state, &id).await {
            Ok(w) if !w.is_empty() => {
                tracing::info!(source_id = %id, warnings = w.len(), "applied parked backup state")
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(source_id = %id, %err, "parked backup state could not be applied yet")
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_identity_matches_old_app() {
        assert_eq!(
            normalize_url_identity(" HTTP://Example.COM:8080/a/b/?x=1 "),
            "http://example.com:8080/a/b?x=1"
        );
        assert_eq!(normalize_url_identity("http://h/"), "http://h/");
        assert_eq!(normalize_url_identity("http://h"), "http://h/");
        assert_eq!(normalize_url_identity("Not A Url"), "not a url");
        assert_eq!(
            fp_stalker("http://p/c/", " 00:1A:79:00:00:01 "),
            "stalker|http://p/c|00:1a:79:00:00:01"
        );
    }

    #[test]
    fn canonical_m3u_ignores_line_endings() {
        assert_eq!(
            fp_m3u_raw("#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://a\r\n"),
            fp_m3u_raw("#EXTM3U\n#EXTINF:-1,A\nhttp://a")
        );
    }
}
