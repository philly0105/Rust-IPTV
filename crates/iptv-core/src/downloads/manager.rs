//! Queue runtime: FIFO queue, at most [`MAX_CONCURRENT`] transfers, per-task
//! stop tokens. Stored in `state.extensions["downloads"]`.

use super::store;
use super::transfer::{self, Outcome};
use crate::error::{CoreError, CoreResult};
use crate::model::DownloadStatus;
use crate::state::AppState;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Extension key of the runtime.
pub const EXT_KEY: &str = "downloads";
/// Transfers running at once.
pub const MAX_CONCURRENT: usize = 2;
/// How long an RPC waits for a running transfer to stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a running transfer was asked to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Keep the `.part`, status `paused`.
    Pause,
    /// Delete the `.part`, status `canceled`.
    Cancel,
    /// Row is about to be removed: keep everything, the caller cleans up.
    Detach,
}

/// Control block of one running transfer.
pub struct TaskCtl {
    pub token: CancellationToken,
    reason: Mutex<Option<StopReason>>,
    /// Live byte count (the DB is written every few seconds only).
    pub bytes: AtomicI64,
    done: tokio::sync::watch::Sender<bool>,
}

impl TaskCtl {
    fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            reason: Mutex::new(None),
            bytes: AtomicI64::new(0),
            done: tokio::sync::watch::channel(false).0,
        }
    }

    /// Reason recorded by the first stop request.
    pub fn reason(&self) -> StopReason {
        self.reason.lock().unwrap_or(StopReason::Pause)
    }
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<i64>,
    active: HashMap<i64, Arc<TaskCtl>>,
}

/// The download queue runtime.
#[derive(Default)]
pub struct DownloadManager {
    inner: Mutex<Inner>,
    /// Bytes per second cap per transfer; 0 = unlimited. Read by running
    /// transfers on every chunk, so changes apply in flight.
    rate_limit: AtomicU64,
    /// Stop wait override in milliseconds; 0 = [`STOP_TIMEOUT`]. Tests only.
    stop_timeout_ms: AtomicU64,
}

/// What a stop request found.
pub enum Stopped {
    /// A running transfer was signalled; await the receiver for completion.
    Running(tokio::sync::watch::Receiver<bool>),
    /// The id was waiting in the queue and has been removed from it.
    Dequeued,
    /// Not known to the runtime.
    Idle,
}

impl DownloadManager {
    /// Bytes-per-second cap applied to each transfer (`None` = unlimited).
    pub fn rate_limit(&self) -> Option<u64> {
        match self.rate_limit.load(Ordering::Relaxed) {
            0 => None,
            n => Some(n),
        }
    }

    pub fn set_rate_limit(&self, bps: Option<u64>) {
        self.rate_limit.store(bps.unwrap_or(0), Ordering::Relaxed);
    }

    /// How long an RPC waits for a running transfer to stop.
    pub fn stop_timeout(&self) -> Duration {
        match self.stop_timeout_ms.load(Ordering::Relaxed) {
            0 => STOP_TIMEOUT,
            ms => Duration::from_millis(ms),
        }
    }

    /// Overrides the stop wait (`None` = default). Used by tests.
    pub fn set_stop_timeout(&self, timeout: Option<Duration>) {
        let ms = timeout.map_or(0, |t| {
            u64::try_from(t.as_millis()).unwrap_or(u64::MAX).max(1)
        });
        self.stop_timeout_ms.store(ms, Ordering::Relaxed);
    }

    /// Live byte count of a running transfer.
    pub fn live_bytes(&self, id: i64) -> Option<i64> {
        self.inner
            .lock()
            .active
            .get(&id)
            .map(|c| c.bytes.load(Ordering::Relaxed))
    }

    /// True while the id is queued in memory or running.
    pub fn is_tracked(&self, id: i64) -> bool {
        let inner = self.inner.lock();
        inner.active.contains_key(&id) || inner.queue.contains(&id)
    }

    /// Stops a running transfer or drops a queued id, atomically. A repeated
    /// request on a transfer that is still winding down (after a `Timeout`)
    /// can escalate the reason: cancel beats remove beats pause, so a cancel
    /// issued after a timed-out pause still ends `canceled`.
    pub fn stop(&self, id: i64, reason: StopReason) -> Stopped {
        let mut inner = self.inner.lock();
        if let Some(ctl) = inner.active.get(&id) {
            {
                let mut current = ctl.reason.lock();
                if current.is_none_or(|c| rank(reason) > rank(c)) {
                    *current = Some(reason);
                }
            }
            ctl.token.cancel();
            return Stopped::Running(ctl.done.subscribe());
        }
        if let Some(pos) = inner.queue.iter().position(|q| *q == id) {
            inner.queue.remove(pos);
            return Stopped::Dequeued;
        }
        Stopped::Idle
    }
}

fn rank(r: StopReason) -> u8 {
    match r {
        StopReason::Pause => 0,
        StopReason::Detach => 1,
        StopReason::Cancel => 2,
    }
}

/// The runtime singleton (created on first use).
pub fn manager(state: &AppState) -> Arc<DownloadManager> {
    state.ext_or_insert_with(EXT_KEY, || Arc::new(DownloadManager::default()))
}

/// Adds `id` to the queue (no duplicates) and starts transfers up to the cap.
pub fn enqueue(state: &Arc<AppState>, id: i64) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        if !inner.active.contains_key(&id) && !inner.queue.contains(&id) {
            inner.queue.push_back(id);
        }
    }
    pump(state, &mgr);
}

fn pump(state: &Arc<AppState>, mgr: &Arc<DownloadManager>) {
    loop {
        let (id, ctl) = {
            let mut inner = mgr.inner.lock();
            if inner.active.len() >= MAX_CONCURRENT {
                return;
            }
            let Some(id) = inner.queue.pop_front() else {
                return;
            };
            let ctl = Arc::new(TaskCtl::new());
            inner.active.insert(id, ctl.clone());
            (id, ctl)
        };
        tokio::spawn(run_task(state.clone(), mgr.clone(), id, ctl));
    }
}

/// Waits until a signalled transfer has persisted its final state. Returns
/// `Timeout` (retryable) when it is still winding down after
/// [`STOP_TIMEOUT`] (for example a disk write stuck on a network share), so
/// the caller does not report a change that has not happened yet. The stop
/// request stays in force; the task applies it as soon as it can, and the
/// row keeps its `downloading` status until then, so calling again either
/// waits once more or finds the final status.
pub async fn wait_stopped(
    state: &AppState,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> CoreResult<()> {
    let limit = manager(state).stop_timeout();
    match tokio::time::timeout(limit, rx.wait_for(|done| *done)).await {
        // A closed channel means the control block is gone, i.e. stopped.
        Ok(_) => Ok(()),
        Err(_) => {
            tracing::warn!("download did not stop within {limit:?}");
            Err(CoreError::Timeout(
                "The download is still stopping. Try again in a moment.".into(),
            ))
        }
    }
}

async fn run_task(state: Arc<AppState>, mgr: Arc<DownloadManager>, id: i64, ctl: Arc<TaskCtl>) {
    let claimed = state
        .db_call(move |c| {
            store::transition(
                c,
                id,
                &[DownloadStatus::Queued],
                DownloadStatus::Downloading,
                None,
            )
        })
        .await;
    match claimed {
        Ok(true) => {
            state.emit("downloads.update", serde_json::json!({}));
            let outcome = transfer::run(&state, id, &ctl, &mgr).await;
            persist_outcome(&state, id, outcome).await;
        }
        Ok(false) => tracing::debug!(id, "download no longer queued; skipping"),
        Err(err) => tracing::error!(id, error = %err, "could not claim download"),
    }
    mgr.inner.lock().active.remove(&id);
    ctl.done.send_replace(true);
    state.emit("downloads.update", serde_json::json!({}));
    pump(&state, &mgr);
}

async fn persist_outcome(state: &Arc<AppState>, id: i64, outcome: Outcome) {
    let result = state
        .db_call(move |c| {
            match outcome {
                Outcome::Completed {
                    file_name,
                    file_path,
                    bytes,
                } => {
                    tracing::info!(id, bytes, "download completed");
                    store::complete(c, id, &file_name, &file_path, bytes)
                }
                Outcome::Stopped {
                    reason,
                    bytes,
                    part,
                } => match reason {
                    StopReason::Pause | StopReason::Detach => {
                        store::finish(c, id, DownloadStatus::Paused, bytes, None)
                    }
                    StopReason::Cancel => {
                        if let Some(part) = part {
                            if let Err(e) = super::naming::remove_regular_file(&part) {
                                // Keep the path so a later cancel/remove can retry the cleanup.
                                tracing::warn!(id, error = %e, "could not delete .part on cancel");
                                return store::finish(c, id, DownloadStatus::Canceled, bytes, None);
                            }
                        }
                        store::clear_destination(c, id)?;
                        store::finish(c, id, DownloadStatus::Canceled, 0, None)
                    }
                },
                Outcome::Failed {
                    message,
                    bytes,
                    keep_part,
                    part,
                } => {
                    tracing::warn!(id, bytes, keep_part, message = %message, "download failed");
                    if !keep_part {
                        if let Some(part) = part {
                            if super::naming::remove_regular_file(&part).is_ok() {
                                store::clear_destination(c, id)?;
                                return store::finish(
                                    c,
                                    id,
                                    DownloadStatus::Failed,
                                    0,
                                    Some(&message),
                                );
                            }
                        }
                    }
                    store::finish(c, id, DownloadStatus::Failed, bytes, Some(&message))
                }
            }
        })
        .await;
    if let Err(err) = result {
        tracing::error!(id, error = %err, "could not persist download outcome");
    }
}
