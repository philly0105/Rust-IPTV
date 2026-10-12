//! Download manager and My Videos (SPEC C4 `downloads.*` / `myvideos.*`, C3
//! `downloads` table). Design notes: `docs/architecture/downloads.md`.
//!
//! - [`manager`]: FIFO queue runtime in `state.extensions["downloads"]`, at
//!   most two concurrent transfers, per-task stop tokens.
//! - [`transfer`]: streaming GET with source headers, Range resume validated
//!   by ETag/Last-Modified (`resume_validator`), in-task retry with backoff,
//!   throttled `downloads.progress` events.
//! - [`naming`]: Windows-safe names, atomic numbered `.part` reservation,
//!   finalize without overwrite.
//! - [`store`]: SQL for the `downloads` table.

pub mod manager;
pub mod naming;
pub mod rpc;
pub mod store;
pub mod transfer;

use crate::error::{CoreError, CoreResult};
use crate::model::{Download, DownloadStatus, ItemRef, PlayerKind, PlayerSource, RequestHeaders};
use crate::state::AppState;
use manager::{StopReason, Stopped};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use manager::{DownloadManager, MAX_CONCURRENT};

/// Restores the queue: rows left `downloading` by a previous run become
/// `queued`, then every queued row is scheduled in FIFO order.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let (requeued, queued) = state
        .db_call(|c| {
            let n = store::requeue_interrupted(c)?;
            Ok((n, store::ids_with_status(c, DownloadStatus::Queued)?))
        })
        .await?;
    manager::manager(&state);
    if requeued > 0 {
        tracing::info!(requeued, "interrupted downloads re-queued");
    }
    for id in &queued {
        manager::enqueue(&state, *id);
    }
    if !queued.is_empty() {
        notify(&state);
    }
    Ok(())
}

fn notify(state: &AppState) {
    state.emit("downloads.update", serde_json::json!({}));
}

/// Caps each transfer's speed (bytes per second; `None` = unlimited). Takes
/// effect on running transfers at their next chunk. Used by tests to make
/// pause points deterministic; not a C4 command.
pub fn set_rate_limit(state: &AppState, bytes_per_second: Option<u64>) {
    manager::manager(state).set_rate_limit(bytes_per_second);
}

/// Overrides how long pause/cancel/remove wait for a running transfer to stop
/// before answering `Timeout` (`None` = 15 s). Test hook; not a C4 command.
pub fn set_stop_timeout(state: &AppState, timeout: Option<std::time::Duration>) {
    manager::manager(state).set_stop_timeout(timeout);
}

/// Public view of a row: live byte count for running transfers and derived
/// `fileAvailable`.
fn present(state: &AppState, mut d: Download) -> Download {
    if let Some(bytes) = manager::manager(state).live_bytes(d.id) {
        d.bytes_downloaded = bytes;
    }
    store::derive_availability(&mut d);
    d
}

/// Every download, newest first.
pub async fn list(state: &Arc<AppState>) -> CoreResult<Vec<Download>> {
    let rows = state.db_call(|c| store::list(c, false)).await?;
    Ok(rows
        .into_iter()
        .map(|r| present(state, r.download))
        .collect())
}

/// Completed downloads (My Videos), most recently completed first.
pub async fn list_completed(state: &Arc<AppState>) -> CoreResult<Vec<Download>> {
    let rows = state.db_call(|c| store::list(c, true)).await?;
    Ok(rows
        .into_iter()
        .map(|r| present(state, r.download))
        .collect())
}

/// One download.
pub async fn get(state: &Arc<AppState>, id: i64) -> CoreResult<Download> {
    let row = state.db_call(move |c| store::get(c, id)).await?;
    Ok(present(state, row.download))
}

/// `downloads.start` input.
#[derive(Debug, Clone, Default)]
pub struct StartRequest {
    pub item_ref: Option<ItemRef>,
    pub episode_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub url: String,
    pub headers: Option<RequestHeaders>,
    pub poster_url: Option<String>,
    pub file_name_hint: Option<String>,
}

/// Scheme check everywhere; in server mode also the SSRF guard, trusting
/// only the item's source's own `host:port`.
async fn validate_url(state: &AppState, url: &str, source_id: &str) -> CoreResult<()> {
    let parsed = url::Url::parse(url.trim())
        .map_err(|_| CoreError::Invalid("The download URL is not a valid address.".into()))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(CoreError::Invalid(format!(
                "Only http and https downloads are supported (got {other})."
            )))
        }
    }
    if crate::http::is_server_mode(state) {
        let trusted = crate::http::source_authority(state, source_id).await?;
        crate::http::check_fetch(state, url, trusted.as_ref()).await?;
    }
    Ok(())
}

/// Starts (or reuses) the download for an item.
///
/// - queued / downloading / paused rows are returned unchanged;
/// - completed rows whose file still exists are returned unchanged;
/// - failed, canceled, and completed-but-missing rows lose any retained
///   `.part` and restart as a fresh transfer under the same id.
///
/// The destination `.part` is reserved before returning, so two downloads
/// with the same name get `name.ext` and `name (1).ext` deterministically.
pub async fn start(state: &Arc<AppState>, req: StartRequest) -> CoreResult<Download> {
    let item_ref = req
        .item_ref
        .clone()
        .ok_or_else(|| CoreError::Invalid("ref is required".into()))?;
    validate_url(state, &req.url, &item_ref.source_id).await?;
    let title = req.title.trim().to_string();
    if title.is_empty() {
        return Err(CoreError::Invalid("A download needs a title.".into()));
    }
    let dir = state.downloads_dir();
    let headers = req.headers.clone().unwrap_or_default();
    let episode_id = req.episode_id.clone().filter(|e| !e.is_empty());

    let (id, fresh) = state
        .db_call(move |conn| -> CoreResult<(i64, bool)> {
            // One transaction: when reserving the destination fails (disk
            // full, permissions) the row is not left queued with no file.
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let c: &rusqlite::Connection = &tx;
            let new = store::NewDownload {
                item_ref: &item_ref,
                episode_id: episode_id.as_deref(),
                title: &title,
                subtitle: req.subtitle.as_deref(),
                url: req.url.trim(),
                poster_url: req.poster_url.as_deref(),
                headers: &headers,
            };
            let id = match store::find_by_ref(c, &item_ref, episode_id.as_deref())? {
                Some(existing) => {
                    let mut d = existing.download.clone();
                    store::derive_availability(&mut d);
                    let keep = match d.status {
                        DownloadStatus::Queued
                        | DownloadStatus::Downloading
                        | DownloadStatus::Paused => true,
                        DownloadStatus::Completed => d.file_available == Some(true),
                        DownloadStatus::Failed | DownloadStatus::Canceled => false,
                    };
                    if keep {
                        // A queued row the manager does not hold (an earlier
                        // start failed after writing it) is queued again;
                        // enqueue ignores rows it already tracks.
                        return Ok((d.id, d.status == DownloadStatus::Queued));
                    }
                    if d.status != DownloadStatus::Completed {
                        if let Some(p) = d.file_path.as_deref() {
                            naming::remove_regular_file(&naming::part_path(Path::new(p)))?;
                        }
                    }
                    store::reset(c, d.id, &new)?;
                    d.id
                }
                None => store::insert(c, &new)?,
            };
            // Reserve the destination now and persist it before any transfer.
            std::fs::create_dir_all(&dir).map_err(|e| {
                CoreError::Io(std::io::Error::new(
                    e.kind(),
                    format!("cannot create downloads folder {}: {e}", dir.display()),
                ))
            })?;
            let name = naming::build_file_name(
                new.title,
                new.subtitle,
                new.url,
                req.file_name_hint.as_deref(),
            );
            let r = naming::reserve(&dir, &name)?;
            store::set_destination(c, id, &r.file_name, &r.final_path.to_string_lossy())?;
            tx.commit()?;
            Ok((id, true))
        })
        .await?;
    if fresh {
        manager::enqueue(state, id);
        notify(state);
    }
    get(state, id).await
}

fn conflict(d: &Download, action: &str) -> CoreError {
    CoreError::Conflict(format!(
        "Cannot {action} a download that is {}.",
        d.status.as_str()
    ))
}

/// Pauses a queued or running download (keeps the `.part`). Idempotent.
pub async fn pause(state: &Arc<AppState>, id: i64) -> CoreResult<()> {
    let d = get(state, id).await?;
    match d.status {
        DownloadStatus::Paused => return Ok(()),
        DownloadStatus::Queued | DownloadStatus::Downloading => {}
        _ => return Err(conflict(&d, "pause")),
    }
    match manager::manager(state).stop(id, StopReason::Pause) {
        Stopped::Running(rx) => manager::wait_stopped(state, rx).await?,
        Stopped::Dequeued | Stopped::Idle => {
            state
                .db_call(move |c| {
                    store::transition(
                        c,
                        id,
                        &[DownloadStatus::Queued, DownloadStatus::Downloading],
                        DownloadStatus::Paused,
                        None,
                    )
                })
                .await?;
            notify(state);
        }
    }
    Ok(())
}

/// Puts a paused (or failed) download back in the queue; it continues from
/// its `.part` via HTTP Range. Idempotent for queued/running rows.
pub async fn resume(state: &Arc<AppState>, id: i64) -> CoreResult<()> {
    let d = get(state, id).await?;
    match d.status {
        DownloadStatus::Queued | DownloadStatus::Downloading => {
            if d.status == DownloadStatus::Queued {
                manager::enqueue(state, id);
            }
            Ok(())
        }
        DownloadStatus::Paused | DownloadStatus::Failed => requeue(state, id).await,
        _ => Err(conflict(&d, "resume")),
    }
}

/// Retries a failed, canceled, or paused download. A retained `.part`
/// resumes; otherwise the transfer starts from zero. A completed download
/// whose file is gone (deleted, moved, replaced by a non-file) downloads
/// again under the same id and name; its old path is never touched. A
/// completed download whose file is still there is refused.
pub async fn retry(state: &Arc<AppState>, id: i64) -> CoreResult<()> {
    let d = get(state, id).await?;
    match d.status {
        DownloadStatus::Failed | DownloadStatus::Canceled | DownloadStatus::Paused => {
            requeue(state, id).await
        }
        DownloadStatus::Queued | DownloadStatus::Downloading => Ok(()),
        DownloadStatus::Completed if d.file_available == Some(true) => Err(CoreError::Conflict(
            "This download is complete and its file is still in place.".into(),
        )),
        DownloadStatus::Completed => {
            let claimed = state
                .db_call(move |c| store::restart_completed(c, id))
                .await?;
            if claimed {
                tracing::info!(
                    id,
                    "completed download's file is missing; downloading again"
                );
                manager::enqueue(state, id);
                notify(state);
            }
            Ok(())
        }
    }
}

async fn requeue(state: &Arc<AppState>, id: i64) -> CoreResult<()> {
    // Conditional claim: two rapid clicks can never start two transfers.
    let claimed = state
        .db_call(move |c| {
            store::transition(
                c,
                id,
                &[
                    DownloadStatus::Paused,
                    DownloadStatus::Failed,
                    DownloadStatus::Canceled,
                ],
                DownloadStatus::Queued,
                None,
            )
        })
        .await?;
    if claimed {
        manager::enqueue(state, id);
        notify(state);
    }
    Ok(())
}

/// Cancels a download and deletes its `.part`. Completed rows are refused
/// (use remove). Idempotent for canceled rows.
pub async fn cancel(state: &Arc<AppState>, id: i64) -> CoreResult<()> {
    let d = get(state, id).await?;
    match d.status {
        DownloadStatus::Canceled => {
            // Retry a cleanup that failed earlier (locked file).
            cleanup_part(state, &d).await?;
            return Ok(());
        }
        DownloadStatus::Completed => return Err(conflict(&d, "cancel")),
        _ => {}
    }
    if let Stopped::Running(rx) = manager::manager(state).stop(id, StopReason::Cancel) {
        manager::wait_stopped(state, rx).await?;
        return Ok(());
    }
    cleanup_part(state, &d).await?;
    state
        .db_call(move |c| {
            store::clear_destination(c, id)?;
            store::finish(c, id, DownloadStatus::Canceled, 0, None)
        })
        .await?;
    notify(state);
    Ok(())
}

async fn cleanup_part(state: &Arc<AppState>, d: &Download) -> CoreResult<()> {
    let Some(p) = d.file_path.clone() else {
        return Ok(());
    };
    let id = d.id;
    let removed = tokio::task::spawn_blocking(move || {
        naming::remove_regular_file(&naming::part_path(Path::new(&p)))
    })
    .await??;
    if removed {
        state
            .db_call(move |c| store::clear_destination(c, id))
            .await?;
    }
    Ok(())
}

/// Removes a download row. Unfinished rows always lose their `.part`;
/// completed rows delete the media file only when `delete_file` is set. When
/// a file cannot be deleted (locked), the row stays so the user can retry.
pub async fn remove(state: &Arc<AppState>, id: i64, delete_file: bool) -> CoreResult<()> {
    let mut d = get(state, id).await?;
    if let Stopped::Running(rx) = manager::manager(state).stop(id, StopReason::Detach) {
        // On timeout the row and its files stay: deleting them under a
        // still-running task could orphan a recreated `.part`.
        manager::wait_stopped(state, rx).await?;
        d = get(state, id).await?;
    }
    let path = d.file_path.clone();
    let completed = d.status == DownloadStatus::Completed;
    tokio::task::spawn_blocking(move || -> CoreResult<()> {
        if let Some(p) = path.as_deref().map(Path::new) {
            naming::remove_regular_file(&naming::part_path(p))?;
            if completed && delete_file {
                naming::remove_regular_file(p)?;
            }
        }
        Ok(())
    })
    .await??;
    state.db_call(move |c| store::delete(c, id)).await?;
    notify(state);
    Ok(())
}

/// Saves the offline playback position.
pub async fn set_position(state: &Arc<AppState>, id: i64, seconds: i64) -> CoreResult<()> {
    state
        .db_call(move |c| store::set_position(c, id, seconds))
        .await
}

/// Absolute path of a completed download whose file is available. Used by
/// `myvideos.playSource` and by the server's `GET /api/files/{id}`.
pub async fn completed_file(state: &Arc<AppState>, id: i64) -> CoreResult<PathBuf> {
    let d = get(state, id).await?;
    if d.status != DownloadStatus::Completed {
        return Err(CoreError::Conflict(format!(
            "Download {id} has not finished yet."
        )));
    }
    match (d.file_available, d.file_path) {
        (Some(true), Some(p)) => Ok(PathBuf::from(p)),
        _ => Err(CoreError::NotFound(
            "The downloaded file is missing. Download it again from My Videos.".into(),
        )),
    }
}

/// Player source for a completed download: the absolute path on desktop
/// (the UI converts it with `convertFileSrc`), `/api/files/{id}` on the server.
pub async fn play_source(state: &Arc<AppState>, id: i64) -> CoreResult<PlayerSource> {
    let path = completed_file(state, id).await?;
    let d = get(state, id).await?;
    let url = if state.is_desktop {
        path.to_string_lossy().into_owned()
    } else {
        format!("/api/files/{id}")
    };
    Ok(PlayerSource {
        url,
        kind: PlayerKind::File,
        headers: None,
        title: d.title,
        subtitle: d.subtitle,
        poster_url: d.poster_url,
        item_ref: Some(d.item_ref),
        episode_id: d.episode_id,
        resume_seconds: (d.position_seconds > 0).then_some(d.position_seconds),
        is_live: false,
        is_radio: false,
    })
}

/// Effective downloads folder.
pub fn dir(state: &AppState) -> PathBuf {
    state.downloads_dir()
}

/// Why the downloads folder cannot change in server mode.
pub const SERVER_DIR_MESSAGE: &str = "The downloads folder cannot be changed from the browser. Set IPTV_DATA_DIR on the server instead (downloads go to <data dir>/downloads).";

/// Refuses in server mode (the folder is fixed to the data dir). Otherwise
/// validates that `path` is an absolute, existing, writable directory, then
/// stores it as `settings.downloadsDir` through [`crate::settings::save`]
/// (an empty path resets to the default folder inside the data dir).
pub async fn set_dir(state: &Arc<AppState>, path: &str) -> CoreResult<()> {
    if crate::http::is_server_mode(state) {
        return Err(CoreError::Unsupported(SERVER_DIR_MESSAGE.into()));
    }
    let trimmed = path.trim().to_string();
    let value = if trimmed.is_empty() {
        None
    } else {
        let p = PathBuf::from(&trimmed);
        if !p.is_absolute() {
            return Err(CoreError::Invalid(
                "Choose a full folder path (for example C:\\Videos).".into(),
            ));
        }
        let probe_dir = p.clone();
        tokio::task::spawn_blocking(move || check_writable_dir(&probe_dir)).await??;
        Some(trimmed)
    };
    // B2's writer validates, persists, refreshes the cache, and emits
    // `settings.changed` (no write and no event when nothing changed).
    let mut next = state.settings_snapshot();
    next.downloads_dir = value;
    crate::settings::save(state, next).await?;
    Ok(())
}

fn check_writable_dir(p: &Path) -> CoreResult<()> {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(CoreError::Invalid(format!(
                "{} is a file, not a folder.",
                p.display()
            )))
        }
        Err(_) => {
            return Err(CoreError::NotFound(format!(
                "Folder {} does not exist. Create it or choose another.",
                p.display()
            )))
        }
    }
    let probe = p.join(format!(
        ".tsrust-write-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(f) => {
            drop(f);
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(CoreError::Invalid(format!(
            "Folder {} is not writable ({e}). Choose another folder.",
            p.display()
        ))),
    }
}

/// Opens the folder containing the download (selecting the file on Windows).
/// Desktop only.
pub async fn reveal(state: &Arc<AppState>, id: i64) -> CoreResult<()> {
    if !state.is_desktop {
        return Err(CoreError::Unsupported(
            "Showing files in a folder is only available in the desktop app.".into(),
        ));
    }
    let d = get(state, id).await?;
    let target = d.file_path.as_deref().map(PathBuf::from);
    let (dir, select) = match target {
        Some(final_path) => {
            let part = naming::part_path(&final_path);
            let existing = if naming::is_regular_file(&final_path) {
                Some(final_path.clone())
            } else if naming::is_regular_file(&part) {
                Some(part)
            } else {
                None
            };
            let dir = final_path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| state.downloads_dir());
            (dir, existing)
        }
        None => (state.downloads_dir(), None),
    };
    if !dir.is_dir() {
        return Err(CoreError::NotFound(format!(
            "Folder {} no longer exists.",
            dir.display()
        )));
    }
    open_folder(&dir, select.as_deref())
}

fn open_folder(dir: &Path, select: Option<&Path>) -> CoreResult<()> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        match select {
            Some(file) => {
                use std::os::windows::process::CommandExt;
                c.raw_arg(format!("/select,\"{}\"", file.display()));
            }
            None => {
                c.arg(dir);
            }
        }
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        match select {
            Some(file) => c.arg("-R").arg(file),
            None => c.arg(dir),
        };
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let _ = select;
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir);
        c
    };
    cmd.spawn().map(|_| ()).map_err(CoreError::Io)
}
