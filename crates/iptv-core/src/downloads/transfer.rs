//! One transfer: destination preparation, Range resume, streaming to the
//! `.part`, in-task retry with backoff, and the no-overwrite finalize.

use super::manager::{DownloadManager, StopReason, TaskCtl};
use super::naming::{self, Reservation};
use super::segments::{self, Ranges, SegEnd};
use super::store::{self, DownloadRow};
use crate::error::{CoreError, CoreResult};
use crate::http::{apply_source_headers, backoff_delay};
use crate::model::{ContentType, SourceKind, WaitReason};
use crate::state::AppState;
use futures::StreamExt;
use reqwest::header::{
    ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
};
use reqwest::StatusCode;
use rusqlite::OptionalExtension;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

/// Consecutive transient failures (without new bytes) tolerated per run.
pub const MAX_ATTEMPTS: u32 = 5;
/// Minimum spacing of `downloads.progress` events per download (4/s).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// How often byte progress is written to SQLite while transferring.
const PERSIST_INTERVAL: Duration = Duration::from_secs(2);
/// Write buffer size for the `.part` file.
const WRITE_BUFFER: usize = 256 * 1024;
/// Longest single throttle sleep, so a rate-limit change (or lifting it) is
/// noticed quickly even when one chunk is worth seconds at the old rate.
pub(super) const THROTTLE_SLICE: Duration = Duration::from_millis(200);

/// How a run ended.
#[derive(Debug, Clone)]
pub enum Outcome {
    Completed {
        file_name: String,
        file_path: String,
        bytes: i64,
    },
    Stopped {
        reason: StopReason,
        bytes: i64,
        part: Option<PathBuf>,
    },
    Failed {
        message: String,
        bytes: i64,
        keep_part: bool,
        part: Option<PathBuf>,
    },
    /// The source refused or was unreachable, not this file: the row goes
    /// back to the queue and its source waits (see `manager::settle`).
    /// `message` is what the row says if it waits too long and fails.
    Requeue {
        reason: WaitReason,
        message: String,
        bytes: i64,
        /// The run wrote bytes the row did not have.
        progressed: bool,
        part: Option<PathBuf>,
    },
}

/// Destination of a run.
struct Dest {
    file_name: String,
    final_path: PathBuf,
    part_path: PathBuf,
}

/// End of one HTTP attempt.
enum AttemptEnd {
    Done(i64),
    Stopped(i64),
    Error {
        err: CoreError,
        /// Offset the attempt started writing at.
        start: i64,
        bytes: i64,
        discard: bool,
    },
}

/// Runs the transfer for `id` until it completes, stops, or fails.
pub async fn run(state: &Arc<AppState>, id: i64, ctl: &TaskCtl, mgr: &DownloadManager) -> Outcome {
    let mut row = match state.db_call(move |c| store::get(c, id)).await {
        Ok(r) => r,
        Err(e) => return failed(format!("Download record unavailable: {e}"), 0, true, None),
    };
    let dest = match prepare_destination(state, &row).await {
        Ok(d) => d,
        Err(e) => {
            return failed(
                format!(
                    "Cannot write to the downloads folder: {e}. Choose another folder in Settings."
                ),
                0,
                true,
                None,
            )
        }
    };
    // Xtream URLs embed credentials that can change and Stalker links expire,
    // so every run (start, resume, retry, restart) resolves a fresh URL.
    let kind = tokio::select! {
        _ = ctl.token.cancelled() => {
            return Outcome::Stopped {
                reason: ctl.reason(),
                bytes: row.download.bytes_downloaded,
                part: Some(dest.part_path.clone()),
            }
        }
        kind = refresh_url(state, &mut row) => kind,
    };
    let mut rep = Representation {
        total: row.download.total_bytes,
        validator: row.resume_validator.clone(),
        one_connection: false,
    };
    let mut failures = 0u32;
    // Highest offset this run has written. An attempt that restarted from
    // zero and re-read bytes it already had made no progress: counting it
    // would let a server that sends a few bytes and then stalls be retried
    // forever.
    let mut reached: Option<i64> = None;
    // What the row had before this run: a run that re-reads it from zero
    // (a file without resume) gets the row no further.
    let had = row.download.bytes_downloaded;
    loop {
        match attempt(state, &row, &dest, ctl, &mut rep, mgr).await {
            AttemptEnd::Done(bytes) => return finalize(&dest, bytes).await,
            AttemptEnd::Stopped(bytes) => {
                return Outcome::Stopped {
                    reason: ctl.reason(),
                    bytes,
                    part: Some(dest.part_path.clone()),
                }
            }
            AttemptEnd::Error {
                err,
                start,
                bytes,
                discard,
            } => {
                let high = reached.unwrap_or(start);
                if bytes > high {
                    failures = 0;
                }
                reached = Some(high.max(bytes));
                failures += 1;
                if err.is_retryable() && !discard && failures < MAX_ATTEMPTS {
                    let delay = backoff_delay(failures - 1);
                    tracing::info!(id, attempt = failures, ?delay, error = %err, "download interrupted; retrying");
                    tokio::select! {
                        _ = ctl.token.cancelled() => {
                            return Outcome::Stopped { reason: ctl.reason(), bytes, part: Some(dest.part_path.clone()) };
                        }
                        _ = tokio::time::sleep(delay) => continue,
                    }
                }
                let wait = if discard {
                    None
                } else {
                    wait_reason(state, mgr, &err, kind, &row.download.item_ref.source_id).await
                };
                if let Some(reason) = wait {
                    tracing::info!(id, ?reason, error = %err, "download waits for its source");
                    return Outcome::Requeue {
                        reason,
                        message: user_message(&err),
                        bytes,
                        progressed: reached.is_some_and(|r| r > had),
                        part: Some(dest.part_path.clone()),
                    };
                }
                let keep = !discard && bytes > 0 && rep.total.is_some();
                return failed(
                    user_message(&err),
                    bytes,
                    keep,
                    Some(dest.part_path.clone()),
                );
            }
        }
    }
}

/// Replaces the row's URL (and headers) with a freshly resolved one for
/// Xtream and Stalker sources and persists it. M3U/file sources, catch-up
/// programmes (live and radio refs), removed sources, and resolution failures
/// keep the stored URL; the transfer then reports whatever the server says
/// about it. Returns the source's kind (`None` when it was removed).
async fn refresh_url(state: &Arc<AppState>, row: &mut DownloadRow) -> Option<SourceKind> {
    let item_ref = row.download.item_ref.clone();
    let episode_id = row.download.episode_id.clone();
    let sid = item_ref.source_id.clone();
    let kind = state
        .db_call(move |c| {
            Ok(
                c.query_row("SELECT kind FROM sources WHERE id = ?1", [&sid], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?,
            )
        })
        .await
        .ok()
        .flatten()
        .and_then(|k| SourceKind::from_str(&k).ok());
    // A catch-up programme's archive URL cannot be rebuilt from its ref: that
    // would resolve the channel's live stream.
    if matches!(
        row.download.item_ref.content_type,
        ContentType::Live | ContentType::Radio
    ) {
        return kind;
    }
    let resolved = match kind {
        Some(SourceKind::Xtream) => {
            crate::xtream::service::stream_url(state, &item_ref, episode_id.as_deref()).await
        }
        Some(SourceKind::Stalker) => {
            crate::stalker::playback::stream_url(state, &item_ref, episode_id.as_deref()).await
        }
        _ => return kind,
    };
    let src = match resolved {
        Ok(src) => src,
        Err(err) => {
            tracing::warn!(id = row.download.id, error = %err, "could not re-resolve download URL; using the stored one");
            return kind;
        }
    };
    if src.url == row.download.url && src.headers.as_ref().is_none_or(|h| *h == row.headers) {
        return kind;
    }
    row.download.url = src.url;
    if let Some(h) = src.headers {
        row.headers = h;
    }
    let (id, url, headers) = (
        row.download.id,
        row.download.url.clone(),
        row.headers.clone(),
    );
    if let Err(err) = state
        .db_call(move |c| store::set_source(c, id, &url, &headers))
        .await
    {
        tracing::warn!(id, error = %err, "could not persist the re-resolved download URL");
    }
    kind
}

/// Whether a run that ended on `err` should wait for its source instead of
/// failing. An unreachable or failing provider (network errors, refused
/// connections and unknown hosts included, timeouts, 429 and 5xx) is an
/// outage, not a broken file: the row waits and its source is tried again
/// later, so an outage costs one probe per step instead of failing the whole
/// queue. An Xtream panel answers 401/403 both for wrong credentials and
/// when every connection is in use, so a refusal there asks the panel for
/// the account (at most once per [`crate::account::FORCE_MIN_AGE`] per
/// source): when the credentials work it was the connection limit, and the
/// row waits for a free connection; when the panel rejects them it fails
/// with the credentials advice as before; when the panel cannot be asked it
/// is an outage. Everything else (404/410, a disk error, a certificate that
/// is not valid, a Content-Range mismatch) fails as before.
async fn wait_reason(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    err: &CoreError,
    kind: Option<SourceKind>,
    source: &str,
) -> Option<WaitReason> {
    match err {
        CoreError::Auth(_) if kind == Some(SourceKind::Xtream) => {
            match credentials_work(state, mgr, source).await {
                Some(true) => Some(WaitReason::Connection),
                Some(false) => None,
                None => Some(WaitReason::Provider),
            }
        }
        CoreError::Network(m) if crate::http::is_certificate_failure(m) => None,
        CoreError::Network(_) | CoreError::Timeout(_) | CoreError::Server(_) => {
            Some(WaitReason::Provider)
        }
        _ => None,
    }
}

/// How long the account check after a refusal may take.
const ACCOUNT_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Asks the Xtream panel for the account: `Some(true)` when the credentials
/// work, `Some(false)` when the panel rejects them, `None` when it could not
/// be asked. A good answer is stored like any account check, so the source's
/// connection limit is fresh too.
async fn credentials_work(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    source: &str,
) -> Option<bool> {
    if let Some(ok) = mgr.recent_check(source) {
        return Some(ok);
    }
    let checked = tokio::time::timeout(
        ACCOUNT_CHECK_TIMEOUT,
        crate::xtream::service::account_info(state, source),
    )
    .await
    .ok()?;
    let ok = match checked {
        Ok(info) => {
            crate::account::remember_xtream(state, source, info).await;
            true
        }
        Err(CoreError::Auth(_)) => false,
        Err(err) => {
            tracing::info!(source, error = %err, "account check after a refused download failed");
            return None;
        }
    };
    mgr.note_check(source, ok);
    Some(ok)
}

fn failed(message: String, bytes: i64, keep_part: bool, part: Option<PathBuf>) -> Outcome {
    Outcome::Failed {
        message,
        bytes,
        keep_part,
        part,
    }
}

/// A non-success answer to the file request, as an error whose kind picks
/// the advice [`user_message`] adds.
pub(super) fn http_status_error(status: reqwest::StatusCode) -> CoreError {
    let code = status.as_u16();
    match code {
        401 | 403 => CoreError::Auth(format!("The provider refused the request (HTTP {code})")),
        404 | 410 => CoreError::NotFound(format!(
            "The provider no longer offers this file (HTTP {code})"
        )),
        408 | 504 => CoreError::Timeout(format!(
            "The provider did not answer in time (HTTP {code}). Check the connection, then retry."
        )),
        429 | 500..=599 => CoreError::Server(format!(
            "The provider could not send the file (HTTP {code})"
        )),
        _ => CoreError::Invalid(format!("The provider answered HTTP {code}")),
    }
}

/// Message stored in `error_message`: names the problem and the next action,
/// once, never the URL.
fn user_message(err: &CoreError) -> String {
    let plain = |m: &str| m.trim().trim_end_matches('.').to_string();
    match err {
        CoreError::Auth(m) => format!("{}. Check the source's credentials, then retry.", plain(m)),
        CoreError::NotFound(m) => format!("{}.", plain(m)),
        // Timeout and network messages already end with what to do.
        CoreError::Timeout(m) | CoreError::Network(m) => m.trim().to_string(),
        CoreError::Server(m) => format!("{}. Retry later.", plain(m)),
        CoreError::Io(e) if e.kind() == std::io::ErrorKind::StorageFull => {
            "The disk is full. Free some space or choose another downloads folder, then retry."
                .to_string()
        }
        CoreError::Io(e) => format!(
            "Disk error: {}. Check the downloads folder, then retry.",
            plain(&e.to_string())
        ),
        CoreError::Invalid(m)
        | CoreError::Conflict(m)
        | CoreError::Unsupported(m)
        | CoreError::EngineMissing(m) => {
            format!("{}. Retry, or start the download again.", plain(m))
        }
        other => format!(
            "{}. Retry, or start the download again.",
            plain(&other.to_string())
        ),
    }
}

/// What the server told us about the file.
struct Representation {
    total: Option<i64>,
    validator: Option<String>,
    /// A segment answer did not match, the provider refused an extra
    /// connection, or the file system cannot leave holes: the rest of this
    /// run uses one connection.
    one_connection: bool,
}

/// Reuses the row's retained `.part`, or reserves a fresh numbered one, and
/// persists `fileName`/`filePath` before any byte is transferred.
async fn prepare_destination(state: &Arc<AppState>, row: &DownloadRow) -> CoreResult<Dest> {
    let d = &row.download;
    let retained = d.file_path.as_deref().map(PathBuf::from);
    let default_dir = state.downloads_dir();
    let requested = d
        .file_name
        .clone()
        .unwrap_or_else(|| naming::build_file_name(&d.title, d.subtitle.as_deref(), &d.url, None));
    let id = d.id;
    let reservation = tokio::task::spawn_blocking(move || -> CoreResult<Reservation> {
        if let Some(final_path) = retained {
            let part = naming::part_path(&final_path);
            let moved_folder = final_path.parent() != Some(default_dir.as_path());
            if moved_folder {
                if let Ok(Some(_)) = naming::regular_file_len(&part) {
                    // The user chose another downloads folder (the advice for
                    // a full disk): continue there. The partial moves along
                    // when it can be renamed (same volume); otherwise the
                    // transfer restarts there and the old partial is deleted
                    // so it stops taking space on the full disk.
                    std::fs::create_dir_all(&default_dir)?;
                    let fresh = naming::reserve(&default_dir, &requested)?;
                    if std::fs::rename(&part, &fresh.part_path).is_err() {
                        if let Err(e) = segments::remove_part(&part) {
                            tracing::warn!(id, error = %e, "could not delete the old partial download");
                        }
                    } else if segments::ranges_path(&part).is_file() {
                        // A split partial needs its sidecar; without it the
                        // moved one starts over.
                        if std::fs::rename(
                            segments::ranges_path(&part),
                            segments::ranges_path(&fresh.part_path),
                        )
                        .is_err()
                        {
                            std::fs::OpenOptions::new()
                                .write(true)
                                .truncate(true)
                                .open(&fresh.part_path)?;
                            segments::remove(&part);
                        }
                    }
                    return Ok(fresh);
                }
            }
            if let Ok(Some(_)) = naming::regular_file_len(&part) {
                let file_name = final_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(requested);
                return Ok(Reservation {
                    file_name,
                    final_path,
                    part_path: part,
                });
            }
            // The retained partial is gone (or replaced by something that is
            // not ours): reserve again in the same folder, never touching it.
            let dir = final_path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or(default_dir);
            std::fs::create_dir_all(&dir)?;
            return Ok(naming::reserve(&dir, &requested)?);
        }
        std::fs::create_dir_all(&default_dir)?;
        Ok(naming::reserve(&default_dir, &requested)?)
    })
    .await??;
    let (name, path) = (
        reservation.file_name.clone(),
        reservation.final_path.to_string_lossy().into_owned(),
    );
    // `start` already stored the destination it reserved, so a fresh run
    // usually has nothing to write here.
    if d.file_name.as_deref() != Some(name.as_str())
        || d.file_path.as_deref() != Some(path.as_str())
    {
        state
            .db_call(move |c| store::set_destination(c, id, &name, &path))
            .await?;
    }
    Ok(Dest {
        file_name: reservation.file_name,
        final_path: reservation.final_path,
        part_path: reservation.part_path,
    })
}

/// `bytes 100-199/2000` -> (100, Some(2000)); `/*` -> None total.
pub(super) fn parse_content_range(v: &str) -> Option<(i64, Option<i64>)> {
    let rest = v.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let (start, _end) = range.split_once('-')?;
    let start = start.trim().parse().ok()?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse().ok()?),
    };
    Some((start, total))
}

fn header_str(resp: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Strong ETag, else Last-Modified.
fn validator_of(resp: &reqwest::Response) -> Option<String> {
    header_str(resp, ETAG)
        .filter(|e| !e.starts_with("W/"))
        .or_else(|| header_str(resp, LAST_MODIFIED))
}

async fn attempt(
    state: &Arc<AppState>,
    row: &DownloadRow,
    dest: &Dest,
    ctl: &TaskCtl,
    rep: &mut Representation,
    mgr: &DownloadManager,
) -> AttemptEnd {
    let id = row.download.id;
    let error = |err: CoreError, start: i64, bytes: i64| AttemptEnd::Error {
        err,
        start,
        bytes,
        discard: false,
    };

    // A sidecar means the `.part` was written in segments: its length says
    // nothing, and each segment resumes where it got to.
    let part = dest.part_path.clone();
    let sidecar = tokio::task::spawn_blocking(move || segments::load(&part))
        .await
        .unwrap_or(segments::Sidecar::Invalid);
    match sidecar {
        segments::Sidecar::None => {}
        segments::Sidecar::Valid(ranges)
            if Some(ranges.total) == rep.total
                && rep.validator.as_deref() == Some(&ranges.validator) =>
        {
            return segmented(state, row, dest, ctl, mgr, rep, ranges, None).await;
        }
        // Not this file's layout, or not one the `.part` holds: start over.
        _ => {
            let part = dest.part_path.clone();
            let cleared = tokio::task::spawn_blocking(move || {
                std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&part)?;
                // Only once the `.part` is empty: with holes and no
                // sidecar, its length would be taken for what it holds.
                segments::remove(&part);
                Ok::<_, std::io::Error>(())
            })
            .await;
            if let Ok(Err(e)) | Err(e) = cleared.map_err(std::io::Error::other) {
                return error(CoreError::Io(e), 0, 0);
            }
            rep.total = None;
            rep.validator = None;
        }
    }
    let existing = match naming::regular_file_len(&dest.part_path) {
        Ok(len) => len.unwrap_or(0) as i64,
        Err(e) => return error(CoreError::Io(e), 0, 0),
    };
    // A partial is resumable only with evidence about the representation.
    let resume_from = if existing > 0 && (rep.validator.is_some() || rep.total.is_some()) {
        existing
    } else {
        0
    };
    if resume_from > 0 && rep.total == Some(resume_from) {
        return AttemptEnd::Done(resume_from);
    }
    ctl.bytes.store(resume_from, Ordering::Relaxed);

    // `identity`: byte ranges and Content-Length must describe the file itself,
    // and a manual Accept-Encoding also turns off reqwest's transparent decoding.
    let url = &row.download.url;
    let client = crate::http::source_client(state, &row.download.item_ref.source_id, url).await;
    let mut req =
        apply_source_headers(client.get(url), &row.headers).header(ACCEPT_ENCODING, "identity");
    // A file may go over several connections: a fresh start asks for a range
    // too, since only a `206` with a total and a validator shows it can.
    let source = row.download.item_ref.source_id.as_str();
    let splittable = may_split(state, source, mgr, rep.one_connection);
    let ranged = resume_from > 0 || splittable;
    if resume_from > 0 {
        req = req.header(RANGE, format!("bytes={resume_from}-"));
        if let Some(v) = &rep.validator {
            req = req.header(IF_RANGE, v.as_str());
        }
    } else if splittable {
        req = req.header(RANGE, "bytes=0-");
    }
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "the server".into());
    // A panel that accepts the connection and never answers, or stops in the
    // middle of the body, costs one idle limit and a reconnect with Range
    // instead of the shared client's 60 s read timeout.
    let (head_limit, idle_limit) = mgr.idle_timeouts();
    let resp = tokio::select! {
        _ = ctl.token.cancelled() => return AttemptEnd::Stopped(resume_from),
        // send_within names the host, and a redirect the server-mode guard
        // blocked is `invalid` (not retried), not a network failure.
        r = crate::http::send_within(req, head_limit) => match r {
            Ok(r) => r,
            Err(e) => return error(e, resume_from, resume_from),
        },
    };

    let status = resp.status();
    let mut offset: i64;
    if status == StatusCode::PARTIAL_CONTENT && ranged {
        let Some((start, total)) = header_str(&resp, CONTENT_RANGE)
            .as_deref()
            .and_then(parse_content_range)
        else {
            return AttemptEnd::Error {
                err: CoreError::Invalid("server sent an unreadable Content-Range".into()),
                start: resume_from,
                bytes: resume_from,
                discard: true,
            };
        };
        if start != resume_from {
            return AttemptEnd::Error {
                err: CoreError::Invalid(format!(
                    "server resumed at byte {start} instead of {resume_from}"
                )),
                start: resume_from,
                bytes: resume_from,
                discard: true,
            };
        }
        if resume_from == 0 {
            // A fresh start: whatever the row knew described another answer.
            rep.total = None;
            rep.validator = None;
        }
        if let (Some(known), Some(t)) = (rep.total, total) {
            if known != t {
                return AttemptEnd::Error {
                    err: CoreError::Invalid(
                        "the remote file changed since the download started".into(),
                    ),
                    start: resume_from,
                    bytes: resume_from,
                    discard: true,
                };
            }
        }
        if rep.total.is_none() {
            rep.total = total;
        }
        if let Some(v) = validator_of(&resp) {
            rep.validator = Some(v);
        }
        offset = resume_from;
    } else if status == StatusCode::RANGE_NOT_SATISFIABLE && resume_from > 0 {
        // Our partial does not fit the remote file: restart from zero.
        if let Err(e) = truncate(&dest.part_path).await {
            return error(CoreError::Io(e), resume_from, resume_from);
        }
        let part = dest.part_path.clone();
        let _ = tokio::task::spawn_blocking(move || segments::remove(&part)).await;
        rep.total = None;
        rep.validator = None;
        return error(
            CoreError::Network("server rejected the resume range; restarting".into()),
            0,
            0,
        );
    } else if status.is_success() {
        // Full body (fresh start, server ignored Range, or If-Range saw a change).
        offset = 0;
        rep.total = resp
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|n| *n > 0);
        rep.validator = validator_of(&resp);
    } else {
        return error(http_status_error(status), resume_from, resume_from);
    }

    let (total, validator) = (rep.total, rep.validator.clone());
    if let Err(e) = state
        .db_call(move |c| store::set_representation(c, id, total, validator.as_deref()))
        .await
    {
        tracing::warn!(id, error = %e, "could not record download size");
    }

    // Over several connections when the answer allows it and the source has
    // spare ones now; otherwise a check every second hands this stream over
    // when they free up (the rest of a season finished, playback stopped).
    let split_total = rep
        .total
        .filter(|_| splittable && status == StatusCode::PARTIAL_CONTENT && rep.validator.is_some());
    let worth_splitting =
        |offset: i64| split_total.is_some_and(|t| t - offset >= 2 * segments::MIN_SEGMENT);
    if worth_splitting(offset) && mgr.connection_allowance(ctl) >= 2 {
        if sparse(mgr, dest).await {
            let ranges = Ranges::new(
                rep.total.unwrap_or(0),
                rep.validator.clone().unwrap_or_default(),
                offset,
            );
            let first = Some((resp.bytes_stream().boxed(), offset));
            return segmented(state, row, dest, ctl, mgr, rep, ranges, first).await;
        }
        // The file system cannot leave holes: the rest of the run keeps
        // one connection and stops asking.
        rep.one_connection = true;
    }

    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&dest.part_path)
        .await;
    let file = match file {
        Ok(f) => f,
        Err(e) => return error(CoreError::Io(e), offset, offset),
    };
    let mut out = tokio::io::BufWriter::with_capacity(WRITE_BUFFER, file);
    let started_at = offset;
    let mut progress = Progress::new(offset);
    let mut stream = resp.bytes_stream().boxed();
    let mut pace = Pace::new(mgr.rate_limit(), offset);
    let mut split_checked = Instant::now();
    let mut hand_over = false;

    let end = loop {
        // The idle timer starts after throttle(), so a rate cap never trips it.
        let next = tokio::select! {
            biased;
            _ = ctl.token.cancelled() => break None,
            n = tokio::time::timeout(idle_limit, stream.next()) => match n {
                Ok(n) => n,
                Err(_) => break Some(Err(CoreError::Timeout(format!(
                    "{host} stopped sending data in the middle of the download (nothing for {} s). Check that the server is online, then try again.",
                    idle_limit.as_secs()
                )))),
            },
        };
        match next {
            Some(Ok(chunk)) => {
                if let Err(e) = out.write_all(&chunk).await {
                    break Some(Err(CoreError::Io(e)));
                }
                offset += chunk.len() as i64;
                ctl.bytes.store(offset, Ordering::Relaxed);
                progress.tick(state, id, offset, rep.total);
                if throttle(&mut pace, mgr, ctl, offset).await {
                    break None;
                }
                if worth_splitting(offset) && split_checked.elapsed() >= SPLIT_CHECK {
                    split_checked = Instant::now();
                    if may_split(state, source, mgr, rep.one_connection)
                        && mgr.connection_allowance(ctl) >= 2
                    {
                        // Asked before the stream is let go: a file system
                        // that cannot leave holes keeps it.
                        if sparse(mgr, dest).await {
                            hand_over = true;
                            break None;
                        }
                        rep.one_connection = true;
                    }
                }
            }
            Some(Err(e)) => break Some(Err(CoreError::from(e))),
            None => break Some(Ok(())),
        }
    };

    // The connection closes before the bookkeeping below, unless it is
    // handed over: the flush, the sync and the progress write can take
    // seconds (an import holding the write lock), and playback waiting for
    // this connection gives up after two.
    let stream = if hand_over {
        Some(stream)
    } else {
        drop(stream);
        None
    };
    let flushed = async {
        out.flush().await?;
        out.get_ref().sync_data().await
    }
    .await;
    drop(out);
    // The last periodic write lands first, so it never overwrites this one.
    if let Some(write) = progress.persisting.take() {
        let _ = write.await;
    }
    let persist = state
        .db_call(move |c| store::set_progress(c, id, offset))
        .await;
    if let Err(e) = persist {
        tracing::warn!(id, error = %e, "could not persist download progress");
    }
    if let Err(e) = flushed {
        return error(CoreError::Io(e), started_at, offset);
    }
    if let Some(stream) = stream {
        let ranges = Ranges::new(
            rep.total.unwrap_or(0),
            rep.validator.clone().unwrap_or_default(),
            offset,
        );
        return segmented(
            state,
            row,
            dest,
            ctl,
            mgr,
            rep,
            ranges,
            Some((stream, offset)),
        )
        .await;
    }
    match end {
        None => AttemptEnd::Stopped(offset),
        Some(Err(e)) => error(e, started_at, offset),
        Some(Ok(())) => match rep.total {
            Some(t) if offset < t => error(
                CoreError::Network("Transfer ended before the advertised size".into()),
                started_at,
                offset,
            ),
            _ => AttemptEnd::Done(offset),
        },
    }
}

/// How often a single-connection transfer checks whether it may split.
const SPLIT_CHECK: Duration = Duration::from_secs(1);

/// Whether a transfer from `source` may go over several connections now:
/// the source's "Connections per download" is Auto, no speed cap is set (it
/// paces one stream), and nothing in this run asked for one connection
/// (`one_connection`: a segment answer that did not match, a refused extra
/// connection, a file system that cannot leave holes). Read again while
/// the transfer runs, so a change applies to a transfer already split.
pub(super) fn may_split(
    state: &AppState,
    source: &str,
    mgr: &DownloadManager,
    one_connection: bool,
) -> bool {
    !one_connection
        && mgr.rate_limit().is_none()
        && !state
            .settings
            .read()
            .download_single_connection
            .iter()
            .any(|s| s == source)
}

/// Lets the `.part` take writes far past its end without filling the gap
/// first (see [`segments::make_sparse`]).
async fn sparse(mgr: &DownloadManager, dest: &Dest) -> bool {
    if mgr.no_holes() {
        return false;
    }
    let part = dest.part_path.clone();
    tokio::task::spawn_blocking(move || segments::make_sparse(&part))
        .await
        .unwrap_or(false)
}

/// Runs `ranges` over several connections and maps the end to the
/// attempt's. `first` is the open answer of the attempt, if any.
#[allow(clippy::too_many_arguments)]
async fn segmented(
    state: &Arc<AppState>,
    row: &DownloadRow,
    dest: &Dest,
    ctl: &TaskCtl,
    mgr: &DownloadManager,
    rep: &mut Representation,
    ranges: Ranges,
    first: Option<(
        futures::stream::BoxStream<'static, reqwest::Result<bytes::Bytes>>,
        i64,
    )>,
) -> AttemptEnd {
    let id = row.download.id;
    let start = ranges.done();
    let url = row.download.url.clone();
    let host = url::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "the server".into());
    let (head_limit, idle_limit) = mgr.idle_timeouts();
    let one_connection = AtomicBool::new(rep.one_connection);
    let job = segments::Job {
        id,
        client: crate::http::source_client(state, &row.download.item_ref.source_id, &url).await,
        url,
        headers: row.headers.clone(),
        part: dest.part_path.clone(),
        ctl,
        mgr,
        head_limit,
        idle_limit,
        host,
        state,
        one_connection: &one_connection,
    };
    let mut progress = Progress::new(start);
    let end = segments::run(job, ranges, first, |done, total| {
        progress.tick(state, id, done, Some(total))
    })
    .await;
    rep.one_connection = one_connection.load(Ordering::Relaxed);
    // The last periodic write lands first, so it never overwrites this one.
    if let Some(write) = progress.persisting.take() {
        let _ = write.await;
    }
    let bytes = match &end {
        SegEnd::Done(b) | SegEnd::Stopped(b) | SegEnd::Error { bytes: b, .. } => *b,
        SegEnd::Changed => 0,
    };
    if let Err(e) = state
        .db_call(move |c| store::set_progress(c, id, bytes))
        .await
    {
        tracing::warn!(id, error = %e, "could not persist download progress");
    }
    match end {
        SegEnd::Done(total) => AttemptEnd::Done(total),
        SegEnd::Stopped(bytes) => AttemptEnd::Stopped(bytes),
        SegEnd::Error { err, bytes } => AttemptEnd::Error {
            err,
            start,
            bytes,
            discard: false,
        },
        SegEnd::Changed => {
            rep.total = None;
            rep.validator = None;
            rep.one_connection = true;
            AttemptEnd::Error {
                err: CoreError::Network(
                    "The server stopped answering byte ranges of this file; it starts over with one connection.".into(),
                ),
                start,
                bytes: 0,
                discard: false,
            }
        }
    }
}

/// Per-attempt speed pacing against the manager's live rate limit. The
/// baseline restarts whenever the limit changes, so a new cap neither
/// "repays" bytes sent at the old rate nor bursts to catch up.
#[derive(Debug)]
pub(super) struct Pace {
    limit: Option<u64>,
    base_bytes: i64,
    base_time: Instant,
}

impl Pace {
    pub(super) fn new(limit: Option<u64>, offset: i64) -> Self {
        Self {
            limit,
            base_bytes: offset,
            base_time: Instant::now(),
        }
    }

    /// How long to wait before reading past `offset` under `limit`.
    pub(super) fn delay(
        &mut self,
        limit: Option<u64>,
        offset: i64,
        now: Instant,
    ) -> Option<Duration> {
        if limit != self.limit {
            *self = Self {
                limit,
                base_bytes: offset,
                base_time: now,
            };
            return None;
        }
        let bps = self.limit.filter(|b| *b > 0)?;
        let due = Duration::from_secs_f64((offset - self.base_bytes).max(0) as f64 / bps as f64);
        due.checked_sub(now.saturating_duration_since(self.base_time))
            .filter(|d| !d.is_zero())
    }
}

/// Sleeps as the rate limit requires, re-reading it every
/// [`THROTTLE_SLICE`]. Returns true when the transfer was asked to stop.
async fn throttle(pace: &mut Pace, mgr: &DownloadManager, ctl: &TaskCtl, offset: i64) -> bool {
    while let Some(wait) = pace.delay(mgr.rate_limit(), offset, Instant::now()) {
        tokio::select! {
            biased;
            _ = ctl.token.cancelled() => return true,
            _ = tokio::time::sleep(wait.min(THROTTLE_SLICE)) => {}
        }
    }
    false
}

async fn truncate(p: &Path) -> std::io::Result<()> {
    tokio::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(p)
        .await
        .map(|_| ())
}

async fn finalize(dest: &Dest, bytes: i64) -> Outcome {
    let (part, final_path) = (dest.part_path.clone(), dest.final_path.clone());
    let moved = tokio::task::spawn_blocking(move || naming::finalize(&part, &final_path)).await;
    match moved {
        Ok(Ok(path)) => {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| dest.file_name.clone());
            if path != dest.final_path {
                tracing::info!("download destination was occupied; saved under a numbered name");
            }
            Outcome::Completed {
                file_name,
                file_path: path.to_string_lossy().into_owned(),
                bytes,
            }
        }
        Ok(Err(e)) => failed(
            format!("Could not move the finished file into place: {e}. Retry to finish without downloading again."),
            bytes,
            true,
            Some(dest.part_path.clone()),
        ),
        Err(e) => failed(format!("Finalize task failed: {e}"), bytes, true, Some(dest.part_path.clone())),
    }
}

/// `downloads.progress` payload (C1).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    id: i64,
    bytes_downloaded: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<i64>,
    bytes_per_second: i64,
}

/// Throttled `downloads.progress` emitter plus periodic DB persistence.
struct Progress {
    last_emit: Option<Instant>,
    last_bytes: i64,
    window_start: Instant,
    last_persist: Instant,
    /// The periodic progress write in flight. The copy loop never waits for
    /// it (an import may hold the write lock for seconds, DB-1); while one
    /// is in flight the next is skipped.
    persisting: Option<tokio::task::JoinHandle<()>>,
}

impl Progress {
    fn new(bytes: i64) -> Self {
        let now = Instant::now();
        Self {
            last_emit: None,
            last_bytes: bytes,
            window_start: now,
            last_persist: now,
            persisting: None,
        }
    }

    fn tick(&mut self, state: &Arc<AppState>, id: i64, bytes: i64, total: Option<i64>) {
        let now = Instant::now();
        if self
            .last_emit
            .is_none_or(|t| now.duration_since(t) >= PROGRESS_INTERVAL)
        {
            let secs = now
                .duration_since(self.window_start)
                .as_secs_f64()
                .max(0.001);
            let bps = ((bytes - self.last_bytes) as f64 / secs).round() as i64;
            state.emit(
                "downloads.progress",
                ProgressEvent {
                    id,
                    bytes_downloaded: bytes,
                    total_bytes: total,
                    bytes_per_second: bps.max(0),
                },
            );
            self.last_emit = Some(now);
            self.last_bytes = bytes;
            self.window_start = now;
        }
        if now.duration_since(self.last_persist) >= PERSIST_INTERVAL
            && self.persisting.as_ref().is_none_or(|w| w.is_finished())
        {
            self.last_persist = now;
            let state = Arc::clone(state);
            self.persisting = Some(tokio::spawn(async move {
                if let Err(e) = state
                    .db_background(move |c| store::set_progress(c, id, bytes))
                    .await
                {
                    tracing::warn!(id, error = %e, "could not persist download progress");
                }
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_messages_name_the_problem_and_one_next_step() {
        use reqwest::StatusCode as S;
        let msg = |s: S| user_message(&http_status_error(s));
        assert_eq!(
            msg(S::NOT_FOUND),
            "The provider no longer offers this file (HTTP 404)."
        );
        for s in [
            S::NOT_FOUND,
            S::FORBIDDEN,
            S::GATEWAY_TIMEOUT,
            S::SERVICE_UNAVAILABLE,
            S::IM_A_TEAPOT,
        ] {
            let m = msg(s);
            assert!(!m.starts_with("download"), "{m}");
            assert!(!m.contains(".."), "{m}");
            assert!(m.ends_with('.'), "{m}");
            assert!(
                m.matches("retry").count() + m.matches("Retry").count() <= 1,
                "{m}"
            );
        }
        let full = user_message(&CoreError::Io(std::io::ErrorKind::StorageFull.into()));
        assert!(full.starts_with("The disk is full."), "{full}");
        let net = user_message(&CoreError::Network(
            "Could not reach x. Check the connection, then retry.".into(),
        ));
        assert_eq!(net.matches("retry").count(), 1, "{net}");
    }

    #[test]
    fn parses_content_range() {
        assert_eq!(
            parse_content_range("bytes 100-199/2000"),
            Some((100, Some(2000)))
        );
        assert_eq!(parse_content_range("bytes 5-9/*"), Some((5, None)));
        assert_eq!(parse_content_range("items 1-2/3"), None);
        assert_eq!(parse_content_range("bytes x-9/10"), None);
    }

    #[test]
    fn pace_follows_live_limit_changes() {
        let t0 = Instant::now();
        let mut p = Pace::new(Some(1000), 0);
        p.base_time = t0;
        // 500 bytes at 1000 B/s are due at 0.5 s.
        assert_eq!(
            p.delay(Some(1000), 500, t0),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            p.delay(Some(1000), 500, t0 + Duration::from_millis(200)),
            Some(Duration::from_millis(300))
        );
        assert_eq!(p.delay(Some(1000), 500, t0 + Duration::from_secs(1)), None);
        // Lifting the limit mid-transfer: no wait from then on.
        assert_eq!(p.delay(None, 600, t0), None);
        assert_eq!(p.delay(None, 10_000_000, t0), None);
        // A new limit starts its own baseline at the current offset.
        let t1 = t0 + Duration::from_secs(5);
        assert_eq!(p.delay(Some(100), 10_000_000, t1), None);
        assert_eq!(
            p.delay(Some(100), 10_000_050, t1),
            Some(Duration::from_millis(500))
        );
        // Zero means unlimited too.
        let mut z = Pace::new(Some(0), 0);
        assert_eq!(z.delay(Some(0), 1 << 30, t0), None);
    }

    /// DB-1R: the periodic progress write passes `AppState::db_background`'s
    /// gate, so while another background write holds it (one parked on an
    /// import's write lock) this one waits there instead of on a connection.
    #[tokio::test]
    async fn periodic_progress_waits_at_the_background_gate() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        let id = state
            .db_call(|c| {
                c.execute(
                    "INSERT INTO downloads (source_id, content_type, item_id, title, url)
                     VALUES ('s1', 'movie', 'm1', 'M', 'http://127.0.0.1/m.mp4')",
                    [],
                )?;
                Ok(c.last_insert_rowid())
            })
            .await
            .unwrap();
        let held = state.background_gate().acquire_owned().await.unwrap();
        let mut p = Progress::new(0);
        p.last_persist = Instant::now().checked_sub(PERSIST_INTERVAL).unwrap();
        p.tick(&state, id, 5_000, None);
        let write = p.persisting.take().expect("the write is due");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!write.is_finished(), "the write waits at the gate");
        drop(held);
        write.await.unwrap();
        let saved: i64 = state
            .db_call(move |c| {
                Ok(c.query_row(
                    "SELECT bytes_downloaded FROM downloads WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(saved, 5_000);
    }
}
