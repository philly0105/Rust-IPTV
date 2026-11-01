//! Refreshing one EPG URL: fetch, parse, stage, swap; plus the background
//! runtime (one refresh per url at a time, at most two at once, a scheduler
//! that keeps stale feeds fresh).

use super::fetch::{self, Fetched};
use super::store::{self, ConfiguredUrl, StagingWriter, Validators};
use super::xmltv::{self, Window, XmltvItem};
use crate::error::{CoreError, CoreResult};
use crate::model::{EpgFetchStatus, EpgOrigin, RequestHeaders};
use crate::state::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

/// Extension key of the runtime in `AppState::extensions`.
pub const RUNTIME_KEY: &str = "epg";
/// Refreshes running at the same time, across all urls.
pub const MAX_CONCURRENT: usize = 2;
/// A successful fetch older than this is refreshed by the scheduler.
pub const STALE_AFTER: Duration = Duration::from_secs(12 * 3600);
/// A failed url is retried by the scheduler after this long.
pub const RETRY_FAILED_AFTER: Duration = Duration::from_secs(30 * 60);
/// First scheduler pass after boot: urls that have no guide yet.
pub const BOOT_DELAY: Duration = Duration::from_secs(10);
/// Urls that already have a guide are refreshed no sooner than this after
/// boot, with the source startup pass: the window, the first screen's
/// queries and the first stream come before a download, parse and swap.
pub const STORED_BOOT_DELAY: Duration = crate::sources::STARTUP_REFRESH_DELAY;
/// Scheduler interval after the first pass (picks up newly added urls).
pub const TICK: Duration = Duration::from_secs(30);
/// A body identical to the one the stored guide came from (same fingerprint)
/// is not read again within this long of that ingest; past it, it is, so the
/// stored 2-day / 14-day window moves on.
pub const REINGEST_AFTER: Duration = Duration::from_secs(24 * 3600);
/// Version of what an ingest stores (parser and staging rules), seeded into
/// every body fingerprint (`fetch`): bumping it makes the next refresh of
/// every feed read an unchanged body again. Bump it whenever a change alters
/// the rows an ingest writes.
pub const INGEST_VERSION: u32 = 1;
/// Minimum gap between two `epg.progress` events of one url while parsing.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// Prefix of the C15 unreadable-feed code ([`unreadable_warning`]).
const UNREADABLE_CODE: &str = "epg_unreadable:";

/// `epg.changed` payload when only a url's status moved (a refresh started,
/// ended on a 304 or on the body already stored, or failed): no guide data
/// changed, so clients refetch `epg.sources` and keep their guide windows.
#[derive(Serialize)]
struct StatusOnly {
    reason: &'static str,
}

const STATUS_ONLY: StatusOnly = StatusOnly { reason: "status" };

/// Process-wide EPG runtime.
pub struct EpgRuntime {
    sem: Arc<Semaphore>,
    running: Mutex<HashSet<String>>,
    last_attempt: Mutex<HashMap<String, Instant>>,
    generation: AtomicU64,
    pub(crate) names: Mutex<Option<Arc<super::resolve::ChannelDirectory>>>,
    /// Guide search: channel resolutions reused until the generation moves.
    pub(crate) search_memo: Mutex<super::search::SearchMemo>,
}

impl Default for EpgRuntime {
    fn default() -> Self {
        Self {
            sem: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            running: Mutex::new(HashSet::new()),
            last_attempt: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(1),
            names: Mutex::new(None),
            search_memo: Mutex::new(Default::default()),
        }
    }
}

impl EpgRuntime {
    /// Data generation; bumped whenever stored channels change or a url is
    /// enabled/disabled, invalidating the cached channel directory.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Invalidates caches derived from EPG data.
    pub fn bump(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// True while a refresh of `url` is queued or running.
    pub fn is_running(&self, url: &str) -> bool {
        self.running.lock().contains(url)
    }
}

/// The runtime of `state`, created on first use.
pub fn runtime(state: &AppState) -> Arc<EpgRuntime> {
    state.ext_or_insert_with(RUNTIME_KEY, || Arc::new(EpgRuntime::default()))
}

/// `epg.progress` payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload<'a> {
    pub url: &'a str,
    pub phase: &'a str,
    pub programs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn progress(state: &AppState, url: &str, phase: &str, programs: u64, message: Option<String>) {
    state.emit(
        "epg.progress",
        ProgressPayload {
            url,
            phase,
            programs,
            message,
        },
    );
}

/// Outcome of one refresh.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IngestStats {
    pub channels: u64,
    pub programs: u64,
    pub skipped_window: u64,
    pub skipped_invalid: u64,
    /// Nothing new: the server answered 304, or sent the body the stored
    /// guide came from; stored data was kept.
    pub not_modified: bool,
    /// Set when the feed ended with an XML error and the data before it was kept.
    pub warning: Option<String>,
}

/// Parses `reader` into staging and swaps it in for `url`, with the body's
/// `validators` (none: no ETag, nothing to recognise the body by).
/// Blocking; call from a blocking thread. `on_progress(phase, programs)` is
/// called with `"parsing"` after each committed batch and `"saving"` before
/// the swap. On error the staging rows are discarded and stored data is
/// untouched.
pub fn ingest_reader(
    conn: &mut rusqlite::Connection,
    url: &str,
    reader: impl BufRead,
    window: Window,
    validators: Option<&Validators>,
    on_progress: &mut dyn FnMut(&str, u64),
) -> CoreResult<IngestStats> {
    // A large feed (millions of programmes) holds the write lock for long
    // stretches, the final swap above all; user writes made meanwhile wait
    // for it as they do for a catalog import (B9-D64) instead of failing
    // with "database is locked" after the normal busy timeout.
    let _long = crate::db::long_write();
    // Bulk-load tuning for this pooled connection only: a 64 MB page cache
    // keeps the (epg_url, channel_id, start) index hot, and deferring WAL
    // checkpoints avoids copying pages back mid-load. Both are restored
    // afterwards.
    let cache: i64 = conn.query_row("PRAGMA cache_size", [], |r| r.get(0))?;
    let autockpt: i64 = conn.query_row("PRAGMA wal_autocheckpoint", [], |r| r.get(0))?;
    let temp_store: i64 = conn.query_row("PRAGMA temp_store", [], |r| r.get(0))?;
    // Staged programmes sit in a temp table (P2-EPGRS-1). On file, behind
    // the temp database's own 2 MB page cache, memory stays flat whatever
    // the size of the feed (pooled connections keep temp tables in memory);
    // restoring the setting closes the temp database, which deletes the
    // file without walking the table's pages. Statement journals follow the
    // setting: the swap's copy journals each page it reuses from the rows it
    // replaces, so a refresh over a stored guide also needs about that
    // guide's size in the temp directory until the swap commits (held in
    // memory before; `epg_reingest_rss`). The swap's index of the staged
    // slots and its list of replaced rows live there too.
    conn.execute_batch(
        "PRAGMA cache_size=-65536; PRAGMA wal_autocheckpoint=0; PRAGMA temp_store=FILE;",
    )?;
    let result = ingest_inner(conn, url, reader, window, validators, on_progress);
    // Guide search (C5): a swap that replaced only what changed kept the
    // title index in step; one that copied the whole feed (or a discarded
    // staging) marked it stale: rebuild it while the bulk-load cache is
    // still large.
    super::search::refresh_index(conn);
    let restore = conn.execute_batch(&format!(
        "PRAGMA cache_size={cache}; PRAGMA wal_autocheckpoint={autockpt}; PRAGMA temp_store={temp_store};"
    ));
    if let Err(e) = restore {
        tracing::warn!(error = %e, "could not restore connection pragmas after EPG ingest");
    }
    // Fold the bulk write back into the database file now rather than on the
    // next unrelated commit, and truncate the WAL: a 100-250 MB guide grows it
    // the most (L2-perf-core-12). Never waits on readers.
    crate::db::checkpoint_truncate(conn);
    result
}

fn ingest_inner(
    conn: &mut rusqlite::Connection,
    url: &str,
    reader: impl BufRead,
    window: Window,
    validators: Option<&Validators>,
    on_progress: &mut dyn FnMut(&str, u64),
) -> CoreResult<IngestStats> {
    let key = store::begin_staging(conn, url)?;
    let result = (|| {
        let mut writer = StagingWriter::new(conn, key);
        let stats = xmltv::parse(reader, window, &mut |item| {
            match item {
                XmltvItem::Channel(c) => writer.push_channel(c)?,
                XmltvItem::Programme(p) => {
                    if writer.push_programme(p)? {
                        on_progress("parsing", writer.program_count);
                    }
                }
            }
            Ok(())
        })?;
        writer.flush()?;
        Ok::<_, CoreError>((stats, writer.channel_count, writer.program_count))
    })();
    match result {
        Ok((stats, channels, staged)) => {
            on_progress("saving", staged);
            let programs = store::commit_staging(conn, url, validators, channels)?;
            // Most programmes unreadable (often an unknown time zone): the
            // status stays ok (the readable part was stored) but the source
            // row and the done event carry the C15 code saying why the
            // guide is empty or thin. The guide is already swapped in, so a
            // failure here must not fail the refresh: an error tells clients
            // no guide data changed.
            let unreadable = unreadable_warning(&stats);
            if let Some(w) = &unreadable {
                if let Err(e) = store::set_status(conn, url, EpgFetchStatus::Ok, Some(w)) {
                    tracing::warn!(error = %e, "could not record the EPG unreadable warning");
                }
            }
            Ok(IngestStats {
                channels,
                programs,
                skipped_window: stats.skipped_window,
                skipped_invalid: stats.skipped_invalid,
                not_modified: false,
                warning: unreadable.or(stats.truncated),
            })
        }
        Err(err) => {
            if let Err(e) = store::discard_staging(conn, url) {
                tracing::warn!(error = %e, "could not discard EPG staging rows");
            }
            Err(err)
        }
    }
}

/// The C15 code `epg_unreadable:<skipped>:<seen>` when more than half of a
/// feed's programmes were skipped as invalid (unreadable start or stop, no
/// channel); `None` otherwise. Stored verbatim as the source's status error;
/// the UI translates it (`epgUnreadable`).
fn unreadable_warning(stats: &xmltv::ParseStats) -> Option<String> {
    let skipped = stats.skipped_invalid;
    let seen = stats
        .programmes
        .saturating_add(stats.skipped_window)
        .saturating_add(skipped);
    (skipped > 0 && skipped.saturating_mul(2) > seen)
        .then(|| format!("{UNREADABLE_CODE}{skipped}:{seen}"))
}

/// Looks up `url` among the configured urls; unknown urls are treated as
/// settings urls without headers (used by tests and direct calls).
pub async fn configured(state: &AppState, url: &str) -> CoreResult<Option<ConfiguredUrl>> {
    let settings = state.settings_snapshot().epg_urls;
    let url = url.trim().to_string();
    state
        .db_call(move |c| {
            Ok(store::configured_urls(c, &settings)?
                .into_iter()
                .find(|x| x.url == url))
        })
        .await
}

/// All configured urls.
pub async fn configured_all(state: &AppState) -> CoreResult<Vec<ConfiguredUrl>> {
    let settings = state.settings_snapshot().epg_urls;
    state
        .db_call(move |c| store::configured_urls(c, &settings))
        .await
}

struct RunningGuard {
    rt: Arc<EpgRuntime>,
    url: String,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.rt.running.lock().remove(&self.url);
    }
}

fn claim(rt: &Arc<EpgRuntime>, url: &str) -> Option<RunningGuard> {
    if !rt.running.lock().insert(url.to_string()) {
        return None;
    }
    rt.last_attempt
        .lock()
        .insert(url.to_string(), Instant::now());
    Some(RunningGuard {
        rt: rt.clone(),
        url: url.to_string(),
    })
}

/// Refreshes `url` now and waits for it. Fails with `Conflict` when a refresh
/// of the same url is already running. Respects the global concurrency limit.
pub async fn refresh_now(state: Arc<AppState>, url: &str) -> CoreResult<IngestStats> {
    let rt = runtime(&state);
    let url = url.trim().to_string();
    let Some(guard) = claim(&rt, &url) else {
        return Err(CoreError::Conflict(
            "this EPG source is already refreshing".into(),
        ));
    };
    run_refresh(state, rt, url, guard).await
}

/// Starts a background refresh of `url`. Returns false when one is already
/// queued or running.
pub fn spawn_refresh(state: Arc<AppState>, url: &str) -> bool {
    let rt = runtime(&state);
    let url = url.trim().to_string();
    let Some(guard) = claim(&rt, &url) else {
        return false;
    };
    tokio::spawn(async move {
        let shown = fetch::log_url(&url);
        if let Err(err) = run_refresh(state, rt, url, guard).await {
            tracing::warn!(url = %shown, error = %err, "EPG refresh failed");
        }
    });
    true
}

/// Starts background refreshes of every enabled configured url. Returns the
/// urls started.
pub async fn spawn_refresh_all(state: Arc<AppState>) -> CoreResult<Vec<String>> {
    let all = configured_all(&state).await?;
    let urls: Vec<String> = all.iter().map(|c| c.url.clone()).collect();
    let enabled = state
        .db_call(move |c| {
            let mut out = Vec::new();
            for u in urls {
                let on = store::source_row(c, &u)?.map(|r| r.enabled).unwrap_or(true);
                if on {
                    out.push(u);
                }
            }
            Ok(out)
        })
        .await?;
    Ok(enabled
        .into_iter()
        .filter(|u| spawn_refresh(state.clone(), u))
        .collect())
}

async fn run_refresh(
    state: Arc<AppState>,
    rt: Arc<EpgRuntime>,
    url: String,
    _guard: RunningGuard,
) -> CoreResult<IngestStats> {
    let _permit = rt
        .sem
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| CoreError::Other(anyhow::anyhow!("EPG runtime closed")))?;
    let cfg = configured(&state, &url).await?.unwrap_or(ConfiguredUrl {
        url: url.clone(),
        origin: EpgOrigin::Settings,
        source_id: None,
        headers: RequestHeaders::default(),
    });
    let shown = fetch::log_url(&url);
    tracing::info!(url = %shown, "EPG refresh started");
    let started = Instant::now();
    let result = refresh_inner(&state, &cfg).await;
    match &result {
        Ok(stats) => {
            tracing::info!(
                url = %shown,
                channels = stats.channels,
                programs = stats.programs,
                not_modified = stats.not_modified,
                ms = started.elapsed().as_millis() as u64,
                "EPG refresh done"
            );
            progress(&state, &url, "done", stats.programs, stats.warning.clone());
            // A 304 or an unchanged body kept the stored guide: only the
            // url's status moved, so cached directories stay valid and
            // clients keep their guide windows.
            if stats.not_modified {
                state.emit("epg.changed", STATUS_ONLY);
            } else {
                rt.bump();
                // Build the next channel directory before clients refetch, so
                // their first now/next does not wait for it; a read arriving
                // meanwhile waits for this one build.
                let dir_rt = rt.clone();
                if let Err(e) = state
                    .db_call(move |c| super::resolve::directory(c, &dir_rt).map(drop))
                    .await
                {
                    tracing::warn!(error = %e, "could not build the EPG channel directory");
                }
                state.emit("epg.changed", serde_json::json!({}));
            }
        }
        Err(err) => {
            let msg = user_message(err);
            let u = url.clone();
            let m = msg.clone();
            if let Err(e) = state
                .db_call(move |c| store::set_status(c, &u, EpgFetchStatus::Error, Some(&m)))
                .await
            {
                tracing::warn!(error = %e, "could not record EPG error status");
            }
            progress(&state, &url, "error", 0, Some(msg));
            // A failed refresh left the stored guide as it was.
            state.emit("epg.changed", STATUS_ONLY);
        }
    }
    result
}

/// Error text shown in the UI: what failed and what to do next.
fn user_message(err: &CoreError) -> String {
    match err {
        CoreError::Network(m) => format!(
            "Could not download the EPG ({m}). Check the URL and your connection, then refresh."
        ),
        CoreError::Timeout(m) => format!("The EPG server timed out ({m}). Try refreshing later."),
        CoreError::Auth(m) => {
            format!("The EPG server refused access ({m}). Check the credentials of the source.")
        }
        CoreError::NotFound(m) => {
            format!(
                "{}. Check the URL in Settings > EPG.",
                m.trim_end_matches('.')
            )
        }
        // Server-mode guard refusals already say what to do.
        CoreError::Invalid(m) if m.contains(crate::http::ALLOW_PRIVATE_HINT) => m.clone(),
        // A cut-off download: the URL is fine, the next refresh may succeed.
        CoreError::Invalid(m) if m == xmltv::CUT_OFF_MESSAGE => {
            format!("{m} Refresh to try again.")
        }
        CoreError::Unsupported(m) => m.clone(),
        CoreError::Invalid(m) => format!(
            "{}. Check that the URL points to an XMLTV file.",
            m.trim_end_matches('.')
        ),
        other => other.to_string(),
    }
}

/// True when `body` is the one the stored guide of `row` was ingested from
/// (the same fingerprint) less than [`REINGEST_AFTER`] before `now`.
fn unchanged(
    row: &store::SourceRow,
    stored: Option<&store::StoredValidators>,
    body: &Validators,
    now: i64,
) -> bool {
    let Some(stored) = stored else {
        return false;
    };
    let age = now.saturating_sub(stored.ingested_at);
    row.program_count > 0
        && body.fingerprint.is_some()
        && stored.fingerprint == body.fingerprint
        && (0..REINGEST_AFTER.as_secs() as i64).contains(&age)
}

async fn refresh_inner(state: &Arc<AppState>, cfg: &ConfiguredUrl) -> CoreResult<IngestStats> {
    let url = cfg.url.clone();
    let (row, stored) = {
        let c = cfg.clone();
        state
            .db_call(move |conn| {
                store::ensure_row(conn, &c)?;
                // Read before the status below clears the error: an
                // unchanged body keeps the stored guide's unreadable warning.
                let row = store::source_row(conn, &c.url)?.unwrap_or_default();
                let stored = store::stored_validators(conn, &c.url)?;
                store::set_status(conn, &c.url, EpgFetchStatus::Fetching, None)?;
                Ok((row, stored))
            })
            .await?
    };
    progress(state, &url, "fetching", 0, None);
    state.emit("epg.changed", STATUS_ONLY);

    // Conditional GET only when the stored data came from those validators
    // (commit_staging writes them with it).
    let known = (row.program_count > 0).then(|| Validators {
        etag: row.etag.clone(),
        last_modified: stored.as_ref().and_then(|s| s.last_modified.clone()),
        fingerprint: None,
    });
    let on_bytes = {
        let st = state.clone();
        let u = url.clone();
        move |bytes: u64| {
            progress(
                &st,
                &u,
                "fetching",
                0,
                Some(format!("{:.1} MB downloaded", bytes as f64 / 1_048_576.0)),
            )
        }
    };
    let body = match fetch::fetch(state, &url, &cfg.headers, known.as_ref(), &on_bytes).await? {
        Fetched::NotModified => {
            let u = url.clone();
            state
                .db_call(move |c| store::mark_not_modified(c, &u))
                .await?;
            return Ok(IngestStats {
                channels: row.channel_count as u64,
                programs: row.program_count as u64,
                not_modified: true,
                ..Default::default()
            });
        }
        Fetched::Body(b) => b,
    };
    // A server without validators (or a local file) giving the body the
    // stored guide came from: parsing it and swapping it in would store the
    // same programmes, so keep them as on a 304.
    if unchanged(
        &row,
        stored.as_ref(),
        &body.validators,
        chrono::Utc::now().timestamp(),
    ) {
        body.cleanup();
        let warning = row.error.filter(|e| e.starts_with(UNREADABLE_CODE));
        let (u, w, v) = (url.clone(), warning.clone(), body.validators.clone());
        state
            .db_call(move |c| store::mark_unchanged(c, &u, w.as_deref(), &v))
            .await?;
        return Ok(IngestStats {
            channels: row.channel_count as u64,
            programs: row.program_count as u64,
            not_modified: true,
            warning,
            ..Default::default()
        });
    }
    progress(state, &url, "parsing", 0, None);

    let pool = state.db.clone();
    let st = state.clone();
    let u = url.clone();
    let path = body.path.clone();
    let validators = body.validators.clone();
    let result = tokio::task::spawn_blocking(move || -> CoreResult<IngestStats> {
        let reader = fetch::open_reader(&path)?;
        let mut conn = pool.get()?;
        let mut last = Instant::now();
        let now = chrono::Utc::now().timestamp();
        ingest_reader(
            &mut conn,
            &u,
            reader,
            Window::around(now),
            Some(&validators),
            &mut |phase, programs| {
                if phase != "parsing" || last.elapsed() >= PROGRESS_EVERY {
                    last = Instant::now();
                    progress(&st, &u, phase, programs, None);
                }
            },
        )
    })
    .await;
    body.cleanup();
    result?.map_err(|e| state.note_db_error(e))
}

/// True when the scheduler should refresh a url with this row now.
fn is_due(
    row: Option<&store::SourceRow>,
    last_attempt: Option<Instant>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let recently_tried = |gap: Duration| last_attempt.is_some_and(|t| t.elapsed() < gap);
    let Some(row) = row else {
        return !recently_tried(RETRY_FAILED_AFTER);
    };
    if !row.enabled {
        return false;
    }
    if row.status == "error" {
        return !recently_tried(RETRY_FAILED_AFTER);
    }
    match row
        .last_fetch_at
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
    {
        None => !recently_tried(RETRY_FAILED_AFTER),
        Some(at) => {
            let age = now.signed_duration_since(at.with_timezone(&chrono::Utc));
            age.to_std().unwrap_or_default() >= STALE_AFTER && !recently_tried(STALE_AFTER)
        }
    }
}

/// One scheduler pass: prunes removed urls and starts refreshes of enabled
/// urls that were never fetched, are older than 12 h, or failed more than
/// 30 min ago. Returns the urls started.
pub async fn schedule_pass(state: Arc<AppState>) -> CoreResult<Vec<String>> {
    pass(state, false).await
}

/// True for a url the passes right after boot leave for later
/// ([`STORED_BOOT_DELAY`]): it already has a guide to show meanwhile.
fn held_at_boot(row: Option<&store::SourceRow>) -> bool {
    row.is_some_and(|r| r.program_count > 0)
}

/// [`schedule_pass`]; with `boot`, urls that already have a guide wait.
async fn pass(state: Arc<AppState>, boot: bool) -> CoreResult<Vec<String>> {
    let rt = runtime(&state);
    let all = configured_all(&state).await?;
    let keep = all.clone();
    let (rows, pruned) = state
        .db_call(move |c| {
            let pruned = store::prune(c, &keep)?;
            if pruned > 0 {
                super::search::refresh_index(c);
            }
            let mut rows = Vec::with_capacity(keep.len());
            for k in &keep {
                rows.push((k.url.clone(), store::source_row(c, &k.url)?));
            }
            Ok((rows, pruned))
        })
        .await?;
    if pruned > 0 {
        rt.bump();
        state.emit("epg.changed", serde_json::json!({}));
    }
    let now = chrono::Utc::now();
    let mut started = Vec::new();
    for (url, row) in rows {
        if rt.is_running(&url) || (boot && held_at_boot(row.as_ref())) {
            continue;
        }
        let last = rt.last_attempt.lock().get(&url).copied();
        if is_due(row.as_ref(), last, now) && spawn_refresh(state.clone(), &url) {
            started.push(url);
        }
    }
    Ok(started)
}

/// Boot: cleans staging leftovers and temp files, then runs the scheduler
/// (first pass after `first_delay`, then every [`TICK`]) until the state is
/// dropped. Passes before [`STORED_BOOT_DELAY`] start only urls that have no
/// guide yet. Each pass also drops the provider guide answers past their
/// TTL ([`crate::catchup::sweep`]).
pub async fn start(state: Arc<AppState>, first_delay: Duration) -> CoreResult<()> {
    runtime(&state);
    fetch::clean_temp_dir(&state);
    state.db_call(|c| store::cleanup_on_boot(c)).await?;
    let weak: Weak<AppState> = Arc::downgrade(&state);
    drop(state);
    let booted = Instant::now();
    tokio::spawn(async move {
        tokio::time::sleep(first_delay).await;
        loop {
            let Some(state) = weak.upgrade() else { break };
            crate::catchup::sweep(&state);
            let boot = booted.elapsed() < STORED_BOOT_DELAY;
            if let Err(err) = pass(state, boot).await {
                tracing::warn!(error = %err, "EPG scheduler pass failed");
            }
            tokio::time::sleep(TICK).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn etag(tag: &str) -> Validators {
        Validators {
            etag: Some(tag.into()),
            ..Default::default()
        }
    }

    fn row(status: &str, enabled: bool, last: Option<&str>) -> store::SourceRow {
        store::SourceRow {
            enabled,
            status: status.into(),
            last_fetch_at: last.map(str::to_string),
            ..Default::default()
        }
    }

    /// Review R2-5: a feed whose programme times could not be read stored an
    /// empty guide with status ok and no message.
    #[test]
    fn unreadable_feed_is_reported_on_the_source() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
            .unwrap();
        let prog = |start: &str| {
            format!(
                r#"<programme channel="c" start="{start}" stop="20261012130000 +0000"><title>T</title></programme>"#
            )
        };
        // Two readable, three in an unknown zone.
        let xml = format!(
            r#"<tv><channel id="c"><display-name>C</display-name></channel>{}{}{}{}{}</tv>"#,
            prog("20261012120000 +0000"),
            prog("20261012121000 +0000"),
            prog("20261012120000 XYZ"),
            prog("20261012121000 XYZ"),
            prog("20261012122000 XYZ"),
        );
        let stats = ingest_reader(
            &mut conn,
            "u",
            std::io::Cursor::new(xml.into_bytes()),
            Window::unbounded(),
            None,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(stats.programs, 2);
        assert_eq!(stats.skipped_invalid, 3);
        let w = stats.warning.expect("warning");
        // C15: exactly the code, no other text.
        assert_eq!(w, "epg_unreadable:3:5");
        let (status, error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, error FROM epg_sources WHERE url = 'u'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "ok");
        assert_eq!(error.as_deref(), Some(w.as_str()));
        // A mostly readable feed carries no warning.
        let s = xmltv::ParseStats {
            programmes: 10,
            skipped_invalid: 4,
            ..Default::default()
        };
        assert!(unreadable_warning(&s).is_none());
    }

    /// L1-core-6: a download cut before `</tv>` (here after the first
    /// channel's programmes, then a cut gzip stream) failed nothing: it replaced
    /// the full guide with its first part and stored the new ETag, so a later
    /// 304 kept the partial guide.
    #[test]
    fn cut_off_feed_keeps_the_previous_guide_and_etag() {
        use std::io::Write;
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
            .unwrap();
        let mut full = String::from("<?xml version=\"1.0\"?>\n<tv>\n");
        for ch in ["a", "b", "c"] {
            for h in 12..15 {
                full.push_str(&format!(
                    "<programme channel=\"{ch}\" start=\"20261012{h}0000 +0000\" stop=\"20261012{}0000 +0000\"><title>{ch}{h}</title></programme>\n",
                    h + 1
                ));
            }
        }
        full.push_str("</tv>");
        let ingest = |conn: &mut rusqlite::Connection, body: &[u8], tag: &str| {
            let reader = std::io::BufReader::new(body);
            ingest_reader(
                conn,
                "u",
                reader,
                Window::unbounded(),
                Some(&etag(tag)),
                &mut |_, _| {},
            )
        };
        let stored = |conn: &rusqlite::Connection| -> (i64, Option<String>, String) {
            conn.query_row(
                "SELECT (SELECT count(*) FROM epg_programs WHERE epg_url = 'u'), etag, status FROM epg_sources WHERE url = 'u'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };
        assert_eq!(
            ingest(&mut conn, full.as_bytes(), "v1").unwrap().programs,
            9
        );
        assert_eq!(stored(&conn), (9, Some("v1".into()), "ok".into()));

        // Cut cleanly between two programmes, inside a title, inside a tag.
        let cut_at = full.find("<programme channel=\"b\"").unwrap();
        for cut in [cut_at, cut_at + 70, cut_at + 20] {
            let err = ingest(&mut conn, &full.as_bytes()[..cut], "v2").unwrap_err();
            assert!(
                matches!(&err, CoreError::Invalid(m) if m == xmltv::CUT_OFF_MESSAGE),
                "cut at {cut}: {err}"
            );
            assert_eq!(
                stored(&conn),
                (9, Some("v1".into()), "ok".into()),
                "cut at {cut}"
            );
            assert!(
                user_message(&err).contains("cut off"),
                "{}",
                user_message(&err)
            );
        }

        // A gzip stream cut in the middle, through the real reader.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("guide.xml.gz");
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(full.as_bytes()).unwrap();
        let gz = enc.finish().unwrap();
        std::fs::write(&path, &gz[..gz.len() / 2]).unwrap();
        let reader = super::fetch::open_reader(&path).unwrap();
        let err = ingest_reader(
            &mut conn,
            "u",
            reader,
            Window::unbounded(),
            Some(&etag("v3")),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(
            matches!(&err, CoreError::Invalid(m) if m == xmltv::CUT_OFF_MESSAGE),
            "{err}"
        );
        assert_eq!(stored(&conn), (9, Some("v1".into()), "ok".into()));

        // The whole file, with or without a trailing newline, still replaces it.
        let mut with_nl = full.clone();
        with_nl.push_str("\r\n\n");
        assert_eq!(
            ingest(&mut conn, with_nl.as_bytes(), "v4")
                .unwrap()
                .programs,
            9
        );
        assert_eq!(stored(&conn), (9, Some("v4".into()), "ok".into()));
    }

    /// P2-EPGRS-1: programmes are staged in the ingest connection's temp
    /// table, so the main database (and its WAL) sees no commit between
    /// programme batches and holds no staged programme; the swap copies them
    /// in once, a slot the feed repeats keeps its first row, and afterwards
    /// the connection's temp storage is back as it was.
    #[test]
    fn programmes_are_staged_outside_the_main_database() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("t.db")).unwrap();
        {
            let mut c = pool.get().unwrap();
            crate::db::migrate(&mut c).unwrap();
            c.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
                .unwrap();
        }
        let ts = |t: i64| {
            chrono::DateTime::from_timestamp(t, 0)
                .unwrap()
                .format("%Y%m%d%H%M%S +0000")
                .to_string()
        };
        let n = 3 * store::BATCH + 7;
        let mut xml =
            String::from("<tv><channel id=\"c0\"><display-name>C0</display-name></channel>");
        for i in 0..n {
            let start = 1_800_000_000 + (i / 3) as i64 * 60;
            xml.push_str(&format!(
                "<programme channel=\"c{}\" start=\"{}\" stop=\"{}\"><title>T{i}</title></programme>",
                i % 3,
                ts(start),
                ts(start + 60)
            ));
        }
        // A repeat of the first slot, batches later: ignored.
        xml.push_str(&format!(
            "<programme channel=\"c0\" start=\"{}\" stop=\"{}\"><title>Repeat</title></programme></tv>",
            ts(1_800_000_000),
            ts(1_800_000_060)
        ));
        let observer = pool.get().unwrap();
        let read = |sql: &str| -> i64 { observer.query_row(sql, [], |r| r.get(0)).unwrap() };
        // (phase, data version, programme rows) at each progress call.
        let mut seen = Vec::new();
        let mut conn = pool.get().unwrap();
        let temp_store: i64 = conn
            .query_row("PRAGMA temp_store", [], |r| r.get(0))
            .unwrap();
        let stats = ingest_reader(
            &mut conn,
            "u",
            std::io::Cursor::new(xml.into_bytes()),
            Window::unbounded(),
            None,
            &mut |phase, _| {
                seen.push((
                    phase.to_string(),
                    read("PRAGMA data_version"),
                    read("SELECT count(*) FROM epg_programs"),
                ));
            },
        )
        .unwrap();
        // The channel is written with the first batch; nothing after it
        // reaches the main database before the swap.
        let saving = seen.last().unwrap();
        assert_eq!(saving.0, "saving", "{seen:?}");
        assert!(
            seen.iter().all(|s| s.1 == saving.1 && s.2 == 0),
            "the main database changed while programmes were staged: {seen:?}"
        );
        assert_eq!(stats.programs, n as u64);
        assert_eq!(
            read("SELECT count(*) FROM epg_programs WHERE epg_url = 'u'"),
            n as i64
        );
        assert_eq!(
            read("SELECT program_count FROM epg_sources WHERE url = 'u'"),
            n as i64
        );
        let first: String = observer
            .query_row(
                "SELECT title FROM epg_programs WHERE channel_id = 'c0' AND start = 1800000000",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first, "T0");
        let after: i64 = conn
            .query_row("PRAGMA temp_store", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, temp_store);
        let staged: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_temp_master WHERE name = 'epg_stage'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staged, 0);
    }

    /// P2-EPGRS-1: a staging write that fails part-way ends the ingest with
    /// its own error; the stored guide, its ETag and counts stay, and no
    /// staging is left behind (rows under the key, nor the temp table).
    #[test]
    fn a_failed_staging_write_ends_the_ingest_with_its_error() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
            .unwrap();
        let prog = |i: usize| {
            format!(
                "<programme channel=\"c\" start=\"{}\" stop=\"{}\"><title>T{i}</title></programme>",
                20_261_012_000_000u64 + i as u64 * 100,
                20_261_012_000_000u64 + i as u64 * 100 + 1
            )
        };
        let ingest = |conn: &mut rusqlite::Connection, xml: String, tag: &str| {
            ingest_reader(
                conn,
                "u",
                std::io::Cursor::new(xml.into_bytes()),
                Window::unbounded(),
                Some(&etag(tag)),
                &mut |_, _| {},
            )
        };
        let good = format!(
            "<tv><channel id=\"c\"><display-name>C</display-name></channel>{}</tv>",
            prog(0)
        );
        assert_eq!(ingest(&mut conn, good, "v1").unwrap().programs, 1);
        conn.execute_batch(
            "CREATE TRIGGER refuse_bad BEFORE INSERT ON epg_channels WHEN new.channel_id = 'bad'
             BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;",
        )
        .unwrap();
        // The bad channel is written with the fourth programme batch.
        let n = 4 * store::BATCH;
        let mut xml = String::from("<tv>");
        for i in 0..n {
            if i == 3 * store::BATCH + 1 {
                xml.push_str("<channel id=\"bad\"><display-name>Bad</display-name></channel>");
            }
            xml.push_str(&prog(i % 60));
        }
        xml.push_str("</tv>");
        let err = ingest(&mut conn, xml, "v2").unwrap_err();
        assert!(err.to_string().contains("refused by the test"), "{err}");
        let (programs, count, etag): (i64, i64, Option<String>) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM epg_programs), program_count, etag FROM epg_sources WHERE url = 'u'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((programs, count, etag.as_deref()), (1, 1, Some("v1")));
        let staging: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM epg_sources WHERE origin = 'staging')
                      + (SELECT count(*) FROM epg_channels WHERE epg_url <> 'u')
                      + (SELECT count(*) FROM sqlite_temp_master WHERE name = 'epg_stage')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0);
    }

    /// A body is kept only when it is the one the stored guide came from,
    /// that guide has programmes, and it was read less than a day ago.
    #[test]
    fn unchanged_rules() {
        let now = 1_800_000_000;
        let stored = |fp: &str, at: i64| store::StoredValidators {
            fingerprint: Some(fp.into()),
            ingested_at: at,
            ..Default::default()
        };
        let body = |fp: Option<&str>| Validators {
            fingerprint: fp.map(str::to_string),
            ..Default::default()
        };
        let mut guide = row("ok", true, None);
        guide.program_count = 5;
        let day = REINGEST_AFTER.as_secs() as i64;
        assert!(unchanged(
            &guide,
            Some(&stored("a", now - 3600)),
            &body(Some("a")),
            now
        ));
        assert!(!unchanged(
            &guide,
            Some(&stored("a", now - 3600)),
            &body(Some("b")),
            now
        ));
        assert!(!unchanged(
            &guide,
            Some(&stored("a", now - 3600)),
            &body(None),
            now
        ));
        assert!(!unchanged(&guide, None, &body(Some("a")), now));
        assert!(!unchanged(
            &guide,
            Some(&stored("a", now - day)),
            &body(Some("a")),
            now
        ));
        assert!(unchanged(
            &guide,
            Some(&stored("a", now - day + 1)),
            &body(Some("a")),
            now
        ));
        // A clock that went back does not keep a guide forever.
        assert!(!unchanged(
            &guide,
            Some(&stored("a", now + 60)),
            &body(Some("a")),
            now
        ));
        guide.program_count = 0;
        assert!(!unchanged(
            &guide,
            Some(&stored("a", now - 3600)),
            &body(Some("a")),
            now
        ));
    }

    /// The passes right after boot leave urls that already have a guide for
    /// the source startup pass's time, and start those without one.
    #[tokio::test]
    async fn boot_passes_start_only_urls_without_a_guide() {
        assert!(BOOT_DELAY < STORED_BOOT_DELAY);
        assert!(STORED_BOOT_DELAY >= crate::sources::STARTUP_REFRESH_DELAY);
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        let stored = dir.path().join("stored.xml").to_string_lossy().into_owned();
        let empty = dir.path().join("empty.xml").to_string_lossy().into_owned();
        state.settings.write().epg_urls = vec![stored.clone(), empty.clone()];
        let stale = (chrono::Utc::now() - chrono::Duration::hours(13)).to_rfc3339();
        let u = stored.clone();
        state
            .db_call(move |c| {
                c.execute(
                    "INSERT INTO epg_sources(url, status, last_fetch_at, program_count) VALUES (?1, 'ok', ?2, 5)",
                    rusqlite::params![u, stale],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(pass(state.clone(), true).await.unwrap(), [empty]);
        assert_eq!(pass(state.clone(), false).await.unwrap(), [stored]);
        assert!(!held_at_boot(None));
        assert!(!held_at_boot(Some(&row("idle", true, None))));
    }

    /// The channel directory is built before the first guide read: at boot,
    /// and by a refresh that stored data, before it tells clients.
    #[tokio::test]
    async fn the_directory_is_built_ahead_of_reads() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        let rt = runtime(&state);
        let built = |rt: &EpgRuntime| rt.names.lock().as_ref().map(|d| d.generation());
        super::super::spawn_directory_build(&state);
        let started = Instant::now();
        while built(&rt).is_none() && started.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(built(&rt), Some(rt.generation()));

        let now = chrono::Utc::now();
        let ts = |h: i64| (now + chrono::Duration::hours(h)).format("%Y%m%d%H%M%S +0000");
        let path = dir.path().join("guide.xml");
        std::fs::write(
            &path,
            format!(
                r#"<tv><channel id="c"><display-name>C</display-name></channel><programme channel="c" start="{}" stop="{}"><title>T</title></programme></tv>"#,
                ts(0),
                ts(1)
            ),
        )
        .unwrap();
        let before = rt.generation();
        refresh_now(state.clone(), &path.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(rt.generation(), before + 1);
        assert_eq!(built(&rt), Some(rt.generation()));
    }

    #[test]
    fn due_rules() {
        let now = chrono::Utc::now();
        let fresh = (now - chrono::Duration::hours(1)).to_rfc3339();
        let stale = (now - chrono::Duration::hours(13)).to_rfc3339();
        assert!(is_due(None, None, now));
        assert!(is_due(Some(&row("idle", true, None)), None, now));
        assert!(!is_due(Some(&row("idle", false, None)), None, now));
        assert!(!is_due(Some(&row("ok", true, Some(&fresh))), None, now));
        assert!(is_due(Some(&row("ok", true, Some(&stale))), None, now));
        assert!(is_due(Some(&row("error", true, Some(&fresh))), None, now));
        assert!(!is_due(
            Some(&row("error", true, None)),
            Some(Instant::now()),
            now
        ));
    }
}
