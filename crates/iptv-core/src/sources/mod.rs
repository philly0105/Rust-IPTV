//! `sources` module (B1): the sources table, importer registry, `sources.*`
//! rpc, and the startup refresh of auto-refresh sources.
//!
//! Importer contract (SPEC C4, amendment A1): each source kind registers an
//! [`Importer`] from its module `init` (m3u from `crate::m3u::init`, xtream
//! from B3, stalker from B4). [`run_import`] wraps every import: it serializes
//! imports per source, records `lastRefreshAt` / `lastError`, refreshes the
//! cached counts, and emits `import.progress` (`done` / `error`) and
//! `sources.changed`. See `docs/architecture/sources.md`.

pub mod rpc;
// account:
pub mod schedule;
pub mod store;

use crate::error::{CoreError, CoreResult, RpcError, RpcErrorCode};
use crate::model::{
    EpgLinks, ImportSummary, M3uOrigin, M3uSourceConfig, RequestHeaders, Source, SourceKind,
    StalkerSourceConfig, XtreamSourceConfig,
};
use crate::state::AppState;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use store::SourceConfig;

/// `AppState.extensions` key of the importer registry.
pub const IMPORTERS_KEY: &str = "importers";
/// `AppState.extensions` key of the per-source import locks.
pub const LOCKS_KEY: &str = "sources.locks";
/// Delay between boot and the startup refresh of auto-refresh sources
/// ([`schedule::startup`]). Late enough that the window, the first screen's
/// queries and the first stream are done on a slow machine before an import
/// downloads and takes the write lock; at 3 s the pass ran while WebView2
/// was still loading (ST-1). The pass refreshes only sources that are due,
/// so most launches import nothing.
pub const STARTUP_REFRESH_DELAY: Duration = Duration::from_secs(30);

/// Importer registry stored under [`IMPORTERS_KEY`].
pub type ImporterRegistry = DashMap<SourceKind, Arc<dyn Importer>>;

type LockMap = DashMap<String, Arc<tokio::sync::Mutex<()>>>;

/// `AppState.extensions` key of the per-source import cancel tokens.
pub const CANCELS_KEY: &str = "sources.cancels";

type CancelMap = DashMap<String, tokio_util::sync::CancellationToken>;

tokio::task_local! {
    /// Cancel token of the import [`run_import`] is running in this task.
    static IMPORT_CANCEL: tokio_util::sync::CancellationToken;
    /// The run itself, so errors raised inside it name the real cause.
    static IMPORT_RUN: Arc<ActiveRun>;
}

/// Imports (or re-imports) one source's catalog. m3u is registered by B1,
/// xtream by B3, stalker by B4, each from its module `init`.
#[async_trait::async_trait]
pub trait Importer: Send + Sync {
    fn kind(&self) -> SourceKind;
    async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary>;
}

/// Registers (or replaces) the importer for `imp.kind()`.
pub fn register_importer(state: &AppState, imp: Arc<dyn Importer>) {
    let registry =
        state.ext_or_insert_with::<ImporterRegistry>(IMPORTERS_KEY, || Arc::new(DashMap::new()));
    registry.insert(imp.kind(), imp);
}

/// Looks up the importer for a source kind. `sources.add` maps `None` to `Unsupported`.
pub fn importer(state: &AppState, kind: SourceKind) -> Option<Arc<dyn Importer>> {
    state
        .ext::<ImporterRegistry>(IMPORTERS_KEY)?
        .get(&kind)
        .map(|e| Arc::clone(e.value()))
}

/// `import.progress` payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress<'a> {
    pub source_id: &'a str,
    /// `connecting` | `fetching` | `parsing` | `saving` | `done` | `error` |
    /// `cancelled`. `connecting` opens every run, before its first request;
    /// `done` with the message `unchanged` means the catalog was kept as is.
    pub phase: &'a str,
    pub done: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'a str>,
    /// Classified error code for `phase: "error"` (C10).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<RpcErrorCode>,
    /// What a `saving` event is doing (see [`SaveStep`]); absent while rows
    /// are written. A client that does not know it keeps showing "Saving".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<&'a str>,
}

/// The long steps of a catalog save around the row writes, sent as
/// `import.progress {phase: "saving", step}` so the progress never sits
/// silent on "Saving N of N" (L3-perf-core-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveStep {
    /// Waiting for the write lock and deleting the previous catalog
    /// (`done` 0, no total: the bar is indeterminate).
    Replacing,
    /// Every row is written; building the indexes, the search index and
    /// the counts before the commit (`done` = `total` = rows written).
    Indexing,
}

impl SaveStep {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Replacing => "replacing",
            Self::Indexing => "indexing",
        }
    }
}

/// Emits `import.progress` (C6). Importers report parse and save counts at
/// most every 2000 items and at most every [`ProgressGate::EVERY`], plus the
/// final count.
pub fn progress(
    state: &AppState,
    source_id: &str,
    phase: &str,
    done: u64,
    total: Option<u64>,
    message: Option<&str>,
) {
    state.emit(
        "import.progress",
        ImportProgress {
            source_id,
            phase,
            done,
            total,
            message,
            code: None,
            step: None,
        },
    );
}

/// Emits `import.progress {phase: "saving", step}` (see [`SaveStep`]):
/// `Replacing` before the writer deletes the previous catalog, `Indexing`
/// once every row is written and the writer finishes.
pub fn progress_step(state: &AppState, source_id: &str, step: SaveStep, written: u64) {
    let (done, total) = match step {
        SaveStep::Replacing => (0, None),
        SaveStep::Indexing => (written, Some(written)),
    };
    state.emit(
        "import.progress",
        ImportProgress {
            source_id,
            phase: "saving",
            done,
            total,
            message: None,
            code: None,
            step: Some(step.as_str()),
        },
    );
}

/// How often an importer reports progress: the first event at once, then at
/// most every [`Self::EVERY`], however fast the rows or chunks arrive (each
/// event re-renders every source card). A run sends its final count
/// whatever the gate says.
#[derive(Debug, Default)]
pub struct ProgressGate {
    last: Option<std::time::Instant>,
}

impl ProgressGate {
    pub const EVERY: Duration = Duration::from_millis(250);

    /// True when an event may go out at `now` (and counts it as sent).
    pub fn due(&mut self, now: std::time::Instant) -> bool {
        match self.last {
            Some(t) if now.saturating_duration_since(t) < Self::EVERY => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

/// Emits `import.progress` with `phase: "error"`, the message and its
/// classified code (C10).
pub fn progress_error(state: &AppState, source_id: &str, message: &str, code: RpcErrorCode) {
    state.emit(
        "import.progress",
        ImportProgress {
            source_id,
            phase: "error",
            done: 0,
            total: None,
            message: Some(message),
            code: Some(code),
            step: None,
        },
    );
}

/// Message of the `done` progress of a run whose playlist had not changed
/// ([`ImportSummary::unchanged`]). Clients refetch only `sources.*` for it.
pub const UNCHANGED_MESSAGE: &str = "unchanged";

/// Emits `import.progress` with `phase: "connecting"`: a run has the source's
/// lock and is about to send its first request. Clients show "Connecting to
/// <host>" until the first fetch progress arrives.
pub fn progress_connecting(state: &AppState, source_id: &str) {
    progress(state, source_id, "connecting", 0, None, None);
}

/// Emits `import.progress` with `phase: "cancelled"` (C8): the run stopped
/// and the previous catalog is intact.
pub fn progress_cancelled(state: &AppState, source_id: &str, message: &str) {
    progress(state, source_id, "cancelled", 0, None, Some(message));
}

/// Why `sources.changed` fired. Clients refetch only what the reason can
/// have changed (L3-perf-core-5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeReason {
    /// A new source row; it has no catalog yet.
    Added,
    /// The source's catalog (or the user state tied to it) was rewritten.
    Catalog,
    /// The source's settings (name, URL, guide links, order) changed.
    Config,
    /// The source and everything tied to it are gone.
    Removed,
    /// Only the source's import status changed (last error, next refresh);
    /// its catalog is as it was.
    Status,
}

impl ChangeReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Catalog => "catalog",
            Self::Config => "config",
            Self::Removed => "removed",
            Self::Status => "status",
        }
    }
}

/// `sources.changed` payload. `sourceId` is absent when the change spans
/// every source (remove all, reorder, a backup restore).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcesChanged<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<&'a str>,
    pub reason: &'static str,
}

/// Emits `sources.changed {sourceId?, reason}`.
pub fn emit_changed(state: &AppState, source_id: Option<&str>, reason: ChangeReason) {
    state.emit(
        "sources.changed",
        SourcesChanged {
            source_id,
            reason: reason.as_str(),
        },
    );
    // remote: the phone's channel list follows the published source's catalog.
    if matches!(reason, ChangeReason::Catalog | ChangeReason::Removed) {
        crate::remote::channels_may_have_changed(state, source_id);
    }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

/// `sources.add` m3u payload.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct M3uAddInput {
    pub origin: Option<M3uOrigin>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub headers: Option<RequestHeaders>,
}

/// `sources.add` args.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSourceArgs {
    pub kind: SourceKind,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub auto_refresh: Option<bool>,
    #[serde(default)]
    pub m3u: Option<M3uAddInput>,
    #[serde(default)]
    pub xtream: Option<XtreamSourceConfig>,
    #[serde(default)]
    pub stalker: Option<StalkerSourceConfig>,
}

/// `Partial<EpgLinks>`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgPatch {
    #[serde(default)]
    pub detected_urls: Option<Vec<String>>,
    #[serde(default)]
    pub manual_urls: Option<Vec<String>>,
    #[serde(default)]
    pub disabled_urls: Option<Vec<String>>,
    /// Guide time shift of the source in minutes; 0 removes it.
    #[serde(default)]
    pub shift_minutes: Option<i32>,
}

/// `sources.update` patch. Config changes do not re-import.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub auto_refresh: Option<bool>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub m3u: Option<M3uSourceConfig>,
    #[serde(default)]
    pub xtream: Option<XtreamSourceConfig>,
    #[serde(default)]
    pub stalker: Option<StalkerSourceConfig>,
    #[serde(default)]
    pub epg: Option<EpgPatch>,
    /// New playlist text for a pasted or uploaded M3U source (origin `text`).
    /// It replaces the stored text; the next `sources.refresh` imports it
    /// under the same source id, so user state stays attached.
    #[serde(default)]
    pub text: Option<String>,
}

/// `sources.counts` result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCounts {
    pub channel_count: i64,
    pub radio_count: i64,
    pub movie_count: i64,
    pub series_count: i64,
}

/// One failed source in `sources.refreshAll`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshFailure {
    pub id: String,
    pub error: String,
    /// Classified code of `error` (C10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<RpcErrorCode>,
}

/// `sources.refreshAll` result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshAllResult {
    pub refreshed: Vec<String>,
    pub failed: Vec<RefreshFailure>,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn trimmed(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn clean_headers(h: RequestHeaders) -> RequestHeaders {
    RequestHeaders {
        user_agent: trimmed(h.user_agent.as_deref()),
        referrer: trimmed(h.referrer.as_deref()),
        origin: trimmed(h.origin.as_deref()),
    }
}

/// Rejects header values HTTP cannot carry (a line break or other control
/// character), so a bad User-Agent fails here instead of on every request.
fn check_headers(h: &RequestHeaders) -> CoreResult<()> {
    for (name, value) in [
        ("User-Agent", &h.user_agent),
        ("Referer", &h.referrer),
        ("Origin", &h.origin),
    ] {
        if value
            .as_deref()
            .is_some_and(|v| reqwest::header::HeaderValue::from_str(v).is_err())
        {
            return Err(CoreError::Invalid(format!(
                "the {name} header has a line break or control character; remove it"
            )));
        }
    }
    Ok(())
}

fn check_http_url(raw: &str, what: &str) -> CoreResult<url::Url> {
    let u = url::Url::parse(raw.trim()).map_err(|e| {
        CoreError::Invalid(format!(
            "{what} is not a valid URL ({e}); include http:// or https://"
        ))
    })?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(CoreError::Invalid(format!(
            "{what} must start with http:// or https://"
        )));
    }
    if u.host_str().is_none_or(str::is_empty) {
        return Err(CoreError::Invalid(format!("{what} has no host")));
    }
    Ok(u)
}

/// Validates and normalizes an m3u config (without pasted text).
pub fn validate_m3u(cfg: M3uSourceConfig) -> CoreResult<M3uSourceConfig> {
    let headers = clean_headers(cfg.headers);
    // guide:
    let catchup = crate::catchup::m3u::validate_override(cfg.catchup)?;
    match cfg.origin {
        M3uOrigin::Url => {
            let url = trimmed(cfg.url.as_deref())
                .ok_or_else(|| CoreError::Invalid("enter the playlist URL".into()))?;
            let parsed = url::Url::parse(&url).map_err(|e| {
                CoreError::Invalid(format!(
                    "the playlist URL is not valid ({e}); include http:// or https://"
                ))
            })?;
            if !matches!(parsed.scheme(), "http" | "https" | "file") {
                return Err(CoreError::Invalid(
                    "the playlist URL must start with http://, https:// or file://".into(),
                ));
            }
            Ok(M3uSourceConfig {
                origin: M3uOrigin::Url,
                url: Some(url),
                file_path: None,
                headers,
                catchup,
            })
        }
        M3uOrigin::File => {
            let path = trimmed(cfg.file_path.as_deref())
                .ok_or_else(|| CoreError::Invalid("choose a playlist file".into()))?;
            match std::fs::metadata(&path) {
                Ok(m) if m.is_file() => {}
                Ok(_) => return Err(CoreError::Invalid(format!("{path} is not a file"))),
                Err(_) => {
                    return Err(CoreError::NotFound(format!(
                        "playlist file not found: {path}"
                    )))
                }
            }
            Ok(M3uSourceConfig {
                origin: M3uOrigin::File,
                url: None,
                file_path: Some(path),
                headers,
                catchup,
            })
        }
        M3uOrigin::Text => Ok(M3uSourceConfig {
            origin: M3uOrigin::Text,
            url: None,
            file_path: None,
            headers,
            catchup,
        }),
    }
}

/// Validates and normalizes an Xtream config (trailing `/` and a pasted
/// `/player_api.php` are removed from the server URL).
pub fn validate_xtream(cfg: XtreamSourceConfig) -> CoreResult<XtreamSourceConfig> {
    let mut server = cfg.server_url.trim().to_string();
    for suffix in ["/player_api.php", "/get.php", "/panel_api.php"] {
        if server.to_ascii_lowercase().ends_with(suffix) {
            server.truncate(server.len() - suffix.len());
        }
    }
    let server = server.trim_end_matches('/').to_string();
    check_http_url(&server, "the server URL")?;
    let username = cfg.username.trim().to_string();
    if username.is_empty() {
        return Err(CoreError::Invalid("enter the Xtream username".into()));
    }
    // The password is kept as typed: providers do issue passwords with a
    // leading or trailing space.
    if cfg.password.trim().is_empty() {
        return Err(CoreError::Invalid("enter the Xtream password".into()));
    }
    let headers = clean_headers(cfg.headers);
    check_headers(&headers)?;
    Ok(XtreamSourceConfig {
        server_url: server,
        username,
        password: cfg.password,
        headers,
    })
}

/// Normalizes a MAC address to `AA:BB:CC:DD:EE:FF`.
pub fn normalize_mac(mac: &str) -> CoreResult<String> {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let separators_ok = mac
        .chars()
        .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '-' | '.' | ' '));
    if hex.len() != 12 || !separators_ok {
        return Err(CoreError::Invalid(format!(
            "'{}' is not a MAC address; use the form 00:1A:79:XX:XX:XX",
            mac.trim()
        )));
    }
    let up = hex.to_ascii_uppercase();
    Ok((0..6)
        .map(|i| &up[i * 2..i * 2 + 2])
        .collect::<Vec<_>>()
        .join(":"))
}

/// Validates and normalizes a Stalker config.
pub fn validate_stalker(cfg: StalkerSourceConfig) -> CoreResult<StalkerSourceConfig> {
    validate_stalker_keeping(cfg, None)
}

/// [`validate_stalker`] for an edit: a MAC equal to `stored_mac` (after
/// trimming) is kept verbatim, so a grandfathered value from an old backup
/// (e.g. `MAG-0001`) survives edits of other fields. A changed MAC must be
/// a 12-hex-digit address and is normalized.
pub fn validate_stalker_keeping(
    cfg: StalkerSourceConfig,
    stored_mac: Option<&str>,
) -> CoreResult<StalkerSourceConfig> {
    let portal = cfg.portal_url.trim().to_string();
    check_http_url(&portal, "the portal URL")?;
    let mac = match stored_mac.map(str::trim) {
        Some(stored) if !stored.is_empty() && stored == cfg.mac_address.trim() => {
            stored.to_string()
        }
        _ => normalize_mac(&cfg.mac_address)?,
    };
    Ok(StalkerSourceConfig {
        portal_url: portal,
        mac_address: mac,
        is_full_portal: cfg.is_full_portal,
        username: trimmed(cfg.username.as_deref()),
        password: cfg.password.filter(|p| !p.is_empty()),
        headers: clean_headers(cfg.headers),
        serial_number: trimmed(cfg.serial_number.as_deref()),
        device_id1: trimmed(cfg.device_id1.as_deref()),
        device_id2: trimmed(cfg.device_id2.as_deref()),
        signature1: trimmed(cfg.signature1.as_deref()),
        signature2: trimmed(cfg.signature2.as_deref()),
    })
}

/// Trims, drops blanks and duplicates (first occurrence wins).
pub fn normalize_urls(urls: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(urls.len());
    for u in urls {
        let u = u.trim().to_string();
        if !u.is_empty() && !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

/// Last path parts that say nothing about the source: playlist and Xtream
/// endpoints, and the stock Stalker/Ministra portal paths. Mirrors
/// `GENERIC_STEM` in `src/features/sources/lib/validate.ts`.
const GENERIC_STEMS: &[&str] = &[
    "get",
    "playlist",
    "index",
    "player_api",
    "c",
    "stalker_portal",
    "portal",
    "server",
    "load",
    "panel",
];

/// `name` without a trailing `.m3u` / `.m3u8` / `.txt` (and `.php` for URLs).
fn strip_playlist_ext(name: &str, php: bool) -> &str {
    let lower = name.to_ascii_lowercase();
    let exts: &[&str] = if php {
        &[".m3u8", ".m3u", ".php", ".txt"]
    } else {
        &[".m3u8", ".m3u", ".txt"]
    };
    exts.iter()
        .find(|e| lower.ends_with(*e))
        .map_or(name, |e| &name[..name.len() - e.len()])
}

/// Readable name from a URL, as the UI's `suggestName` derives it: the
/// percent-decoded last path part without its playlist extension, or the host
/// (without `www.`) when that part is empty or a generic endpoint name.
fn name_from_url(u: &str) -> Option<String> {
    let parsed = url::Url::parse(u).ok()?;
    let last = parsed
        .path_segments()
        .and_then(|mut s| s.rfind(|p| !p.is_empty()))
        .unwrap_or("");
    // A broken escape (invalid UTF-8) keeps the raw text, like `safeDecode`.
    let decoded = percent_encoding::percent_decode_str(last)
        .decode_utf8()
        .map_or_else(|_| last.to_string(), |d| d.into_owned());
    let stem = strip_playlist_ext(&decoded, true).trim();
    if !stem.is_empty() && !GENERIC_STEMS.iter().any(|g| g.eq_ignore_ascii_case(stem)) {
        return Some(stem.to_string());
    }
    let host = parsed.host_str()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then(|| host.to_string())
}

fn default_name(kind: SourceKind, cfg: &SourceConfig) -> String {
    match cfg {
        SourceConfig::M3u(c) => match c.origin {
            M3uOrigin::Url => c.url.as_deref().and_then(name_from_url),
            M3uOrigin::File => c.file_path.as_deref().and_then(|p| {
                let file = std::path::Path::new(p).file_name()?.to_string_lossy();
                let stem = strip_playlist_ext(&file, false).trim();
                Some(if stem.is_empty() { file.as_ref() } else { stem }.to_string())
            }),
            M3uOrigin::Text => None,
        }
        .unwrap_or_else(|| "Pasted playlist".to_string()),
        SourceConfig::Xtream(c) => {
            name_from_url(&c.server_url).unwrap_or_else(|| kind.as_str().to_string())
        }
        SourceConfig::Stalker(c) => {
            name_from_url(&c.portal_url).unwrap_or_else(|| kind.as_str().to_string())
        }
    }
}

/// Plain message of an error, without the internal category prefix.
pub fn error_text(err: &CoreError) -> String {
    match err {
        CoreError::NotFound(m)
        | CoreError::Invalid(m)
        | CoreError::Network(m)
        | CoreError::Auth(m)
        | CoreError::Timeout(m)
        | CoreError::Server(m)
        | CoreError::EngineMissing(m)
        | CoreError::Conflict(m)
        | CoreError::Unsupported(m) => m.clone(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

fn lock_for(state: &AppState, id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = state.ext_or_insert_with::<LockMap>(LOCKS_KEY, || Arc::new(DashMap::new()));
    let lock = locks
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));
    Arc::clone(lock.value())
}

fn cancels(state: &AppState) -> Arc<CancelMap> {
    state.ext_or_insert_with::<CancelMap>(CANCELS_KEY, || Arc::new(DashMap::new()))
}

/// Cancels the import of `id` that is running (and every one queued behind
/// the import lock when `removing`), without waiting for the lock. Imports
/// that start later get a fresh token unless `removing`.
fn cancel_imports(state: &AppState, id: &str, removing: bool) {
    let next = tokio_util::sync::CancellationToken::new();
    if removing {
        next.cancel();
    }
    if let Some(old) = cancels(state).insert(id.to_string(), next) {
        old.cancel();
    }
}

/// Cancel token of the import running in the current task (set by
/// [`run_import`] and [`run_import_with`]); importers and the HTTP helpers
/// stop their network reads when it fires.
pub fn import_cancel() -> Option<tokio_util::sync::CancellationToken> {
    IMPORT_CANCEL.try_with(Clone::clone).ok()
}

/// True when the import running in the current task was cancelled.
pub fn is_import_cancelled() -> bool {
    IMPORT_CANCEL
        .try_with(tokio_util::sync::CancellationToken::is_cancelled)
        .unwrap_or(false)
}

const REMOVED_OR_CHANGED_MESSAGE: &str = "the import stopped because the source was removed or its settings changed. Refresh the source to import it again.";
const USER_CANCELLED_MESSAGE: &str =
    "import stopped: cancelled by user. Nothing from this run was saved; refresh the source to import it again.";

/// The error a cancelled import ends with. Inside a run stopped by
/// `sources.cancelImport` this is [`user_cancelled_error`], so code that
/// only sees the token (HTTP helpers, importers) reports the real cause.
pub fn import_cancelled_error() -> CoreError {
    let by_user = IMPORT_RUN
        .try_with(|r| r.user_cancelled.load(Ordering::SeqCst))
        .unwrap_or(false);
    if by_user {
        user_cancelled_error()
    } else {
        CoreError::Conflict(REMOVED_OR_CHANGED_MESSAGE.into())
    }
}

/// The error an import stopped by `sources.cancelImport` ends with (C8).
pub fn user_cancelled_error() -> CoreError {
    CoreError::Conflict(USER_CANCELLED_MESSAGE.into())
}

/// True for the errors of a cancelled import ([`import_cancelled_error`],
/// [`user_cancelled_error`]); they are not import failures.
pub fn is_cancelled_error(err: &CoreError) -> bool {
    matches!(err, CoreError::Conflict(m) if m == REMOVED_OR_CHANGED_MESSAGE || m == USER_CANCELLED_MESSAGE)
}

/// True for [`user_cancelled_error`] only.
fn is_user_cancel(err: &CoreError) -> bool {
    matches!(err, CoreError::Conflict(m) if m == USER_CANCELLED_MESSAGE)
}

/// How long a cancelled import may take to stop on its own (cooperative
/// checks between fetch, parse and save) before [`run_import`] drops it.
/// A catalog writer still running on the blocking pool then rolls back at
/// its next check (see [`writer_cancel_token`]).
pub const CANCEL_GRACE: Duration = Duration::from_secs(2);

/// `AppState.extensions` key of the runs in progress (C8).
pub const ACTIVE_KEY: &str = "sources.active";

/// One import or refresh in progress for a source.
#[derive(Debug)]
pub struct ActiveRun {
    pub token: tokio_util::sync::CancellationToken,
    /// Set by `sources.cancelImport` (versus a remove or settings change).
    pub user_cancelled: AtomicBool,
    /// First partial failure of the run ([`note_import_warning`]).
    pub warning: parking_lot::Mutex<Option<(String, RpcErrorCode)>>,
}

/// Notes a partial failure of the import running in this task: a content
/// type that could not be loaded kept its previous rows (or its
/// categories). The run still succeeds; [`run_import`] records the first
/// warning as the source's `lastError`, so the source says what is missing
/// instead of looking fully refreshed. No-op outside a run.
pub fn note_import_warning(message: &str, code: RpcErrorCode) {
    let _ = IMPORT_RUN.try_with(|r| {
        let mut w = r.warning.lock();
        if w.is_none() {
            *w = Some((message.to_string(), code));
        }
    });
}

type ActiveMap = DashMap<String, Arc<ActiveRun>>;

fn active(state: &AppState) -> Arc<ActiveMap> {
    state.ext_or_insert_with::<ActiveMap>(ACTIVE_KEY, || Arc::new(DashMap::new()))
}

type WriterTokens = DashMap<String, Vec<Arc<tokio_util::sync::CancellationToken>>>;

/// Cancel tokens of the runs in progress, for catalog writers on the
/// blocking pool (no task-local there). Process-wide because a writer only
/// has its connection and source id, so the key is the database file plus
/// the source id ([`writer_key`]): two app states (tests, server plus
/// desktop) with the same source id never see each other's cancel. A writer
/// snapshots the newest token when it begins, so a newer run never sees an
/// older run's cancel.
static WRITER_TOKENS: std::sync::LazyLock<WriterTokens> = std::sync::LazyLock::new(DashMap::new);

/// `WRITER_TOKENS` key: the canonical database path and the source id.
fn writer_key(db_path: &std::path::Path, source_id: &str) -> String {
    let db = std::fs::canonicalize(db_path).unwrap_or_else(|_| db_path.to_path_buf());
    format!("{}\u{0}{source_id}", db.to_string_lossy())
}

/// Cancel token of the newest run in progress for `source_id` in the
/// database `conn` is open on. Catalog writers take it when they begin and
/// check it while inserting and before committing, so a cancelled run never
/// commits a catalog.
pub fn writer_cancel_token(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> Option<tokio_util::sync::CancellationToken> {
    let db = conn.path().unwrap_or_default();
    WRITER_TOKENS
        .get(&writer_key(std::path::Path::new(db), source_id))
        .and_then(|v| v.last().map(|t| (**t).clone()))
}

/// Registers a run for [`cancel_import`] and the catalog writers; dropping it
/// unregisters.
struct RunGuard {
    active: Arc<ActiveMap>,
    id: String,
    run: Arc<ActiveRun>,
    writer_key: String,
    writer_token: Arc<tokio_util::sync::CancellationToken>,
    /// While the run lasts, user writes wait for its write transaction
    /// instead of failing after the normal busy timeout (review round 3).
    _long: crate::db::LongWrite,
}

impl RunGuard {
    fn new(state: &AppState, id: &str, token: tokio_util::sync::CancellationToken) -> Self {
        let run = Arc::new(ActiveRun {
            token: token.clone(),
            user_cancelled: AtomicBool::new(false),
            warning: parking_lot::Mutex::new(None),
        });
        let active = active(state);
        active.insert(id.to_string(), run.clone());
        let writer_token = Arc::new(token);
        let writer_key = writer_key(&state.db_path(), id);
        WRITER_TOKENS
            .entry(writer_key.clone())
            .or_default()
            .push(writer_token.clone());
        Self {
            active,
            writer_key,
            id: id.to_string(),
            run,
            writer_token,
            _long: crate::db::long_write(),
        }
    }

    fn user_cancelled(&self) -> bool {
        self.run.user_cancelled.load(Ordering::SeqCst)
    }

    /// Message of the cancel that stopped this run.
    fn cancel_message(&self) -> &'static str {
        if self.user_cancelled() {
            USER_CANCELLED_MESSAGE
        } else {
            REMOVED_OR_CHANGED_MESSAGE
        }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.active
            .remove_if(&self.id, |_, r| Arc::ptr_eq(r, &self.run));
        if let dashmap::mapref::entry::Entry::Occupied(mut e) =
            WRITER_TOKENS.entry(self.writer_key.clone())
        {
            e.get_mut().retain(|t| !Arc::ptr_eq(t, &self.writer_token));
            if e.get().is_empty() {
                e.remove();
            }
        }
    }
}

/// True while an import or refresh of `id` is running (holding the
/// per-source lock).
pub fn is_import_running(state: &AppState, id: &str) -> bool {
    active(state).contains_key(id)
}

/// `sources.cancelImport` (C8): cancels the import or refresh of `id` that is
/// running. Returns true when one was running and is now cancelling (it ends
/// with `import.progress` `phase: "cancelled"` and keeps the previous
/// catalog), false when nothing was running. Runs queued behind it start
/// normally.
pub fn cancel_import(state: &AppState, id: &str) -> bool {
    let Some(run) = active(state).get(id).map(|r| Arc::clone(r.value())) else {
        return false;
    };
    let map = cancels(state);
    // A remove in progress leaves a cancelled token for queued runs; keep it.
    let removing = map.get(id).is_some_and(|t| t.is_cancelled());
    run.user_cancelled.store(true, Ordering::SeqCst);
    run.token.cancel();
    if !removing {
        map.insert(id.to_string(), tokio_util::sync::CancellationToken::new());
    }
    tracing::info!(source_id = id, "import cancel requested");
    true
}

/// Cancels every import, refresh and partial sync running now, for app exit
/// (HO-4): each stops at its next check and keeps its previous catalog, and
/// a catalog writer rolls back before it commits, which releases the write
/// lock. Returns how many were running.
pub fn cancel_all_imports(state: &AppState) -> usize {
    let runs: Vec<Arc<ActiveRun>> = active(state)
        .iter()
        .map(|r| Arc::clone(r.value()))
        .collect();
    for run in &runs {
        run.token.cancel();
    }
    runs.len()
}

/// Runs `fut` while holding the per-source import lock that [`run_import`]
/// and [`remove`] take, so a partial sync (e.g. `xtream.sync` with a
/// `contentTypes` subset) never interleaves with a full refresh of the same
/// source. `fut` must not call `run_import` / `remove` for that source itself
/// (the lock is not reentrant).
///
/// The run is cancellable like [`run_import`] (`sources.cancelImport`, a
/// remove, a settings change): `fut` sees the token through
/// [`import_cancel`], and the HTTP helpers and catalog writers honour it.
/// `fut` reports its own outcome; when the run was cancelled this also emits
/// `import.progress` `phase: "cancelled"`. A cancelled `fut` that does not
/// stop within [`CANCEL_GRACE`] is dropped, as in [`run_import`], and the
/// result is [`CancelOutcome::cancelled`].
pub async fn run_import_with<T: CancelOutcome>(
    state: &AppState,
    id: &str,
    fut: impl std::future::Future<Output = T>,
) -> T {
    let lock = lock_for(state, id);
    let _guard = lock.lock().await;
    let token = current_token(state, id);
    if token.is_cancelled() {
        // Queued behind a run that `remove` cancelled: the source is going.
        return T::cancelled(import_cancelled_error());
    }
    let run = RunGuard::new(state, id, token.clone());
    progress_connecting(state, id);
    let fut = IMPORT_RUN.scope(run.run.clone(), IMPORT_CANCEL.scope(token.clone(), fut));
    tokio::pin!(fut);
    let out = tokio::select! {
        out = &mut fut => out,
        () = token.cancelled() => match tokio::time::timeout(CANCEL_GRACE, &mut fut).await {
            Ok(out) => out,
            Err(_) => {
                tracing::warn!(source_id = id, "sync did not stop in time after cancel; dropped");
                T::cancelled(if run.user_cancelled() {
                    user_cancelled_error()
                } else {
                    import_cancelled_error()
                })
            }
        },
    };
    if token.is_cancelled() {
        progress_cancelled(state, id, run.cancel_message());
    }
    out
}

/// Result of a [`run_import_with`] run that was dropped after a cancel.
pub trait CancelOutcome {
    fn cancelled(err: CoreError) -> Self;
}

impl CancelOutcome for () {
    fn cancelled(_: CoreError) -> Self {}
}

impl<T> CancelOutcome for Option<T> {
    fn cancelled(_: CoreError) -> Self {
        None
    }
}

impl<T> CancelOutcome for CoreResult<T> {
    fn cancelled(err: CoreError) -> Self {
        Err(err)
    }
}

impl<T> CancelOutcome for Result<T, String> {
    fn cancelled(err: CoreError) -> Self {
        Err(error_text(&err))
    }
}

/// `AppState.extensions` key of the full imports in progress, which a
/// [`refresh`] of the same source joins instead of importing again (ST-2).
const INFLIGHT_KEY: &str = "sources.inflight";

/// The result of a full import, once it has ended.
type Joined = Option<Arc<CoreResult<(Source, ImportSummary)>>>;

/// One full import in progress ([`run_import`], not a partial sync).
struct Running {
    token: tokio_util::sync::CancellationToken,
    result: tokio::sync::watch::Receiver<Joined>,
}

type InflightMap = DashMap<String, Arc<Running>>;

/// Registers a full import for [`join_running_import`]; [`Self::finish`]
/// hands its result to the refreshes that joined it, and dropping it
/// unregisters the run.
struct Inflight {
    map: Arc<InflightMap>,
    id: String,
    running: Arc<Running>,
    tx: tokio::sync::watch::Sender<Joined>,
}

impl Inflight {
    fn new(state: &AppState, id: &str, token: tokio_util::sync::CancellationToken) -> Self {
        let (tx, result) = tokio::sync::watch::channel(None);
        let running = Arc::new(Running { token, result });
        let map =
            state.ext_or_insert_with::<InflightMap>(INFLIGHT_KEY, || Arc::new(DashMap::new()));
        map.insert(id.to_string(), running.clone());
        Self {
            map,
            id: id.to_string(),
            running,
            tx,
        }
    }

    fn finish(&self, result: &CoreResult<(Source, ImportSummary)>) {
        let copy = match result {
            Ok(done) => Ok(done.clone()),
            Err(err) => Err(crate::tmdb::cache::clone_error(err)),
        };
        self.tx.send_modify(|joined| *joined = Some(Arc::new(copy)));
    }
}

impl Drop for Inflight {
    fn drop(&mut self) {
        self.map
            .remove_if(&self.id, |_, r| Arc::ptr_eq(r, &self.running));
    }
}

/// Waits for the full import of `id` that is running and returns a copy of
/// its result. `None` when there is none to join: nothing runs, a partial
/// sync holds the lock, the run was already cancelled, or it ended without
/// a result (dropped).
async fn join_running_import(
    state: &AppState,
    id: &str,
) -> Option<CoreResult<(Source, ImportSummary)>> {
    let running = state
        .ext::<InflightMap>(INFLIGHT_KEY)?
        .get(id)
        .map(|r| Arc::clone(r.value()))?;
    if running.token.is_cancelled() {
        return None;
    }
    let mut rx = running.result.clone();
    drop(running);
    let done = rx.wait_for(Option::is_some).await.ok()?;
    let joined: Joined = (*done).clone();
    drop(done);
    let shared = joined?;
    Some(match &*shared {
        Ok(v) => Ok(v.clone()),
        Err(err) => Err(crate::tmdb::cache::clone_error(err)),
    })
}

/// `AppState.extensions` key of the import save slot ([`save_slot`]).
const SAVE_SLOT_KEY: &str = "sources.saveSlot";

/// Waits for the app's one import decode-and-save slot (ST-2). Imports of
/// several sources may download at the same time, but only one decodes its
/// answers and writes its catalog, so two large syncs never hold their rows
/// in memory together. The slot is held until the permit drops. Inside a
/// run, a cancel ends the wait.
pub async fn save_slot(state: &AppState) -> CoreResult<tokio::sync::OwnedSemaphorePermit> {
    let slot = state.ext_or_insert_with::<tokio::sync::Semaphore>(SAVE_SLOT_KEY, || {
        Arc::new(tokio::sync::Semaphore::new(1))
    });
    let closed = || CoreError::Other(anyhow::anyhow!("the import queue is closed"));
    match import_cancel() {
        Some(token) => tokio::select! {
            permit = slot.acquire_owned() => permit.map_err(|_| closed()),
            () = token.cancelled() => Err(import_cancelled_error()),
        },
        None => slot.acquire_owned().await.map_err(|_| closed()),
    }
}

fn current_token(state: &AppState, id: &str) -> tokio_util::sync::CancellationToken {
    cancels(state)
        .entry(id.to_string())
        .or_default()
        .value()
        .clone()
}

// Every source ordered by position, with cached counts.
pub async fn list(state: &AppState) -> CoreResult<Vec<Source>> {
    state.db_call(|c| store::list(c)).await
}

/// One source.
pub async fn get(state: &AppState, id: &str) -> CoreResult<Source> {
    let id = id.to_string();
    state.db_call(move |c| store::get(c, &id)).await
}

/// Error of [`add`]: the id of the created source (when the failure happened
/// during the import), the id of the source that already uses the address
/// (a refused duplicate), and the cause.
#[derive(Debug)]
pub struct AddError {
    pub source_id: Option<String>,
    pub existing_source_id: Option<String>,
    pub error: CoreError,
}

impl From<CoreError> for AddError {
    fn from(error: CoreError) -> Self {
        Self {
            source_id: None,
            existing_source_id: None,
            error,
        }
    }
}

impl From<AddError> for RpcError {
    fn from(e: AddError) -> Self {
        let cancelled = is_cancelled_error(&e.error);
        let mut err = RpcError::from(e.error);
        // A refused duplicate: `details.existingSourceId`, never `sourceId`,
        // which names a source this add created (the UI discards that one).
        if let Some(id) = e.existing_source_id {
            return err.with_details(serde_json::json!({ "existingSourceId": id }));
        }
        match (e.source_id, cancelled) {
            (Some(id), true) => {
                err = err.with_details(serde_json::json!({ "sourceId": id, "cancelled": true }))
            }
            (Some(id), false) => err = err.with_details(serde_json::json!({ "sourceId": id })),
            (None, true) => err = err.with_details(serde_json::json!({ "cancelled": true })),
            (None, false) => {}
        }
        err
    }
}

/// RPC error of a run that may have been cancelled: a cancelled run carries
/// `details.cancelled = true` (C8) so callers can tell it from a failure.
pub fn cancel_aware_rpc_error(err: CoreError) -> RpcError {
    let cancelled = is_cancelled_error(&err);
    let rpc = RpcError::from(err);
    if cancelled {
        rpc.with_details(serde_json::json!({ "cancelled": true }))
    } else {
        rpc
    }
}

/// Held across the duplicate check and the write in [`add`] and [`update`],
/// so two concurrent calls cannot both claim one address.
fn identity_lock(state: &AppState) -> Arc<tokio::sync::Mutex<()>> {
    state.ext_or_insert_with("sources_identity_lock", || {
        Arc::new(tokio::sync::Mutex::new(()))
    })
}

/// `Conflict` for a config whose address `existing` (a source name) already
/// uses. The wording avoids "cancelled" / "import stopped", which mark a
/// cancelled run's conflict.
fn duplicate_error(config: &SourceConfig, existing: &str) -> CoreError {
    let what = match config {
        SourceConfig::M3u(c) if c.origin == M3uOrigin::File => "playlist file",
        SourceConfig::M3u(_) => "playlist URL",
        SourceConfig::Xtream(_) => "server and username",
        SourceConfig::Stalker(_) => "portal and MAC address",
    };
    CoreError::Conflict(format!(
        "this source already exists: \"{existing}\" uses the same {what}"
    ))
}

/// The stored config of `s` (`None` when it could not be read).
fn config_of(s: &Source) -> Option<SourceConfig> {
    match s.kind {
        SourceKind::M3u => s.m3u.clone().map(SourceConfig::M3u),
        SourceKind::Xtream => s.xtream.clone().map(SourceConfig::Xtream),
        SourceKind::Stalker => s.stalker.clone().map(SourceConfig::Stalker),
    }
}

/// `sources.add`: validates, inserts, runs the importer. On importer failure
/// the source stays (with `lastError`) and the error carries its id.
///
/// An address another source already uses (see [`store::identity`]; pasted
/// text is never a duplicate) is refused with `Conflict` before anything is
/// created; that error's `existing_source_id` (`details.existingSourceId` in
/// the RPC error) is the existing source's id, and its `source_id` is `None`.
pub async fn add(state: Arc<AppState>, args: AddSourceArgs) -> Result<Source, AddError> {
    let (config, raw_text) = match args.kind {
        SourceKind::M3u => {
            let input = args
                .m3u
                .ok_or_else(|| CoreError::Invalid("m3u settings are missing".into()))?;
            let origin = input.origin.unwrap_or(if input.text.is_some() {
                M3uOrigin::Text
            } else if input.file_path.is_some() {
                M3uOrigin::File
            } else {
                M3uOrigin::Url
            });
            let text = match origin {
                M3uOrigin::Text => {
                    let t = input.text.unwrap_or_default();
                    if t.trim().is_empty() {
                        return Err(CoreError::Invalid("paste the playlist text".into()).into());
                    }
                    Some(t)
                }
                _ => None,
            };
            let cfg = validate_m3u(M3uSourceConfig {
                origin,
                url: input.url,
                file_path: input.file_path,
                headers: input.headers.unwrap_or_default(),
                catchup: None,
            })?;
            (SourceConfig::M3u(cfg), text)
        }
        SourceKind::Xtream => {
            let cfg = args
                .xtream
                .ok_or_else(|| CoreError::Invalid("Xtream settings are missing".into()))?;
            (SourceConfig::Xtream(validate_xtream(cfg)?), None)
        }
        SourceKind::Stalker => {
            let cfg = args
                .stalker
                .ok_or_else(|| CoreError::Invalid("Stalker portal settings are missing".into()))?;
            (SourceConfig::Stalker(validate_stalker(cfg)?), None)
        }
    };
    if importer(&state, args.kind).is_none() {
        return Err(CoreError::Unsupported(format!(
            "{} sources are not available in this build",
            args.kind.as_str()
        ))
        .into());
    }
    let name = match args.name.trim() {
        "" => default_name(args.kind, &config),
        n => n.to_string(),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let auto_refresh = args.auto_refresh.unwrap_or(false);
    {
        let _same = identity_lock(&state).lock_owned().await;
        let id = id.clone();
        let data_dir = state.data_dir.clone();
        let duplicate = state
            .db_call(move |c| {
                if let Some((other_id, other_name)) = store::find_same(c, &config, None)? {
                    return Ok(Some((other_id, duplicate_error(&config, &other_name))));
                }
                let raw = raw_text.as_deref().map(|t| (data_dir.as_path(), t));
                store::insert(c, &id, &name, auto_refresh, &config, raw)?;
                Ok(None)
            })
            .await?;
        // Nothing was created: the error names the source that already exists.
        if let Some((other_id, error)) = duplicate {
            return Err(AddError {
                source_id: None,
                existing_source_id: Some(other_id),
                error,
            });
        }
    }
    tracing::info!(source_id = %id, kind = args.kind.as_str(), "source added");
    emit_changed(&state, Some(&id), ChangeReason::Added);
    // User-initiated: an unreachable host fails after the short connect
    // timeout instead of the background 10 s.
    match crate::http::interactive(run_import(state.clone(), &id)).await {
        Ok((source, _)) => Ok(source),
        Err(error) => Err(AddError {
            source_id: Some(id),
            existing_source_id: None,
            error,
        }),
    }
}

/// Runs the importer for one source (serialized per source), then records the
/// outcome. A failed import leaves the previous catalog in place and records
/// `lastError` with its code (C10).
///
/// Cancellation (C8): `sources.cancelImport`, [`remove`] and a settings change
/// in [`update`] cancel the run's token. The importer stops at its next
/// cooperative check (HTTP sends and body reads, stage boundaries, catalog
/// writer batches); one that does not stop within [`CANCEL_GRACE`] is
/// dropped. Catalog writers check the token before committing, so a
/// cancelled run leaves the previous catalog intact. It emits
/// `import.progress` `phase: "cancelled"` and records no `lastError`.
pub async fn run_import(state: Arc<AppState>, id: &str) -> CoreResult<(Source, ImportSummary)> {
    let guard = lock_for(&state, id).lock_owned().await;
    run_import_locked(state, id, guard).await
}

/// [`run_import`] unless an import, refresh, partial sync or remove of `id`
/// holds its lock right now; then `None` and nothing runs. The scheduled
/// refresh uses it so it never queues behind (and then repeats) a manual
/// refresh.
pub async fn try_run_import(
    state: Arc<AppState>,
    id: &str,
) -> Option<CoreResult<(Source, ImportSummary)>> {
    let guard = lock_for(&state, id).try_lock_owned().ok()?;
    Some(run_import_locked(state, id, guard).await)
}

async fn run_import_locked(
    state: Arc<AppState>,
    id: &str,
    guard: tokio::sync::OwnedMutexGuard<()>,
) -> CoreResult<(Source, ImportSummary)> {
    let token = current_token(&state, id);
    // A refresh of this source while it runs joins it (ST-2).
    let inflight = Inflight::new(&state, id, token.clone());
    let result = run_import_inner(state, id, guard, token).await;
    inflight.finish(&result);
    result
}

async fn run_import_inner(
    state: Arc<AppState>,
    id: &str,
    guard: tokio::sync::OwnedMutexGuard<()>,
    token: tokio_util::sync::CancellationToken,
) -> CoreResult<(Source, ImportSummary)> {
    if token.is_cancelled() {
        // Queued behind an import that `remove` cancelled.
        return Err(import_cancelled_error());
    }
    let run = RunGuard::new(&state, id, token.clone());
    let source = get(&state, id).await?;
    let Some(imp) = importer(&state, source.kind) else {
        let err = CoreError::Unsupported(format!(
            "{} sources are not available in this build",
            source.kind.as_str()
        ));
        record(&state, id, Some((&error_text(&err), err.code()))).await;
        progress_error(&state, id, &error_text(&err), err.code());
        return Err(err);
    };
    let started = std::time::Instant::now();
    progress_connecting(&state, id);
    let fut = IMPORT_RUN.scope(
        run.run.clone(),
        IMPORT_CANCEL.scope(token.clone(), imp.import(state.clone(), &source)),
    );
    tokio::pin!(fut);
    let outcome = tokio::select! {
        r = &mut fut => r,
        () = token.cancelled() => {
            // Give the importer a moment to stop cleanly (temp files, logs).
            match tokio::time::timeout(CANCEL_GRACE, &mut fut).await {
                Ok(r) => r,
                Err(_) => {
                    tracing::warn!(source_id = id, "import did not stop in time after cancel; dropped");
                    Err(import_cancelled_error())
                }
            }
        }
    };
    match outcome {
        Ok(summary) => {
            // A cancel that arrived after the catalog was committed is too
            // late to undo; the run is reported as done.
            let sid = id.to_string();
            let kind = source.kind;
            let (movies, series) = (summary.movies, summary.series);
            let warning = run.run.warning.lock().take();
            state
                .db_call(move |c| {
                    store::record_import(c, &sid, None)?;
                    if let Some((msg, code)) = &warning {
                        // A content type kept its previous rows: say so.
                        store::record_import_error(c, &sid, msg, *code)?;
                    }
                    if kind == SourceKind::Stalker {
                        // Portal VOD is not stored locally; keep its totals.
                        crate::catalog::set_remote_counts(c, &sid, movies, series)?;
                    }
                    Ok(())
                })
                .await?;
            drop(run);
            // The backup import lock is never taken while this source's
            // import lock is held (lock order: backup, then source).
            drop(guard);
            let restored = apply_parked_backup(&state, id).await;
            let total = (summary.channels + summary.movies + summary.series).max(0) as u64;
            // Unchanged: only the source's import time moved, so clients
            // refetch `sources.*` (on this message) and keep their catalog,
            // list and guide queries; no `sources.changed`.
            let message = summary.unchanged.then_some(UNCHANGED_MESSAGE);
            progress(&state, id, "done", total, Some(total), message);
            tracing::info!(
                source_id = id,
                channels = summary.channels,
                movies = summary.movies,
                series = summary.series,
                unchanged = summary.unchanged,
                ms = started.elapsed().as_millis() as u64,
                "source imported"
            );
            if !summary.unchanged || restored {
                emit_changed(&state, Some(id), ChangeReason::Catalog);
            }
            let source = get(&state, id).await?;
            spawn_guide_refresh(&state, &source);
            // account:
            crate::account::after_import(&state, &source);
            Ok((source, summary))
        }
        Err(err) if token.is_cancelled() => {
            let msg = run.cancel_message();
            tracing::info!(
                source_id = id,
                by_user = run.user_cancelled(),
                ms = started.elapsed().as_millis() as u64,
                "source import cancelled; previous catalog kept"
            );
            if !is_cancelled_error(&err) {
                tracing::debug!(source_id = id, error = %error_text(&err), "error after cancel");
            }
            progress_cancelled(&state, id, msg);
            emit_changed(&state, Some(id), ChangeReason::Status);
            Err(if run.user_cancelled() {
                user_cancelled_error()
            } else {
                import_cancelled_error()
            })
        }
        Err(err) => {
            let msg = error_text(&err);
            let code = err.code();
            tracing::warn!(source_id = id, error = %msg, code = code.as_str(), "source import failed; previous catalog kept");
            record(&state, id, Some((&msg, code))).await;
            progress_error(&state, id, &msg, code);
            emit_changed(&state, Some(id), ChangeReason::Status);
            Err(err)
        }
    }
}

// Guide URLs of a source that a refresh should cover: detected and manual
/// URLs minus the disabled ones, trimmed, blanks dropped, first occurrence kept.
pub fn guide_urls(links: &EpgLinks) -> Vec<String> {
    let disabled: std::collections::HashSet<&str> =
        links.disabled_urls.iter().map(|u| u.trim()).collect();
    let mut seen = std::collections::HashSet::new();
    links
        .detected_urls
        .iter()
        .chain(links.manual_urls.iter())
        .map(|u| u.trim())
        .filter(|u| !u.is_empty() && !disabled.contains(u) && seen.insert(*u))
        .map(str::to_owned)
        .collect()
}

/// True when a stored guide row needs no refresh: switched off globally, or
/// fetched successfully within the EPG scheduler's staleness window.
fn guide_is_current(
    row: &crate::epg::store::SourceRow,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    if !row.enabled {
        return true;
    }
    if row.status != "ok" {
        return false;
    }
    row.last_fetch_at
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .and_then(|at| now.signed_duration_since(at).to_std().ok())
        .is_some_and(|age| age < crate::epg::ingest::STALE_AFTER)
}

/// After a successful import, starts background refreshes of the source's
/// enabled guide URLs that have no fresh data yet, so a source added from any
/// path (`sources.add`, `backup.import`, deep links, `refreshAll`) gets its
/// guide without waiting for the EPG scheduler. Never blocks or fails the
/// import: errors are logged with redacted URLs. A URL already refreshing is
/// coalesced by the EPG runtime (`epg::spawn_refresh` returns false).
fn spawn_guide_refresh(state: &Arc<AppState>, source: &Source) {
    let urls = guide_urls(&source.epg);
    if urls.is_empty() {
        return;
    }
    let state = state.clone();
    let source_id = source.id.clone();
    tokio::spawn(async move {
        let due = state
            .db_call(move |c| {
                let now = chrono::Utc::now();
                let mut due = Vec::with_capacity(urls.len());
                for u in urls {
                    match crate::epg::store::source_row(c, &u)? {
                        Some(row) if guide_is_current(&row, now) => {}
                        _ => due.push(u),
                    }
                }
                Ok(due)
            })
            .await;
        match due {
            Ok(due) => {
                for url in due {
                    let shown = crate::epg::fetch::log_url(&url);
                    if crate::epg::spawn_refresh(state.clone(), &url) {
                        tracing::info!(source_id = %source_id, url = %shown, "guide refresh queued after import");
                    } else {
                        tracing::debug!(source_id = %source_id, url = %shown, "guide already refreshing");
                    }
                }
            }
            Err(err) => {
                tracing::warn!(source_id = %source_id, %err, "could not check guide freshness after import")
            }
        }
    });
}

/// Applies user state a backup import parked for this source because its
/// catalog could not be loaded then (favorites, positions, hidden groups).
/// A failure is logged and left parked; it never fails the refresh.
///
/// Only a source with a parked row (`backup_pending:<id>`) waits for the
/// global backup import lock, so adding or refreshing an unrelated source never
/// blocks behind a running `backup.import`.
async fn apply_parked_backup(state: &Arc<AppState>, id: &str) -> bool {
    let key = format!("{}{id}", crate::backup::PENDING_PREFIX);
    let parked = state
        .db_call(move |c| {
            Ok(c.prepare_cached("SELECT 1 FROM app_state WHERE key = ?1")?
                .exists([&key])?)
        })
        .await;
    match parked {
        Ok(true) => {}
        Ok(false) => return false,
        Err(err) => {
            tracing::warn!(source_id = id, %err, "could not check for parked backup state");
            return false;
        }
    }
    match crate::backup::apply_pending_restore(state, id).await {
        Ok(w) => {
            if !w.is_empty() {
                tracing::info!(
                    source_id = id,
                    warnings = w.len(),
                    "applied parked backup state"
                );
            }
            true
        }
        Err(err) => {
            tracing::warn!(source_id = id, %err, "parked backup state could not be applied");
            false
        }
    }
}

/// Records a failed import (message and code, C10), or a success when `error`
/// is `None`. The message is redacted: it is shown on screen and exported.
async fn record(state: &AppState, id: &str, error: Option<(&str, RpcErrorCode)>) {
    let sid = id.to_string();
    let error = error.map(|(m, c)| (crate::logging::redact_text(m).into_owned(), c));
    if let Err(err) = state
        .db_call(move |c| match &error {
            Some((msg, code)) => store::record_import_error(c, &sid, msg, *code),
            None => store::record_import(c, &sid, None),
        })
        .await
    {
        tracing::warn!(source_id = id, %err, "could not record import outcome");
    }
}

/// `sources.update`. Moving a source to an address another source already
/// uses is refused with `Conflict`; nothing is changed then.
pub async fn update(state: &AppState, id: &str, patch: SourcePatch) -> CoreResult<Source> {
    let current = get(state, id).await?;
    let mut config: Option<SourceConfig> = None;
    if let Some(m) = patch.m3u {
        if current.kind != SourceKind::M3u {
            return Err(CoreError::Invalid(
                "m3u settings given for a non-m3u source".into(),
            ));
        }
        config = Some(SourceConfig::M3u(validate_m3u(m)?));
    }
    if let Some(x) = patch.xtream {
        if current.kind != SourceKind::Xtream {
            return Err(CoreError::Invalid(
                "Xtream settings given for a non-Xtream source".into(),
            ));
        }
        config = Some(SourceConfig::Xtream(validate_xtream(x)?));
    }
    if let Some(s) = patch.stalker {
        if current.kind != SourceKind::Stalker {
            return Err(CoreError::Invalid(
                "Stalker settings given for a non-Stalker source".into(),
            ));
        }
        let stored_mac = current.stalker.as_ref().map(|c| c.mac_address.as_str());
        config = Some(SourceConfig::Stalker(validate_stalker_keeping(
            s, stored_mac,
        )?));
    }
    // New text for a pasted or uploaded playlist: stored here, imported by
    // the next refresh.
    let text = match patch.text {
        Some(t) => {
            let origin = match &config {
                Some(SourceConfig::M3u(c)) => Some(c.origin),
                _ => current.m3u.as_ref().map(|c| c.origin),
            };
            if origin != Some(M3uOrigin::Text) {
                return Err(CoreError::Invalid(
                    "only a pasted or uploaded playlist takes new playlist text".into(),
                ));
            }
            if t.trim().is_empty() {
                return Err(CoreError::Invalid("paste the playlist text".into()));
            }
            Some(t)
        }
        None => None,
    };
    // Only the M3U catch-up override changed: it applies when channels are
    // read, so a running import of the same playlist carries on.
    let catchup_only = match (&current.m3u, &config) {
        (Some(old), Some(SourceConfig::M3u(new))) => {
            let strip = |c: &M3uSourceConfig| M3uSourceConfig {
                catchup: None,
                ..c.clone()
            };
            strip(old) == strip(new)
        }
        _ => false,
    };
    // Another portal (URL or MAC): rows listed by the old one must go.
    let portal_changed = match (&current.stalker, &config) {
        (Some(old), Some(SourceConfig::Stalker(new))) => {
            old.portal_url.trim() != new.portal_url.trim()
                || old.mac_address.trim() != new.mac_address.trim()
        }
        _ => false,
    };
    // A new address (not the one this source already has) must not be
    // another source's; checked under the lock, inside the write.
    let claim = config.clone().filter(|cfg| {
        let new = store::identity(cfg);
        new.is_some() && new != config_of(&current).as_ref().and_then(store::identity)
    });
    let name = match patch.name.as_deref().map(str::trim) {
        Some("") => return Err(CoreError::Invalid("the name cannot be empty".into())),
        Some(n) => Some(n.to_string()),
        None => None,
    };
    if let Some(p) = &patch.epg {
        // Server mode refuses new local EPG paths up front (no file access).
        let known = |u: &String| {
            current.epg.detected_urls.contains(u) || current.epg.manual_urls.contains(u)
        };
        for u in p.manual_urls.iter().chain(&p.detected_urls).flatten() {
            if !known(u) {
                crate::epg::fetch::check_server_url(state, u)?;
            }
        }
        if let Some(m) = p.shift_minutes {
            crate::epg::query::check_shift_minutes(m)?;
        }
    }
    let epg = patch.epg.map(|p| {
        let mut e: EpgLinks = current.epg.clone();
        if let Some(v) = p.detected_urls {
            e.detected_urls = normalize_urls(v);
        }
        if let Some(v) = p.manual_urls {
            e.manual_urls = normalize_urls(v);
        }
        if let Some(v) = p.disabled_urls {
            e.disabled_urls = normalize_urls(v);
        }
        if let Some(m) = p.shift_minutes {
            e.shift_minutes = (m != 0).then_some(m);
        }
        e
    });
    // A new source shift moves every guide time of the source.
    let shift_changed = epg
        .as_ref()
        .is_some_and(|e| e.shift_minutes != current.epg.shift_minutes);
    let sid = id.to_string();
    let auto_refresh = patch.auto_refresh;
    let position = patch.position;
    // Only the auto-refresh flag changed: no catalog, list or guide reader
    // cares, so clients refetch `sources.*` only (ST-5).
    let reason = if name.is_none()
        && config.is_none()
        && epg.is_none()
        && position.is_none()
        && text.is_none()
    {
        ChangeReason::Status
    } else {
        ChangeReason::Config
    };
    // New text: stop an import of the old text, and keep imports out until
    // the new text is stored.
    let _import = match &text {
        Some(_) => {
            cancel_imports(state, id, false);
            Some(lock_for(state, id).lock_owned().await)
        }
        None => None,
    };
    let _same = match claim {
        Some(_) => Some(identity_lock(state).lock_owned().await),
        None => None,
    };
    let data_dir = state.data_dir.clone();
    // Large new text waits next to the cached copy until the transaction
    // commits, so a refused update leaves the stored playlist as it was.
    let staged = crate::m3u::staged_playlist_path(&data_dir, id);
    let staged_in = staged.clone();
    let result = state
        .db_call(move |c| {
            let mut config_changed = false;
            // Checked and placed before the write lock, as `store::insert` does.
            let raw = match &text {
                Some(t) => {
                    if crate::m3u::rpc::preview(t).channel_count == 0 {
                        return Err(CoreError::Invalid(
                            "this is not an M3U playlist (no channels found); paste the playlist text".into(),
                        ));
                    }
                    Some(crate::m3u::place_raw_text_at(&staged_in, t)?)
                }
                None => None,
            };
            let text_inline = raw.is_some_and(|r| !r.is_empty());
            let text_staged = raw.is_some_and(str::is_empty);
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if let Some(raw) = raw {
                // The sha stays the current catalog's, so the next import sees
                // new text and re-imports it (the remapper keeps user state).
                tx.execute(
                    "INSERT INTO m3u_raw (source_id, raw, sha256, fetched_at) VALUES (?1, ?2, '', ?3)
                     ON CONFLICT(source_id) DO UPDATE SET raw = excluded.raw",
                    rusqlite::params![sid, raw, crate::db::now_rfc3339()],
                )?;
            }
            if let Some(cfg) = &claim {
                if let Some((_, other)) = store::find_same(&tx, cfg, Some(&sid))? {
                    return Err(duplicate_error(cfg, &other));
                }
            }
            if let Some(n) = &name {
                tx.execute(
                    "UPDATE sources SET name = ?2 WHERE id = ?1",
                    rusqlite::params![sid, n],
                )?;
            }
            if let Some(a) = auto_refresh {
                tx.execute(
                    "UPDATE sources SET auto_refresh = ?2 WHERE id = ?1",
                    rusqlite::params![sid, a],
                )?;
            }
            if let Some(cfg) = &config {
                let json = cfg.to_json()?;
                let n = tx.execute(
                    "UPDATE sources SET config_json = ?2 WHERE id = ?1 AND config_json IS NOT ?2",
                    rusqlite::params![sid, json],
                )?;
                if n > 0 {
                    // New URL or credentials: a cached portal session is stale.
                    store::forget_session(&tx, &sid)?;
                    config_changed = true;
                }
            }
            if let Some(e) = &epg {
                tx.execute(
                    "UPDATE sources SET epg_json = ?2 WHERE id = ?1",
                    rusqlite::params![sid, serde_json::to_string(e)?],
                )?;
            }
            tx.execute(
                "UPDATE sources SET updated_at = ?2 WHERE id = ?1",
                rusqlite::params![sid, crate::db::now_rfc3339()],
            )?;
            tx.commit()?;
            if text_staged {
                let dest = crate::m3u::cached_playlist_path(&data_dir, &sid);
                std::fs::rename(&staged_in, dest)?;
            }
            if let Some(p) = position {
                store::move_to(c, &sid, p)?;
            }
            Ok((store::get(c, &sid)?, config_changed, text_inline))
        })
        .await;
    if result.is_err() {
        // Refused or failed: the staged text (if any) never counts.
        let _ = std::fs::remove_file(&staged);
    }
    let (updated, config_changed, text_inline) = result?;
    if text_inline {
        // A disk copy of the previous (large) text is stale now.
        crate::m3u::remove_cached_playlist(state, id);
    }
    if config_changed && !catchup_only {
        // An import still running fetches the old address (and may be stuck
        // on it); stop it so the next refresh uses the new settings.
        cancel_imports(state, id, false);
        // Cached panel guide answers may belong to another server/account.
        crate::catchup::forget_source(state, id);
    }
    if portal_changed {
        crate::stalker::forget_source(state, id).await;
    }
    emit_changed(state, Some(id), reason);
    if shift_changed {
        state.emit("epg.changed", serde_json::json!({}));
    }
    Ok(updated)
}

/// `sources.remove`. Cancels a running import of the source (and any queued
/// one), then waits for it to stop.
pub async fn remove(state: &AppState, id: &str) -> CoreResult<()> {
    cancel_imports(state, id, true);
    let lock = lock_for(state, id);
    let _guard = lock.lock().await;
    let sid = id.to_string();
    // Deleting a large catalog holds the write lock for seconds: other
    // writes wait for it instead of failing after the 5 s busy timeout, as
    // during an import (DB-2). `remove_all` and a backup Replace come here.
    let long = crate::db::long_write();
    let deleted = state
        .db_call(move |c| {
            store::delete(c, &sid)?;
            // The delete grew the WAL by about the catalog's size: fold it
            // back (never waits on a busy reader).
            crate::db::checkpoint_truncate(c);
            Ok(())
        })
        .await;
    drop(long);
    // Imports after this (a failed delete, or an id reused) start uncancelled.
    cancels(state).remove(id);
    deleted?;
    crate::m3u::remove_cached_playlist(state, id);
    crate::stalker::forget_source(state, id).await;
    crate::catchup::forget_source(state, id);
    // recording: drop its reminders, cancel or stop its recordings.
    crate::recording::forget_source(state, id).await;
    // lists: the cascade dropped the source's list items; announce `lists.changed`.
    crate::lists::forget_source(state, id).await;
    if let Some(locks) = state.ext::<LockMap>(LOCKS_KEY) {
        locks.remove(id);
    }
    tracing::info!(source_id = id, "source removed");
    emit_changed(state, Some(id), ChangeReason::Removed);
    Ok(())
}

/// `sources.removeAll`: removes every source through the same path as
/// [`remove`] (each waits for its running import), then emits one more
/// `sources.changed`. A source already gone is skipped.
pub async fn remove_all(state: &AppState) -> CoreResult<()> {
    let ids: Vec<String> = list(state).await?.into_iter().map(|s| s.id).collect();
    for id in &ids {
        match remove(state, id).await {
            Ok(()) | Err(CoreError::NotFound(_)) => {}
            Err(err) => return Err(err),
        }
    }
    tracing::info!(count = ids.len(), "all sources removed");
    emit_changed(state, None, ChangeReason::Removed);
    Ok(())
}

/// `sources.reorder`.
pub async fn reorder(state: &AppState, ids: Vec<String>) -> CoreResult<()> {
    state.db_call(move |c| store::reorder(c, &ids)).await?;
    emit_changed(state, None, ChangeReason::Config);
    Ok(())
}

/// `sources.refresh`: re-import one source.
///
/// User-initiated (a card's Refresh, the add dialog's Try again): an
/// unreachable host fails after the short connect timeout, as in [`add`]
/// (L4-settings-4). The startup pass and the schedule ([`schedule`]) call
/// the importer directly and keep the background 10 s and retries.
///
/// A source that is importing already is not imported twice (ST-2): the
/// refresh waits for that import and returns its result. A run that an
/// edit or a remove stopped does not count; the refresh then imports again
/// (with the new settings) as before.
pub async fn refresh(state: Arc<AppState>, id: &str) -> CoreResult<Source> {
    match join_running_import(&state, id).await {
        Some(Err(err)) if is_cancelled_error(&err) && !is_user_cancel(&err) => {}
        Some(joined) => return joined.map(|(source, _)| source),
        None => {}
    }
    Ok(crate::http::interactive(run_import(state, id)).await?.0)
}

/// `sources.refreshAll`: re-imports every auto-refresh source, one at a time.
pub async fn refresh_all(state: Arc<AppState>) -> CoreResult<RefreshAllResult> {
    let sources = list(&state).await?;
    let mut out = RefreshAllResult::default();
    for s in sources.into_iter().filter(|s| s.auto_refresh) {
        match run_import(state.clone(), &s.id).await {
            Ok(_) => out.refreshed.push(s.id),
            Err(CoreError::NotFound(_)) if get(&state, &s.id).await.is_err() => {
                // Removed while we were refreshing others; nothing to report.
            }
            // Cancelled (cancelImport, remove, edit): not a failure.
            Err(err) if is_cancelled_error(&err) => {}
            Err(err) => out.failed.push(RefreshFailure {
                id: s.id,
                code: Some(err.code()),
                error: crate::logging::redact_text(&error_text(&err)).into_owned(),
            }),
        }
    }
    Ok(out)
}

/// `sources.counts`.
pub async fn counts(state: &AppState, id: &str) -> CoreResult<SourceCounts> {
    let s = get(state, id).await?;
    Ok(SourceCounts {
        channel_count: s.channel_count,
        radio_count: s.radio_count,
        movie_count: s.movie_count,
        series_count: s.series_count,
    })
}

/// Schedules the startup refresh of the auto-refresh sources that are due
/// [`STARTUP_REFRESH_DELAY`] after boot (in the background; boot does not
/// wait for it; see [`schedule::startup`]), then the periodic refresh every
/// `sourceRefreshIntervalHours` (see [`schedule`]; 0 = startup only).
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    if state.ext::<()>("sources.started").is_some() {
        return Ok(());
    }
    state.set_ext("sources.started", Arc::new(()));
    // Weak: the task ends when the app state is dropped.
    let weak = Arc::downgrade(&state);
    drop(state);
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_REFRESH_DELAY).await;
        let Some(state) = weak.upgrade() else {
            return;
        };
        let r = schedule::startup(&state, &schedule::SystemClock, schedule::STAGGER).await;
        if !(r.refreshed.is_empty() && r.failed.is_empty()) {
            tracing::info!(
                refreshed = r.refreshed.len(),
                failed = r.failed.len(),
                "startup refresh finished"
            );
        }
        drop(state);
        // account: the periodic refresh.
        schedule::run(weak, schedule::TICK).await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::BroadcastSink;

    struct Fake;
    #[async_trait::async_trait]
    impl Importer for Fake {
        fn kind(&self) -> SourceKind {
            SourceKind::Xtream
        }
        async fn import(
            &self,
            _state: Arc<AppState>,
            _source: &Source,
        ) -> CoreResult<ImportSummary> {
            Ok(ImportSummary::default())
        }
    }

    #[tokio::test]
    async fn registry_and_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let (sink, mut rx) = BroadcastSink::channel(4);
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
            .await
            .unwrap();
        assert!(importer(&state, SourceKind::Xtream).is_none());
        register_importer(&state, Arc::new(Fake));
        assert!(importer(&state, SourceKind::Xtream).is_some());
        assert!(importer(&state, SourceKind::M3u).is_none());

        progress(&state, "s1", "parsing", 10, Some(20), None);
        let ev = rx.recv().await.unwrap();
        assert_eq!(ev.kind, "import.progress");
        assert_eq!(ev.payload["sourceId"], "s1");
        assert_eq!(ev.payload["total"], 20);
        assert!(ev.payload.get("message").is_none());
    }

    #[tokio::test]
    async fn import_does_not_wait_for_a_running_backup_import() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(
            tmp.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        register_importer(&state, Arc::new(Fake));
        let cfg = SourceConfig::Xtream(XtreamSourceConfig {
            server_url: "http://h".into(),
            username: "u".into(),
            password: "p".into(),
            headers: Default::default(),
        });
        state
            .db_call(move |c| store::insert(c, "x1", "X", false, &cfg, None))
            .await
            .unwrap();
        // A backup import holds the global lock (e.g. while it syncs its own
        // sources); a refresh of an unrelated source must not block on it.
        let lock = crate::backup::import_lock(&state);
        let _held = lock.lock().await;
        let done = tokio::time::timeout(Duration::from_secs(5), run_import(state.clone(), "x1"))
            .await
            .expect("run_import blocked behind the backup import lock");
        assert!(done.is_ok());
    }

    /// L1-sources-home-6: names given to sources added without one follow the
    /// UI's `suggestName` (no `c`, `get.php` or percent-encoded names).
    #[test]
    fn default_names_follow_the_ui_rules() {
        let m3u = |origin, url: Option<&str>, file: Option<&str>| {
            default_name(
                SourceKind::M3u,
                &SourceConfig::M3u(M3uSourceConfig {
                    origin,
                    url: url.map(str::to_string),
                    file_path: file.map(str::to_string),
                    headers: RequestHeaders::default(),
                    catchup: None,
                }),
            )
        };
        let url = |u: &str| m3u(M3uOrigin::Url, Some(u), None);
        assert_eq!(
            url("http://www.example.com/get.php?username=u&password=p"),
            "example.com"
        );
        assert_eq!(url("http://tv.example.com/My%20List.m3u8"), "My List");
        assert_eq!(url("http://tv.example.com/lists/sports.M3U"), "sports");
        assert_eq!(url("http://tv.example.com/lists/news.txt/"), "news");
        assert_eq!(url("http://tv.example.com/Playlist.m3u"), "tv.example.com");
        assert_eq!(url("http://tv.example.com/panel"), "tv.example.com");
        assert_eq!(url("http://tv.example.com/"), "tv.example.com");
        // A broken escape keeps the raw text.
        assert_eq!(url("http://tv.example.com/bad%E0%A4.m3u"), "bad%E0%A4");
        assert_eq!(
            m3u(M3uOrigin::File, None, Some("C:/lists/family.m3u8")),
            "family"
        );
        assert_eq!(m3u(M3uOrigin::Text, None, None), "Pasted playlist");

        let xtream = |server: &str| {
            default_name(
                SourceKind::Xtream,
                &SourceConfig::Xtream(XtreamSourceConfig {
                    server_url: server.into(),
                    username: "u".into(),
                    password: "p".into(),
                    headers: Default::default(),
                }),
            )
        };
        assert_eq!(xtream("http://www.provider.tv:8080"), "provider.tv");
        assert_eq!(xtream("http://provider.tv/player_api.php"), "provider.tv");
        assert_eq!(xtream("not a url"), "xtream");

        for portal in [
            "http://portal.example.net/c",
            "http://portal.example.net/c/",
            "http://portal.example.net/stalker_portal/c/",
            "http://portal.example.net/portal.php",
            "http://portal.example.net/stalker_portal/server/load.php",
        ] {
            assert_eq!(
                name_from_url(portal).as_deref(),
                Some("portal.example.net"),
                "{portal}"
            );
        }
    }

    #[test]
    fn validation_normalizes() {
        assert_eq!(
            normalize_mac("00-1a-79-00-00-01").unwrap(),
            "00:1A:79:00:00:01"
        );
        assert_eq!(normalize_mac("001A79000001").unwrap(), "00:1A:79:00:00:01");
        assert!(normalize_mac("00:1A:79:00:00").is_err());
        assert!(normalize_mac("zz:1A:79:00:00:01").is_err());
        let x = validate_xtream(XtreamSourceConfig {
            server_url: " http://h:8080/player_api.php ".into(),
            username: "u".into(),
            password: "p".into(),
            headers: Default::default(),
        })
        .unwrap();
        assert_eq!(x.server_url, "http://h:8080");
        // L1-core-20: the username is trimmed, the password is not.
        let spaced = validate_xtream(XtreamSourceConfig {
            server_url: "http://h".into(),
            username: " u ".into(),
            password: " p ".into(),
            headers: Default::default(),
        })
        .unwrap();
        assert_eq!(
            (spaced.username.as_str(), spaced.password.as_str()),
            ("u", " p ")
        );
        assert!(validate_xtream(XtreamSourceConfig {
            server_url: "http://h".into(),
            username: "u".into(),
            password: "   ".into(),
            headers: Default::default(),
        })
        .is_err());
        assert!(validate_xtream(XtreamSourceConfig {
            server_url: "ftp://h".into(),
            username: "u".into(),
            password: "p".into(),
            headers: Default::default(),
        })
        .is_err());
        let bad_ua = validate_xtream(XtreamSourceConfig {
            server_url: "http://h".into(),
            username: "u".into(),
            password: "p".into(),
            headers: RequestHeaders {
                user_agent: Some("Agent\n1".into()),
                ..Default::default()
            },
        });
        assert!(matches!(bad_ua, Err(CoreError::Invalid(_))), "{bad_ua:?}");
        assert_eq!(
            normalize_urls(vec![" a ".into(), "".into(), "a".into(), "b".into()]),
            vec!["a", "b"]
        );
    }
}
