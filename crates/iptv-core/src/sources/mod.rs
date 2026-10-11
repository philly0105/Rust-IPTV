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
pub mod store;

use crate::error::{CoreError, CoreResult, RpcError};
use crate::model::{
    EpgLinks, ImportSummary, M3uOrigin, M3uSourceConfig, RequestHeaders, Source, SourceKind,
    StalkerSourceConfig, XtreamSourceConfig,
};
use crate::state::AppState;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use store::SourceConfig;

/// `AppState.extensions` key of the importer registry.
pub const IMPORTERS_KEY: &str = "importers";
/// `AppState.extensions` key of the per-source import locks.
pub const LOCKS_KEY: &str = "sources.locks";
/// Delay between boot and the startup refresh of auto-refresh sources.
pub const STARTUP_REFRESH_DELAY: Duration = Duration::from_secs(3);

/// Importer registry stored under [`IMPORTERS_KEY`].
pub type ImporterRegistry = DashMap<SourceKind, Arc<dyn Importer>>;

type LockMap = DashMap<String, Arc<tokio::sync::Mutex<()>>>;

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
    /// `fetching` | `parsing` | `saving` | `done` | `error`
    pub phase: &'a str,
    pub done: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'a str>,
}

/// Emits `import.progress` (C6). Importers call it at least every 2000 items.
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
        },
    );
}

/// Emits `sources.changed {}`.
pub fn emit_changed(state: &AppState) {
    state.emit("sources.changed", serde_json::json!({}));
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
}

/// `sources.counts` result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCounts {
    pub channel_count: i64,
    pub movie_count: i64,
    pub series_count: i64,
}

/// One failed source in `sources.refreshAll`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshFailure {
    pub id: String,
    pub error: String,
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
            })
        }
        M3uOrigin::Text => Ok(M3uSourceConfig {
            origin: M3uOrigin::Text,
            url: None,
            file_path: None,
            headers,
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
    let password = cfg.password.trim().to_string();
    if password.is_empty() {
        return Err(CoreError::Invalid("enter the Xtream password".into()));
    }
    Ok(XtreamSourceConfig {
        server_url: server,
        username,
        password,
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
    let portal = cfg.portal_url.trim().to_string();
    check_http_url(&portal, "the portal URL")?;
    Ok(StalkerSourceConfig {
        portal_url: portal,
        mac_address: normalize_mac(&cfg.mac_address)?,
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

fn default_name(kind: SourceKind, cfg: &SourceConfig) -> String {
    let from_url = |u: &str| -> Option<String> {
        let parsed = url::Url::parse(u).ok()?;
        let seg = parsed
            .path_segments()
            .and_then(|mut s| s.next_back().map(str::to_owned))
            .filter(|s| !s.is_empty());
        seg.or_else(|| parsed.host_str().map(str::to_owned))
    };
    match cfg {
        SourceConfig::M3u(c) => match c.origin {
            M3uOrigin::Url => c.url.as_deref().and_then(from_url),
            M3uOrigin::File => c.file_path.as_deref().and_then(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            }),
            M3uOrigin::Text => None,
        }
        .unwrap_or_else(|| "Pasted playlist".to_string()),
        SourceConfig::Xtream(c) => {
            from_url(&c.server_url).unwrap_or_else(|| kind.as_str().to_string())
        }
        SourceConfig::Stalker(c) => {
            from_url(&c.portal_url).unwrap_or_else(|| kind.as_str().to_string())
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

/// Runs `fut` while holding the per-source import lock that [`run_import`]
/// and [`remove`] take, so a partial sync (e.g. `xtream.sync` with a
/// `contentTypes` subset) never interleaves with a full refresh of the same
/// source. `fut` must not call `run_import` / `remove` for that source itself
/// (the lock is not reentrant).
pub async fn run_import_with<T>(
    state: &AppState,
    id: &str,
    fut: impl std::future::Future<Output = T>,
) -> T {
    let lock = lock_for(state, id);
    let _guard = lock.lock().await;
    fut.await
}

/// Every source ordered by position, with cached counts.
pub async fn list(state: &AppState) -> CoreResult<Vec<Source>> {
    state.db_call(|c| store::list(c)).await
}

/// One source.
pub async fn get(state: &AppState, id: &str) -> CoreResult<Source> {
    let id = id.to_string();
    state.db_call(move |c| store::get(c, &id)).await
}

/// Error of [`add`]: the id of the created source (when the failure happened
/// during the import) and the cause.
#[derive(Debug)]
pub struct AddError {
    pub source_id: Option<String>,
    pub error: CoreError,
}

impl From<CoreError> for AddError {
    fn from(error: CoreError) -> Self {
        Self {
            source_id: None,
            error,
        }
    }
}

impl From<AddError> for RpcError {
    fn from(e: AddError) -> Self {
        let mut err = RpcError::from(e.error);
        if let Some(id) = e.source_id {
            err = err.with_details(serde_json::json!({ "sourceId": id }));
        }
        err
    }
}

/// `sources.add`: validates, inserts, runs the importer. On importer failure
/// the source stays (with `lastError`) and the error carries its id.
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
        let id = id.clone();
        state
            .db_call(move |c| {
                store::insert(c, &id, &name, auto_refresh, &config, raw_text.as_deref())
            })
            .await?;
    }
    tracing::info!(source_id = %id, kind = args.kind.as_str(), "source added");
    emit_changed(&state);
    match run_import(state.clone(), &id).await {
        Ok((source, _)) => Ok(source),
        Err(error) => Err(AddError {
            source_id: Some(id),
            error,
        }),
    }
}

/// Runs the importer for one source (serialized per source), then records the
/// outcome. A failed import leaves the previous catalog in place.
pub async fn run_import(state: Arc<AppState>, id: &str) -> CoreResult<(Source, ImportSummary)> {
    let lock = lock_for(&state, id);
    let _guard = lock.lock().await;
    let source = get(&state, id).await?;
    let Some(imp) = importer(&state, source.kind) else {
        let err = CoreError::Unsupported(format!(
            "{} sources are not available in this build",
            source.kind.as_str()
        ));
        record(&state, id, Some(&error_text(&err))).await;
        return Err(err);
    };
    let started = std::time::Instant::now();
    match imp.import(state.clone(), &source).await {
        Ok(summary) => {
            let sid = id.to_string();
            let kind = source.kind;
            let (movies, series) = (summary.movies, summary.series);
            state
                .db_call(move |c| {
                    store::record_import(c, &sid, None)?;
                    if kind == SourceKind::Stalker {
                        // Portal VOD is not stored locally; keep its totals.
                        crate::catalog::set_remote_counts(c, &sid, movies, series)?;
                    }
                    Ok(())
                })
                .await?;
            apply_parked_backup(&state, id).await;
            let total = (summary.channels + summary.movies + summary.series).max(0) as u64;
            progress(&state, id, "done", total, Some(total), None);
            tracing::info!(
                source_id = id,
                channels = summary.channels,
                movies = summary.movies,
                series = summary.series,
                ms = started.elapsed().as_millis() as u64,
                "source imported"
            );
            emit_changed(&state);
            let source = get(&state, id).await?;
            spawn_guide_refresh(&state, &source);
            Ok((source, summary))
        }
        Err(err) => {
            let msg = error_text(&err);
            tracing::warn!(source_id = id, error = %msg, "source import failed; previous catalog kept");
            record(&state, id, Some(&msg)).await;
            progress(&state, id, "error", 0, None, Some(&msg));
            emit_changed(&state);
            Err(err)
        }
    }
}

/// Guide URLs of a source that a refresh should cover: detected and manual
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
async fn apply_parked_backup(state: &Arc<AppState>, id: &str) {
    match crate::backup::apply_pending_restore(state, id).await {
        Ok(w) if !w.is_empty() => {
            tracing::info!(
                source_id = id,
                warnings = w.len(),
                "applied parked backup state"
            )
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(source_id = id, %err, "parked backup state could not be applied")
        }
    }
}

async fn record(state: &AppState, id: &str, error: Option<&str>) {
    let sid = id.to_string();
    let error = error.map(str::to_owned);
    if let Err(err) = state
        .db_call(move |c| store::record_import(c, &sid, error.as_deref()))
        .await
    {
        tracing::warn!(source_id = id, %err, "could not record import outcome");
    }
}

/// `sources.update`.
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
        config = Some(SourceConfig::Stalker(validate_stalker(s)?));
    }
    let name = match patch.name.as_deref().map(str::trim) {
        Some("") => return Err(CoreError::Invalid("the name cannot be empty".into())),
        Some(n) => Some(n.to_string()),
        None => None,
    };
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
        e
    });
    let sid = id.to_string();
    let auto_refresh = patch.auto_refresh;
    let position = patch.position;
    state
        .db_call(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
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
            if let Some(p) = position {
                store::move_to(c, &sid, p)?;
            }
            store::get(c, &sid)
        })
        .await
        .inspect(|_| emit_changed(state))
}

/// `sources.remove`. Waits for a running import of the source to finish.
pub async fn remove(state: &AppState, id: &str) -> CoreResult<()> {
    let lock = lock_for(state, id);
    let _guard = lock.lock().await;
    let sid = id.to_string();
    state.db_call(move |c| store::delete(c, &sid)).await?;
    if let Some(locks) = state.ext::<LockMap>(LOCKS_KEY) {
        locks.remove(id);
    }
    tracing::info!(source_id = id, "source removed");
    emit_changed(state);
    Ok(())
}

/// `sources.reorder`.
pub async fn reorder(state: &AppState, ids: Vec<String>) -> CoreResult<()> {
    state.db_call(move |c| store::reorder(c, &ids)).await?;
    emit_changed(state);
    Ok(())
}

/// `sources.refresh`: re-import one source.
pub async fn refresh(state: Arc<AppState>, id: &str) -> CoreResult<Source> {
    Ok(run_import(state, id).await?.0)
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
            Err(err) => out.failed.push(RefreshFailure {
                id: s.id,
                error: error_text(&err),
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
        movie_count: s.movie_count,
        series_count: s.series_count,
    })
}

/// Schedules the startup refresh of auto-refresh sources 3 s after boot (in
/// the background; boot does not wait for it).
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    if state.ext::<()>("sources.started").is_some() {
        return Ok(());
    }
    state.set_ext("sources.started", Arc::new(()));
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_REFRESH_DELAY).await;
        match refresh_all(state).await {
            Ok(r) if r.refreshed.is_empty() && r.failed.is_empty() => {}
            Ok(r) => tracing::info!(
                refreshed = r.refreshed.len(),
                failed = r.failed.len(),
                "startup refresh finished"
            ),
            Err(err) => tracing::warn!(%err, "startup refresh failed"),
        }
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
        })
        .unwrap();
        assert_eq!(x.server_url, "http://h:8080");
        assert!(validate_xtream(XtreamSourceConfig {
            server_url: "ftp://h".into(),
            username: "u".into(),
            password: "p".into()
        })
        .is_err());
        assert_eq!(
            normalize_urls(vec![" a ".into(), "".into(), "a".into(), "b".into()]),
            vec!["a", "b"]
        );
    }
}
