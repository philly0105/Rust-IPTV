//! `settings` module (B2): application settings and main-window geometry.
//!
//! Settings live as one camelCase JSON document in the `settings` table (row
//! id 1, C3) and are cached in [`AppState::settings`]. Every write goes through
//! [`update`] or [`reset`], which serialize writers, validate, persist, refresh
//! the cache, and emit `settings.changed`.
//!
//! `settings.update` takes a partial patch and applies it with JSON Merge Patch
//! semantics (RFC 7396): objects merge recursively (so `{tmdb: {enabled: true}}`
//! keeps the stored API key), arrays and scalars replace, and `null` removes an
//! optional field (back to its default).
//!
//! Window geometry lives in `app_state` under [`WINDOW_STATE_KEY`].
//!
//! Secrets: `tmdb.apiKey` is part of the settings document. It is never logged;
//! validation messages name fields, not values.

pub mod rpc;

use crate::error::{CoreError, CoreResult};
use crate::model::{Settings, WindowState};
use crate::player::DetectedPlayers;
use crate::state::AppState;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

/// The 19 UI languages (C9). The settings `language` value is the folder name.
pub const LANGUAGES: [&str; 19] = [
    "ar", "ary", "by", "de", "el", "en", "es", "fr", "hu", "it", "ja", "ko", "nl", "pl", "pt",
    "ru", "tr", "zh", "zhtw",
];

/// `app_state` key holding the main window geometry.
pub const WINDOW_STATE_KEY: &str = "window_state";

/// Lowest port the remote control server may bind (no privileged ports).
pub const MIN_REMOTE_PORT: u16 = 1024;

/// Longest accepted `lastRoute`.
const MAX_ROUTE_LEN: usize = 2048;

/// Largest accepted window dimension / coordinate magnitude (px).
const MAX_WINDOW_DIM: u32 = 32_768;
const MAX_WINDOW_COORD: i32 = 100_000;

/// Accepted `epgOffsetMinutes` range (12 hours either way).
pub const EPG_OFFSET_RANGE: std::ops::RangeInclusive<i32> = -720..=720;
/// Accepted `vodMinRating` range.
pub const VOD_RATING_RANGE: std::ops::RangeInclusive<f64> = 0.0..=10.0;
// account:
/// Largest accepted `sourceRefreshIntervalHours` (one week).
pub const MAX_REFRESH_INTERVAL_HOURS: u32 = 168;
/// Largest accepted `accountExpiryWarnDays`.
pub const MAX_EXPIRY_WARN_DAYS: u32 = 60;

/// Fields only the desktop app may change: they name executables, their
/// arguments, and folders on the machine running the core. In server (PWA)
/// mode any browser on the network could otherwise point them at an
/// arbitrary program or folder.
pub const DESKTOP_ONLY_FIELDS: [&str; 6] = [
    "mpvPath",
    "vlcPath",
    "mpvArgs",
    "vlcArgs",
    "downloadsDir",
    "recordingsDir",
];

/// Error returned when a server-mode client changes a [`DESKTOP_ONLY_FIELDS`] entry.
pub const DESKTOP_ONLY_MESSAGE: &str = "player and folder settings apply only to the desktop app";

/// `AppState.extensions` key of the writer lock.
const LOCK_KEY: &str = "settings_write_lock";

fn write_lock(state: &AppState) -> Arc<tokio::sync::Mutex<()>> {
    state.ext_or_insert_with(LOCK_KEY, || Arc::new(tokio::sync::Mutex::new(())))
}

/// Start of a masked secret; the UI's `maskSecret` uses the same form.
pub const SECRET_MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}";

/// The mask plus the last 4 characters (only the mask for 4 or fewer).
fn mask_secret(secret: &str) -> String {
    let n = secret.chars().count();
    if n <= 4 {
        return SECRET_MASK.to_string();
    }
    let tail: String = secret.chars().skip(n - 4).collect();
    format!("{SECRET_MASK}{tail}")
}

/// Settings as an RPC client or `settings.changed` sees them. In server
/// mode the TMDB key is masked: a browser on the network never gets it back.
/// The desktop app sees it unchanged.
pub fn for_client(state: &AppState, mut s: Settings) -> Settings {
    if !state.is_desktop {
        s.tmdb.api_key = s.tmdb.api_key.as_deref().map(mask_secret);
    }
    s
}

/// `AppState.extensions` key of the TMDB key cleared by the last
/// [`reset`] (server mode only; in memory, never persisted or sent).
const RESET_KEY_STASH: &str = "settings_reset_tmdb_key";

#[derive(Default)]
struct ResetKeyStash(parking_lot::Mutex<Option<String>>);

fn reset_stash(state: &AppState) -> Arc<ResetKeyStash> {
    state.ext_or_insert_with(RESET_KEY_STASH, || Arc::new(ResetKeyStash::default()))
}

/// Server mode: a patch that sends back the masked key (the UI resends the
/// whole `tmdb` object) keeps the stored key instead of overwriting it.
/// After a reset cleared the key, the mask of that key (an Undo resending
/// the pre-reset settings) restores it.
fn unmask_key(state: &AppState, current: &Settings, patch: &mut Value) {
    let Some(tmdb) = patch.get_mut("tmdb").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(sent) = tmdb
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|k| k.starts_with(SECRET_MASK))
        .map(str::to_owned)
    else {
        return;
    };
    let stash = reset_stash(state);
    let mut stashed = stash.0.lock();
    match stashed.as_deref() {
        Some(old) if current.tmdb.api_key.is_none() && mask_secret(old) == sent => {
            tmdb.insert("apiKey".into(), Value::String(old.to_owned()));
            *stashed = None;
        }
        _ => {
            tmdb.remove("apiKey");
        }
    }
}

/// Current settings (from the cache).
pub fn get(state: &AppState) -> Settings {
    state.settings_snapshot()
}

/// Applies `patch` (a partial camelCase Settings object) over the current
/// settings, validates, persists, refreshes the cache, and emits
/// `settings.changed`. Returns the new settings.
pub async fn update(state: &Arc<AppState>, mut patch: Value) -> CoreResult<Settings> {
    if !patch.is_object() {
        return Err(CoreError::invalid("settings patch must be a JSON object"));
    }
    let lock = write_lock(state);
    let _guard = lock.lock().await;

    let current = state.settings_snapshot();
    if !state.is_desktop {
        unmask_key(state, &current, &mut patch);
    }
    let merged = merge(&current, &patch)?;
    if !state.is_desktop {
        // Before validation, so a server client cannot probe which paths exist.
        check_desktop_only(&current, &merged, &DESKTOP_ONLY_FIELDS)?;
    }
    // Server mode refuses new local EPG paths up front (no file access).
    for u in merged
        .epg_urls
        .iter()
        .filter(|u| !current.epg_urls.contains(u))
    {
        crate::epg::fetch::check_server_url(state, u)?;
    }
    let next = validate(&current, merged)?;
    if next == current {
        // Nothing changed: skip the write and the event.
        return Ok(current);
    }
    store(state, next).await
}

/// Restores the defaults, persists them, and emits `settings.changed`. In
/// server mode the [`DESKTOP_ONLY_FIELDS`] keep their values: a server
/// client cannot set them, so an Undo that resent them would be refused and
/// leave every setting reset (review round 3).
pub async fn reset(state: &Arc<AppState>) -> CoreResult<Settings> {
    let lock = write_lock(state);
    let _guard = lock.lock().await;
    let mut next = Settings::default();
    if !state.is_desktop {
        let current = state.settings_snapshot();
        // Server clients only ever saw the mask, so an Undo cannot resend
        // the key: keep it in memory for [`unmask_key`].
        if current.tmdb.api_key.is_some() {
            *reset_stash(state).0.lock() = current.tmdb.api_key.clone();
        }
        next.mpv_path = current.mpv_path;
        next.vlc_path = current.vlc_path;
        next.mpv_args = current.mpv_args;
        next.vlc_args = current.vlc_args;
        next.downloads_dir = current.downloads_dir;
        next.recordings_dir = current.recordings_dir;
    }
    store(state, next).await
}

/// Replaces the whole settings document (for modules that change one field,
/// such as `downloads.setDir`): normalizes, validates against the current
/// settings, persists, refreshes `state.settings`, and emits
/// `settings.changed`. No write and no event when nothing changed.
pub async fn save(state: &AppState, next: Settings) -> CoreResult<Settings> {
    let lock = write_lock(state);
    let _guard = lock.lock().await;
    let current = state.settings_snapshot();
    let next = validate(&current, normalize(next))?;
    if !state.is_desktop {
        // `downloadsDir` is exempt here: `downloads.setDir` is the only caller
        // that changes it through `save`, and it applies its own server rule.
        let fields: Vec<&str> = DESKTOP_ONLY_FIELDS
            .into_iter()
            .filter(|f| *f != "downloadsDir")
            .collect();
        check_desktop_only(&current, &next, &fields)?;
    }
    if next == current {
        return Ok(current);
    }
    store(state, next).await
}

/// Refuses (Unsupported) when any of `fields` differs between `current` and `next`.
pub fn check_desktop_only(current: &Settings, next: &Settings, fields: &[&str]) -> CoreResult<()> {
    let changed = |f: &str| match f {
        "mpvPath" => current.mpv_path != next.mpv_path,
        "vlcPath" => current.vlc_path != next.vlc_path,
        "mpvArgs" => current.mpv_args != next.mpv_args,
        "vlcArgs" => current.vlc_args != next.vlc_args,
        "downloadsDir" => current.downloads_dir != next.downloads_dir,
        "recordingsDir" => current.recordings_dir != next.recordings_dir,
        _ => false,
    };
    if fields.iter().any(|f| changed(f)) {
        return Err(CoreError::Unsupported(DESKTOP_ONLY_MESSAGE.into()));
    }
    Ok(())
}

async fn store(state: &AppState, next: Settings) -> CoreResult<Settings> {
    let json = serde_json::to_string(&next)?;
    state.db_call(move |conn| persist_json(conn, &json)).await?;
    *state.settings.write() = next.clone();
    tracing::info!("settings updated");
    state.emit("settings.changed", for_client(state, next.clone()));
    Ok(next)
}

/// Merges `patch` over `current` and returns validated, normalized settings.
/// Pure: no I/O besides checking the existence of changed paths.
pub fn apply_patch(current: &Settings, patch: &Value) -> CoreResult<Settings> {
    validate(current, merge(current, patch)?)
}

/// Merges `patch` over `current` and normalizes, without validating.
fn merge(current: &Settings, patch: &Value) -> CoreResult<Settings> {
    let mut doc = serde_json::to_value(current)?;
    merge_patch(&mut doc, patch);
    let next: Settings = serde_json::from_value(doc).map_err(|e| {
        // serde messages name the offending type, never the full document.
        CoreError::invalid(format!("invalid settings: {e}"))
    })?;
    Ok(normalize(next))
}

/// RFC 7396 JSON Merge Patch.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(p) => {
            if !target.is_object() {
                *target = Value::Object(Default::default());
            }
            let t = target.as_object_mut().expect("object");
            for (k, v) in p {
                if v.is_null() {
                    t.remove(k);
                } else {
                    merge_patch(t.entry(k.clone()).or_insert(Value::Null), v);
                }
            }
        }
        other => *target = other.clone(),
    }
}

fn trim_opt(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Trims strings, maps empty optional strings to `None`, and de-duplicates EPG URLs.
pub fn normalize(mut s: Settings) -> Settings {
    s.language = s.language.trim().to_ascii_lowercase();
    s.last_route = trim_opt(s.last_route);
    s.mpv_path = trim_opt(s.mpv_path);
    s.vlc_path = trim_opt(s.vlc_path);
    s.downloads_dir = trim_opt(s.downloads_dir);
    s.recordings_dir = trim_opt(s.recordings_dir);
    s.tmdb.api_key = trim_opt(s.tmdb.api_key);
    s.tmdb.language = trim_opt(s.tmdb.language);
    let mut seen = std::collections::HashSet::new();
    s.epg_urls = s
        .epg_urls
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty() && seen.insert(u.clone()))
        .collect();
    s
}

/// Validates `next`. Paths are only checked when they changed relative to
/// `current`, so a player that was uninstalled later does not block unrelated
/// edits (the UI shows it through `settings.detectPlayers`).
pub fn validate(current: &Settings, next: Settings) -> CoreResult<Settings> {
    if !LANGUAGES.contains(&next.language.as_str()) {
        return Err(CoreError::invalid(format!(
            "unsupported language \"{}\"; expected one of {}",
            next.language,
            LANGUAGES.join(", ")
        )));
    }
    if next.remote_control.port < MIN_REMOTE_PORT {
        return Err(CoreError::invalid(format!(
            "remote control port must be between {MIN_REMOTE_PORT} and 65535"
        )));
    }
    if let Some(route) = &next.last_route {
        if !route.starts_with('/') || route.len() > MAX_ROUTE_LEN {
            return Err(CoreError::invalid(
                "lastRoute must be an app path starting with '/'",
            ));
        }
    }
    if !EPG_OFFSET_RANGE.contains(&next.epg_offset_minutes) {
        return Err(CoreError::invalid(format!(
            "epgOffsetMinutes must be between {} and {}",
            EPG_OFFSET_RANGE.start(),
            EPG_OFFSET_RANGE.end()
        )));
    }
    if !next.vod_min_rating.is_finite() || !VOD_RATING_RANGE.contains(&next.vod_min_rating) {
        return Err(CoreError::invalid("vodMinRating must be between 0 and 10"));
    }
    // account:
    if next.source_refresh_interval_hours > MAX_REFRESH_INTERVAL_HOURS {
        return Err(CoreError::invalid(format!(
            "sourceRefreshIntervalHours must be between 0 and {MAX_REFRESH_INTERVAL_HOURS}"
        )));
    }
    if next.account_expiry_warn_days > MAX_EXPIRY_WARN_DAYS {
        return Err(CoreError::invalid(format!(
            "accountExpiryWarnDays must be between 0 and {MAX_EXPIRY_WARN_DAYS}"
        )));
    }
    // recording:
    for (field, value, max) in [
        (
            "recordingPaddingBeforeMinutes",
            next.recording_padding_before_minutes,
            60,
        ),
        (
            "recordingPaddingAfterMinutes",
            next.recording_padding_after_minutes,
            120,
        ),
        ("reminderLeadMinutes", next.reminder_lead_minutes, 60),
    ] {
        if value > max {
            return Err(CoreError::invalid(format!(
                "{field} must be between 0 and {max}"
            )));
        }
    }
    let changed = |a: &Option<String>, b: &Option<String>| a != b;
    if changed(&current.mpv_path, &next.mpv_path) {
        check_file("mpvPath", next.mpv_path.as_deref())?;
    }
    if changed(&current.vlc_path, &next.vlc_path) {
        check_file("vlcPath", next.vlc_path.as_deref())?;
    }
    if changed(&current.downloads_dir, &next.downloads_dir) {
        check_dir("downloadsDir", next.downloads_dir.as_deref())?;
    }
    if changed(&current.recordings_dir, &next.recordings_dir) {
        check_dir("recordingsDir", next.recordings_dir.as_deref())?;
    }
    Ok(next)
}

fn check_dir(field: &str, dir: Option<&str>) -> CoreResult<()> {
    if let Some(dir) = dir {
        if !Path::new(dir).is_dir() {
            return Err(CoreError::invalid(format!(
                "{field} does not exist or is not a folder: {dir}"
            )));
        }
    }
    Ok(())
}

fn check_file(field: &str, path: Option<&str>) -> CoreResult<()> {
    if let Some(p) = path {
        if !Path::new(p).is_file() {
            return Err(CoreError::invalid(format!(
                "{field} does not point to an existing file: {p}"
            )));
        }
    }
    Ok(())
}

/// Writes the settings row (upsert of row id 1).
pub fn persist(conn: &Connection, settings: &Settings) -> CoreResult<()> {
    persist_json(conn, &serde_json::to_string(settings)?)
}

fn persist_json(conn: &Connection, json: &str) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO settings(id, json, updated_at) VALUES (1, ?1, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        [json],
    )?;
    Ok(())
}

/// Stored window geometry, or `None` when never saved or unreadable.
pub async fn window_state(state: &AppState) -> CoreResult<Option<WindowState>> {
    state
        .db_call(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM app_state WHERE key = ?1",
                    [WINDOW_STATE_KEY],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(
                raw.and_then(|text| match serde_json::from_str::<WindowState>(&text) {
                    Ok(ws) => Some(ws),
                    Err(err) => {
                        tracing::warn!(%err, "stored window state is unreadable; ignoring it");
                        None
                    }
                }),
            )
        })
        .await
}

/// Validates and stores window geometry.
pub async fn set_window_state(state: &AppState, ws: WindowState) -> CoreResult<()> {
    validate_window(&ws)?;
    let json = serde_json::to_string(&ws)?;
    state
        .db_call(move |conn| {
            conn.execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                [WINDOW_STATE_KEY, json.as_str()],
            )?;
            Ok(())
        })
        .await
}

/// Rejects zero-sized or absurd geometry (a corrupt value would open the
/// window off-screen or invisible on next launch).
pub fn validate_window(ws: &WindowState) -> CoreResult<()> {
    if ws.width == 0 || ws.height == 0 || ws.width > MAX_WINDOW_DIM || ws.height > MAX_WINDOW_DIM {
        return Err(CoreError::invalid(format!(
            "window size must be between 1 and {MAX_WINDOW_DIM} px"
        )));
    }
    for c in [ws.x, ws.y].into_iter().flatten() {
        if c.abs() > MAX_WINDOW_COORD {
            return Err(CoreError::invalid("window position is out of range"));
        }
    }
    Ok(())
}

/// `settings.detectPlayers`: delegates to the player module.
pub fn detect_players(state: &AppState) -> DetectedPlayers {
    crate::player::detect(&state.settings_snapshot())
}

/// No runtime needed.
pub async fn init(_state: Arc<AppState>) -> CoreResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Theme;
    use serde_json::json;

    #[test]
    fn merge_patch_follows_rfc7396() {
        let mut doc = json!({"a": 1, "o": {"x": 1, "y": 2}, "arr": [1, 2]});
        merge_patch(
            &mut doc,
            &json!({"a": null, "o": {"y": 3, "z": 4}, "arr": [9]}),
        );
        assert_eq!(doc, json!({"o": {"x": 1, "y": 3, "z": 4}, "arr": [9]}));
    }

    #[test]
    fn nested_patch_keeps_siblings() {
        let mut cur = Settings::default();
        cur.tmdb.api_key = Some("k".into());
        let next = apply_patch(&cur, &json!({"tmdb": {"enabled": true}})).unwrap();
        assert!(next.tmdb.enabled);
        assert_eq!(next.tmdb.api_key.as_deref(), Some("k"));
        let cleared = apply_patch(&next, &json!({"tmdb": {"apiKey": null}})).unwrap();
        assert!(cleared.tmdb.api_key.is_none());
    }

    #[test]
    fn validation_rules() {
        let cur = Settings::default();
        assert!(apply_patch(&cur, &json!({"language": "zhtw"})).is_ok());
        assert!(apply_patch(&cur, &json!({"language": "xx"})).is_err());
        assert!(apply_patch(&cur, &json!({"remoteControl": {"port": 80}})).is_err());
        assert!(apply_patch(&cur, &json!({"remoteControl": {"port": 70000}})).is_err());
        assert!(apply_patch(&cur, &json!({"remoteControl": {"port": 1024}})).is_ok());
        assert!(apply_patch(&cur, &json!({"theme": "neon"})).is_err());
        assert!(apply_patch(&cur, &json!({"mpvPath": "Z:/definitely/missing/mpv.exe"})).is_err());
        assert!(apply_patch(&cur, &json!({"downloadsDir": "Z:/missing/dir"})).is_err());
        assert!(apply_patch(&cur, &json!({"lastRoute": "dashboard"})).is_err());
        assert!(apply_patch(&cur, &json!({"recordingsDir": "Z:/missing/dir"})).is_err());
        assert!(apply_patch(&cur, &json!({"epgOffsetMinutes": 720})).is_ok());
        assert!(apply_patch(&cur, &json!({"epgOffsetMinutes": -720})).is_ok());
        assert!(apply_patch(&cur, &json!({"epgOffsetMinutes": 721})).is_err());
        assert!(apply_patch(&cur, &json!({"epgOffsetMinutes": 1.5})).is_err());
        assert!(apply_patch(&cur, &json!({"vodMinRating": 7.5})).is_ok());
        assert!(apply_patch(&cur, &json!({"vodMinRating": 10.5})).is_err());
        assert!(apply_patch(&cur, &json!({"vodMinRating": -1})).is_err());
        // Empty strings normalize to None and pass.
        let n = apply_patch(&cur, &json!({"mpvPath": "  ", "theme": "dark"})).unwrap();
        assert!(n.mpv_path.is_none());
        assert_eq!(n.theme, Theme::Dark);
    }

    #[test]
    fn stale_paths_do_not_block_other_edits() {
        let cur = Settings {
            mpv_path: Some("Z:/gone/mpv.exe".into()),
            ..Settings::default()
        };
        let n = apply_patch(&cur, &json!({"theme": "light"})).unwrap();
        assert_eq!(n.mpv_path.as_deref(), Some("Z:/gone/mpv.exe"));
    }

    #[test]
    fn epg_urls_are_trimmed_and_deduped() {
        let n = apply_patch(
            &Settings::default(),
            &json!({"epgUrls": [" http://a/x.xml", "http://a/x.xml", "", "http://b"]}),
        )
        .unwrap();
        assert_eq!(n.epg_urls, vec!["http://a/x.xml", "http://b"]);
    }

    #[test]
    fn window_validation() {
        let ok = WindowState {
            x: Some(10),
            y: Some(-20),
            width: 1280,
            height: 800,
            maximized: false,
        };
        assert!(validate_window(&ok).is_ok());
        assert!(validate_window(&WindowState {
            width: 0,
            ..ok.clone()
        })
        .is_err());
        assert!(validate_window(&WindowState {
            x: Some(1_000_000),
            ..ok
        })
        .is_err());
    }
}
