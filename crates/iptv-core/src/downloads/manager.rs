//! Queue runtime: FIFO queue, at most [`MAX_CONCURRENT`] transfers, per-task
//! stop tokens. Stored in `state.extensions["downloads"]`. The order (running
//! ids, then the queue) is saved in `app_state` so `init` restores it.

use super::store;
use super::transfer::{self, Outcome};
use crate::error::{CoreError, CoreResult};
use crate::model::DownloadStatus;
use crate::state::AppState;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Extension key of the runtime.
pub const EXT_KEY: &str = "downloads";
/// Transfers running at once.
pub const MAX_CONCURRENT: usize = 2;
/// How long an RPC waits for a running transfer to stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts at the `queued -> downloading` claim within one run. The claim
/// waits for the database, which a long import or guide save can hold.
pub const CLAIM_ATTEMPTS: u32 = 3;
/// How long an id whose claims all failed waits before it is queued again.
const CLAIM_RETRY: Duration = Duration::from_secs(30);

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
    /// Start order among running transfers.
    seq: u64,
}

impl TaskCtl {
    fn new(seq: u64) -> Self {
        Self {
            token: CancellationToken::new(),
            reason: Mutex::new(None),
            bytes: AtomicI64::new(0),
            done: tokio::sync::watch::channel(false).0,
            seq,
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
    /// Next [`TaskCtl::seq`].
    started: u64,
}

impl Inner {
    /// Running ids in start order, then the queue: the order `init` restores.
    fn order(&self) -> Vec<i64> {
        let mut running: Vec<(u64, i64)> = self.active.iter().map(|(id, c)| (c.seq, *id)).collect();
        running.sort_unstable();
        running
            .into_iter()
            .map(|(_, id)| id)
            .chain(self.queue.iter().copied())
            .collect()
    }
}

/// The latest queue order, for the task that saves it.
struct OrderTx(tokio::sync::watch::Sender<Vec<i64>>);

impl Default for OrderTx {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(Vec::new()).0)
    }
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
    /// Response-head and body-idle limit override in milliseconds; 0 = the
    /// defaults ([`crate::http::HEADER_TIMEOUT`], [`crate::http::BODY_IDLE_TIMEOUT`]).
    /// Tests only.
    idle_timeout_ms: AtomicU64,
    /// Claims that fail on purpose before a real one runs. Tests only.
    failing_claims: AtomicU32,
    /// [`CLAIM_RETRY`] override in milliseconds; 0 = default. Tests only.
    claim_retry_ms: AtomicU64,
    order: OrderTx,
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

    /// How long a transfer waits for the response head, and for the next
    /// body chunk, before it reconnects.
    pub fn idle_timeouts(&self) -> (Duration, Duration) {
        match self.idle_timeout_ms.load(Ordering::Relaxed) {
            0 => (crate::http::HEADER_TIMEOUT, crate::http::BODY_IDLE_TIMEOUT),
            ms => (Duration::from_millis(ms), Duration::from_millis(ms)),
        }
    }

    /// Overrides both idle limits (`None` = defaults). Used by tests.
    pub fn set_idle_timeout(&self, timeout: Option<Duration>) {
        let ms = timeout.map_or(0, |t| {
            u64::try_from(t.as_millis()).unwrap_or(u64::MAX).max(1)
        });
        self.idle_timeout_ms.store(ms, Ordering::Relaxed);
    }

    /// Makes the next `failures` claims fail and an id whose claims all
    /// failed come back after `retry` instead of [`CLAIM_RETRY`]. Used by
    /// tests.
    pub fn fail_next_claims(&self, failures: u32, retry: Duration) {
        self.failing_claims.store(failures, Ordering::Relaxed);
        let ms = u64::try_from(retry.as_millis()).unwrap_or(u64::MAX).max(1);
        self.claim_retry_ms.store(ms, Ordering::Relaxed);
    }

    fn claim_retry(&self) -> Duration {
        match self.claim_retry_ms.load(Ordering::Relaxed) {
            0 => CLAIM_RETRY,
            ms => Duration::from_millis(ms),
        }
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
            self.publish(&inner);
            return Stopped::Dequeued;
        }
        Stopped::Idle
    }

    /// Hands the current order to the task that saves it (a no-op when it
    /// did not change).
    fn publish(&self, inner: &Inner) {
        let next = inner.order();
        self.order.0.send_if_modified(|saved| {
            let changed = *saved != next;
            if changed {
                *saved = next;
            }
            changed
        });
    }
}

/// Saves the queue order in `app_state` whenever it changes, in its own
/// task: a burst of changes while one write waits for the database ends in
/// one write of the latest order. Ends when the runtime is dropped.
pub fn spawn_order_writer(state: &Arc<AppState>) {
    let mut rx = manager(state).order.0.subscribe();
    let state = Arc::downgrade(state);
    tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            let ids = rx.borrow_and_update().clone();
            let Some(state) = state.upgrade() else {
                return;
            };
            if let Err(err) = state
                .db_call(move |c| store::save_queue_order(c, &ids))
                .await
            {
                tracing::warn!(error = %err, "could not save the download queue order");
            }
        }
    });
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
            mgr.publish(&inner);
        }
    }
    pump(state, &mgr);
}

/// [`enqueue`] at the head of the queue, for a download the user resumes,
/// retries or asks for next: it takes the next free slot instead of waiting
/// behind the rest. An id already queued moves to the front; a running one
/// is left alone.
pub fn enqueue_front(state: &Arc<AppState>, id: i64) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        if !inner.active.contains_key(&id) {
            if let Some(pos) = inner.queue.iter().position(|q| *q == id) {
                inner.queue.remove(pos);
            }
            inner.queue.push_front(id);
            mgr.publish(&inner);
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
            let ctl = Arc::new(TaskCtl::new(inner.started));
            inner.started += 1;
            inner.active.insert(id, ctl.clone());
            mgr.publish(&inner);
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

/// The conditional `queued -> downloading` claim, retried with backoff a
/// few times when the database is busy or briefly unavailable.
async fn claim(state: &Arc<AppState>, mgr: &DownloadManager, id: i64) -> CoreResult<bool> {
    let mut attempt = 0;
    loop {
        let simulated = mgr
            .failing_claims
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
            .is_ok();
        let claimed = if simulated {
            Err(CoreError::Timeout("simulated claim failure".into()))
        } else {
            state
                .db_call(move |c| {
                    store::transition(
                        c,
                        id,
                        &[DownloadStatus::Queued],
                        DownloadStatus::Downloading,
                        None,
                    )
                })
                .await
        };
        match claimed {
            Err(err) if attempt + 1 < CLAIM_ATTEMPTS => {
                tracing::warn!(id, attempt, error = %err, "could not claim download; retrying");
                tokio::time::sleep(crate::http::backoff_delay(attempt)).await;
                attempt += 1;
            }
            other => return other,
        }
    }
}

async fn run_task(state: Arc<AppState>, mgr: Arc<DownloadManager>, id: i64, ctl: Arc<TaskCtl>) {
    let mut retry_later = false;
    match claim(&state, &mgr, id).await {
        Ok(true) => {
            state.emit("downloads.update", serde_json::json!({}));
            // A panic in the transfer must still free the concurrency slot
            // and leave the row in a final state.
            let outcome = match futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(
                transfer::run(&state, id, &ctl, &mgr),
            ))
            .await
            {
                Ok(outcome) => outcome,
                Err(_) => {
                    tracing::error!(id, "download task panicked");
                    Outcome::Failed {
                        message: "The download stopped because of an internal error. Retry it."
                            .into(),
                        bytes: 0,
                        keep_part: true,
                        part: None,
                    }
                }
            };
            persist_outcome(&state, id, outcome).await;
        }
        Ok(false) => tracing::debug!(id, "download no longer queued; skipping"),
        Err(err) => {
            // The row is still `queued` in the database: dropping the id
            // would leave it waiting with no task until the next launch.
            let delay = mgr.claim_retry();
            tracing::error!(id, error = %err, ?delay, "could not claim download; queueing it again later");
            retry_later = !ctl.token.is_cancelled();
        }
    }
    {
        let mut inner = mgr.inner.lock();
        inner.active.remove(&id);
        mgr.publish(&inner);
    }
    ctl.done.send_replace(true);
    state.emit("downloads.update", serde_json::json!({}));
    if retry_later {
        let (state, delay) = (state.clone(), mgr.claim_retry());
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            enqueue_front(&state, id);
        });
    }
    pump(&state, &mgr);
}

/// Attempts at saving a run's outcome before giving up (a busy database).
const PERSIST_ATTEMPTS: u32 = 3;

async fn persist_outcome(state: &Arc<AppState>, id: i64, outcome: Outcome) {
    for attempt in 1..=PERSIST_ATTEMPTS {
        match persist_once(state, id, outcome.clone()).await {
            Ok(()) => return,
            Err(err) => {
                tracing::warn!(id, attempt, error = %err, "could not persist download outcome");
                tokio::time::sleep(Duration::from_millis(200 * u64::from(attempt))).await;
            }
        }
    }
    // Never leave the row `downloading` with no task behind it: resume and
    // retry treat that status as running and would do nothing.
    let fallback = state
        .db_call(move |c| {
            store::finish(
                c,
                id,
                DownloadStatus::Failed,
                0,
                Some("The download state could not be saved. Retry the download."),
            )
        })
        .await;
    if let Err(err) = fallback {
        tracing::error!(id, error = %err, "could not persist download outcome");
    }
}

async fn persist_once(state: &Arc<AppState>, id: i64, outcome: Outcome) -> CoreResult<()> {
    state
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
        .await
}
