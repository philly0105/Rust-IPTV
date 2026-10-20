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

/// Collects unmatched ids per category and renders compact warnings, then
/// any other warnings of the entry ([`Misses::note`]) under the same label.
#[derive(Default)]
struct Misses(Vec<(&'static str, Vec<String>)>, Vec<String>);

impl Misses {
    fn add(&mut self, what: &'static str, id: impl Into<String>) {
        match self.0.iter_mut().find(|(w, _)| *w == what) {
            Some((_, ids)) => ids.push(id.into()),
            None => self.0.push((what, vec![id.into()])),
        }
    }
    /// A warning that is not a "not found" list, shown as `{label}: {text}`.
    fn note(&mut self, text: String) {
        self.1.push(text);
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
        for text in self.1 {
            warnings.push(format!("{label}: {text}"));
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
    /// parental: `settings.tsrustParental` (Tsrust extension).
    parental: Option<Value>,
    playlists: Vec<Value>,
    /// lists: top-level `tsrustCustomLists` (Tsrust extension, Run 2 C8).
    custom_lists: Vec<Value>,
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
    let parental = v
        .get("settings")
        .and_then(|s| s.get(super::EXT_PARENTAL_SETTINGS))
        .filter(|p| !p.is_null())
        .cloned();
    let custom_lists = arr(&v, super::EXT_CUSTOM_LISTS).to_vec();
    Ok(Manifest {
        epg_urls,
        app_settings,
        parental,
        playlists: playlists.clone(),
        custom_lists,
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

/// guide: a backup's `catchupOverride` object; dropped when it is not a valid override.
fn catchup_of(v: &Value) -> Option<crate::model::CatchupOverride> {
    let o = v.get("catchupOverride")?;
    let parsed = serde_json::from_value(o.clone()).ok()?;
    crate::catchup::m3u::validate_override(Some(parsed))
        .ok()
        .flatten()
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
            // guide: the source-wide catch-up override (absent in older backups).
            let catchup = catchup_of(&src);
            let final_cfg = match (src_kind.as_str(), &url, &file_hint) {
                (_, Some(u), _) if url_kind => M3uSourceConfig {
                    origin: M3uOrigin::Url,
                    url: Some(u.clone()),
                    file_path: None,
                    headers: headers.clone(),
                    catchup: catchup.clone(),
                },
                ("file", _, Some(p)) if !probe_files || std::path::Path::new(p).is_file() => {
                    M3uSourceConfig {
                        origin: M3uOrigin::File,
                        url: None,
                        file_path: Some(p.clone()),
                        headers: headers.clone(),
                        catchup: catchup.clone(),
                    }
                }
                _ => M3uSourceConfig {
                    origin: M3uOrigin::Text,
                    url: None,
                    file_path: None,
                    headers: headers.clone(),
                    catchup: catchup.clone(),
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
                    headers: headers_of(&c),
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

/// M3U config keys a merge may fill: the origin, URL and file path describe
/// where the existing source reads its playlist and always stay.
const M3U_FILL_KEYS: &[&str] = &["headers", "catchup"];

/// Merging a backup into an existing source (L2-settings-7): the source's
/// saved config wins, so an older backup never undoes later edits or blanks
/// a saved secret; the backup only fills top-level keys the saved config
/// lacks (missing, null, "" or {}). `keys` limits which keys may be filled.
fn fill_blanks(saved_json: &str, backup_json: &str, keys: Option<&[&str]>) -> String {
    let (Ok(Value::Object(mut saved)), Ok(Value::Object(backup))) = (
        serde_json::from_str::<Value>(saved_json),
        serde_json::from_str::<Value>(backup_json),
    ) else {
        return saved_json.to_string();
    };
    let blank = |v: Option<&Value>| match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Object(o)) => o.is_empty(),
        Some(_) => false,
    };
    for (key, value) in backup {
        if keys.is_some_and(|k| !k.contains(&key.as_str())) || blank(Some(&value)) {
            continue;
        }
        if blank(saved.get(&key)) {
            saved.insert(key, value);
        }
    }
    Value::Object(saved).to_string()
}

/// True when the two config documents are equal as JSON.
fn same_config(a: &str, b: &str) -> bool {
    match (
        serde_json::from_str::<Value>(a),
        serde_json::from_str::<Value>(b),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// `backup.import`: every catalog loads before it returns.
pub async fn import(
    state: &Arc<AppState>,
    json: &str,
    mode: ImportMode,
) -> CoreResult<ImportReport> {
    import_with(state, json, mode, false).await
}

/// `backup.import` with `background`: a merge returns once the source rows
/// and the user state that needs no catalog are written; the catalogs that
/// must load (named in [`ImportReport::refreshing`]) load afterwards, one at
/// a time, and each source's favorites and history follow its catalog
/// (L2-settings-3). Replace ignores `background`: it keeps the old sources
/// only until a new catalog loaded, so it has to wait for them.
pub async fn import_with(
    state: &Arc<AppState>,
    json: &str,
    mode: ImportMode,
    background: bool,
) -> CoreResult<ImportReport> {
    let manifest = parse_manifest(json)?;
    // parental: Replace removes every source and their parental locks with
    // them, so it needs the PIN (an active unlock) while controls are on.
    if mode == ImportMode::Replace {
        crate::parental::require_unlocked(state, "replace your sources from a backup").await?;
    }
    // One import at a time. The shared write lock (`import_lock`) is taken
    // only around database writes so a portal that hangs during its catalog
    // sync never blocks refreshes or `sources.add` (they take it to apply
    // parked state).
    let run = run_lock(state).lock_owned().await;
    let lock = import_lock(state);
    let mut report = ImportReport::default();
    let defer = background && mode == ImportMode::Merge;
    let mut deferred: Vec<Deferred> = Vec::new();

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
    // parental / watchlist: My List rows of every imported entry (applied in
    // one call at the end) and whether locks were added.
    let mut watch: Vec<crate::watchlist::WatchlistBackupEntry> = Vec::new();
    // Run 2 (C8): series recording rules of every imported entry, restored
    // once Replace has removed the old sources (their rules would otherwise
    // count toward the rule limit).
    let mut rule_sets: Vec<RuleSet> = Vec::new();
    let mut locks_added = false;
    // lists: backup `exportedId` -> the source id it was imported as, for the
    // custom lists restored after every entry (C8).
    let mut source_map: HashMap<String, String> = HashMap::new();
    let mut fingerprint_targets: HashMap<String, String> = HashMap::new();
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
            // The same playlist twice: its list items belong to the first copy.
            if let (Some(x), Some(t)) = (
                &entry.exported_id,
                fingerprint_targets.get(&entry.fingerprint),
            ) {
                source_map.entry(x.clone()).or_insert_with(|| t.clone());
            }
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
        // Mapped even when the import fails below: a source row that stayed
        // keeps its list items; one that did not is dropped by the restore.
        fingerprint_targets.insert(entry.fingerprint.clone(), target_id.clone());
        if let Some(x) = &entry.exported_id {
            source_map
                .entry(x.clone())
                .or_insert_with(|| target_id.clone());
        }
        match import_entry(
            state,
            &lock,
            &entry,
            &target_id,
            matched.is_some(),
            defer,
            &mut report.warnings,
        )
        .await
        {
            Ok(outcome) => {
                report.imported += 1;
                failures.extend(outcome.failure);
                if let Some(d) = outcome.deferred {
                    report.refreshing.push(d.name.clone());
                    deferred.push(d);
                }
                locks_added |=
                    restore_locks(state, &lock, &entry, &target_id, &mut report.warnings).await?;
                collect_watchlist(&entry, &target_id, &mut watch, &mut report.warnings);
                collect_rules(&entry, &target_id, &mut rule_sets, &mut report.warnings);
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
            crate::sources::emit_changed(state, None, crate::sources::ChangeReason::Catalog);
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
        // Their parental locks went with them.
        locks_added = true;
    }

    restore_recording_rules(state, &lock, rule_sets, &mut report.warnings).await?;
    restore_watchlist(state, &lock, watch, mode, &mut report.warnings).await?;
    restore_custom_lists(
        state,
        &lock,
        &manifest.custom_lists,
        source_map,
        mode,
        &mut report.warnings,
    )
    .await?;
    if locks_added {
        crate::parental::announce(state).await?;
    }
    crate::sources::emit_changed(state, None, crate::sources::ChangeReason::Catalog);
    tracing::info!(
        imported = report.imported,
        skipped = report.skipped,
        warnings = report.warnings.len(),
        refreshing = deferred.len(),
        ?mode,
        "backup imported"
    );
    if !deferred.is_empty() {
        tokio::spawn(load_deferred(state.clone(), deferred, run));
    }
    Ok(report)
}

/// True when source `id` holds a catalog (channels, movies or series).
async fn has_catalog(state: &AppState, id: &str) -> CoreResult<bool> {
    let id = id.to_string();
    state.db_call(move |c| catalog_loaded(c, &id)).await
}

fn catalog_loaded(c: &Connection, id: &str) -> CoreResult<bool> {
    Ok(c.query_row(
        "SELECT COALESCE((SELECT channel_count + movie_count + series_count FROM source_counts WHERE source_id = ?1), 0) > 0
             OR EXISTS(SELECT 1 FROM items WHERE source_id = ?1)",
        [id],
        |r| r.get(0),
    )?)
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
    // Settings: app-level preferences (Tsrust extension). Each key is checked
    // on its own first, so a value this build refuses (an accent added by a
    // later version, a scale out of range) skips only that key, with its own
    // warning, instead of every setting in the backup.
    if !manifest.app_settings.is_empty() {
        let current = state.settings_snapshot();
        let mut patch = Map::new();
        for (key, value) in &manifest.app_settings {
            let mut one = Map::new();
            one.insert(key.clone(), value.clone());
            match crate::settings::apply_patch(&current, &Value::Object(one)) {
                Ok(_) => {
                    patch.insert(key.clone(), value.clone());
                }
                Err(err) => report.warnings.push(format!(
                    "App setting {key} was not restored: {}",
                    crate::sources::error_text(&err)
                )),
            }
        }
        if !patch.is_empty() {
            if let Err(err) = crate::settings::update(state, Value::Object(patch)).await {
                report.warnings.push(format!(
                    "App settings could not be restored: {}",
                    crate::sources::error_text(&err)
                ));
            }
        }
    }
    // parental: options (Tsrust extension). Refused with a warning while
    // parental controls are on and locked.
    if let Some(p) = &manifest.parental {
        if let Err(err) = crate::parental::restore_options(state, p, &mut report.warnings).await {
            report
                .warnings
                .push(format!("Parental settings could not be restored: {err}"));
        }
    }
}

/// parental: adds the entry's `tsrustParentalLocks` to source `id` (no PIN
/// needed, as with `parental.setLocked`). Locks do not depend on the catalog,
/// so they are applied even when the catalog did not load. Returns true when
/// a lock was added.
async fn restore_locks(
    state: &Arc<AppState>,
    lock: &tokio::sync::Mutex<()>,
    entry: &Entry,
    id: &str,
    warnings: &mut Vec<String>,
) -> CoreResult<bool> {
    let rows = arr(&entry.user_state, super::EXT_PARENTAL_LOCKS).to_vec();
    if rows.is_empty() {
        return Ok(false);
    }
    let id = id.to_string();
    let _guard = lock.lock().await;
    let (added, skipped) = state
        .db_call(move |c| crate::parental::restore_locks(c, &id, &rows))
        .await?;
    if skipped > 0 {
        warnings.push(format!(
            "{}: {skipped} parental lock(s) in the backup were not readable and were skipped",
            entry.label
        ));
    }
    Ok(added > 0)
}

/// watchlist: queues the entry's `tsrustWatchlist` rows under source `id`.
fn collect_watchlist(
    entry: &Entry,
    id: &str,
    out: &mut Vec<crate::watchlist::WatchlistBackupEntry>,
    warnings: &mut Vec<String>,
) {
    let mut bad = 0usize;
    for v in arr(&entry.user_state, super::EXT_WATCHLIST) {
        match serde_json::from_value::<crate::watchlist::WatchlistBackupEntry>(v.clone()) {
            Ok(mut e) => {
                e.source_id = id.to_string();
                out.push(e);
            }
            Err(_) => bad += 1,
        }
    }
    if bad > 0 {
        warnings.push(format!(
            "{}: {bad} My List entr{} in the backup were not readable and were skipped",
            entry.label,
            if bad == 1 { "y" } else { "ies" }
        ));
    }
}

/// Run 2 (C8): one imported entry's series recording rules.
struct RuleSet {
    source_id: String,
    label: String,
    rules: Vec<crate::recording::RecordingRuleBackup>,
}

/// Run 2 (C8): queues the entry's `tsrustRecordingRules` under source `id`.
/// Rules do not need the catalog, so they are restored at import even when
/// the rest of the entry's state is parked until its first refresh.
fn collect_rules(entry: &Entry, id: &str, out: &mut Vec<RuleSet>, warnings: &mut Vec<String>) {
    let mut misses = Misses::default();
    let mut rules = Vec::new();
    for (n, v) in arr(&entry.user_state, super::EXT_RECORDING_RULES)
        .iter()
        .enumerate()
    {
        match serde_json::from_value::<crate::recording::RecordingRuleBackup>(v.clone()) {
            Ok(r) => rules.push(r),
            Err(_) => misses.add("recording rules", format!("#{} (unreadable)", n + 1)),
        }
    }
    misses.flush(&entry.label, warnings);
    if !rules.is_empty() {
        out.push(RuleSet {
            source_id: id.to_string(),
            label: entry.label.clone(),
            rules,
        });
    }
}

/// Run 2 (C8): restores the queued recording rules once every entry is
/// imported and, on Replace, the previous sources are removed: the rules of
/// sources about to go must not count toward the rule limit
/// ([`crate::recording::rules::MAX_RULES`]). Rules the limit leaves out are
/// reported. One source's rules failing is rolled back on its own.
async fn restore_recording_rules(
    state: &Arc<AppState>,
    lock: &tokio::sync::Mutex<()>,
    sets: Vec<RuleSet>,
    warnings: &mut Vec<String>,
) -> CoreResult<()> {
    use crate::recording::rules::{import_counted, RuleImport, MAX_RULES};
    if sets.is_empty() {
        return Ok(());
    }
    let _guard = lock.lock().await;
    let (mut w, written) = state
        .db_call(move |c| {
            // One write transaction: the limit is counted against every rule
            // there is, including ones a concurrent `addRule` writes.
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut w = Vec::new();
            let mut done = RuleImport::default();
            for set in &sets {
                let exists = tx
                    .prepare_cached("SELECT 1 FROM sources WHERE id = ?1")?
                    .exists([&set.source_id])?;
                if !exists {
                    continue;
                }
                tx.execute_batch("SAVEPOINT backup_rules")?;
                match import_counted(&tx, &set.source_id, &set.rules) {
                    Ok(n) => {
                        tx.execute_batch("RELEASE backup_rules")?;
                        done.written += n.written;
                        done.over_cap += n.over_cap;
                    }
                    Err(err) => {
                        tx.execute_batch("ROLLBACK TO backup_rules; RELEASE backup_rules")?;
                        tracing::warn!(source_id = %set.source_id, error = %err, "backup: could not restore the recording rules");
                        let mut misses = Misses::default();
                        misses.add("recording rules", format!("all {} ({err})", set.rules.len()));
                        misses.flush(&set.label, &mut w);
                    }
                }
            }
            tx.commit()?;
            if done.over_cap > 0 {
                let (n, rules, were) = match done.over_cap {
                    1 => (1, "rule", "was"),
                    n => (n, "rules", "were"),
                };
                w.push(format!(
                    "{n} series recording {rules} in the backup {were} not restored: you can keep up to {MAX_RULES} series rules"
                ));
            }
            Ok((w, done.written))
        })
        .await?;
    drop(_guard);
    warnings.append(&mut w);
    if written > 0 {
        // The scheduler schedules their airings on its next re-match pass.
        state.emit(crate::recording::EVENT_RECORDINGS_UPDATE, json!({}));
    }
    Ok(())
}

/// watchlist: stores the queued My List rows in one call (C3). Replace clears
/// My List first, even when the backup has none; Merge adds to it.
async fn restore_watchlist(
    state: &Arc<AppState>,
    lock: &tokio::sync::Mutex<()>,
    entries: Vec<crate::watchlist::WatchlistBackupEntry>,
    mode: ImportMode,
    warnings: &mut Vec<String>,
) -> CoreResult<()> {
    let replace = mode == ImportMode::Replace;
    if entries.is_empty() && !replace {
        return Ok(());
    }
    let total = entries.len();
    let _guard = lock.lock().await;
    let applied = state
        .db_call(move |c| crate::watchlist::import_entries(c, &entries, replace))
        .await?;
    drop(_guard);
    if applied < total {
        warnings.push(format!(
            "{} of {total} My List entries were not restored (unknown source, live channel, or the list is full)",
            total - applied
        ));
    }
    if applied > 0 || replace {
        state.emit(crate::watchlist::CHANGED_EVENT, json!({}));
    }
    Ok(())
}

/// lists: reads the manifest's `tsrustCustomLists` leniently: a list without
/// a name and an item without a source, content type or item id are dropped
/// and counted.
fn parse_custom_lists(raw: &[Value]) -> (Vec<crate::lists::CustomListBackup>, usize) {
    let mut bad = 0usize;
    let mut out = Vec::new();
    for (n, v) in raw.iter().enumerate() {
        let Some(name) = s_field(v, "name") else {
            bad += arr(v, "items").len().max(1);
            continue;
        };
        let mut items = Vec::new();
        for (m, it) in arr(v, "items").iter().enumerate() {
            let ct = s_field(it, "contentType").and_then(|c| c.parse::<ContentType>().ok());
            let (Some(sid), Some(ct), Some(item_id)) =
                (s_field(it, "sourceExportedId"), ct, s_field(it, "itemId"))
            else {
                bad += 1;
                continue;
            };
            items.push(crate::lists::CustomListItemBackup {
                source_exported_id: sid,
                content_type: ct,
                item_id,
                title: s_field(it, "title").unwrap_or_default(),
                logo_url: s_field(it, "logoUrl"),
                position: i_field(it, "position").unwrap_or(m as i64),
                added_at: it.get("addedAt").and_then(normalize_ts).unwrap_or_default(),
            });
        }
        out.push(crate::lists::CustomListBackup {
            id: s_field(v, "id").unwrap_or_default(),
            name,
            position: i_field(v, "position").unwrap_or(n as i64),
            on_dashboard: v.get("onDashboard").is_none() || b_field(v, "onDashboard"),
            created_at: v
                .get("createdAt")
                .and_then(normalize_ts)
                .unwrap_or_default(),
            items,
        });
    }
    (out, bad)
}

/// lists: restores the manifest's custom lists once every entry is imported,
/// mapping each item's source through `source_map` (backup `exportedId` ->
/// imported source id). Replace recreates the lists, clearing them even when
/// the backup has none; Merge adds to lists of the same name. Items whose
/// source is not in the backup are dropped with a warning; lists that could
/// not be created (blank name, list limit) are counted in another.
async fn restore_custom_lists(
    state: &Arc<AppState>,
    lock: &tokio::sync::Mutex<()>,
    raw: &[Value],
    source_map: HashMap<String, String>,
    mode: ImportMode,
    warnings: &mut Vec<String>,
) -> CoreResult<()> {
    let replace = mode == ImportMode::Replace;
    if raw.is_empty() && !replace {
        return Ok(());
    }
    let (lists, bad) = parse_custom_lists(raw);
    if bad > 0 {
        warnings.push(format!(
            "Custom lists: skipped {bad} unreadable entr{} in the backup",
            if bad == 1 { "y" } else { "ies" }
        ));
    }
    let mut misses = Misses::default();
    let mut unmapped = 0usize;
    for it in lists.iter().flat_map(|l| &l.items) {
        if !source_map.contains_key(&it.source_exported_id) {
            unmapped += 1;
            let what = if it.title.is_empty() {
                &it.item_id
            } else {
                &it.title
            };
            misses.add("channels", what.clone());
        }
    }
    misses.flush("Custom lists (source not in the backup)", warnings);
    let _guard = lock.lock().await;
    let out = state
        .db_call(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let out = crate::lists::import_lists(&tx, &lists, &source_map, replace)?;
            tx.commit()?;
            Ok(out)
        })
        .await?;
    drop(_guard);
    if out.items_dropped > unmapped {
        warnings.push(format!(
            "Custom lists: {} channel(s) were not restored (their source is gone, they are not live or radio channels, or a list or the lists are full)",
            out.items_dropped - unmapped
        ));
    }
    if out.lists_dropped > 0 {
        let (n, lists, were) = match out.lists_dropped {
            1 => (1, "list", "was"),
            n => (n, "lists", "were"),
        };
        warnings.push(format!(
            "Custom lists: {n} {lists} in the backup {were} not restored (a blank name, or you can keep up to {} lists)",
            crate::lists::MAX_LISTS
        ));
    }
    if out.written > 0 || replace {
        state.emit(crate::lists::CHANGED_EVENT, json!({}));
    }
    Ok(())
}

/// What [`import_entry`] did with an entry's catalog.
struct EntryOutcome {
    /// Plain reason the catalog did not load.
    failure: Option<String>,
    /// The catalog load a background merge runs after the RPC returned.
    deferred: Option<Deferred>,
}

/// A catalog load left for [`load_deferred`]; the entry's user state is
/// parked until it succeeds.
struct Deferred {
    id: String,
    /// The source's name (a merge keeps the existing one).
    name: String,
    kind: SourceKind,
    run_cfg: Option<M3uSourceConfig>,
}

async fn import_entry(
    state: &Arc<AppState>,
    lock: &tokio::sync::Mutex<()>,
    entry: &Entry,
    id: &str,
    is_merge: bool,
    defer: bool,
    warnings: &mut Vec<String>,
) -> CoreResult<EntryOutcome> {
    // 1. Source row (+ raw text for m3u), with its real config. A URL entry
    //    without channels in its text is fetched from its URL; any other m3u
    //    entry imports its embedded text (step 2).
    //
    //    A merge keeps the existing source's name, auto refresh, position and
    //    config; the backup only fills what the source lacks (L2-settings-7).
    //    When the source already holds a catalog and the merge changed
    //    nothing in its config, the catalog is not imported again and the
    //    user state applies to the loaded one (L2-settings-3).
    let fetch_url = matches!(&entry.config, Config::M3u { by_url: true, final_cfg, .. } if final_cfg.origin == M3uOrigin::Url);
    let is_m3u = entry.kind == SourceKind::M3u;
    let backup_json = match &entry.config {
        Config::M3u { final_cfg, .. } => serde_json::to_string(final_cfg)?,
        Config::Xtream(c) => serde_json::to_string(c)?,
        Config::Stalker(c) => serde_json::to_string(c)?,
    };
    let (config_json, skip, stored_name) = {
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
        state
            .db_call(move |c| {
                let saved: Option<(String, String)> = if is_merge {
                    c.query_row(
                        "SELECT name, config_json FROM sources WHERE id = ?1 AND kind = ?2",
                        params![id, kind],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?
                } else {
                    None
                };
                let (config_json, skip) = match &saved {
                    Some((_, saved_cfg)) => {
                        let fill = is_m3u.then_some(M3U_FILL_KEYS);
                        let merged = fill_blanks(saved_cfg, &backup_json, fill);
                        let skip = same_config(&merged, saved_cfg) && catalog_loaded(c, &id)?;
                        (merged, skip)
                    }
                    None => (backup_json, false),
                };
                // Over RAW_INLINE_MAX the text goes to the playlist cache
                // with raw = '', exactly as an import of a large file does.
                let raw = match &raw {
                    Some(text) if !skip => Some((
                        crate::m3u::place_raw_text(&data_dir, &id, text)?,
                        text.as_str(),
                    )),
                    _ => None,
                };
                let tx = c.transaction()?;
                let now = crate::db::now_rfc3339();
                let name = match saved {
                    Some((saved_name, _)) => {
                        let name = if saved_name.trim().is_empty() {
                            name
                        } else {
                            saved_name
                        };
                        tx.execute(
                            "UPDATE sources SET name = ?2, updated_at = ?3, config_json = ?4 WHERE id = ?1",
                            params![id, name, now, config_json],
                        )?;
                        name
                    }
                    None => {
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
                        name
                    }
                };
                if let Some((stored, text)) = raw {
                    // sha256 stays empty unless the text is unchanged, so the
                    // m3u importer's "unchanged since last import" shortcut
                    // only fires when the catalog really matches the text.
                    // Inline text compares directly; a cached copy (raw = '')
                    // compares by the sha the importer recorded for it.
                    let sha = crate::m3u::importer::playlist_sha(text.as_bytes());
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
                Ok((config_json, skip, name))
            })
            .await?
    };
    if is_merge {
        warnings.push(format!(
            "{}: merged into an existing source with the same connection",
            entry.label
        ));
    }

    // 2. Catalog. An m3u entry's importer runs with a `text` origin so it
    //    parses the embedded playlist instead of fetching it; the row keeps
    //    its real origin. `failure` is the plain reason it did not load.
    let run_cfg = if is_m3u && !fetch_url && !skip {
        let cfg: M3uSourceConfig = serde_json::from_str(&config_json)?;
        Some(M3uSourceConfig {
            origin: M3uOrigin::Text,
            url: None,
            file_path: None,
            headers: cfg.headers,
            catchup: cfg.catchup,
        })
    } else {
        None
    };
    let mut failure = None;
    let no_password = entry.kind == SourceKind::Xtream
        // The stored config: a merge may have kept the saved password.
        && serde_json::from_str::<XtreamSourceConfig>(&config_json)
            .map_or(true, |c| c.password.is_empty());
    let synced = if skip {
        true
    } else if no_password {
        let msg =
            "The backup has no password for this account; edit the source to add it, then refresh";
        set_error_coded(state, id, Some((msg, crate::error::RpcErrorCode::Auth))).await?;
        warnings.push(format!("{}: catalog not loaded: {msg}", entry.label));
        failure = Some(format!("{}: {msg}", entry.label));
        false
    } else if defer {
        // Background merge: the user state waits, parked, for the catalog.
        let _guard = lock.lock().await;
        let (id_s, kind, user_state) = (id.to_string(), entry.kind, entry.user_state.clone());
        state
            .db_call(move |c| park(c, &id_s, kind, &user_state))
            .await?;
        return Ok(EntryOutcome {
            failure: None,
            deferred: Some(Deferred {
                id: id.to_string(),
                name: stored_name,
                kind: entry.kind,
                run_cfg,
            }),
        });
    } else {
        // Through the per-source lock (never the global one): the same
        // serialization `sources.refresh` uses, without blocking other sources.
        match crate::sources::run_import_with(
            state,
            id,
            run_importer(state, id, entry.kind, run_cfg),
        )
        .await
        {
            Ok(total) => {
                // Ends the source's progress toast, as `sources::run_import` does.
                crate::sources::progress(state, id, "done", total, Some(total), None);
                true
            }
            Err(msg) => {
                warnings.push(format!(
                    "{}: catalog not loaded ({msg}); the source was kept and its favorites and history will be restored after the first successful refresh",
                    entry.label
                ));
                failure = Some(format!("{}: {msg}", entry.label));
                false
            }
        }
    };

    // 3. User state.
    let _guard = lock.lock().await;
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
    Ok(EntryOutcome {
        failure,
        deferred: None,
    })
}

/// Background merge (L2-settings-3): loads the deferred catalogs one at a
/// time, as `sources.refreshAll` does, each through the per-source lock and
/// with the usual `import.progress` events, then applies the source's parked
/// user state (it still follows its catalog). Holds the backup run lock, so
/// the next `backup.import` waits for it.
async fn load_deferred(
    state: Arc<AppState>,
    deferred: Vec<Deferred>,
    _run: tokio::sync::OwnedMutexGuard<()>,
) {
    let mut failed = 0usize;
    for d in deferred {
        let loaded = crate::sources::run_import_with(
            &state,
            &d.id,
            run_importer(&state, &d.id, d.kind, d.run_cfg),
        )
        .await;
        let ok = loaded.is_ok();
        failed += usize::from(!ok);
        // As in the foreground: Stalker state applies even without a catalog.
        if ok || d.kind == SourceKind::Stalker {
            match restore_parked(&state, &d.id, d.kind != SourceKind::Stalker).await {
                Ok(w) if !w.is_empty() => {
                    tracing::info!(source_id = %d.id, warnings = w.len(), "backup state restored after its catalog loaded");
                }
                Ok(_) => {}
                Err(err) => {
                    tracing::warn!(source_id = %d.id, %err, "parked backup state could not be applied");
                }
            }
        }
        // `done` once the parked state is in, so it and `sources.changed`
        // reach clients together: one refetch round, not two (ST-5).
        if let Ok(total) = loaded {
            crate::sources::progress(&state, &d.id, "done", total, Some(total), None);
        }
        crate::sources::emit_changed(&state, Some(&d.id), crate::sources::ChangeReason::Catalog);
    }
    tracing::info!(failed, "backup import: background catalog loads finished");
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
/// outcome on the row. Returns the item total for the caller's `done`
/// progress, or a user-facing message on failure. `run_cfg`
/// replaces the stored m3u config for this run only (the `text` origin that
/// parses the embedded playlist).
async fn run_importer(
    state: &Arc<AppState>,
    id: &str,
    kind: SourceKind,
    run_cfg: Option<M3uSourceConfig>,
) -> Result<u64, String> {
    let Some(imp) = crate::sources::importer(state, kind) else {
        let msg = format!("no {kind} importer is available");
        let code = crate::error::RpcErrorCode::Unsupported;
        let _ = set_error_coded(state, id, Some((&msg, code))).await;
        return Err(msg);
    };
    let source = {
        let id = id.to_string();
        match state.db_call(move |c| load_source(c, &id)).await {
            Ok(Some(mut s)) => {
                if run_cfg.is_some() {
                    s.m3u = run_cfg;
                }
                s
            }
            Ok(None) => return Err("source row vanished during import".into()),
            Err(e) => return Err(e.to_string()),
        }
    };
    if kind == SourceKind::Stalker {
        // A replace re-creates the id, maybe against another portal: rows
        // remembered in memory for the old one must not answer for it.
        crate::stalker::Runtime::get(state).forget_source(id);
    }
    // guide: a replaced id may point at another panel; drop its cached guide answers.
    crate::catchup::forget_source(state, id);
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
            Ok((summary.channels + summary.movies + summary.series).max(0) as u64)
        }
        Err(err) => {
            let msg = crate::sources::error_text(&err);
            tracing::warn!(source_id = %id, %kind, error = %msg, "backup source import failed");
            let _ = set_error_coded(state, id, Some((&msg, err.code()))).await;
            if crate::sources::is_cancelled_error(&err) {
                crate::sources::progress_cancelled(state, id, &msg);
            } else {
                crate::sources::progress_error(state, id, &msg, err.code());
            }
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
    restore_parked(state, source_id, true).await
}

/// [`apply_pending_restore`]; `require_items: false` applies the state even
/// to an empty catalog (a Stalker portal whose sync failed, as a foreground
/// import does).
async fn restore_parked(
    state: &Arc<AppState>,
    source_id: &str,
    require_items: bool,
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
            if require_items && !has_items {
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
/// new source id: EPG mappings and per-channel guide shifts (each kept when
/// the source already has one for the item), playback positions (same rules
/// as the IPTVnator positions: dated rows only replace older ones, undated
/// rows only fill gaps) and hidden categories. `check_items` requires the
/// item in the local catalog (M3U); Stalker VOD is not stored locally, so its
/// positions apply as is.
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
    for m in arr(us, super::EXT_EPG_SHIFTS) {
        let (Some(ct), Some(item)) = (ct_of(m), s_field(m, "itemId")) else {
            continue;
        };
        let Some(minutes) = i_field(m, "shiftMinutes") else {
            continue;
        };
        // A range check, not `abs()`: an out-of-range number or string
        // saturates to i64::MIN, whose absolute value overflows.
        let max = i64::from(crate::epg::query::MAX_SHIFT_MINUTES);
        if minutes == 0 || !(-max..=max).contains(&minutes) {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO epg_channel_shift(source_id, content_type, item_id, shift_minutes)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, ct.as_str(), item, minutes],
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
    // Run 2 (C8): channel edits and the watch log. Keyed by catalog id like
    // the rest, but they do not need the item in the catalog. Recording
    // rules are restored apart, after the import ([`restore_recording_rules`]).
    apply_run2_ext(
        conn,
        id,
        us,
        super::EXT_CHANNEL_EDITS,
        "channel edits",
        crate::channeledit::import_edits,
        misses,
    )?;
    let log = apply_run2_ext(
        conn,
        id,
        us,
        super::EXT_WATCH_LOG,
        "watch history days",
        crate::stats::import_log,
        misses,
    )?;
    if let Some(n) = log.map(|l| l.skipped).filter(|&n| n > 0) {
        let (entries, were) = match n {
            1 => ("entry", "was"),
            _ => ("entries", "were"),
        };
        misses.note(format!(
            "{n} watch history {entries} in the backup {were} not restored (an unreadable date or one outside the last {} days, no title or item id, or no time watched)",
            crate::stats::RETENTION_DAYS
        ));
    }
    Ok(())
}

/// Run 2 (C8): parses one per-entry extension array into its module's backup
/// rows and stores them under source `id` with that module's import
/// function. An unreadable row is skipped; a store that fails is rolled back
/// on its own (a savepoint), so neither costs the rest of the entry's state.
/// Both are reported through `misses`. Returns what the store returned;
/// `None` when it did not run or failed.
fn apply_run2_ext<T: serde::de::DeserializeOwned, R>(
    conn: &Connection,
    id: &str,
    us: &Value,
    key: &str,
    what: &'static str,
    store: fn(&Connection, &str, &[T]) -> CoreResult<R>,
    misses: &mut Misses,
) -> CoreResult<Option<R>> {
    let raw = arr(us, key);
    if raw.is_empty() {
        return Ok(None);
    }
    let mut rows = Vec::with_capacity(raw.len());
    for (n, v) in raw.iter().enumerate() {
        match serde_json::from_value::<T>(v.clone()) {
            Ok(r) => rows.push(r),
            Err(_) => misses.add(what, format!("#{} (unreadable)", n + 1)),
        }
    }
    if rows.is_empty() {
        return Ok(None);
    }
    conn.execute_batch("SAVEPOINT backup_run2_ext")?;
    match store(conn, id, &rows) {
        Ok(out) => {
            conn.execute_batch("RELEASE backup_run2_ext")?;
            Ok(Some(out))
        }
        Err(err) => {
            conn.execute_batch("ROLLBACK TO backup_run2_ext; RELEASE backup_run2_ext")?;
            tracing::warn!(source_id = %id, key, error = %err, "backup: could not restore an extension");
            misses.add(what, format!("all {} ({err})", rows.len()));
            Ok(None)
        }
    }
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
