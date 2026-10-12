//! Manifest v1 import (C15).
//!
//! Untrusted input: every entry and every user-state item is read leniently
//! from `serde_json::Value`. A malformed entry is skipped with a warning; a
//! malformed item is dropped with a warning; only a wrong `kind`/`version` or
//! unparseable JSON rejects the whole file.

use super::{
    fp_m3u_raw, fp_m3u_url, fp_stalker, fp_xtream, import_lock, invalid, load_source, load_sources,
    run_lock, source_fingerprint, ImportMode, ImportReport, APP_SETTING_KEYS, BACKUP_KIND,
    BACKUP_VERSION, PENDING_PREFIX,
};
use crate::error::CoreResult;
use crate::model::{
    ContentType, M3uOrigin, M3uSourceConfig, RequestHeaders, SourceKind, StalkerSourceConfig,
    XtreamSourceConfig,
};
use crate::state::AppState;
use crate::userstate::{
    favorite_upsert_json, normalize_ts, now_ts, position_set, recent_upsert_json, PositionInput,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// How many example ids a "not found" warning lists.
const WARN_EXAMPLES: usize = 5;

// ---------------------------------------------------------------------------
// Lenient field access
// ---------------------------------------------------------------------------

fn s_field(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn b_field(v: &Value, key: &str) -> bool {
    match v.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => matches!(s.trim(), "1" | "true" | "yes"),
        _ => false,
    }
}

/// Integer from a number or numeric string (floats truncate).
fn i_value(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f as i64)),
        Value::String(s) => {
            let t = s.trim();
            t.parse::<i64>().ok().or_else(|| {
                t.parse::<f64>()
                    .ok()
                    .filter(|f| f.is_finite())
                    .map(|f| f as i64)
            })
        }
        _ => None,
    }
}

fn i_field(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(i_value)
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn unique_strings(values: &[Value]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .filter_map(|v| match v {
            Value::String(s) => Some(s.trim().to_string()),
            // Tolerate `{url: ...}` objects in place of plain URLs.
            Value::Object(_) => s_field(v, "url"),
            _ => None,
        })
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}

/// Collects unmatched ids per category and renders compact warnings.
#[derive(Default)]
struct Misses(Vec<(&'static str, Vec<String>)>);

impl Misses {
    fn add(&mut self, what: &'static str, id: impl Into<String>) {
        match self.0.iter_mut().find(|(w, _)| *w == what) {
            Some((_, ids)) => ids.push(id.into()),
            None => self.0.push((what, vec![id.into()])),
        }
    }
    fn flush(self, label: &str, warnings: &mut Vec<String>) {
        for (what, ids) in self.0 {
            let examples: Vec<&str> = ids.iter().take(WARN_EXAMPLES).map(String::as_str).collect();
            let more = if ids.len() > WARN_EXAMPLES {
                ", ..."
            } else {
                ""
            };
            warnings.push(format!(
                "{label}: {} {what} not found and skipped ({}{more})",
                ids.len(),
                examples.join(", ")
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

struct Manifest {
    epg_urls: Option<Vec<String>>,
    /// [`APP_SETTING_KEYS`] present in `settings` (Tsrust extension).
    app_settings: Map<String, Value>,
    playlists: Vec<Value>,
}

fn parse_manifest(json: &str) -> CoreResult<Manifest> {
    let v: Value = serde_json::from_str(json.trim_start_matches('\u{feff}'))
        .map_err(|e| invalid(format!("backup file is not valid JSON: {e}")))?;
    if v.is_array() {
        return Err(invalid(
            "legacy playlist JSON exports are not supported; export a versioned backup from IPTVnator first",
        ));
    }
    if !v.is_object() {
        return Err(invalid("backup file must be a JSON object"));
    }
    if v.get("kind").and_then(Value::as_str) != Some(BACKUP_KIND) {
        return Err(invalid(
            "unsupported backup file format (expected an IPTVnator playlist backup)",
        ));
    }
    match v.get("version").and_then(i_value) {
        Some(BACKUP_VERSION) => {}
        other => {
            return Err(invalid(format!(
                "unsupported backup version: {}",
                other.map_or_else(|| "unknown".to_string(), |n| n.to_string())
            )))
        }
    }
    let Some(playlists) = v.get("playlists").and_then(Value::as_array) else {
        return Err(invalid("backup file must contain a playlists array"));
    };
    let epg_urls = v
        .get("settings")
        .and_then(|s| s.get("epgUrls"))
        .and_then(Value::as_array)
        .map(|a| unique_strings(a));
    let app_settings = v
        .get("settings")
        .and_then(Value::as_object)
        .map(|s| {
            s.iter()
                .filter(|(k, _)| APP_SETTING_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    Ok(Manifest {
        epg_urls,
        app_settings,
        playlists: playlists.clone(),
    })
}

/// Old-app `mergeUrls`: primary first, de-duplicated by URL identity.
fn merge_urls(primary: &[String], secondary: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    primary
        .iter()
        .chain(secondary)
        .map(|u| u.trim().to_string())
        .filter(|u| {
            let id = super::normalize_url_identity(u);
            !id.is_empty() && seen.insert(id)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

enum Config {
    M3u {
        raw: String,
        /// Config written after the import (url / file / text origin).
        final_cfg: M3uSourceConfig,
        /// The backup text has no channel (empty or header only, e.g. a URL
        /// source whose first import failed): import from the URL instead.
        by_url: bool,
    },
    Xtream(XtreamSourceConfig),
    Stalker(StalkerSourceConfig),
}

struct Entry {
    kind: SourceKind,
    exported_id: Option<String>,
    title: String,
    auto_refresh: bool,
    position: Option<i64>,
    config: Config,
    user_state: Value,
    fingerprint: String,
    label: String,
}

fn headers_of(v: &Value) -> RequestHeaders {
    RequestHeaders {
        user_agent: s_field(v, "userAgent"),
        referrer: s_field(v, "referrer"),
        origin: s_field(v, "origin"),
    }
}

#[cfg(test)]
fn parse_entry(v: &Value, index: usize) -> Result<Entry, String> {
    parse_entry_with(v, index, true)
}

/// [`parse_entry`]; `probe_files` false (server mode) skips the `is_file`
/// check on a `file` entry's path, so the result never reveals whether a
/// path exists on the server ([`keep_text_only`] then always applies).
fn parse_entry_with(v: &Value, index: usize, probe_files: bool) -> Result<Entry, String> {
    if !v.is_object() {
        return Err(format!("playlist #{}: not an object", index + 1));
    }
    let portal = s_field(v, "portalType").unwrap_or_default();
    let exported_id = s_field(v, "exportedId");
    let title = s_field(v, "title")
        .or_else(|| exported_id.clone())
        .unwrap_or_else(|| format!("Imported playlist {}", index + 1));
    let label = format!("\"{title}\"");
    let auto_refresh = b_field(v, "autoRefresh");
    let position = i_field(v, "position").map(|p| p.clamp(0, MAX_IMPORTED_POSITION));
    let user_state = v.get("userState").cloned().unwrap_or_else(|| json!({}));

    let (kind, config, fingerprint) = match portal.as_str() {
        "m3u" => {
            let src = v.get("source").cloned().unwrap_or(Value::Null);
            let raw = src
                .get("rawM3u")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let url = s_field(&src, "url");
            let src_kind = s_field(&src, "kind").unwrap_or_default();
            let url_kind =
                url.is_some() && (src_kind != "file" && src_kind != "text" || src_kind == "url");
            let mut reader = crate::m3u::M3uReader::new(std::io::Cursor::new(raw.as_bytes()));
            let has_channel = reader.next().is_some();
            // A URL source whose text is empty (its first import failed) or
            // only the header is imported from its URL. Junk text is refused
            // below, as before.
            let by_url =
                url_kind && !has_channel && (raw.trim().is_empty() || reader.stats().saw_header);
            if !by_url {
                if raw.trim().is_empty() {
                    return Err(format!("M3U backup {label} is missing raw playlist data"));
                }
                // Text the importer would refuse (no `#EXTM3U`, no entry), or
                // with no channel and no URL to refresh from, cannot become a
                // catalog: treat it like missing data so Replace never wipes
                // sources for it.
                if !has_channel && (url.is_none() || !reader.stats().saw_header) {
                    return Err(format!(
                        "M3U backup {label} has no channels in its playlist data"
                    ));
                }
            }
            let file_hint = s_field(&src, "filePathHint");
            let headers = headers_of(&src);
            let final_cfg = match (src_kind.as_str(), &url, &file_hint) {
                (_, Some(u), _) if url_kind => M3uSourceConfig {
                    origin: M3uOrigin::Url,
                    url: Some(u.clone()),
                    file_path: None,
                    headers: headers.clone(),
                },
                ("file", _, Some(p)) if !probe_files || std::path::Path::new(p).is_file() => {
                    M3uSourceConfig {
                        origin: M3uOrigin::File,
                        url: None,
                        file_path: Some(p.clone()),
                        headers: headers.clone(),
                    }
                }
                _ => M3uSourceConfig {
                    origin: M3uOrigin::Text,
                    url: None,
                    file_path: None,
                    headers: headers.clone(),
                },
            };
            let fp = match &url {
                Some(u) => fp_m3u_url(u),
                None => fp_m3u_raw(&raw),
            };
            (
                SourceKind::M3u,
                Config::M3u {
                    raw,
                    final_cfg,
                    by_url,
                },
                fp,
            )
        }
        "xtream" => {
            let c = v.get("connection").cloned().unwrap_or(Value::Null);
            let (Some(server), Some(user)) = (s_field(&c, "serverUrl"), s_field(&c, "username"))
            else {
                return Err(format!(
                    "Xtream backup {label} is missing connection metadata"
                ));
            };
            let server = server.trim_end_matches('/').to_string();
            let fp = fp_xtream(&server, &user);
            (
                SourceKind::Xtream,
                Config::Xtream(XtreamSourceConfig {
                    server_url: server,
                    username: user,
                    password: s_field(&c, "password").unwrap_or_default(),
                }),
                fp,
            )
        }
        "stalker" => {
            let c = v.get("connection").cloned().unwrap_or(Value::Null);
            let (Some(portal_url), Some(mac)) =
                (s_field(&c, "portalUrl"), s_field(&c, "macAddress"))
            else {
                return Err(format!(
                    "Stalker backup {label} is missing connection metadata"
                ));
            };
            let fp = fp_stalker(&portal_url, &mac);
            (
                SourceKind::Stalker,
                Config::Stalker(StalkerSourceConfig {
                    portal_url,
                    // Verbatim: the MAC is the account key, and old backups
                    // may hold grandfathered non-standard values.
                    mac_address: mac.trim().to_string(),
                    is_full_portal: b_field(&c, "isFullStalkerPortal"),
                    username: s_field(&c, "username"),
                    password: s_field(&c, "password"),
                    headers: headers_of(&c),
                    serial_number: s_field(&c, "stalkerSerialNumber"),
                    device_id1: s_field(&c, "stalkerDeviceId1"),
                    device_id2: s_field(&c, "stalkerDeviceId2"),
                    signature1: s_field(&c, "stalkerSignature1"),
                    signature2: s_field(&c, "stalkerSignature2"),
                }),
                fp,
            )
        }
        other => {
            return Err(format!(
                "playlist {label}: unsupported portal type \"{}\"",
                if other.is_empty() { "unknown" } else { other }
            ))
        }
    };
    Ok(Entry {
        kind,
        exported_id,
        title,
        auto_refresh,
        position,
        config,
        user_state,
        fingerprint,
        label,
    })
}

/// Server mode never reads files from the server's disk (`filePathHint` or a
/// `file://` URL come from the uploaded backup): such playlists keep the raw
/// text stored in the backup instead. Returns a warning when it changed.
fn keep_text_only(entry: &mut Entry) -> Option<String> {
    let Config::M3u { final_cfg, .. } = &mut entry.config else {
        return None;
    };
    let file_url = final_cfg
        .url
        .as_deref()
        .is_some_and(|u| u.trim().to_ascii_lowercase().starts_with("file://"));
    if final_cfg.origin != M3uOrigin::File && !file_url {
        return None;
    }
    final_cfg.origin = M3uOrigin::Text;
    final_cfg.url = None;
    final_cfg.file_path = None;
    if let Config::M3u { by_url: true, .. } = &entry.config {
        return Some(format!(
            "{}: the playlist URL was ignored (server mode cannot read files on the server) and the backup has no channels for it",
            entry.label
        ));
    }
    Some(format!(
        "{}: the playlist file path was ignored (server mode cannot read files on the server); the playlist text from the backup was imported instead",
        entry.label
    ))
}

fn usable_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        // The id names files (`playlists/{id}.m3u`): no drive prefix (`C:x`),
        // alternate data stream (`a:b`) or dot file / `..`.
        && !id.starts_with('.')
}

/// Largest source position a backup may set (keeps `MAX(position) + 1`
/// inside i64 for every later `sources.add`).
const MAX_IMPORTED_POSITION: i64 = 1_000_000;

/// Config keys a backup made without secrets omits.
const SECRET_CONFIG_KEYS: &[&str] = &["password", "signature1", "signature2"];

/// Merging a backup made without secrets into an existing source keeps the
/// source's saved secrets instead of blanking them.
fn keep_saved_secrets(existing_json: &str, incoming_json: &str) -> String {
    let (Ok(Value::Object(old)), Ok(Value::Object(mut new))) = (
        serde_json::from_str::<Value>(existing_json),
        serde_json::from_str::<Value>(incoming_json),
    ) else {
        return incoming_json.to_string();
    };
    for key in SECRET_CONFIG_KEYS {
        let missing = match new.get(*key) {
            None | Some(Value::Null) => true,
            Some(Value::String(v)) => v.is_empty(),
            Some(_) => false,
        };
        if missing {
            if let Some(saved) = old.get(*key).filter(|v| !v.is_null()) {
                new.insert((*key).to_string(), saved.clone());
            }
        }
    }
    Value::Object(new).to_string()
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// `backup.import`.
pub async fn import(
    state: &Arc<AppState>,
    json: &str,
    mode: ImportMode,
) -> CoreResult<ImportReport> {
    let manifest = parse_manifest(json)?;
    // One import at a time. The shared write lock (`import_lock`) is taken
    // only around database writes so a portal that hangs during its catalog
    // sync never blocks refreshes or `sources.add` (they take it to apply
    // parked state).
    let run = run_lock(state);
    let _run = run.lock().await;
    let lock = import_lock(state);
    let mut report = ImportReport::default();

    // Every entry is read before anything is changed: Replace must not wipe
    // the user's sources for a backup none of whose playlists can be used.
    let server_mode = crate::http::is_server_mode(state);
    let parsed: Vec<Result<Entry, String>> = manifest
        .playlists
        .iter()
        .enumerate()
        .map(|(i, v)| parse_entry_with(v, i, !server_mode))
        .collect();
    if mode == ImportMode::Replace && parsed.iter().all(Result::is_err) {
        let reason = parsed
            .iter()
            .find_map(|r| r.as_ref().err())
            .cloned()
            .unwrap_or_else(|| "the backup has no playlists".to_string());
        return Err(crate::CoreError::Invalid(format!(
            "None of the playlists in this backup can be imported, so nothing was replaced ({reason})"
        )));
    }

    // Replace never deletes first: the backup's playlists are imported next to
    // the existing sources, which go only once at least one new catalog
    // loaded. Otherwise the new rows are rolled back and nothing changes.
    let replace_snapshot = if mode == ImportMode::Replace {
        Some(
            state
                .db_call(|c| {
                    let ids = c
                        .prepare("SELECT id FROM sources")?
                        .query_map([], |r| r.get(0))?
                        .collect::<Result<Vec<String>, _>>()?;
                    let pins = c
                        .prepare(
                            "SELECT match_key, source_id, item_id, updated_at FROM vod_source_pins",
                        )?
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                        .collect::<Result<Vec<(String, String, String, String)>, _>>()?;
                    Ok((ids, pins))
                })
                .await?,
        )
    } else {
        restore_settings(state, &manifest, mode, &mut report).await;
        None
    };

    let fingerprints = if mode == ImportMode::Replace {
        // Every entry becomes a new source; nothing merges into an old one.
        HashMap::new()
    } else {
        let data_dir = state.data_dir.clone();
        state
            .db_call(move |c| {
                let mut map = HashMap::new();
                for s in load_sources(c)? {
                    if let Some(fp) = source_fingerprint(c, &data_dir, &s)? {
                        map.entry(fp).or_insert_with(|| s.id.clone());
                    }
                }
                Ok(map)
            })
            .await?
    };
    let mut existing_ids: HashSet<String> = state
        .db_call(|c| {
            Ok(c.prepare("SELECT id FROM sources")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<HashSet<String>, _>>()?)
        })
        .await?;

    let mut created = Vec::new();
    let mut any_catalog = false;
    // Plain reasons a catalog did not load, for the Replace rollback message.
    let mut failures: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for parsed_entry in parsed {
        let mut entry = match parsed_entry {
            Ok(e) => e,
            Err(msg) => {
                report.skipped += 1;
                report.warnings.push(msg);
                continue;
            }
        };
        if server_mode {
            if let Some(w) = keep_text_only(&mut entry) {
                report.warnings.push(w);
            }
        }
        if !seen.insert(entry.fingerprint.clone()) {
            report.skipped += 1;
            report
                .warnings
                .push(format!("{}: duplicate backup entry skipped", entry.label));
            continue;
        }
        let matched = fingerprints.get(&entry.fingerprint).cloned();
        let target_id = match &matched {
            Some(id) => id.clone(),
            None => match &entry.exported_id {
                Some(id) if usable_id(id) && !existing_ids.contains(id) => id.clone(),
                _ => uuid::Uuid::new_v4().to_string(),
            },
        };
        // Reserved before the import: its source row may be written even
        // when a later step fails, and no later entry may reuse the id.
        existing_ids.insert(target_id.clone());
        if matched.is_none() {
            created.push(target_id.clone());
        }
        match import_entry(
            state,
            &lock,
            &entry,
            &target_id,
            matched.is_some(),
            &mut report.warnings,
        )
        .await
        {
            Ok(failure) => {
                report.imported += 1;
                failures.extend(failure);
                if !any_catalog {
                    any_catalog = has_catalog(state, &target_id).await?;
                }
            }
            Err(err) => {
                report.skipped += 1;
                report.warnings.push(format!("{}: {err}", entry.label));
                failures.push(format!("{}: {err}", entry.label));
            }
        }
    }

    if let Some((old_ids, old_pins)) = replace_snapshot {
        if !any_catalog && !old_ids.is_empty() {
            // Roll back: the new rows go, the old sources and pins stay.
            for id in &created {
                match crate::sources::remove(state, id).await {
                    Ok(()) | Err(crate::CoreError::NotFound(_)) => {}
                    Err(err) => {
                        tracing::warn!(source_id = %id, error = %err, "could not roll back an imported source")
                    }
                }
            }
            let _guard = lock.lock().await;
            state
                .db_call(move |c| {
                    let tx = c.transaction()?;
                    tx.execute("DELETE FROM vod_source_pins", [])?;
                    for (k, s, i, at) in &old_pins {
                        tx.execute(
                            "INSERT INTO vod_source_pins(match_key, source_id, item_id, updated_at) VALUES (?1, ?2, ?3, ?4)",
                            params![k, s, i, at],
                        )?;
                    }
                    tx.commit()?;
                    Ok(())
                })
                .await?;
            state.emit("sources.changed", json!({}));
            // The import's own failure, without the "source was kept" tail
            // of its warning: the source was just rolled back.
            let reason = failures
                .first()
                .or_else(|| report.warnings.iter().find(|w| w.contains("no channels")))
                .or(report.warnings.first())
                .cloned()
                .unwrap_or_else(|| "no catalog could be loaded".to_string());
            return Err(crate::CoreError::Invalid(format!(
                "None of the playlists in this backup could be loaded, so nothing was replaced ({reason})"
            )));
        }
        for id in &old_ids {
            match crate::sources::remove(state, id).await {
                Ok(()) | Err(crate::CoreError::NotFound(_)) => {}
                Err(err) => return Err(err),
            }
        }
        let _guard = lock.lock().await;
        state
            .db_call(move |c| {
                let mut stmt = c.prepare("DELETE FROM vod_source_pins WHERE source_id = ?1")?;
                for id in &old_ids {
                    stmt.execute([id])?;
                }
                Ok(())
            })
            .await?;
        drop(_guard);
        tracing::info!("backup import (replace): previous sources removed");
        restore_settings(state, &manifest, mode, &mut report).await;
    }

    state.emit("sources.changed", json!({}));
    tracing::info!(
        imported = report.imported,
        skipped = report.skipped,
        warnings = report.warnings.len(),
        ?mode,
        "backup imported"
    );
    Ok(report)
}

/// True when source `id` holds a catalog (channels, movies or series).
async fn has_catalog(state: &AppState, id: &str) -> CoreResult<bool> {
    let id = id.to_string();
    state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT COALESCE((SELECT channel_count + movie_count + series_count FROM source_counts WHERE source_id = ?1), 0) > 0
                     OR EXISTS(SELECT 1 FROM items WHERE source_id = ?1)",
                [id],
                |r| r.get(0),
            )?)
        })
        .await
}

/// Restores the backup's EPG URLs and app settings (Replace: only after the
/// new sources replaced the old ones).
async fn restore_settings(
    state: &Arc<AppState>,
    manifest: &Manifest,
    mode: ImportMode,
    report: &mut ImportReport,
) {
    // Settings: EPG URLs.
    let current = state.settings_snapshot().epg_urls;
    let mut next = match (&manifest.epg_urls, mode) {
        (Some(urls), ImportMode::Merge) => merge_urls(urls, &current),
        (Some(urls), ImportMode::Replace) => merge_urls(urls, &[]),
        (None, ImportMode::Replace) => Vec::new(),
        (None, ImportMode::Merge) => current.clone(),
    };
    // Server mode cannot use local EPG files: drop each new one with its own
    // warning instead of letting it reject the whole list.
    next.retain(|u| {
        current.contains(u)
            || match crate::epg::fetch::check_server_url(state, u) {
                Ok(()) => true,
                Err(err) => {
                    report
                        .warnings
                        .push(format!("EPG URL {u} was not restored: {err}"));
                    false
                }
            }
    });
    if next != current {
        if let Err(err) = crate::settings::update(state, json!({ "epgUrls": next })).await {
            report
                .warnings
                .push(format!("EPG URLs could not be restored: {err}"));
        }
    }
    // Settings: app-level preferences (Tsrust extension).
    if !manifest.app_settings.is_empty() {
        let patch = Value::Object(manifest.app_settings.clone());
        if let Err(err) = crate::settings::update(state, patch).await {
            report
                .warnings
                .push(format!("App settings could not be restored: {err}"));
        }
    }
}

async fn import_entry(
    state: &Arc<AppState>,
    lock: &tokio::sync::Mutex<()>,
    entry: &Entry,
    id: &str,
    is_merge: bool,
    warnings: &mut Vec<String>,
) -> CoreResult<Option<String>> {
    // 1. Source row (+ raw text for m3u). The m3u row starts as a `text`
    //    source so the importer parses the embedded playlist instead of
    //    fetching it; its real origin is written after the import. A URL
    //    entry without channels in its text is fetched from its URL.
    let fetch_url = matches!(&entry.config, Config::M3u { by_url: true, final_cfg, .. } if final_cfg.origin == M3uOrigin::Url);
    let config_json = match &entry.config {
        Config::M3u { final_cfg, .. } if fetch_url => serde_json::to_string(final_cfg)?,
        Config::M3u { final_cfg, .. } => serde_json::to_string(&M3uSourceConfig {
            origin: M3uOrigin::Text,
            url: None,
            file_path: None,
            headers: final_cfg.headers.clone(),
        })?,
        Config::Xtream(c) => serde_json::to_string(c)?,
        Config::Stalker(c) => serde_json::to_string(c)?,
    };
    let stored_config = {
        let id = id.to_string();
        let kind = entry.kind.as_str();
        let name = entry.title.clone();
        let auto_refresh = entry.auto_refresh;
        let position = entry.position;
        let raw = match &entry.config {
            Config::M3u { raw, .. } if !fetch_url => Some(raw.clone()),
            _ => None,
        };
        let _guard = lock.lock().await;
        let data_dir = state.data_dir.clone();
        let sid = id.clone();
        let stored_config = state
            .db_call(move |c| {
                // Over RAW_INLINE_MAX the text goes to the playlist cache
                // with raw = '', exactly as an import of a large file does.
                let raw = match &raw {
                    Some(text) => Some((
                        crate::m3u::place_raw_text(&data_dir, &sid, text)?,
                        text.as_str(),
                    )),
                    None => None,
                };
                let tx = c.transaction()?;
                let now = crate::db::now_rfc3339();
                let mut config_json = config_json;
                if is_merge {
                    let saved: Option<String> = tx
                        .query_row(
                            "SELECT config_json FROM sources WHERE id = ?1 AND kind = ?2",
                            params![id, kind],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(saved) = saved {
                        config_json = keep_saved_secrets(&saved, &config_json);
                    }
                }
                let pos = match position {
                    Some(p) => p,
                    None => tx.query_row(
                        "SELECT COALESCE(MAX(position), -1) + 1 FROM sources",
                        [],
                        |r| r.get(0),
                    )?,
                };
                tx.execute(
                    "INSERT INTO sources(id, kind, name, position, auto_refresh, created_at, updated_at, config_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name, auto_refresh = excluded.auto_refresh,
                       position = CASE WHEN ?8 THEN excluded.position ELSE sources.position END,
                       updated_at = excluded.updated_at, config_json = excluded.config_json",
                    params![id, kind, name, pos, auto_refresh as i64, now, config_json, position.is_some()],
                )?;
                if let Some((stored, text)) = raw {
                    // sha256 stays empty unless the text is unchanged, so the
                    // m3u importer's "unchanged since last import" shortcut
                    // only fires when the catalog really matches the text.
                    // Inline text compares directly; a cached copy (raw = '')
                    // compares by the sha the importer recorded for it.
                    let sha = hex::encode(Sha256::digest(text.as_bytes()));
                    tx.execute(
                        "INSERT INTO m3u_raw(source_id, raw, sha256, fetched_at) VALUES (?1, ?2, '', ?3)
                         ON CONFLICT(source_id) DO UPDATE SET
                           sha256 = CASE
                             WHEN excluded.raw <> '' AND m3u_raw.raw = excluded.raw THEN m3u_raw.sha256
                             WHEN excluded.raw = '' AND m3u_raw.sha256 = ?4 THEN m3u_raw.sha256
                             ELSE '' END,
                           raw = excluded.raw, fetched_at = excluded.fetched_at",
                        params![id, stored, now, sha],
                    )?;
                }
                tx.commit()?;
                Ok(config_json)
            })
            .await?;
        stored_config
    };
    if is_merge {
        warnings.push(format!(
            "{}: merged into an existing source with the same connection",
            entry.label
        ));
    }

    // 2. Catalog. `failure` is the plain reason it did not load.
    let mut failure = None;
    let synced = match &entry.config {
        // The stored config: a merge may have kept the saved password.
        Config::Xtream(_)
            if serde_json::from_str::<XtreamSourceConfig>(&stored_config)
                .map_or(true, |c| c.password.is_empty()) =>
        {
            let msg = "The backup has no password for this account; edit the source to add it, then refresh";
            set_error_coded(state, id, Some((msg, crate::error::RpcErrorCode::Auth))).await?;
            warnings.push(format!("{}: catalog not loaded: {msg}", entry.label));
            failure = Some(format!("{}: {msg}", entry.label));
            false
        }
        // Through the per-source lock (never the global one): the same
        // serialization `sources.refresh` uses, without blocking other sources.
        _ => match crate::sources::run_import_with(state, id, run_importer(state, id, entry.kind))
            .await
        {
            Ok(()) => true,
            Err(msg) => {
                warnings.push(format!(
                    "{}: catalog not loaded ({msg}); the source was kept and its favorites and history will be restored after the first successful refresh",
                    entry.label
                ));
                failure = Some(format!("{}: {msg}", entry.label));
                false
            }
        },
    };

    // 3. Final m3u origin (url / file) now that the text is imported.
    let _guard = lock.lock().await;
    if let Config::M3u { final_cfg, .. } = &entry.config {
        if final_cfg.origin != M3uOrigin::Text && !fetch_url {
            let cfg = serde_json::to_string(final_cfg)?;
            let id = id.to_string();
            state
                .db_call(move |c| {
                    c.execute(
                        "UPDATE sources SET config_json = ?2 WHERE id = ?1",
                        params![id, cfg],
                    )?;
                    Ok(())
                })
                .await?;
        }
    }

    // 4. User state.
    let kind = entry.kind;
    let user_state = entry.user_state.clone();
    let label = entry.label.clone();
    let id_s = id.to_string();
    let mut w = state
        .db_call(move |c| {
            let tx = c.transaction()?;
            let mut w = Vec::new();
            if !synced && kind != SourceKind::Stalker {
                park(&tx, &id_s, kind, &user_state)?;
            } else {
                apply_user_state(&tx, &id_s, kind, &user_state, &label, &mut w)?;
            }
            tx.commit()?;
            Ok(w)
        })
        .await?;
    warnings.append(&mut w);
    Ok(failure)
}

/// Records an import outcome with its classified code (C10).
async fn set_error_coded(
    state: &AppState,
    id: &str,
    err: Option<(&str, crate::error::RpcErrorCode)>,
) -> CoreResult<()> {
    let id = id.to_string();
    let err = err.map(|(m, c)| (m.to_string(), c));
    state
        .db_call(move |c| {
            match &err {
                Some((msg, code)) => crate::sources::store::record_import_error(c, &id, msg, *code)?,
                None => {
                    c.execute(
                        "UPDATE sources SET last_error = NULL, last_error_code = NULL, last_refresh_at = ?2 WHERE id = ?1",
                        params![id, crate::db::now_rfc3339()],
                    )?;
                }
            }
            Ok(())
        })
        .await
}

/// Runs the registered importer for `kind` on source `id`, recording the
/// outcome on the row. Returns a user-facing message on failure.
async fn run_importer(state: &Arc<AppState>, id: &str, kind: SourceKind) -> Result<(), String> {
    let Some(imp) = crate::sources::importer(state, kind) else {
        let msg = format!("no {kind} importer is available");
        let code = crate::error::RpcErrorCode::Unsupported;
        let _ = set_error_coded(state, id, Some((&msg, code))).await;
        return Err(msg);
    };
    let source = {
        let id = id.to_string();
        match state.db_call(move |c| load_source(c, &id)).await {
            Ok(Some(s)) => s,
            Ok(None) => return Err("source row vanished during import".into()),
            Err(e) => return Err(e.to_string()),
        }
    };
    if kind == SourceKind::Stalker {
        // A replace re-creates the id, maybe against another portal: rows
        // remembered in memory for the old one must not answer for it.
        crate::stalker::Runtime::get(state).forget_source(id);
    }
    match imp.import(state.clone(), &source).await {
        Ok(summary) => {
            tracing::info!(source_id = %id, %kind, channels = summary.channels, movies = summary.movies, series = summary.series, "backup source imported");
            let _ = set_error_coded(state, id, None).await;
            if kind == SourceKind::Stalker {
                // Portal VOD is not stored locally; keep its totals, as
                // `sources::run_import` does.
                let (sid, movies, series) = (id.to_string(), summary.movies, summary.series);
                let res = state
                    .db_call(move |c| crate::catalog::set_remote_counts(c, &sid, movies, series))
                    .await;
                if let Err(err) = res {
                    tracing::warn!(source_id = %id, error = %err, "could not record the portal totals");
                }
            }
            Ok(())
        }
        Err(err) => {
            let msg = crate::sources::error_text(&err);
            tracing::warn!(source_id = %id, %kind, error = %msg, "backup source import failed");
            let _ = set_error_coded(state, id, Some((&msg, err.code()))).await;
            Err(msg)
        }
    }
}

fn park(conn: &Connection, id: &str, kind: SourceKind, user_state: &Value) -> CoreResult<()> {
    let value = json!({ "portalType": kind.as_str(), "userState": user_state }).to_string();
    conn.execute(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![format!("{PENDING_PREFIX}{id}"), value],
    )?;
    Ok(())
}

/// Applies user state parked by an import whose catalog could not be loaded.
/// Call after a successful `sources.refresh`. Returns the warnings (empty when
/// nothing was parked); keeps the state parked while the catalog is still empty.
pub async fn apply_pending_restore(
    state: &Arc<AppState>,
    source_id: &str,
) -> CoreResult<Vec<String>> {
    // Nothing parked (the common case after every refresh): return without
    // touching the import lock.
    let key = format!("{PENDING_PREFIX}{source_id}");
    let parked = state
        .db_call(move |c| {
            Ok(c.prepare_cached("SELECT 1 FROM app_state WHERE key = ?1")?
                .exists([&key])?)
        })
        .await?;
    if !parked {
        return Ok(Vec::new());
    }
    let lock = import_lock(state);
    let _guard = lock.lock().await;
    let id = source_id.to_string();
    state
        .db_call(move |c| {
            let key = format!("{PENDING_PREFIX}{id}");
            let Some(raw) = c
                .query_row("SELECT value FROM app_state WHERE key = ?1", [&key], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
            else {
                return Ok(Vec::new());
            };
            let Some(source) = load_source(c, &id)? else {
                c.execute("DELETE FROM app_state WHERE key = ?1", [&key])?;
                return Ok(Vec::new());
            };
            let has_items = c
                .prepare("SELECT 1 FROM items WHERE source_id = ?1 LIMIT 1")?
                .exists([&id])?;
            if !has_items {
                return Ok(Vec::new());
            }
            let parked: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            let user_state = parked
                .get("userState")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let tx = c.transaction()?;
            let mut w = Vec::new();
            let label = format!("\"{}\"", source.name);
            apply_user_state(&tx, &id, source.kind, &user_state, &label, &mut w)?;
            tx.execute("DELETE FROM app_state WHERE key = ?1", [&key])?;
            tx.commit()?;
            Ok(w)
        })
        .await
}

// ---------------------------------------------------------------------------
// User state
// ---------------------------------------------------------------------------

fn apply_user_state(
    conn: &Connection,
    id: &str,
    kind: SourceKind,
    us: &Value,
    label: &str,
    warnings: &mut Vec<String>,
) -> CoreResult<()> {
    let mut misses = Misses::default();
    match kind {
        SourceKind::M3u => apply_m3u(conn, id, us, &mut misses)?,
        SourceKind::Xtream => apply_xtream(conn, id, us, &mut misses)?,
        SourceKind::Stalker => apply_stalker(conn, id, us, &mut misses)?,
    }
    misses.flush(label, warnings);
    Ok(())
}

/// Catalog facts used for snapshots.
struct ItemInfo {
    content_type: ContentType,
    item_id: String,
    title: String,
    poster: Option<String>,
    category: Option<String>,
}

fn snapshot_json(
    info: &ItemInfo,
    subtitle: Option<String>,
    extra: Option<Map<String, Value>>,
) -> String {
    let mut m = Map::new();
    m.insert("title".into(), json!(info.title));
    if let Some(s) = subtitle.or_else(|| {
        // Live channels show their group; VOD shows nothing.
        matches!(info.content_type, ContentType::Live | ContentType::Radio)
            .then(|| info.category.clone())
            .flatten()
    }) {
        m.insert("subtitle".into(), json!(s));
    }
    if let Some(p) = &info.poster {
        m.insert("posterUrl".into(), json!(p));
    }
    m.insert("contentType".into(), json!(info.content_type.as_str()));
    if let Some(extra) = extra {
        m.extend(extra);
    }
    Value::Object(m).to_string()
}

fn next_favorite_position(conn: &Connection) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM favorites",
        [],
        |r| r.get(0),
    )?)
}

fn item_ref(id: &str, info: &ItemInfo) -> crate::model::ItemRef {
    crate::model::ItemRef::new(id, info.content_type, info.item_id.clone())
}

// ----- m3u --------------------------------------------------------------------

fn apply_m3u(conn: &Connection, id: &str, us: &Value, misses: &mut Misses) -> CoreResult<()> {
    let favorites = unique_strings(arr(us, "favorites"));
    let recent: Vec<&Value> = arr(us, "recentlyViewed")
        .iter()
        .filter(|v| s_field(v, "url").is_some())
        .collect();
    let hidden = unique_strings(arr(us, "hiddenGroupTitles"));

    let wanted: HashSet<String> = favorites
        .iter()
        .cloned()
        .chain(recent.iter().filter_map(|v| s_field(v, "url")))
        .collect();
    let mut by_url: HashMap<String, ItemInfo> = HashMap::new();
    if !wanted.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT i.content_type, i.item_id, i.url, i.title, COALESCE(i.logo_url, i.poster_url), c.name
             FROM items i
             LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id
             WHERE i.source_id = ?1 AND i.url IS NOT NULL",
        )?;
        let mut rows = stmt.query([id])?;
        while let Some(r) = rows.next()? {
            let url: String = r.get(2)?;
            if !wanted.contains(&url) || by_url.contains_key(&url) {
                continue;
            }
            let ct: String = r.get(0)?;
            let Ok(content_type) = ct.parse::<ContentType>() else {
                continue;
            };
            by_url.insert(
                url,
                ItemInfo {
                    content_type,
                    item_id: r.get(1)?,
                    title: r.get(3)?,
                    poster: r.get(4)?,
                    category: r.get(5)?,
                },
            );
        }
    }

    let base = next_favorite_position(conn)?;
    for (i, url) in favorites.iter().enumerate() {
        match by_url.get(url) {
            Some(info) => {
                favorite_upsert_json(
                    conn,
                    &item_ref(id, info),
                    &snapshot_json(info, None, None),
                    None,
                    Some(base + i as i64),
                )?;
            }
            None => misses.add("favorite channels", url.clone()),
        }
    }
    for v in recent {
        let url = s_field(v, "url").unwrap_or_default();
        match by_url.get(&url) {
            Some(info) => {
                let at = v
                    .get("added_at")
                    .and_then(normalize_ts)
                    .or_else(|| v.get("viewedAt").and_then(normalize_ts));
                recent_upsert_json(
                    conn,
                    &item_ref(id, info),
                    &snapshot_json(info, None, None),
                    at.as_deref(),
                )?;
            }
            None => misses.add("recently viewed channels", url),
        }
    }
    for name in hidden {
        let n = conn.execute(
            "UPDATE categories SET hidden = 1 WHERE source_id = ?1 AND name = ?2",
            params![id, name],
        )?;
        if n == 0 {
            misses.add("hidden groups", name);
        }
    }
    apply_tsrust_state(conn, id, us, true, misses)
}

/// Whether a playback position row exists for the item (and episode).
fn position_exists(
    conn: &Connection,
    id: &str,
    ct: ContentType,
    item_id: &str,
    episode_id: Option<&str>,
) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT 1 FROM playback_positions
             WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id = ?4",
        )?
        .exists(params![
            id,
            ct.as_str(),
            item_id,
            episode_id.map(str::trim).unwrap_or("")
        ])?)
}

/// Applies the Tsrust `userState` extensions (see `backup::EXT_*`) under the
/// new source id: EPG mappings (kept when the source already has one for
/// the item), playback positions (same rules as the IPTVnator positions:
/// dated rows only replace older ones, undated rows only fill gaps) and
/// hidden categories. `check_items` requires the item in the local catalog
/// (M3U); Stalker VOD is not stored locally, so its positions apply as is.
fn apply_tsrust_state(
    conn: &Connection,
    id: &str,
    us: &Value,
    check_items: bool,
    misses: &mut Misses,
) -> CoreResult<()> {
    let ct_of = |v: &Value| s_field(v, "contentType").and_then(|c| c.parse::<ContentType>().ok());
    for m in arr(us, super::EXT_EPG_MAPPINGS) {
        let (Some(ct), Some(item)) = (ct_of(m), s_field(m, "itemId")) else {
            continue;
        };
        conn.execute(
            "INSERT OR IGNORE INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, ct.as_str(), item, s_field(m, "epgChannelId")],
        )?;
    }
    for p in arr(us, super::EXT_POSITIONS) {
        let (Some(ct), Some(item), Some(pos)) = (
            ct_of(p),
            s_field(p, "itemId"),
            i_field(p, "positionSeconds"),
        ) else {
            continue;
        };
        let episode_id = s_field(p, "episodeId");
        let updated_at = p.get("updatedAt").and_then(normalize_ts);
        let mut snapshot = p
            .get("snapshot")
            .filter(|v| v.is_object())
            .map(Value::to_string);
        if check_items {
            match lookup(conn, id, ct, &item)? {
                Some(info) => {
                    snapshot = snapshot.or_else(|| Some(snapshot_json(&info, None, None)));
                }
                None => {
                    misses.add("playback positions", format!("{} {item}", ct.as_str()));
                    continue;
                }
            }
        }
        if updated_at.is_none() && position_exists(conn, id, ct, &item, episode_id.as_deref())? {
            continue;
        }
        let input = PositionInput {
            item_ref: crate::model::ItemRef::new(id, ct, item.clone()),
            episode_id,
            position_seconds: pos.max(0),
            duration_seconds: i_field(p, "durationSeconds"),
            snapshot_json: snapshot,
            updated_at,
            watched: b_field(p, "watched"),
        };
        if position_set(conn, &input).is_err() {
            misses.add("playback positions", format!("{} {item}", ct.as_str()));
        }
    }
    for h in arr(us, super::EXT_HIDDEN_CATEGORIES) {
        let (Some(ct), Some(cat)) = (ct_of(h), s_field(h, "categoryId")) else {
            continue;
        };
        let n = conn.execute(
            "UPDATE categories SET hidden = 1 WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
            params![id, ct.as_str(), cat],
        )?;
        if n == 0 {
            misses.add("hidden categories", cat);
        }
    }
    Ok(())
}

// ----- xtream -----------------------------------------------------------------

fn xtream_ct(v: &str) -> Option<ContentType> {
    match v {
        "live" => Some(ContentType::Live),
        "movie" | "movies" | "vod" => Some(ContentType::Movie),
        "series" => Some(ContentType::Series),
        _ => None,
    }
}

fn lookup(
    conn: &Connection,
    id: &str,
    ct: ContentType,
    item_id: &str,
) -> CoreResult<Option<ItemInfo>> {
    Ok(conn
        .prepare_cached(
            "SELECT i.title, COALESCE(i.poster_url, i.logo_url), c.name FROM items i
             LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id
             WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.item_id = ?3",
        )?
        .query_row(params![id, ct.as_str(), item_id], |r| {
            Ok(ItemInfo {
                content_type: ct,
                item_id: item_id.to_string(),
                title: r.get(0)?,
                poster: r.get(1)?,
                category: r.get(2)?,
            })
        })
        .optional()?)
}

fn apply_xtream(conn: &Connection, id: &str, us: &Value, misses: &mut Misses) -> CoreResult<()> {
    // Hidden categories: the backup is authoritative for the listed types.
    if us.get("hiddenCategories").is_some_and(Value::is_array) {
        conn.execute(
            "UPDATE categories SET hidden = 0 WHERE source_id = ?1 AND content_type IN ('live','movie','series')",
            [id],
        )?;
        for h in arr(us, "hiddenCategories") {
            let (Some(ct), Some(cat)) = (
                s_field(h, "categoryType").as_deref().and_then(xtream_ct),
                i_field(h, "xtreamId"),
            ) else {
                // Issue #1017 exports: entries without a usable id are dropped.
                continue;
            };
            let n = conn.execute(
                "UPDATE categories SET hidden = 1 WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
                params![id, ct.as_str(), cat.to_string()],
            )?;
            if n == 0 {
                misses.add("hidden categories", cat.to_string());
            }
        }
    }

    // Favorites, in their saved order.
    let mut favs: Vec<(usize, &Value)> = arr(us, "favorites").iter().enumerate().collect();
    favs.sort_by_key(|(i, v)| (i_field(v, "position").unwrap_or(i64::MAX), *i));
    let base = next_favorite_position(conn)?;
    for (n, (_, f)) in favs.into_iter().enumerate() {
        let (Some(ct), Some(xid)) = (
            s_field(f, "contentType").as_deref().and_then(xtream_ct),
            i_field(f, "xtreamId"),
        ) else {
            continue;
        };
        match lookup(conn, id, ct, &xid.to_string())? {
            Some(info) => {
                let at = f.get("addedAt").and_then(normalize_ts);
                favorite_upsert_json(
                    conn,
                    &item_ref(id, &info),
                    &snapshot_json(&info, None, None),
                    at.as_deref(),
                    Some(base + n as i64),
                )?;
            }
            None => misses.add("favorites", format!("{} {xid}", ct.as_str())),
        }
    }

    for r in arr(us, "recentlyViewed") {
        let (Some(ct), Some(xid)) = (
            s_field(r, "contentType").as_deref().and_then(xtream_ct),
            i_field(r, "xtreamId"),
        ) else {
            continue;
        };
        match lookup(conn, id, ct, &xid.to_string())? {
            Some(info) => {
                let at = r.get("viewedAt").and_then(normalize_ts);
                recent_upsert_json(
                    conn,
                    &item_ref(id, &info),
                    &snapshot_json(&info, None, None),
                    at.as_deref(),
                )?;
            }
            None => misses.add("recently viewed items", format!("{} {xid}", ct.as_str())),
        }
    }

    // Playback positions (PlaybackPositionData).
    for p in arr(us, "playbackPositions") {
        let Some(content_id) = i_field(p, "contentXtreamId") else {
            continue;
        };
        let Some(pos) = i_field(p, "positionSeconds") else {
            continue;
        };
        let duration = i_field(p, "durationSeconds");
        let updated_at = p.get("updatedAt").and_then(normalize_ts);
        // Tsrust extension; absent in IPTVnator files (= not watched).
        let watched = p.get("watched").and_then(Value::as_bool).unwrap_or(false);
        let kind = s_field(p, "contentType").unwrap_or_default();
        let (ct, item_id, episode_id, subtitle, extra) = match kind.as_str() {
            "vod" | "movie" => (ContentType::Movie, content_id.to_string(), None, None, None),
            "episode" => {
                let Some(series) = i_field(p, "seriesXtreamId") else {
                    misses.add(
                        "episode positions without a series id",
                        content_id.to_string(),
                    );
                    continue;
                };
                let season = i_field(p, "seasonNumber");
                let episode = i_field(p, "episodeNumber");
                let subtitle = match (season, episode) {
                    (Some(s), Some(e)) => Some(format!("S{s} E{e}")),
                    _ => None,
                };
                let mut extra = Map::new();
                if let Some(s) = season {
                    extra.insert("seasonNumber".into(), json!(s));
                }
                if let Some(e) = episode {
                    extra.insert("episodeNumber".into(), json!(e));
                }
                (
                    ContentType::Series,
                    series.to_string(),
                    Some(content_id.to_string()),
                    subtitle,
                    Some(extra),
                )
            }
            _ => continue,
        };
        match lookup(conn, id, ct, &item_id)? {
            Some(info) => {
                // An undated backup row cannot prove it is newer: it only
                // fills a gap and never overwrites stored progress. (A Replace
                // imports into new sources, which have no rows yet.) Dated
                // rows go through `position_set`'s newer-only rule.
                if updated_at.is_none()
                    && position_exists(
                        conn,
                        id,
                        info.content_type,
                        &info.item_id,
                        episode_id.as_deref(),
                    )?
                {
                    continue;
                }
                position_set(
                    conn,
                    &PositionInput {
                        item_ref: item_ref(id, &info),
                        episode_id,
                        position_seconds: pos.max(0),
                        duration_seconds: duration,
                        snapshot_json: Some(snapshot_json(&info, subtitle, extra)),
                        updated_at,
                        watched,
                    },
                )?;
            }
            None => misses.add("playback positions", format!("{} {item_id}", ct.as_str())),
        }
    }

    // Source pins: present = authoritative, absent = no opinion.
    if let Some(pins) = us.get("sourcePins").and_then(Value::as_array) {
        conn.execute("DELETE FROM vod_source_pins WHERE source_id = ?1", [id])?;
        for pin in pins {
            let (Some(key), Some(content)) = (s_field(pin, "matchKey"), i_field(pin, "contentId"))
            else {
                continue;
            };
            let at = pin
                .get("updatedAt")
                .and_then(normalize_ts)
                .unwrap_or_else(now_ts);
            conn.execute(
                "INSERT INTO vod_source_pins(match_key, source_id, item_id, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(match_key) DO UPDATE SET source_id = excluded.source_id, item_id = excluded.item_id, updated_at = excluded.updated_at",
                params![key, id, content.to_string(), at],
            )?;
        }
    }
    apply_tsrust_state(conn, id, us, true, misses)
}

// ----- stalker ----------------------------------------------------------------

/// Content type of a `StalkerPortalItem` (old app `type` / `category_id` /
/// `stream_type`, `radio`, `is_series` markers).
pub(crate) fn stalker_ct(item: &Value) -> ContentType {
    for key in ["type", "category_id", "stream_type"] {
        if let Some(t) = s_field(item, key) {
            match t.to_ascii_lowercase().as_str() {
                "itv" | "live" | "tv" => return ContentType::Live,
                "radio" => return ContentType::Radio,
                "series" => return ContentType::Series,
                "vod" | "movie" | "movies" => {
                    return if b_field(item, "is_series") {
                        ContentType::Series
                    } else {
                        ContentType::Movie
                    }
                }
                _ => {}
            }
        }
    }
    if b_field(item, "radio") {
        ContentType::Radio
    } else if b_field(item, "is_series") {
        ContentType::Series
    } else if item.get("tv_genre_id").is_some()
        || item.get("xmltv_id").is_some()
        || item.get("number").is_some()
    {
        ContentType::Live
    } else {
        ContentType::Movie
    }
}

fn stalker_id(item: &Value) -> Option<String> {
    ["id", "stream_id", "series_id", "movie_id"]
        .iter()
        .find_map(|k| s_field(item, k))
}

fn apply_stalker(conn: &Connection, id: &str, us: &Value, misses: &mut Misses) -> CoreResult<()> {
    let to_info = |item: &Value| -> Option<(ItemInfo, String)> {
        let item_id = stalker_id(item)?;
        let content_type = stalker_ct(item);
        let title = ["title", "o_name", "name"]
            .iter()
            .find_map(|k| s_field(item, k))
            .unwrap_or_else(|| item_id.clone());
        let poster = ["cover", "logo", "poster_url", "screenshot_uri"]
            .iter()
            .find_map(|k| s_field(item, k));
        let info = ItemInfo {
            content_type,
            item_id,
            title,
            poster,
            category: None,
        };
        let mut extra = Map::new();
        extra.insert("portalItem".into(), item.clone());
        let snap = snapshot_json(&info, None, Some(extra));
        Some((info, snap))
    };

    let base = next_favorite_position(conn)?;
    for (n, item) in arr(us, "favorites").iter().enumerate() {
        match to_info(item) {
            Some((info, snap)) => {
                let at = item.get("added_at").and_then(normalize_ts);
                favorite_upsert_json(
                    conn,
                    &item_ref(id, &info),
                    &snap,
                    at.as_deref(),
                    Some(base + n as i64),
                )?;
            }
            None => misses.add("favorites without an id", "?"),
        }
    }
    for item in arr(us, "recentlyViewed") {
        match to_info(item) {
            Some((info, snap)) => {
                let at = item.get("added_at").and_then(normalize_ts);
                recent_upsert_json(conn, &item_ref(id, &info), &snap, at.as_deref())?;
            }
            None => misses.add("recently viewed items without an id", "?"),
        }
    }
    apply_tsrust_state(conn, id, us, false, misses)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_manifests() {
        assert!(parse_manifest("not json").is_err());
        assert!(parse_manifest("[]").is_err());
        assert!(parse_manifest(r#"{"kind":"other","version":1,"playlists":[]}"#).is_err());
        let e =
            parse_manifest(r#"{"kind":"iptvnator-playlist-backup","version":2,"playlists":[]}"#)
                .err()
                .unwrap();
        assert!(e.to_string().contains("version"));
        assert!(parse_manifest(r#"{"kind":"iptvnator-playlist-backup","version":1}"#).is_err());
        let m = parse_manifest(
            r#"{"kind":"iptvnator-playlist-backup","version":1,"playlists":[],"settings":{"epgUrls":[" a ","a",""]},"extra":true}"#,
        )
        .unwrap();
        assert_eq!(m.epg_urls.unwrap(), vec!["a"]);
    }

    #[test]
    fn stalker_types() {
        assert_eq!(stalker_ct(&json!({"type": "itv"})), ContentType::Live);
        assert_eq!(
            stalker_ct(&json!({"category_id": "radio"})),
            ContentType::Radio
        );
        assert_eq!(
            stalker_ct(&json!({"category_id": "vod", "is_series": "1"})),
            ContentType::Series
        );
        assert_eq!(
            stalker_ct(&json!({"category_id": "5", "tv_genre_id": "5"})),
            ContentType::Live
        );
        assert_eq!(stalker_ct(&json!({"id": 1})), ContentType::Movie);
        assert_eq!(stalker_id(&json!({"movie_id": 77})).as_deref(), Some("77"));
    }

    #[test]
    fn entry_parsing() {
        let e = parse_entry(
            &json!({"portalType":"m3u","exportedId":"x","title":"T","source":{"kind":"url","rawM3u":"#EXTM3U","url":"http://h/p.m3u"}}),
            0,
        )
        .unwrap();
        assert_eq!(e.fingerprint, "m3u|url|http://h/p.m3u");
        match e.config {
            Config::M3u { final_cfg, .. } => assert_eq!(final_cfg.origin, M3uOrigin::Url),
            _ => panic!(),
        }
        let e = parse_entry(
            &json!({"portalType":"m3u","exportedId":"x","title":"T","source":{"kind":"file","rawM3u":"#EXTM3U\n#EXTINF:-1,A\nhttp://h/a","filePathHint":"Z:/missing.m3u"}}),
            0,
        )
        .unwrap();
        match e.config {
            Config::M3u { final_cfg, .. } => assert_eq!(final_cfg.origin, M3uOrigin::Text),
            _ => panic!(),
        }
        assert!(parse_entry(&json!({"portalType":"m3u","title":"T","source":{}}), 0).is_err());
        // Review round 1: unusable text. A header-only playlist with a URL
        // stays (it can be refreshed); without a URL, or junk text, it is out.
        for src in [
            json!({"kind":"text","rawM3u":"#EXTM3U"}),
            json!({"kind":"text","rawM3u":"this is not a playlist"}),
            json!({"kind":"url","rawM3u":"this is not a playlist","url":"http://h/p.m3u"}),
        ] {
            let v = json!({"portalType":"m3u","title":"T","source":src});
            let err = parse_entry(&v, 0).err().expect("refused");
            assert!(err.contains("no channels"), "{err}");
        }
        assert!(parse_entry(
            &json!({"portalType":"xtream","title":"T","connection":{"serverUrl":"http://h"}}),
            0
        )
        .is_err());
        assert!(parse_entry(&json!({"portalType":"weird","title":"T"}), 0).is_err());
        assert!(usable_id("abc-1_2"));
        assert!(!usable_id("a b"));
    }
}
