//! Queue runtime: the queue, per-source connection budgets, per-task stop
//! tokens. Stored in `state.extensions["downloads"]`. The order (running ids,
//! then the queue) is saved in `app_state` so `init` restores it.
//!
//! Each source gets a connection budget ([`download_budget`]): its account's
//! limit minus one connection kept for playback, never more than playback
//! and recordings on that source leave, and [`MAX_CONCURRENT`] when the
//! account reports no limit. The core learns what plays from the players
//! (`downloads.playback`, a lease each player renews), from the media proxy
//! ([`open_stream`]) and from recordings ([`hold_recording`]). When playback
//! needs a connection a download holds, the newest download from that source
//! yields: it stops like a pause, keeps its `.part`, and waits at the front
//! of the queue until the connection is free again.
//!
//! A transfer may hold connections on several sources (mirrors): every
//! source's budget counts what every transfer holds there
//! ([`TaskCtl::holdings`]), plus short holds for fingerprints
//! ([`DownloadManager::try_hold`]) and probe connections. A probe that
//! learned a limit above the account's reported one ([`super::probe`])
//! raises the budget to [`learned_download_budget`]. A queued row whose
//! source is full may start on another source with an identical copy
//! (queue spreading, `spread.rs`).

mod spread;

use super::segments::MAX_CONNECTIONS;
use super::shared::{limit_key, read_record, Endpoint, LimitRecord};
use super::store;
use super::transfer::{self, Outcome};
use crate::error::{CoreError, CoreResult};
use crate::model::{
    CopyRef, DownloadStatus, DownloadWait, LimitKind, Limiting, Settings, SourceKind, TransferNote,
    TransferStats, WaitReason,
};
use crate::state::AppState;
use parking_lot::Mutex;
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Extension key of the runtime.
pub const EXT_KEY: &str = "downloads";
/// Connections downloads from one source may use when its account reports
/// no limit (M3U and Stalker sources, an unknown or unlimited account).
pub const MAX_CONCURRENT: usize = 2;
/// How long a player's `downloads.playback` report counts unless renewed.
pub const PLAYBACK_LEASE: Duration = Duration::from_secs(90);
/// How long a source still counts as playing after its last proxied
/// request: an HLS player fetches segments one by one, with gaps.
pub const STREAM_LINGER: Duration = Duration::from_secs(30);
/// Longest wait for downloads to let go of a connection playback needs.
const MAKE_ROOM_WAIT: Duration = Duration::from_secs(2);
/// Extra wait after a download let go: the panel notices the closed
/// connection a moment after the client closed it, and a stream asking
/// sooner can still be refused.
const YIELD_GRACE: Duration = Duration::from_millis(300);
/// How long a stream a player stops reporting, or a recording that ends,
/// still takes a connection of its source, on top of what else uses it. A
/// player answers its report before it lets the old stream go (mpv loads
/// the next channel only once the report for it is answered), and the panel
/// counts the closed connection a moment longer.
pub const RELEASE_GRACE: Duration = Duration::from_secs(3);
/// How long a source waits after refusing or failing a download, by step
/// in a row, in multiples of [`WAIT_BASE`]: 15 s, 30 s, 1, 2, 5, then
/// 10 min.
const WAIT_STEPS: [u32; 6] = [1, 2, 4, 8, 20, 40];
const WAIT_BASE: Duration = Duration::from_secs(15);
/// How long a row keeps waiting for its source (without new bytes) before
/// it fails.
pub const WAIT_LIMIT: Duration = Duration::from_secs(2 * 3600);
/// How long an RPC waits for a running transfer to stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts at the `queued -> downloading` claim within one run. The claim
/// waits for the database, which a long import or guide save can hold.
pub const CLAIM_ATTEMPTS: u32 = 3;
/// How long an id whose claims all failed waits before it is queued again.
const CLAIM_RETRY: Duration = Duration::from_secs(30);
/// How long a source gives no mirror connections after refusing one
/// ([`DownloadManager::mirror_refused`]).
pub const MIRROR_COOLDOWN: Duration = Duration::from_secs(120);
/// How long an endpoint resolved ahead for the next row stays usable
/// ([`DownloadManager::take_preresolved`]).
pub const PRERESOLVE_TTL: Duration = Duration::from_secs(60);
/// How long a source is not probed after a round there was aborted
/// (playback, a recording or a stop), so an abort cannot repeat every tick.
pub const PROBE_ABORT_BACKOFF: Duration = Duration::from_secs(600);

/// Why a running transfer was asked to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Keep the `.part`, status `paused`.
    Pause,
    /// Delete the `.part`, status `canceled`.
    Cancel,
    /// Row is about to be removed: keep everything, the caller cleans up.
    Detach,
    /// Playback or a recording on the same source needs the connection:
    /// keep the `.part`, back to `queued` at the front of the queue. Never a
    /// user pause, and any user stop overrides it.
    Yield,
}

/// Control block of one running transfer.
pub struct TaskCtl {
    pub token: CancellationToken,
    reason: Mutex<Option<StopReason>>,
    /// Live byte count (the DB is written every few seconds only).
    pub bytes: AtomicI64,
    /// u64::MAX inherits; zero is explicitly unlimited.
    rate_limit: AtomicU64,
    /// Something in this run asked for one connection
    /// ([`TaskCtl::set_one_connection`]): no probe runs for it.
    one_connection: AtomicBool,
    done: tokio::sync::watch::Sender<bool>,
    /// Start order among running transfers.
    seq: u64,
    /// Source the transfer downloads from.
    pub source: String,
    /// Connections the transfer holds open (more than one while it
    /// downloads in segments): the sum of [`TaskCtl::holdings`].
    pub(crate) connections: AtomicUsize,
    /// The row's own source (`item_ref.source_id`); differs from `source`
    /// only when the queue spread the row to another copy.
    pub row_source: String,
    /// The copy this run downloads; `None` is the row's own ref and episode.
    pub copy: Option<CopyRef>,
    /// Connections held per source, the authority (`source`) first.
    holdings: Mutex<Vec<(String, usize)>>,
    /// Streams that ended early (error or EOF, not the engine's own cut),
    /// per source.
    drops: Mutex<Vec<(String, u64)>>,
    /// Status lines for [`TransferStats::notes`], oldest first.
    notes: Mutex<VecDeque<(Instant, TransferNote)>>,
    /// The latest breakdown the transfer published.
    stats: Mutex<Option<TransferStats>>,
}

/// How long a [`TransferNote`] stays in [`TaskCtl::recent_notes`].
const NOTE_TTL: Duration = Duration::from_secs(60);
/// Most notes [`TaskCtl::recent_notes`] returns.
const MAX_NOTES: usize = 5;

impl TaskCtl {
    fn new(seq: u64, source: String) -> Self {
        Self::placed(seq, source.clone(), source, None)
    }

    /// A run on `source` of a row whose own source is `row_source`,
    /// downloading `copy` (`None`: the row's own ref and episode).
    fn placed(seq: u64, source: String, row_source: String, copy: Option<CopyRef>) -> Self {
        Self {
            token: CancellationToken::new(),
            reason: Mutex::new(None),
            bytes: AtomicI64::new(0),
            rate_limit: AtomicU64::new(u64::MAX),
            one_connection: AtomicBool::new(false),
            done: tokio::sync::watch::channel(false).0,
            seq,
            row_source,
            copy,
            holdings: Mutex::new(vec![(source.clone(), 1)]),
            drops: Mutex::new(Vec::new()),
            notes: Mutex::new(VecDeque::new()),
            stats: Mutex::new(None),
            source,
            connections: AtomicUsize::new(1),
        }
    }

    /// A control block no runtime tracks. Tests only.
    #[doc(hidden)]
    pub fn detached(source: &str) -> Arc<TaskCtl> {
        Arc::new(Self::new(0, source.to_string()))
    }

    /// A control block no runtime tracks, for a run of a row of
    /// `row_source` spread to `copy`. Tests only.
    #[doc(hidden)]
    pub fn detached_spread(row_source: &str, copy: CopyRef) -> Arc<TaskCtl> {
        let source = copy.source_id().to_string();
        Arc::new(Self::placed(0, source, row_source.to_string(), Some(copy)))
    }

    /// Records that the transfer holds `n` connections on `source` and
    /// updates `connections` to the sum over all sources. True when the sum
    /// went down: the caller then calls [`DownloadManager::released`].
    pub fn set_held(&self, source: &str, n: usize) -> bool {
        let mut holdings = self.holdings.lock();
        match holdings.iter_mut().find(|(s, _)| s == source) {
            Some(entry) => entry.1 = n,
            None if n > 0 => holdings.push((source.to_string(), n)),
            None => {}
        }
        holdings.retain(|(s, n)| *n > 0 || *s == self.source);
        let sum = holdings.iter().map(|(_, n)| n).sum();
        let before = self.connections.swap(sum, Ordering::Relaxed);
        sum < before
    }

    /// Connections held on `source`.
    pub fn held(&self, source: &str) -> usize {
        self.holdings
            .lock()
            .iter()
            .find(|(s, _)| s == source)
            .map_or(0, |(_, n)| *n)
    }

    /// Connections held per source, the authority first.
    pub fn holdings(&self) -> Vec<(String, usize)> {
        self.holdings.lock().clone()
    }

    /// A stream on `source` ended early, by error or EOF (not by the
    /// engine's own cut).
    pub fn note_drop(&self, source: &str) {
        let mut drops = self.drops.lock();
        match drops.iter_mut().find(|(s, _)| s == source) {
            Some(entry) => entry.1 += 1,
            None => drops.push((source.to_string(), 1)),
        }
    }

    /// Streams on `source` that ended early so far.
    pub fn drops(&self, source: &str) -> u64 {
        self.drops
            .lock()
            .iter()
            .find(|(s, _)| s == source)
            .map_or(0, |(_, n)| *n)
    }

    /// Adds a status line for the transfer's breakdown.
    pub fn push_note(&self, note: TransferNote) {
        let now = Instant::now();
        let mut notes = self.notes.lock();
        notes.push_back((now, note));
        while notes
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > NOTE_TTL)
            || notes.len() > MAX_NOTES
        {
            notes.pop_front();
        }
    }

    /// Status lines of the last minute, oldest first, at most five.
    pub fn recent_notes(&self) -> Vec<TransferNote> {
        let now = Instant::now();
        let notes = self.notes.lock();
        let fresh: Vec<TransferNote> = notes
            .iter()
            .filter(|(at, _)| now.duration_since(*at) <= NOTE_TTL)
            .map(|(_, n)| n.clone())
            .collect();
        fresh[fresh.len().saturating_sub(MAX_NOTES)..].to_vec()
    }

    /// Stores the transfer's latest breakdown (`downloads.stats`).
    pub fn publish_stats(&self, s: TransferStats) {
        *self.stats.lock() = Some(s);
    }

    /// The transfer's latest breakdown, once it published one.
    pub fn stats(&self) -> Option<TransferStats> {
        self.stats.lock().clone()
    }

    fn connections(&self) -> usize {
        self.connections.load(Ordering::Relaxed)
    }

    /// Asks the transfer to give its connections back ([`StopReason::Yield`]),
    /// unless a stop was already requested (a user's pause or cancel wins).
    fn request_yield(&self) {
        let mut reason = self.reason.lock();
        if reason.is_none() {
            *reason = Some(StopReason::Yield);
            self.token.cancel();
        }
    }

    /// Records that this run keeps to one connection (a segment answer that
    /// did not match, a refused extra connection, a file system without
    /// holes), so it never probes.
    pub fn set_one_connection(&self, on: bool) {
        self.one_connection.store(on, Ordering::Relaxed);
    }

    pub fn set_rate_limit(&self, bps: Option<u64>) {
        self.rate_limit
            .store(bps.unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    pub fn rate_limit(&self, global: u64) -> Option<u64> {
        let limit = match self.rate_limit.load(Ordering::Relaxed) {
            u64::MAX => global,
            limit => limit,
        };
        (limit > 0).then_some(limit)
    }

    /// Reason recorded by the first stop request.
    pub fn reason(&self) -> StopReason {
        self.reason.lock().unwrap_or(StopReason::Pause)
    }
}

/// Connections `c` holds on `source`. On its authority this is also every
/// connection its holdings do not place elsewhere: an engine that counts its
/// connections only in `connections` keeps them all on the authority.
fn held_on(c: &TaskCtl, source: &str) -> usize {
    let holdings = c.holdings.lock();
    let here = holdings
        .iter()
        .find(|(s, _)| s == source)
        .map_or(0, |(_, n)| *n);
    if c.source != source {
        return here;
    }
    let elsewhere: usize = holdings
        .iter()
        .filter(|(s, _)| s != source)
        .map(|(_, n)| n)
        .sum();
    here.max(c.connections().saturating_sub(elsewhere))
}

/// The settings the runtime decides with, copied out of the settings lock
/// so no decision holds it.
#[derive(Debug, Clone)]
pub(super) struct Policy {
    /// `download_probe_disabled`: never probed, learned limits ignored.
    probe_disabled: Vec<String>,
    /// `download_use_mirrors`.
    use_mirrors: bool,
    /// `download_allow_equivalent`.
    allow_equivalent: bool,
    /// `download_single_connection`.
    single: Vec<String>,
    /// `download_rate_limit_bps`.
    rate_limit: u64,
}

impl Policy {
    pub(super) fn of(s: &Settings) -> Self {
        Self {
            probe_disabled: s.download_probe_disabled.clone(),
            use_mirrors: s.download_use_mirrors,
            allow_equivalent: s.download_allow_equivalent,
            single: s.download_single_connection.clone(),
            rate_limit: s.download_rate_limit_bps,
        }
    }

    /// Whether probes may run on `source` and what they learned counts.
    pub(super) fn learns(&self, source: &str) -> bool {
        !self.probe_disabled.iter().any(|s| s == source)
    }

    fn single(&self, source: &str) -> bool {
        self.single.iter().any(|s| s == source)
    }
}

/// What the runtime knows of a source beyond its account's limit.
#[derive(Debug, Clone)]
enum Info {
    /// Being read; meanwhile the source is never probed and its learned
    /// limit does not count yet.
    Loading,
    Known {
        /// A sources row of a kind probes apply to (Xtream, Stalker).
        probeable: bool,
        /// What probes learned ([`super::shared::limit_key`]).
        record: Option<LimitRecord>,
    },
}

/// A source whose limit or [`Info`] a background read fills in.
struct Load {
    source: String,
    limit: bool,
    info: bool,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<i64>,
    /// Source of each queued id.
    queued_from: HashMap<i64, String>,
    active: HashMap<i64, Arc<TaskCtl>>,
    /// Next [`TaskCtl::seq`].
    started: u64,
    /// Connection limit per source, from its cached account status.
    limits: HashMap<String, Limit>,
    /// What each player last reported playing (`downloads.playback`).
    leases: HashMap<String, Lease>,
    /// Streams the media proxy holds open, per source.
    streams: HashMap<String, usize>,
    /// Until when a source counts as playing after its last proxied stream.
    lingering: HashMap<String, Instant>,
    /// Streams players stopped reporting a moment ago.
    released: Closed,
    /// Recordings running, per source.
    recordings: HashMap<String, usize>,
    /// Recordings that ended a moment ago.
    ended: Closed,
    /// Sources whose downloads wait before the next attempt, and why.
    blocked: HashMap<String, Block>,
    /// When each queued id started waiting on a blocked source.
    waiting_since: HashMap<i64, Instant>,
    /// Refusals or failures in a row per source, for the backoff step.
    streaks: HashMap<String, u32>,
    /// When the armed wake-up fires.
    wake_at: Option<Instant>,
    /// Per source: whether probes apply, and what they learned.
    info: HashMap<String, Info>,
    /// Sources that refused a mirror connection, until they give mirror
    /// connections again ([`MIRROR_COOLDOWN`]).
    cooldown: HashMap<String, Instant>,
    /// Connections held outside any transfer ([`DownloadManager::try_hold`]):
    /// the source, and a token alive as long as the hold.
    holds: Vec<(String, Weak<()>)>,
    /// Probe rounds running, per source: the count of their open
    /// connections, alive as long as the round.
    probes: HashMap<String, Weak<AtomicUsize>>,
    /// Sources whose last probe round was aborted, until they may be
    /// probed again ([`PROBE_ABORT_BACKOFF`]).
    probe_backoff: HashMap<String, Instant>,
    /// Rows known to hold an equivalent copy's bytes (`origin_json`): they
    /// run on that copy or on copies identical to it, never their own.
    origins: HashMap<i64, CopyRef>,
    /// Where each queued row could start besides its own source.
    plans: HashMap<i64, spread::PlanState>,
    /// Rows a fingerprint batch already covered.
    batched: HashSet<i64>,
    /// Endpoints resolved ahead, per row.
    preresolved: HashMap<i64, spread::Pre>,
    /// Running rows whose origin's source was removed: their run discards
    /// the bytes it held from that copy when it ends ([`forget_source`]).
    discard: HashSet<i64>,
    /// A note the row's next run shows: why it starts over from its own
    /// copy.
    carried: HashMap<i64, TransferNote>,
    /// Copies a row's run ended on with a `Respread`: the row is never
    /// placed on them again this session, whatever the verdicts say. Kept
    /// until the row completes, is canceled or is removed.
    respread: HashSet<(i64, CopyRef)>,
}

/// A source's connection limit as the runtime knows it.
#[derive(Debug, Clone, Copy)]
enum Limit {
    /// Being read from the cached account status; its ids wait meanwhile.
    Loading,
    /// `max_connections` when the account reports one above zero.
    Known(Option<i64>),
}

struct Lease {
    sources: Vec<String>,
    until: Instant,
}

/// Connections that closed a moment ago, per source, each with when it
/// stops counting ([`RELEASE_GRACE`]): the panel still counts them, on top
/// of whatever else uses the source.
#[derive(Default)]
struct Closed(HashMap<String, Vec<Instant>>);

impl Closed {
    fn add(&mut self, source: &str, until: Instant) {
        self.0.entry(source.to_string()).or_default().push(until);
    }

    fn count(&self, source: &str, now: Instant) -> usize {
        self.0
            .get(source)
            .map_or(0, |t| t.iter().filter(|t| **t > now).count())
    }

    fn expire(&mut self, now: Instant) {
        self.0.retain(|_, t| {
            t.retain(|t| *t > now);
            !t.is_empty()
        });
    }

    fn ends(&self) -> impl Iterator<Item = Instant> + '_ {
        self.0.values().flatten().copied()
    }
}

/// Why and until when downloads from a source wait (the provider refused a
/// connection, or was unreachable).
struct Block {
    until: Instant,
    /// `until` as wall-clock time, for the UI.
    until_wall: chrono::DateTime<chrono::Utc>,
    reason: WaitReason,
}

/// Connections downloads from one source may use right now: the account's
/// limit minus one kept free for playback, and never more than playback and
/// recordings on the source leave. A 1-connection account downloads only
/// while nothing else uses it. With no limit (or an unknown one) downloads
/// keep [`MAX_CONCURRENT`] whatever plays.
pub fn download_budget(limit: Option<i64>, playing: usize, recording: usize) -> usize {
    match limit
        .and_then(|l| usize::try_from(l).ok())
        .filter(|l| *l > 0)
    {
        None => MAX_CONCURRENT,
        Some(limit) => {
            let kept = usize::from(limit >= 2);
            (limit - kept).min(limit.saturating_sub(playing + recording))
        }
    }
}

/// [`download_budget`] for a source whose probe learned a limit above the
/// reported one: everything playback and recordings leave, with no
/// connection kept free (yield hands playback its connection back).
pub fn learned_download_budget(learned: i64, playing: usize, recording: usize) -> usize {
    usize::try_from(learned)
        .unwrap_or(0)
        .saturating_sub(playing + recording)
}

impl Inner {
    /// Streams playing from `source`: the most any one signal reports (a
    /// player's lease and the proxy see the same playback). A stream a
    /// player let go a moment ago counts beside the ones players report; a
    /// proxied one is still among the proxy's streams or lingering.
    fn playing(&self, source: &str, now: Instant) -> usize {
        let reported = self
            .leases
            .values()
            .filter(|l| l.until > now)
            .map(|l| l.sources.iter().filter(|s| *s == source).count())
            .sum::<usize>()
            + self.released.count(source, now);
        let proxied = self
            .streams
            .get(source)
            .copied()
            .unwrap_or(0)
            .max(usize::from(
                self.lingering.get(source).is_some_and(|t| *t > now),
            ));
        reported.max(proxied)
    }

    fn recording(&self, source: &str, now: Instant) -> usize {
        self.recordings.get(source).copied().unwrap_or(0) + self.ended.count(source, now)
    }

    /// The limit downloads from `source` follow, and where it comes from: a
    /// learned limit above the reported one (probing on for the source),
    /// else the reported one. `None` while the reported limit is being read.
    fn effective(&self, source: &str, policy: &Policy) -> Option<(Option<i64>, LimitKind)> {
        let Limit::Known(reported) = *self.limits.get(source)? else {
            return None;
        };
        let learned = match self.info.get(source) {
            Some(Info::Known {
                record: Some(r), ..
            }) if policy.learns(source) => Some(r.limit),
            _ => None,
        };
        Some(match (learned, reported) {
            (Some(l), r) if l > r.unwrap_or(0) => (Some(l), LimitKind::Learned),
            (_, Some(r)) => (Some(r), LimitKind::Reported),
            (_, None) => (None, LimitKind::Unknown),
        })
    }

    /// The budget with `playing` and `recording` taken: a learned limit
    /// keeps no connection free ([`learned_download_budget`]), a reported
    /// one does ([`download_budget`]).
    fn budget_with(
        &self,
        source: &str,
        playing: usize,
        recording: usize,
        policy: &Policy,
    ) -> Option<usize> {
        Some(match self.effective(source, policy)? {
            (Some(learned), LimitKind::Learned) => {
                learned_download_budget(learned, playing, recording)
            }
            (limit, _) => download_budget(limit, playing, recording),
        })
    }

    /// `None` while the source's limit is still being read.
    fn budget(&self, source: &str, now: Instant, policy: &Policy) -> Option<usize> {
        self.budget_with(
            source,
            self.playing(source, now),
            self.recording(source, now),
            policy,
        )
    }

    /// Connections transfers hold on `source`, wherever they download from,
    /// including ones winding down; `except` is left out.
    fn transfers_on(&self, source: &str, except: Option<&TaskCtl>) -> usize {
        self.active
            .values()
            .filter(|c| except.is_none_or(|e| !std::ptr::eq(Arc::as_ptr(c), e)))
            .map(|c| held_on(c, source))
            .sum()
    }

    /// Connections held on `source` through [`DownloadManager::try_hold`].
    fn holds_on(&self, source: &str) -> usize {
        self.holds
            .iter()
            .filter(|(s, t)| s == source && t.strong_count() > 0)
            .count()
    }

    /// Connections a probe round holds open on `source`.
    fn probing_on(&self, source: &str) -> usize {
        self.probes
            .get(source)
            .and_then(Weak::upgrade)
            .map_or(0, |n| n.load(Ordering::Relaxed))
    }

    fn probing(&self, source: &str) -> bool {
        self.probes
            .get(source)
            .is_some_and(|w| w.strong_count() > 0)
    }

    /// Everything the app holds on `source` besides playback and
    /// recordings: transfers (mirror connections included), holds, probes.
    fn used(&self, source: &str) -> usize {
        self.transfers_on(source, None) + self.holds_on(source) + self.probing_on(source)
    }

    fn blocked_now(&self, source: &str, now: Instant) -> bool {
        self.blocked.get(source).is_some_and(|b| b.until > now)
    }

    fn cooled(&self, source: &str, now: Instant) -> bool {
        self.cooldown.get(source).is_some_and(|t| *t > now)
    }

    /// The source row `id` waits for: its origin's, else its own.
    fn home(&self, id: i64) -> Option<&str> {
        match self.origins.get(&id) {
            Some(o) => Some(o.source_id()),
            None => self.queued_from.get(&id).map(String::as_str),
        }
    }

    /// True when a queued row could start on `source`: it is the row's own
    /// (or origin's) source, or its spread plan lists a copy there that the
    /// source would take now. Such a row gets the connection before a
    /// transfer adds one.
    fn queue_wants(&self, source: &str, now: Instant, policy: &Policy) -> bool {
        let spreads_here =
            policy.use_mirrors && !self.cooled(source, now) && !self.blocked_now(source, now);
        self.queue.iter().any(|id| {
            self.home(*id) == Some(source)
                || spreads_here
                    && matches!(
                        self.plans.get(id),
                        Some(spread::PlanState::Ready(p))
                            if p.targets(source, policy, self.origins.contains_key(id))
                    )
        })
    }

    /// [`DownloadManager::connection_allowance`] with the lock held.
    fn authority_allowance(&self, ctl: &TaskCtl, now: Instant, policy: &Policy) -> usize {
        let source = ctl.source.as_str();
        // A file splits only into connections the account is known to have
        // spare: an M3U playlist or a Stalker portal that reports no limit
        // often allows one (Stalker: one per MAC).
        if !matches!(self.effective(source, policy), Some((Some(_), _))) {
            return 1;
        }
        if self.playing(source, now) > 0 || self.queue_wants(source, now, policy) {
            return 1;
        }
        let Some(budget) = self.budget(source, now, policy) else {
            return 1;
        };
        // A probe round's connections are left out: they are the probing
        // transfer's own, and close before the round returns.
        let others = self.transfers_on(source, Some(ctl)) + self.holds_on(source);
        budget.saturating_sub(others).max(1)
    }

    /// Connections `ctl` may hold on `source`, a source other than its
    /// authority: none while `download_use_mirrors` is off, the limit loads,
    /// anything plays or records there, the source is blocked or cooling
    /// down after a refused mirror connection, or a queued row could start
    /// there. `ctl` is `None` for a holder that holds nothing there yet.
    fn mirror_allowance(
        &self,
        ctl: Option<&TaskCtl>,
        source: &str,
        now: Instant,
        policy: &Policy,
    ) -> usize {
        if !policy.use_mirrors {
            return 0;
        }
        let Some((limit, _)) = self.effective(source, policy) else {
            return 0;
        };
        if self.playing(source, now) + self.recording(source, now) > 0
            || self.blocked_now(source, now)
            || self.cooled(source, now)
            || self.queue_wants(source, now, policy)
        {
            return 0;
        }
        let others =
            self.transfers_on(source, ctl) + self.holds_on(source) + self.probing_on(source);
        match limit {
            None => usize::from(others == 0),
            Some(_) => self
                .budget(source, now, policy)
                .unwrap_or(0)
                .saturating_sub(others),
        }
    }

    /// Whether a queued row may start on `source` now.
    fn has_room(&self, source: &str, now: Instant, policy: &Policy) -> bool {
        !self.blocked.contains_key(source)
            && self
                .budget(source, now, policy)
                .is_some_and(|b| self.used(source) < b)
    }

    /// Where queued row `id` could start besides its home, when its home
    /// has no room and the row may move ([`spread::may_move`]): a source
    /// with room and an identical copy (of its origin, when it has one),
    /// else, for a fresh row with equivalent copies allowed, a source with
    /// room and an equivalent copy (`adopt`: the copy becomes the row's
    /// origin). A missing or stale plan is listed for a read.
    fn spread_pick(
        &mut self,
        id: i64,
        home: &str,
        now: Instant,
        policy: &Policy,
        loads: &mut Vec<Load>,
        plan_loads: &mut Vec<i64>,
    ) -> Option<(String, Option<CopyRef>, bool)> {
        let plan = match self.plans.get(&id) {
            Some(spread::PlanState::Loading) => return None,
            Some(spread::PlanState::Ready(p)) if p.at.elapsed() < spread::PLAN_TTL => p.clone(),
            _ => {
                self.plans.insert(id, spread::PlanState::Loading);
                plan_loads.push(id);
                return None;
            }
        };
        if !plan.movable {
            return None;
        }
        let has_origin = self.origins.contains_key(&id);
        let equivalent: &[CopyRef] = if policy.allow_equivalent && plan.fresh && !has_origin {
            &plan.equivalent
        } else {
            &[]
        };
        let tries = plan
            .identical
            .iter()
            .map(|c| (c, false))
            .chain(equivalent.iter().map(|c| (c, true)));
        for (copy, adopt) in tries {
            let source = copy.source_id();
            if source == home || self.braked(id, copy) {
                continue;
            }
            self.request_load(source, loads);
            if !self.cooled(source, now) && self.has_room(source, now, policy) {
                return Some((source.to_string(), Some(copy.clone()), adopt));
            }
        }
        None
    }

    /// Marks what is not known yet about `source` as loading and lists it
    /// for a background read.
    fn request_load(&mut self, source: &str, loads: &mut Vec<Load>) {
        let limit = !self.limits.contains_key(source);
        let info = !self.info.contains_key(source);
        if limit {
            self.limits.insert(source.to_string(), Limit::Loading);
        }
        if info {
            self.info.insert(source.to_string(), Info::Loading);
        }
        if limit || info {
            loads.push(Load {
                source: source.to_string(),
                limit,
                info,
            });
        }
    }

    /// Asks the newest transfers of every source over its budget to yield
    /// until the rest fit. Returns their done signals. A transfer counts on
    /// a source only while it holds a connection there ([`held_on`]): one
    /// whose own source has none (only mirrors fetching) leaves it to the
    /// row that starts there. Mirror connections on a source give way on
    /// their own within a tick ([`DownloadManager::allowance_on`] drops to 0
    /// while anything plays there), and probes abort, so only transfers
    /// holding their own source yield here.
    fn preempt(&self, now: Instant, policy: &Policy) -> Vec<tokio::sync::watch::Receiver<bool>> {
        let mut done = Vec::new();
        let holding = |c: &&Arc<TaskCtl>| !c.token.is_cancelled() && held_on(c, &c.source) > 0;
        let sources: HashSet<&str> = self
            .active
            .values()
            .filter(holding)
            .map(|c| c.source.as_str())
            .collect();
        for source in sources {
            let Some(budget) = self.budget(source, now, policy) else {
                continue;
            };
            let mut running: Vec<&Arc<TaskCtl>> = self
                .active
                .values()
                .filter(|c| c.source == source && holding(c))
                .collect();
            // A transfer in segments gives its extra connections back on
            // its own within a tick (`connection_allowance`), so only whole
            // transfers over the budget yield.
            let mut held = running.len();
            running.sort_by_key(|c| std::cmp::Reverse(c.seq));
            for ctl in running {
                if held <= budget {
                    break;
                }
                tracing::info!(source, "download yields its connection to playback");
                ctl.request_yield();
                held -= 1;
                done.push(ctl.done.subscribe());
            }
        }
        done
    }

    /// Drops reports, lingers and blocks that ran out.
    fn expire(&mut self, now: Instant) {
        self.leases.retain(|_, l| l.until > now);
        self.lingering.retain(|_, t| *t > now);
        self.released.expire(now);
        self.ended.expire(now);
        self.blocked.retain(|_, b| b.until > now);
        self.cooldown.retain(|_, t| *t > now);
        self.probe_backoff.retain(|_, t| *t > now);
        self.holds.retain(|(_, t)| t.strong_count() > 0);
        self.probes.retain(|_, n| n.strong_count() > 0);
    }

    /// The next time a budget can grow while something waits, when no
    /// earlier wake-up is armed for it.
    fn arm_wake(&mut self, now: Instant) -> Option<Instant> {
        if self.queue.is_empty() {
            return None;
        }
        let next = self
            .leases
            .values()
            .map(|l| l.until)
            .chain(self.lingering.values().copied())
            .chain(self.released.ends())
            .chain(self.ended.ends())
            .chain(self.blocked.values().map(|b| b.until))
            .chain(self.cooldown.values().copied())
            .filter(|t| *t > now)
            .min()?;
        if self.wake_at.is_some_and(|w| w > now && w <= next) {
            return None;
        }
        self.wake_at = Some(next);
        Some(next)
    }

    /// True when row `id` must not be placed on `copy` again
    /// ([`Inner::respread`]).
    fn braked(&self, id: i64, copy: &CopyRef) -> bool {
        self.respread.contains(&(id, copy.clone()))
    }

    /// Drops what the runtime keeps about a row only while it is tracked.
    fn forget(&mut self, id: i64) {
        self.origins.remove(&id);
        self.plans.remove(&id);
        self.batched.remove(&id);
        self.preresolved.remove(&id);
        self.discard.remove(&id);
        self.carried.remove(&id);
    }

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
    /// The state this runtime belongs to, for callers that only have a
    /// `&AppState` (an account check) or outlive a request (a stream hold).
    state: OnceLock<Weak<AppState>>,
    /// Last account check after a refused request, per source: when, and
    /// whether the credentials worked.
    checked: Mutex<HashMap<String, (Instant, bool)>>,
    /// [`WAIT_BASE`] and [`WAIT_LIMIT`] overrides in milliseconds; 0 =
    /// defaults. Tests only.
    wait_base_ms: AtomicU64,
    wait_limit_ms: AtomicU64,
    /// [`PLAYBACK_LEASE`] override in milliseconds; 0 = default. Tests only.
    lease_ms: AtomicU64,
    /// The downloads folder behaves as one that cannot leave holes (FAT,
    /// exFAT). Tests only.
    no_holes: AtomicBool,
    /// Extra time every sidecar save of a split file takes, in
    /// milliseconds: a slow disk's sync. Tests only.
    slow_sync_ms: AtomicU64,
    /// How a split transfer adds and recycles connections.
    ramp_timing: Mutex<RampTiming>,
    /// How connection-limit probes pace themselves.
    probe_timing: Mutex<ProbeTiming>,
}

/// How a transfer ramps its connections up ([`DownloadManager::ramp_timing`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RampTiming {
    /// How long an added connection has to raise the total speed.
    pub gain_window: Duration,
    /// Age after which the slowest connection is replaced.
    pub recycle_after: Duration,
}

impl Default for RampTiming {
    fn default() -> Self {
        Self {
            gain_window: Duration::from_secs(1),
            recycle_after: Duration::from_secs(10),
        }
    }
}

/// How connection-limit probes pace themselves
/// ([`DownloadManager::probe_timing`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeTiming {
    /// How long each extra connection is held before the next one.
    pub step: Duration,
    /// How long a learned limit stands before the source is probed again.
    pub retest_after: Duration,
}

impl Default for ProbeTiming {
    fn default() -> Self {
        Self {
            step: Duration::from_secs(3),
            retest_after: Duration::from_secs(7 * 24 * 3600),
        }
    }
}

/// Why a connection is held outside any transfer's plan
/// ([`DownloadManager::try_hold`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HoldPurpose {
    /// Reading a copy's sample windows.
    Fingerprint,
    /// Comparing a candidate mirror with a fingerprint.
    Verify,
}

/// One connection of `source` held outside any transfer's plan. Dropping it
/// gives the connection back and pumps the queue.
pub struct ConnHold {
    pub source: String,
    pub purpose: HoldPurpose,
    state: Option<Weak<AppState>>,
    /// Alive as long as the hold; the runtime counts the connection until
    /// it is gone.
    token: Option<Arc<()>>,
}

impl Drop for ConnHold {
    fn drop(&mut self) {
        // Given back before the pump, so the pump sees the connection free.
        self.token.take();
        if let Some(state) = self.state.as_ref().and_then(Weak::upgrade) {
            let mgr = manager(&state);
            pump_if_running(&state, &mgr);
        }
    }
}

/// A probe round in progress ([`DownloadManager::begin_probe`]).
pub(super) struct ProbeRound {
    /// Probe connections open now; the runtime counts them against the
    /// source while this lives.
    pub(super) open: Arc<AtomicUsize>,
    /// Connections the app held on the source when the round began (the
    /// probing transfer's included).
    pub(super) base: usize,
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
    /// Called inside the serialized DB write so startup cannot install an older cap.
    pub fn set_download_rate_limit(&self, id: i64, bps: Option<u64>) {
        if let Some(ctl) = self.inner.lock().active.get(&id) {
            ctl.set_rate_limit(bps);
        }
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

    /// Why a queued id waits, when it is more than its turn: playback or
    /// other transfers hold its source's connections, or the source is
    /// blocked after a refusal. The source is the row's home: its origin's
    /// when it holds an equivalent copy's bytes, else its own.
    pub fn waiting(&self, id: i64) -> Option<DownloadWait> {
        let policy = self.policy();
        let inner = self.inner.lock();
        if !inner.queued_from.contains_key(&id) {
            return None;
        }
        let source = inner.home(id)?;
        let now = Instant::now();
        if let Some(b) = inner.blocked.get(source).filter(|b| b.until > now) {
            return Some(DownloadWait {
                reason: b.reason,
                until: Some(
                    b.until_wall
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                ),
            });
        }
        let (Some(_), _) = inner.effective(source, &policy)? else {
            return None;
        };
        let used = inner.used(source);
        if used < inner.budget(source, now, &policy)? {
            return None;
        }
        let without_playback =
            inner.budget_with(source, 0, inner.recording(source, now), &policy)?;
        let reason = if without_playback > used {
            WaitReason::Playback
        } else {
            WaitReason::Connection
        };
        Some(DownloadWait {
            reason,
            until: None,
        })
    }

    /// Connections a running transfer holds, when it holds more than one.
    pub fn connections(&self, id: i64) -> Option<usize> {
        self.inner
            .lock()
            .active
            .get(&id)
            .map(|c| c.connections())
            .filter(|n| *n > 1)
    }

    /// How many connections the transfer `ctl` may hold on its own source
    /// now (at least 1): what the source's budget leaves after its other
    /// holders (transfers, mirror connections, holds), and 1 while anything
    /// plays from the source, a queued download could start there (that one
    /// gets the connection first), or its limit is unknown.
    pub fn connection_allowance(&self, ctl: &TaskCtl) -> usize {
        let policy = self.policy();
        let now = Instant::now();
        self.inner.lock().authority_allowance(ctl, now, &policy)
    }

    /// Connections `ctl` may hold on `source` now, counting the ones it
    /// already holds there, never more than [`MAX_CONNECTIONS`]. On its own
    /// source this is [`connection_allowance`](Self::connection_allowance).
    /// On a mirror it is what the budget leaves after every other holder
    /// there, and 0 while `download_use_mirrors` is off (read live), the
    /// limit loads (the read starts), anything plays or records there, a
    /// queued row could start there, or the source refused a mirror
    /// connection less than [`MIRROR_COOLDOWN`] ago. An
    /// unknown limit gives 1 while no one else uses the source.
    pub fn allowance_on(&self, ctl: &TaskCtl, source: &str) -> usize {
        if source == ctl.source {
            return self.connection_allowance(ctl).min(MAX_CONNECTIONS);
        }
        self.mirror_spare(Some(ctl), source)
    }

    /// Connections a new holder could take on `source` now for a transfer
    /// whose own source is `item_source`: [`allowance_on`](Self::allowance_on)
    /// for a mirror it holds nothing on yet. 0 on `item_source` itself (a
    /// transfer's own source is not a mirror of it).
    pub fn spare_on(&self, item_source: &str, source: &str) -> usize {
        if source == item_source {
            return 0;
        }
        self.mirror_spare(None, source)
    }

    /// Active transfers holding at least one connection on `source`, their
    /// own or a mirror.
    pub fn holders(&self, source: &str) -> usize {
        self.inner
            .lock()
            .active
            .values()
            .filter(|c| held_on(c, source) > 0)
            .count()
    }

    fn mirror_spare(&self, ctl: Option<&TaskCtl>, source: &str) -> usize {
        self.ensure_loaded(source);
        let policy = self.policy();
        let cap = if policy.single(source) {
            1
        } else {
            MAX_CONNECTIONS
        };
        let now = Instant::now();
        self.inner
            .lock()
            .mirror_allowance(ctl, source, now, &policy)
            .min(cap)
    }

    /// A short hold on one connection of `source` outside any transfer's
    /// plan (fingerprints, verification). `None` when the source has no
    /// spare connection: something plays or records there, a queued row
    /// could start there, it is blocked or cooling down, or its budget is
    /// spent (with an unknown or loading limit: anyone else uses it).
    pub fn try_hold(&self, source: &str, purpose: HoldPurpose) -> Option<ConnHold> {
        self.ensure_loaded(source);
        let policy = self.policy();
        let now = Instant::now();
        let mut inner = self.inner.lock();
        if inner.playing(source, now) + inner.recording(source, now) > 0
            || inner.blocked_now(source, now)
            || inner.cooled(source, now)
            || inner.queue_wants(source, now, &policy)
        {
            return None;
        }
        let used = inner.used(source);
        let spare = match inner.effective(source, &policy) {
            Some((Some(_), _)) => inner.budget(source, now, &policy).is_some_and(|b| used < b),
            _ => used == 0,
        };
        if !spare {
            return None;
        }
        let token = Arc::new(());
        inner
            .holds
            .push((source.to_string(), Arc::downgrade(&token)));
        Some(ConnHold {
            source: source.to_string(),
            purpose,
            state: self.state.get().cloned(),
            token: Some(token),
        })
    }

    /// A mirror connection to `source` was refused: for [`MIRROR_COOLDOWN`]
    /// the source gives no mirror connections, holds or spread starts. Its
    /// own downloads, their waits and its backoff are untouched.
    pub fn mirror_refused(&self, source: &str) {
        self.inner
            .lock()
            .cooldown
            .insert(source.to_string(), Instant::now() + MIRROR_COOLDOWN);
    }

    /// The runtime's reason `ctl` may not hold more connections on `source`:
    /// playback or a recording there, other downloads (running there, or
    /// queued to start there), a refusal (a backoff or a mirror cooldown),
    /// else the account's limit once one is known.
    pub fn limit_reason(&self, ctl: &TaskCtl, source: &str) -> Option<Limiting> {
        let policy = self.policy();
        let now = Instant::now();
        let inner = self.inner.lock();
        let source_id = source.to_string();
        if inner.playing(source, now) + inner.recording(source, now) > 0 {
            return Some(Limiting::Playback { source_id });
        }
        let others = inner.transfers_on(source, Some(ctl)) + inner.holds_on(source);
        if others > 0 || inner.queue_wants(source, now, &policy) {
            return Some(Limiting::OtherDownloads { source_id });
        }
        if inner.blocked_now(source, now) || inner.cooled(source, now) {
            return Some(Limiting::Refused { source_id });
        }
        match inner.effective(source, &policy) {
            Some((Some(limit), _)) => Some(Limiting::AccountLimit { source_id, limit }),
            _ => None,
        }
    }

    /// `source`'s connection limit for the transfer breakdown: a learned
    /// limit above the reported one, else the reported one, once known.
    pub fn effective_limit(&self, source: &str) -> (Option<i64>, LimitKind) {
        self.ensure_loaded(source);
        let policy = self.policy();
        self.inner
            .lock()
            .effective(source, &policy)
            .unwrap_or((None, LimitKind::Unknown))
    }

    /// The endpoint resolved ahead for running row `id`, when it is younger
    /// than [`PRERESOLVE_TTL`] and is the copy the run downloads. Taken
    /// once.
    pub fn take_preresolved(&self, id: i64) -> Option<Endpoint> {
        let mut inner = self.inner.lock();
        let spread::Pre::Ready { at, ep, own } = inner.preresolved.remove(&id)? else {
            return None;
        };
        if at.elapsed() > PRERESOLVE_TTL {
            return None;
        }
        let ctl = inner.active.get(&id)?;
        let matches = match &ctl.copy {
            Some(copy) => ep.copy == *copy,
            None => own,
        };
        matches.then_some(ep)
    }

    /// The settings decisions follow now; the defaults for a runtime no
    /// state is bound to (unit tests).
    fn policy(&self) -> Policy {
        match self.state.get().and_then(Weak::upgrade) {
            Some(state) => Policy::of(&state.settings.read()),
            None => Policy::of(&Settings::default()),
        }
    }

    /// Starts reading what is not known yet about `source` (its limit, its
    /// probe record), when a state is bound and a runtime runs.
    fn ensure_loaded(&self, source: &str) {
        let Some(state) = self.state.get().and_then(Weak::upgrade) else {
            return;
        };
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let mut loads = Vec::new();
        self.inner.lock().request_load(source, &mut loads);
        if !loads.is_empty() {
            let mgr = manager(&state);
            for load in loads {
                tokio::spawn(load_source(state.clone(), mgr.clone(), load));
            }
        }
    }

    /// Reads what is not known yet about `source` and waits for it (at
    /// most a few seconds), for a probe that needs the record now.
    pub(super) async fn load_now(&self, state: &Arc<AppState>, source: &str) {
        let mgr = manager(state);
        for _ in 0..200 {
            let mut loads = Vec::new();
            let known = {
                let mut inner = self.inner.lock();
                inner.request_load(source, &mut loads);
                matches!(inner.limits.get(source), Some(Limit::Known(_)))
                    && matches!(inner.info.get(source), Some(Info::Known { .. }))
            };
            if known {
                return;
            }
            for load in loads {
                load_source(state.clone(), mgr.clone(), load).await;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// [`super::probe::probe_due`] with the settings read.
    pub(super) fn probe_due_with(&self, ctl: &TaskCtl, source: &str, policy: &Policy) -> bool {
        // A transfer that may not split never uses what a probe learns.
        if !policy.learns(source)
            || ctl.token.is_cancelled()
            || policy.single(source)
            || ctl.rate_limit(policy.rate_limit).is_some()
            || ctl.one_connection.load(Ordering::Relaxed)
        {
            return false;
        }
        self.ensure_loaded(source);
        let now = Instant::now();
        {
            let inner = self.inner.lock();
            let Some(Info::Known {
                probeable: true,
                record,
            }) = inner.info.get(source)
            else {
                return false;
            };
            let due = record.as_ref().is_none_or(|r| {
                chrono::DateTime::parse_from_rfc3339(&r.next_probe_at)
                    .map_or(true, |at| at <= chrono::Utc::now())
            });
            if !due
                || inner.playing(source, now) + inner.recording(source, now) > 0
                || inner.probing(source)
                || inner.probe_backoff.get(source).is_some_and(|t| *t > now)
                || inner.blocked_now(source, now)
            {
                return false;
            }
            let Some((limit, _)) = inner.effective(source, policy) else {
                return false;
            };
            let cap = i64::try_from(MAX_CONNECTIONS).unwrap_or(i64::MAX);
            if limit.is_some_and(|l| l > cap) {
                return false;
            }
        }
        held_on(ctl, source) >= self.allowance_on(ctl, source)
    }

    /// Starts a probe round on `source` for `ctl`: `None` when one already
    /// runs there. The round counts as using the connections it opens until
    /// the returned value is dropped.
    pub(super) fn begin_probe(&self, ctl: &TaskCtl, source: &str) -> Option<ProbeRound> {
        let mut inner = self.inner.lock();
        if inner.probing(source) {
            return None;
        }
        let open = Arc::new(AtomicUsize::new(0));
        inner
            .probes
            .insert(source.to_string(), Arc::downgrade(&open));
        let base =
            inner.transfers_on(source, Some(ctl)) + held_on(ctl, source) + inner.holds_on(source);
        Some(ProbeRound { open, base })
    }

    /// True when a probe on `source` for `ctl` must stop: the transfer is
    /// stopping, or playback or a recording started there.
    pub(super) fn probe_interrupted(&self, ctl: &TaskCtl, source: &str) -> bool {
        if ctl.token.is_cancelled() {
            return true;
        }
        let now = Instant::now();
        let inner = self.inner.lock();
        inner.playing(source, now) + inner.recording(source, now) > 0
    }

    /// Records that a probe round on `source` was aborted: none runs there
    /// for [`PROBE_ABORT_BACKOFF`].
    pub(super) fn probe_aborted(&self, source: &str) {
        self.inner
            .lock()
            .probe_backoff
            .insert(source.to_string(), Instant::now() + PROBE_ABORT_BACKOFF);
    }

    /// Lets `source` be probed again at once after an aborted round
    /// ([`super::probe::reset`]).
    pub(super) fn clear_probe_backoff(&self, source: &str) {
        self.inner.lock().probe_backoff.remove(source);
    }

    /// The account's reported limit of `source`, once read.
    pub(super) fn reported_limit(&self, source: &str) -> Option<i64> {
        match self.inner.lock().limits.get(source) {
            Some(Limit::Known(limit)) => *limit,
            _ => None,
        }
    }

    /// The probe record of `source` as the runtime knows it.
    pub(super) fn record(&self, source: &str) -> Option<LimitRecord> {
        match self.inner.lock().info.get(source) {
            Some(Info::Known { record, .. }) => record.clone(),
            _ => None,
        }
    }

    /// Replaces the probe record of `source` after a write (`None`: reset).
    /// A read in flight is dropped, so the next use reads the new one.
    pub(super) fn set_record(&self, source: &str, record: Option<LimitRecord>) {
        let mut inner = self.inner.lock();
        match inner.info.get_mut(source) {
            Some(Info::Known { record: r, .. }) => *r = record,
            Some(Info::Loading) => {
                inner.info.remove(source);
            }
            None => {}
        }
    }

    /// True while a probe round runs on `source`.
    pub(super) fn is_probing(&self, source: &str) -> bool {
        self.inner.lock().probing(source)
    }

    /// Pumps the queue of the bound state, when a runtime runs.
    pub(super) fn repump(&self) {
        if let Some(state) = self.state.get().and_then(Weak::upgrade) {
            let mgr = manager(&state);
            pump_if_running(&state, &mgr);
        }
    }

    fn active(&self, id: i64) -> Option<Arc<TaskCtl>> {
        self.inner.lock().active.get(&id).cloned()
    }

    /// The latest breakdown of running transfer `id`.
    pub fn transfer_stats(&self, id: i64) -> Option<TransferStats> {
        self.active(id)?.stats()
    }

    /// Sources running transfer `id` draws on, when more than one.
    pub fn sources_in_use(&self, id: i64) -> Option<usize> {
        let n = self
            .active(id)?
            .holdings()
            .iter()
            .filter(|(_, n)| *n > 0)
            .count();
        (n > 1).then_some(n)
    }

    /// The source running transfer `id` downloads from, when it is not the
    /// row's own.
    pub fn served_by(&self, id: i64) -> Option<String> {
        let ctl = self.active(id)?;
        (ctl.source != ctl.row_source).then(|| ctl.source.clone())
    }

    /// How split transfers ramp their connections.
    pub fn ramp_timing(&self) -> RampTiming {
        *self.ramp_timing.lock()
    }

    /// Overrides [`RampTiming`]. Used by tests.
    pub fn set_ramp_timing(&self, gain_window: Duration, recycle_after: Duration) {
        *self.ramp_timing.lock() = RampTiming {
            gain_window,
            recycle_after,
        };
    }

    /// How connection-limit probes pace themselves.
    pub fn probe_timing(&self) -> ProbeTiming {
        *self.probe_timing.lock()
    }

    /// Overrides [`ProbeTiming`]. Used by tests.
    pub fn set_probe_timing(&self, step: Duration, retest_after: Duration) {
        *self.probe_timing.lock() = ProbeTiming { step, retest_after };
    }

    /// A split transfer gave a connection back: a queued download of its
    /// source may start now.
    pub fn released(&self) {
        if let Some(state) = self.state.get().and_then(Weak::upgrade) {
            let mgr = manager(&state);
            pump(&state, &mgr);
        }
    }

    /// True while a transfer holds more connections on `source` than it may
    /// now, whether `source` is its own or a mirror.
    fn over_allowance(&self, source: &str) -> bool {
        let ctls: Vec<Arc<TaskCtl>> = self
            .inner
            .lock()
            .active
            .values()
            .filter(|c| !c.token.is_cancelled() && held_on(c, source) > 0)
            .cloned()
            .collect();
        ctls.iter()
            .any(|c| held_on(c, source) > self.allowance_on(c, source))
    }

    /// Shortens the waits after a refusal or outage (the backoff base and
    /// the give-up limit). Used by tests.
    pub fn set_wait_timing(&self, base: Duration, limit: Duration) {
        let ms = |d: Duration| u64::try_from(d.as_millis()).unwrap_or(u64::MAX).max(1);
        self.wait_base_ms.store(ms(base), Ordering::Relaxed);
        self.wait_limit_ms.store(ms(limit), Ordering::Relaxed);
    }

    /// Makes every `.part` act as one on a file system that cannot leave
    /// holes, so no file splits. Used by tests.
    pub fn set_no_holes(&self, on: bool) {
        self.no_holes.store(on, Ordering::Relaxed);
    }

    pub(crate) fn no_holes(&self) -> bool {
        self.no_holes.load(Ordering::Relaxed)
    }

    /// Makes every sidecar save of a split file take `extra` longer, the
    /// way a slow disk's sync does. Used by tests.
    pub fn set_slow_sync(&self, extra: Duration) {
        let ms = u64::try_from(extra.as_millis()).unwrap_or(u64::MAX);
        self.slow_sync_ms.store(ms, Ordering::Relaxed);
    }

    pub(crate) fn slow_sync(&self) -> Duration {
        Duration::from_millis(self.slow_sync_ms.load(Ordering::Relaxed))
    }

    /// Shortens how long a playback report counts. Used by tests.
    pub fn set_playback_lease(&self, lease: Duration) {
        let ms = u64::try_from(lease.as_millis()).unwrap_or(u64::MAX).max(1);
        self.lease_ms.store(ms, Ordering::Relaxed);
    }

    fn playback_lease(&self) -> Duration {
        match self.lease_ms.load(Ordering::Relaxed) {
            0 => PLAYBACK_LEASE,
            ms => Duration::from_millis(ms),
        }
    }

    fn wait_timing(&self) -> (Duration, Duration) {
        let read = |a: &AtomicU64, d: Duration| match a.load(Ordering::Relaxed) {
            0 => d,
            ms => Duration::from_millis(ms),
        };
        (
            read(&self.wait_base_ms, WAIT_BASE),
            read(&self.wait_limit_ms, WAIT_LIMIT),
        )
    }

    /// Books a run's outcome against its source. A `Requeue` blocks the
    /// source for the next backoff step and keeps the row's waiting clock,
    /// or becomes `Failed` once the row waited [`WAIT_LIMIT`] without new
    /// bytes. Bytes from the source (a completed or progressing run, one
    /// that yielded to playback included) end its streak and the row's
    /// waiting clock. A `Respread` books nothing: the copy was at fault,
    /// not the source, and the retired verdict keeps the row off it.
    fn settle(&self, id: i64, source: &str, outcome: Outcome) -> Outcome {
        let now = Instant::now();
        let (base, limit) = self.wait_timing();
        let mut inner = self.inner.lock();
        let Outcome::Requeue {
            reason,
            message,
            bytes,
            progressed,
            part,
        } = outcome
        else {
            if matches!(
                outcome,
                Outcome::Completed { .. }
                    | Outcome::Stopped {
                        reason: StopReason::Yield,
                        progressed: true,
                        ..
                    }
            ) {
                inner.streaks.remove(source);
            }
            if !matches!(
                outcome,
                Outcome::Stopped {
                    reason: StopReason::Yield,
                    progressed: false,
                    ..
                }
            ) {
                inner.waiting_since.remove(&id);
            }
            return outcome;
        };
        if progressed {
            inner.streaks.remove(source);
            inner.waiting_since.remove(&id);
        }
        let since = *inner.waiting_since.entry(id).or_insert(now);
        if now.duration_since(since) >= limit {
            inner.waiting_since.remove(&id);
            return Outcome::Failed {
                message,
                bytes,
                keep_part: true,
                part,
            };
        }
        let step = inner.streaks.get(source).copied().unwrap_or(0);
        inner
            .streaks
            .insert(source.to_string(), step.saturating_add(1));
        let factor = WAIT_STEPS[(step as usize).min(WAIT_STEPS.len() - 1)];
        let delay = base.saturating_mul(factor);
        inner.blocked.insert(
            source.to_string(),
            Block {
                until: now + delay,
                until_wall: chrono::Utc::now()
                    + chrono::Duration::from_std(delay).unwrap_or_default(),
                reason,
            },
        );
        Outcome::Requeue {
            reason,
            message,
            bytes,
            progressed,
            part,
        }
    }

    /// Lets downloads from `source` try again now instead of waiting out
    /// the backoff (the user asked for one with Download next).
    pub fn unblock(&self, source: &str) {
        self.inner.lock().blocked.remove(source);
    }

    /// The last account check of `source` when it is younger than
    /// [`crate::account::FORCE_MIN_AGE`]: whether its credentials worked.
    pub fn recent_check(&self, source: &str) -> Option<bool> {
        self.checked
            .lock()
            .get(source)
            .filter(|(at, _)| at.elapsed() < crate::account::FORCE_MIN_AGE)
            .map(|(_, ok)| *ok)
    }

    pub fn note_check(&self, source: &str, ok: bool) {
        self.checked
            .lock()
            .insert(source.to_string(), (Instant::now(), ok));
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
        if matches!(reason, StopReason::Cancel | StopReason::Detach) {
            inner.respread.retain(|(r, _)| *r != id);
        }
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
            inner.queued_from.remove(&id);
            inner.waiting_since.remove(&id);
            inner.forget(id);
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
        StopReason::Yield => 0,
        StopReason::Pause => 1,
        StopReason::Detach => 2,
        StopReason::Cancel => 3,
    }
}

/// The runtime singleton (created on first use).
pub fn manager(state: &AppState) -> Arc<DownloadManager> {
    state.ext_or_insert_with(EXT_KEY, || Arc::new(DownloadManager::default()))
}

/// Ties the runtime to its state (`init`), for the callers that only have a
/// `&AppState`.
pub fn bind(state: &Arc<AppState>) {
    let _ = manager(state).state.set(Arc::downgrade(state));
}

/// Pumps the queue of the runtime bound to `state`, if any.
fn kick(state: &AppState) {
    let mgr = manager(state);
    if let Some(state) = mgr.state.get().and_then(Weak::upgrade) {
        pump(&state, &mgr);
    }
}

/// Adds `id` (downloading from `source`) to the queue, no duplicates, and
/// starts transfers up to each source's budget.
pub fn enqueue(state: &Arc<AppState>, id: i64, source: &str) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        if !inner.active.contains_key(&id) && !inner.queue.contains(&id) {
            inner.queue.push_back(id);
            inner.queued_from.insert(id, source.to_string());
            mgr.publish(&inner);
        }
    }
    pump(state, &mgr);
}

/// [`enqueue`] at the head of the queue, for a download the user resumes,
/// retries or asks for next, or one that yielded: it takes the next free
/// connection instead of waiting behind the rest. An id already queued
/// moves to the front; a running one is left alone.
pub fn enqueue_front(state: &Arc<AppState>, id: i64, source: &str) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        if !inner.active.contains_key(&id) {
            if let Some(pos) = inner.queue.iter().position(|q| *q == id) {
                inner.queue.remove(pos);
            }
            inner.queue.push_front(id);
            inner.queued_from.insert(id, source.to_string());
            mgr.publish(&inner);
        }
    }
    pump(state, &mgr);
}

/// How a run was placed, for its claim ([`claim`]).
struct Start {
    /// The row's origin as the runtime knew it when it placed the run.
    origin: Option<CopyRef>,
    /// The run downloads an equivalent copy that becomes the row's origin.
    adopt: bool,
    /// Fingerprint the home source's other queued rows first
    /// ([`spread::fingerprint_batch`]).
    batch: bool,
}

/// Starts every queued id whose home source has a free connection (in
/// queue order, so one source at its limit never holds up another), or,
/// when it has none, a source with room and an identical copy (queue
/// spreading). Asks transfers over their source's budget to yield, and arms
/// a wake-up for the next time a budget can grow. Returns the done signals
/// of the transfers asked to yield.
///
/// The cap is per source: a source with an unknown limit runs at most
/// [`MAX_CONCURRENT`] files, one with a known limit what its budget gives,
/// and the queue as a whole as many as its sources have room for.
fn pump(
    state: &Arc<AppState>,
    mgr: &Arc<DownloadManager>,
) -> Vec<tokio::sync::watch::Receiver<bool>> {
    let now = Instant::now();
    let policy = Policy::of(&state.settings.read());
    let mut starts = Vec::new();
    let mut loads = Vec::new();
    let mut plan_loads = Vec::new();
    let (yielding, wake) = {
        let mut inner = mgr.inner.lock();
        inner.expire(now);
        let mut i = 0;
        while i < inner.queue.len() {
            let id = inner.queue[i];
            let own = inner.queued_from.get(&id).cloned().unwrap_or_default();
            let origin = inner.origins.get(&id).cloned();
            let home = origin
                .as_ref()
                .map_or_else(|| own.clone(), |o| o.source_id().to_string());
            inner.request_load(&home, &mut loads);
            let place = if inner.has_room(&home, now, &policy) {
                Some((home.clone(), origin.clone(), false))
            } else if policy.use_mirrors {
                inner.spread_pick(id, &home, now, &policy, &mut loads, &mut plan_loads)
            } else {
                None
            };
            let Some((source, copy, adopt)) = place else {
                i += 1;
                continue;
            };
            inner.queue.remove(i);
            inner.queued_from.remove(&id);
            inner.plans.remove(&id);
            let batch = policy.use_mirrors
                && source == home
                && origin.is_none()
                && !inner.batched.contains(&id)
                && inner
                    .queue
                    .iter()
                    .any(|q| inner.home(*q) == Some(home.as_str()));
            let ctl = Arc::new(TaskCtl::placed(inner.started, source, own, copy));
            if let Some(note) = inner.carried.remove(&id) {
                ctl.push_note(note);
            }
            inner.started += 1;
            inner.active.insert(id, ctl.clone());
            starts.push((
                id,
                ctl,
                Start {
                    origin,
                    adopt,
                    batch,
                },
            ));
        }
        mgr.publish(&inner);
        (inner.preempt(now, &policy), inner.arm_wake(now))
    };
    for (id, ctl, start) in starts {
        tokio::spawn(run_task(state.clone(), mgr.clone(), id, ctl, start));
    }
    for load in loads {
        tokio::spawn(load_source(state.clone(), mgr.clone(), load));
    }
    if !plan_loads.is_empty() {
        tokio::spawn(spread::load_plans(state.clone(), mgr.clone(), plan_loads));
    }
    if let Some(at) = wake {
        let state = Arc::downgrade(state);
        tokio::spawn(async move {
            tokio::time::sleep_until(at.into()).await;
            let Some(state) = state.upgrade() else {
                return;
            };
            let mgr = manager(&state);
            mgr.inner.lock().wake_at = None;
            pump(&state, &mgr);
        });
    }
    yielding
}

/// Reads what `load` lists about its source: the connection limit from
/// its cached account status (every Xtream sync and account check
/// refreshes it), and whether probes apply to it and what they learned.
/// Fills only what is still loading (a status stored meanwhile by
/// [`account_changed`], or a record a probe wrote, is newer), then pumps.
/// A read that fails counts as no limit and no record, as a missing status
/// does.
async fn load_source(state: Arc<AppState>, mgr: Arc<DownloadManager>, load: Load) {
    let Load {
        source,
        limit: want_limit,
        info: want_info,
    } = load;
    let sid = source.clone();
    let read = state
        .db_call(move |c| {
            let limit = if want_limit {
                crate::account::load(c, &sid)?
                    .and_then(|s| s.max_connections)
                    .filter(|m| *m > 0)
            } else {
                None
            };
            let info = if want_info {
                let kind: Option<String> = c
                    .query_row("SELECT kind FROM sources WHERE id = ?1", [&sid], |r| {
                        r.get(0)
                    })
                    .optional()?;
                let probeable = matches!(
                    kind.as_deref().map(SourceKind::from_str),
                    Some(Ok(SourceKind::Xtream | SourceKind::Stalker))
                );
                let record = if probeable {
                    read_record::<LimitRecord>(c, &limit_key(&sid))?
                } else {
                    None
                };
                Some((probeable, record))
            } else {
                None
            };
            Ok((limit, info))
        })
        .await;
    let (limit, info) = match read {
        Ok(read) => read,
        Err(err) => {
            tracing::warn!(source, error = %err, "could not read the source's connection limit");
            (None, Some((false, None)))
        }
    };
    {
        let mut inner = mgr.inner.lock();
        if want_limit {
            if let Some(entry @ Limit::Loading) = inner.limits.get_mut(&source) {
                *entry = Limit::Known(limit);
            }
        }
        if let (true, Some((probeable, record))) = (want_info, info) {
            if let Some(entry @ Info::Loading) = inner.info.get_mut(&source) {
                *entry = Info::Known { probeable, record };
            }
        }
    }
    pump(&state, &mgr);
}

/// A new account status was stored: downloads from that source follow its
/// connection limit from now on.
pub fn account_changed(state: &AppState, status: &crate::account::AccountStatus) {
    let limit = status.max_connections.filter(|m| *m > 0);
    manager(state)
        .inner
        .lock()
        .limits
        .insert(status.source_id.clone(), Limit::Known(limit));
    kick(state);
}

/// Waits (up to [`MAKE_ROOM_WAIT`]) for transfers asked to yield to let go,
/// for transfers holding connections on `source` (their own or a mirror) to
/// give back the ones they may no longer hold, and for a probe round there
/// to close, plus [`YIELD_GRACE`] when anything had to.
async fn wait_yielded(
    mgr: &DownloadManager,
    source: Option<&str>,
    done: Vec<tokio::sync::watch::Receiver<bool>>,
) {
    let deadline = tokio::time::Instant::now() + MAKE_ROOM_WAIT;
    let mut waited = !done.is_empty();
    let all = futures::future::join_all(done.into_iter().map(|mut rx| async move {
        let _ = rx.wait_for(|d| *d).await;
    }));
    let _ = tokio::time::timeout_at(deadline, all).await;
    if let Some(source) = source {
        while (mgr.over_allowance(source) || mgr.is_probing(source))
            && tokio::time::Instant::now() < deadline
        {
            waited = true;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    if waited {
        tokio::time::sleep(YIELD_GRACE).await;
    }
}

/// `downloads.playback`: the sources one player (`client`) is playing from
/// now; empty when it stopped. Downloads over a source's budget yield, and
/// this returns once they let go of their connections (at most
/// [`MAKE_ROOM_WAIT`]). The report lapses after [`PLAYBACK_LEASE`] unless
/// renewed, so a closed window never holds downloads back for long.
pub async fn set_playback(state: &Arc<AppState>, client: &str, sources: Vec<String>) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        let now = Instant::now();
        let before = if sources.is_empty() {
            inner.leases.remove(client)
        } else {
            let until = now + mgr.playback_lease();
            inner.leases.insert(
                client.to_string(),
                Lease {
                    sources: sources.clone(),
                    until,
                },
            )
        };
        // The player still holds the streams it reported last when this
        // returns: each entry of that report the new one no longer has (a
        // source it left, one of a wall's two tiles on a source) stays its
        // own a moment longer.
        let before = before
            .filter(|l| l.until > now)
            .map(|l| l.sources)
            .unwrap_or_default();
        let mut kept: Vec<&String> = sources.iter().collect();
        for source in &before {
            match kept.iter().position(|s| *s == source) {
                Some(i) => {
                    kept.swap_remove(i);
                }
                None => inner.released.add(source, now + RELEASE_GRACE),
            }
        }
    }
    let done = pump(state, &mgr);
    let first = sources.first().map(String::as_str);
    wait_yielded(&mgr, first, done).await;
    for source in sources.iter().skip(1) {
        wait_yielded(&mgr, Some(source), Vec::new()).await;
    }
}

/// A stream the media proxy has open from a source; it counts as playback
/// until dropped, and for [`STREAM_LINGER`] after.
pub struct StreamHold {
    state: Weak<AppState>,
    source: String,
}

impl Drop for StreamHold {
    fn drop(&mut self) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let mgr = manager(&state);
        {
            let mut inner = mgr.inner.lock();
            if let Some(n) = inner.streams.get_mut(&self.source) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    inner.streams.remove(&self.source);
                }
            }
            inner
                .lingering
                .insert(self.source.clone(), Instant::now() + STREAM_LINGER);
        }
        pump_if_running(&state, &mgr);
    }
}

/// [`pump`] from a `Drop`: it spawns tasks, which needs a runtime (gone
/// once the app is shutting down).
fn pump_if_running(state: &Arc<AppState>, mgr: &Arc<DownloadManager>) {
    if tokio::runtime::Handle::try_current().is_ok() {
        pump(state, mgr);
    }
}

/// Called by the media proxy before it opens a stream from `source`: the
/// stream counts as playback while the returned hold lives, and downloads
/// holding the connection it needs yield first (this waits up to
/// [`MAKE_ROOM_WAIT`] for them), so the stream's own request does not meet
/// a full account.
pub async fn open_stream(state: &Arc<AppState>, source: &str) -> StreamHold {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        *inner.streams.entry(source.to_string()).or_default() += 1;
        inner
            .lingering
            .insert(source.to_string(), Instant::now() + STREAM_LINGER);
    }
    let done = pump(state, &mgr);
    wait_yielded(&mgr, Some(source), done).await;
    StreamHold {
        state: Arc::downgrade(state),
        source: source.to_string(),
    }
}

/// A recording writing from a source; it takes one of the source's
/// connections from downloads until dropped.
pub struct RecordingHold {
    state: Weak<AppState>,
    source: String,
}

impl Drop for RecordingHold {
    fn drop(&mut self) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let mgr = manager(&state);
        {
            let mut inner = mgr.inner.lock();
            if let Some(n) = inner.recordings.get_mut(&self.source) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    inner.recordings.remove(&self.source);
                }
                // The recording's connection closed a moment ago, and the
                // panel still counts it.
                inner
                    .ended
                    .add(&self.source, Instant::now() + RELEASE_GRACE);
            }
        }
        pump_if_running(&state, &mgr);
    }
}

/// Counts a recording from `source` against its downloads' budget until the
/// hold is dropped; downloads over it yield and the recording waits for them
/// (at most [`MAKE_ROOM_WAIT`]).
pub async fn hold_recording(state: &Arc<AppState>, source: &str) -> RecordingHold {
    let mgr = manager(state);
    *mgr.inner
        .lock()
        .recordings
        .entry(source.to_string())
        .or_default() += 1;
    let done = pump(state, &mgr);
    wait_yielded(&mgr, Some(source), done).await;
    RecordingHold {
        state: Arc::downgrade(state),
        source: source.to_string(),
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

/// Takes one from `n` when it is above zero. A compare-exchange loop rather
/// than `fetch_update`, which newer Rust deprecates for `try_update`, a name
/// the MSRV (1.90) does not have.
fn take_one(n: &AtomicU32) -> bool {
    let mut cur = n.load(Ordering::Relaxed);
    while cur > 0 {
        match n.compare_exchange_weak(cur, cur - 1, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return true,
            Err(now) => cur = now,
        }
    }
    false
}

/// What a claim found.
enum Claim {
    /// The row is `downloading` now; this run owns it.
    Claimed,
    /// The row is no longer queued (paused, canceled or removed meanwhile).
    NotQueued,
    /// The row's origin is not the one the run was placed for (a restart
    /// left one, or a reset cleared it): it goes back to the queue with the
    /// stored one.
    Misplaced(Option<CopyRef>),
    /// The run would adopt an equivalent copy, but the row has bytes of its
    /// own by now.
    Stale,
    /// The run stopped before its claim (a stop request during the
    /// fingerprint batch).
    Interrupted,
}

/// The conditional `queued -> downloading` claim, retried with backoff a
/// few times when the database is busy or briefly unavailable. In the same
/// write it checks the row's origin against the run's placement and, for a
/// run that adopts an equivalent copy, stores that copy as the origin.
async fn claim(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    id: i64,
    ctl: &Arc<TaskCtl>,
    start: &Start,
) -> CoreResult<Claim> {
    if let Some(copy) = ctl
        .copy
        .as_ref()
        .filter(|c| Some(*c) != start.origin.as_ref())
    {
        if mgr.inner.lock().braked(id, copy) {
            return Ok(Claim::Stale);
        }
    }
    let mut attempt = 0;
    loop {
        let simulated = take_one(&mgr.failing_claims);
        let claimed = if simulated {
            Err(CoreError::Timeout("simulated claim failure".into()))
        } else {
            let claim_ctl = ctl.clone();
            let (origin, adopt) = (start.origin.clone(), start.adopt);
            state
                .db_write(move |c| {
                    let d = store::get(c, id)?.download;
                    claim_ctl.set_rate_limit(d.rate_limit_bps);
                    if d.status != DownloadStatus::Queued {
                        return Ok(Claim::NotQueued);
                    }
                    if d.origin != origin {
                        return Ok(Claim::Misplaced(d.origin));
                    }
                    // A run on another copy needs a row that may move; one
                    // adopting an equivalent copy, a fresh row.
                    let elsewhere = claim_ctl.copy.is_some() && claim_ctl.copy != origin;
                    if elsewhere && !spread::may_move(&d) || adopt && !spread::is_fresh(&d) {
                        return Ok(Claim::Stale);
                    }
                    let tx = c.transaction()?;
                    if !store::transition(
                        &tx,
                        id,
                        &[DownloadStatus::Queued],
                        DownloadStatus::Downloading,
                        None,
                    )? {
                        return Ok(Claim::NotQueued);
                    }
                    if adopt {
                        store::set_origin(&tx, id, claim_ctl.copy.as_ref())?;
                    }
                    tx.commit()?;
                    Ok(Claim::Claimed)
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

async fn run_task(
    state: Arc<AppState>,
    mgr: Arc<DownloadManager>,
    id: i64,
    ctl: Arc<TaskCtl>,
    start: Start,
) {
    if start.batch {
        spread::fingerprint_batch(&state, &mgr, id, &ctl).await;
    }
    let mut retry_later = false;
    // A run that never started goes straight back to the front of the
    // queue, unless the user stopped it meanwhile.
    let mut again = false;
    // Bytes and `.part` of a run that goes back to the queue, and whether
    // it waits for its source (else it yielded).
    let mut back: Option<(i64, Option<std::path::PathBuf>, bool)> = None;
    let claimed = if ctl.token.is_cancelled() {
        Ok(Claim::Interrupted)
    } else {
        claim(&state, &mgr, id, &ctl, &start).await
    };
    let unstopped = || matches!(*ctl.reason.lock(), None | Some(StopReason::Yield));
    match claimed {
        Ok(Claim::Claimed) => {
            if start.adopt {
                if let Some(copy) = &ctl.copy {
                    mgr.inner.lock().origins.insert(id, copy.clone());
                }
            }
            state.emit("downloads.update", serde_json::json!({}));
            spread::preresolve_next(&state, &mgr);
            let elsewhere = ctl
                .copy
                .as_ref()
                .filter(|c| c.source_id() != ctl.row_source);
            let gone = match elsewhere {
                Some(copy) => copy_gone(&state, &mgr, id, &ctl, copy).await,
                None => None,
            };
            // A panic in the transfer must still free the concurrency slot
            // and leave the row in a final state.
            let run = futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(
                transfer::run(&state, id, &ctl, &mgr),
            ));
            let mut outcome = match gone {
                Some(outcome) => outcome,
                None => match run.await {
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
                },
            };
            // A stop request can escalate after the transfer returned.
            if let Outcome::Stopped { reason, .. } = &mut outcome {
                *reason = ctl.reason();
            }
            let outcome = mgr.settle(id, &ctl.source, outcome);
            {
                let mut inner = mgr.inner.lock();
                match (&outcome, &ctl.copy) {
                    (Outcome::Respread { .. }, Some(copy)) => {
                        inner.respread.insert((id, copy.clone()));
                    }
                    (Outcome::Completed { .. }, _) => inner.respread.retain(|(r, _)| *r != id),
                    _ => {}
                }
            }
            let outcome = drop_origin_bytes(&state, &mgr, id, &ctl, outcome).await;
            back = match &outcome {
                Outcome::Stopped {
                    reason: StopReason::Yield,
                    bytes,
                    part,
                    ..
                } => Some((*bytes, part.clone(), false)),
                Outcome::Requeue { bytes, part, .. } => Some((*bytes, part.clone(), true)),
                // The copy was at fault, not a source: straight back to the
                // front.
                Outcome::Respread { bytes, .. } => Some((*bytes, part_of(&state, id).await, false)),
                _ => None,
            };
            persist_outcome(&state, id, outcome).await;
        }
        Ok(Claim::NotQueued) => tracing::debug!(id, "download no longer queued; skipping"),
        Ok(Claim::Interrupted) => again = unstopped(),
        Ok(Claim::Misplaced(origin)) => {
            tracing::debug!(id, "download placed for another origin; queueing it again");
            let mut inner = mgr.inner.lock();
            match origin {
                Some(o) => inner.origins.insert(id, o),
                None => inner.origins.remove(&id),
            };
            inner.plans.remove(&id);
            drop(inner);
            again = unstopped();
        }
        Ok(Claim::Stale) => {
            mgr.inner.lock().plans.remove(&id);
            again = unstopped();
        }
        Err(err) => {
            // The row is still `queued` in the database: dropping the id
            // would leave it waiting with no task until the next launch. A
            // yield asked for meanwhile does not change that; a user's stop
            // does, and the RPC that asked for it saves it.
            let delay = mgr.claim_retry();
            tracing::error!(id, error = %err, ?delay, "could not claim download; queueing it again later");
            retry_later = unstopped();
        }
    }
    // A row that yielded goes back to the front of the queue, and one that
    // waits for its source behind its home's other queued rows: a file that
    // keeps failing (one broken file answering 5xx) must not take the
    // source's connection first each time the wait ends while good files
    // wait behind it. Unless the user stopped it meanwhile: their pause,
    // cancel or remove wins, and is saved before they hear back. A run
    // spread to another source goes back as a row of its own source.
    let mut overruled = None;
    {
        let mut inner = mgr.inner.lock();
        inner.active.remove(&id);
        let mut queued = false;
        if let Some((bytes, part, waits)) = back.take() {
            match *ctl.reason.lock() {
                Some(r) if r != StopReason::Yield => overruled = Some((r, (bytes, part))),
                _ => {
                    let at = if waits {
                        let home = inner
                            .origins
                            .get(&id)
                            .map_or(ctl.row_source.as_str(), CopyRef::source_id)
                            .to_string();
                        inner
                            .queue
                            .iter()
                            .rposition(|q| inner.home(*q) == Some(home.as_str()))
                            .map_or(0, |i| i + 1)
                    } else {
                        0
                    };
                    inner.queue.insert(at, id);
                    queued = true;
                }
            }
        } else if again {
            inner.queue.push_front(id);
            queued = true;
        }
        if queued {
            inner.queued_from.insert(id, ctl.row_source.clone());
        } else if !retry_later {
            inner.forget(id);
        }
        mgr.publish(&inner);
    }
    if let Some((reason, (bytes, part))) = overruled {
        mgr.inner.lock().waiting_since.remove(&id);
        persist_outcome(
            &state,
            id,
            Outcome::Stopped {
                reason,
                bytes,
                part,
                progressed: false,
            },
        )
        .await;
    }
    ctl.done.send_replace(true);
    state.emit("downloads.update", serde_json::json!({}));
    if retry_later {
        let (state, delay, source) = (state.clone(), mgr.claim_retry(), ctl.row_source.clone());
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            enqueue_front(&state, id, &source);
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
                    ..
                } => match reason {
                    StopReason::Pause | StopReason::Detach => {
                        store::finish(c, id, DownloadStatus::Paused, bytes, None)
                    }
                    StopReason::Yield => store::requeue(c, id, bytes).map(|_| ()),
                    StopReason::Cancel => {
                        if let Some(part) = part {
                            if let Err(e) = super::segments::remove_part(&part) {
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
                            if super::segments::remove_part(&part).is_ok() {
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
                Outcome::Requeue { bytes, .. } => store::requeue(c, id, bytes).map(|_| ()),
                Outcome::Respread { message, bytes } => {
                    tracing::info!(id, bytes, message = %message, "download goes back to the queue");
                    store::requeue(c, id, bytes).map(|_| ())
                }
            }
        })
        .await
}

/// The `.part` row `id` writes, when it has a destination.
async fn part_of(state: &Arc<AppState>, id: i64) -> Option<std::path::PathBuf> {
    let path = state
        .db_call(move |c| Ok(store::get(c, id)?.download.file_path))
        .await
        .ok()??;
    Some(super::naming::part_path(std::path::Path::new(&path)))
}

/// Resolves the copy a run on another source downloads (a spread copy, or
/// the row's origin) before its transfer starts, unless it was resolved
/// ahead. A copy that is gone (its source removed, or the title gone from
/// that catalog) is final for that copy: the verdict between it and the
/// row's base (its origin, else its own copy) is retired and the run ends
/// as a `Respread`, so the row goes back at once instead of
/// waiting for a source that will never have it. Any other failure is left
/// to the transfer, which resolves again and waits for the source.
async fn copy_gone(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    id: i64,
    ctl: &TaskCtl,
    copy: &CopyRef,
) -> Option<Outcome> {
    let ready = matches!(
        mgr.inner.lock().preresolved.get(&id),
        Some(spread::Pre::Ready { at, ep, .. }) if ep.copy == *copy && at.elapsed() <= PRERESOLVE_TTL
    );
    if ready {
        return None;
    }
    let resolved = tokio::select! {
        // The transfer sees the stop at once.
        _ = ctl.token.cancelled() => return None,
        r = super::shared::resolve(state, copy) => r,
    };
    match resolved {
        Ok(ep) => {
            mgr.inner.lock().preresolved.insert(
                id,
                spread::Pre::Ready {
                    at: Instant::now(),
                    ep,
                    own: false,
                },
            );
            None
        }
        Err(CoreError::NotFound(why)) => {
            let d = state
                .db_call(move |c| store::get(c, id))
                .await
                .ok()?
                .download;
            // The run compared the copy with the row's base: its origin,
            // else its own copy.
            let own = CopyRef::new(d.item_ref, d.episode_id);
            let base = d.origin.filter(|o| o != copy).unwrap_or(own);
            super::mirrors::record_mismatch(state, &base, copy, false).await;
            Some(Outcome::Respread {
                message: format!("The copy on another source is gone: {why}."),
                bytes: d.bytes_downloaded,
            })
        }
        Err(_) => None,
    }
}

/// Discards what row `id` holds: its `.part` and sidecar go, and the row
/// loses its destination, progress and origin (the path a failed run that
/// keeps no `.part` takes), so its next run starts over from its own copy.
fn discard_bytes(c: &rusqlite::Connection, id: i64) -> CoreResult<()> {
    if let Some(path) = store::get(c, id)?.download.file_path {
        let part = super::naming::part_path(std::path::Path::new(&path));
        if let Err(e) = super::segments::remove_part(&part) {
            tracing::warn!(id, error = %e, "could not delete the partial download");
        }
    }
    store::clear_destination(c, id)
}

/// Ends a run whose bytes came from a copy the row may no longer trust:
/// a `Respread` on the row's origin (the file it adopted changed since it
/// was checked, or is gone), or any run of a row whose origin's source was
/// removed meanwhile ([`forget_source`]). The row discards those bytes
/// ([`discard_bytes`]) and forgets its origin, and its next run, at the
/// front of the queue, starts over from its own copy. A completed run, and
/// every other one, passes unchanged.
async fn drop_origin_bytes(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    id: i64,
    ctl: &TaskCtl,
    outcome: Outcome,
) -> Outcome {
    let (changed, removed) = {
        let mut inner = mgr.inner.lock();
        let on_origin = ctl.copy.is_some() && inner.origins.get(&id) == ctl.copy.as_ref();
        (
            on_origin && matches!(outcome, Outcome::Respread { .. }),
            inner.discard.remove(&id),
        )
    };
    if !(changed || removed) || matches!(outcome, Outcome::Completed { .. }) {
        return outcome;
    }
    let source = ctl.copy.as_ref().map_or("", CopyRef::source_id).to_string();
    tracing::info!(
        id,
        source,
        "the copy this download started from changed or is gone; it starts over from its own copy"
    );
    if let Err(err) = state.db_call(move |c| discard_bytes(c, id)).await {
        tracing::warn!(id, error = %err, "could not reset the download");
    }
    {
        let mut inner = mgr.inner.lock();
        inner.origins.remove(&id);
        inner.plans.remove(&id);
        inner.preresolved.remove(&id);
        if changed {
            inner
                .carried
                .insert(id, TransferNote::MirrorMismatch { source_id: source });
        }
    }
    match outcome {
        Outcome::Stopped {
            reason: reason @ (StopReason::Pause | StopReason::Detach | StopReason::Cancel),
            ..
        } => Outcome::Stopped {
            reason,
            bytes: 0,
            part: None,
            progressed: false,
        },
        Outcome::Failed { message, .. } => Outcome::Failed {
            message,
            bytes: 0,
            keep_part: false,
            part: None,
        },
        Outcome::Respread { message, .. } | Outcome::Requeue { message, .. } => {
            Outcome::Respread { message, bytes: 0 }
        }
        _ => Outcome::Respread {
            message: "The source of the copy this download started from was removed.".into(),
            bytes: 0,
        },
    }
}

/// Releases the rows whose origin is a copy on source `source`, inside the
/// source's delete transaction: their bytes belong to a copy that goes
/// away, so each discards them ([`discard_bytes`]) and starts over from its
/// own copy. A completed row only forgets its origin (its file is whole); a
/// running one is left to its run, which [`forget_source`] stops.
pub fn release_origins(conn: &rusqlite::Connection, source: &str) -> CoreResult<()> {
    let rows = conn
        .prepare("SELECT id, status, origin_json FROM downloads WHERE origin_json IS NOT NULL")?
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, status, json) in rows {
        let Ok(origin) = serde_json::from_str::<CopyRef>(&json) else {
            continue;
        };
        if origin.source_id() != source {
            continue;
        }
        if status == DownloadStatus::Completed.as_str() {
            store::set_origin(conn, id, None)?;
        } else if status != DownloadStatus::Downloading.as_str() {
            discard_bytes(conn, id)?;
        }
    }
    Ok(())
}

/// Source `source` was removed (after [`release_origins`] ran in its
/// delete): queued rows whose origin was there start from their own copy,
/// running ones stop, discard the bytes they held from it and go back to
/// the front of the queue, and runs spread to a copy there stop and go
/// back as rows of their own source.
pub fn forget_source(state: &AppState, source: &str) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        let bound: Vec<i64> = inner
            .origins
            .iter()
            .filter(|(_, o)| o.source_id() == source)
            .map(|(id, _)| *id)
            .collect();
        for id in bound {
            match inner.active.get(&id).cloned() {
                Some(ctl) => {
                    inner.discard.insert(id);
                    ctl.request_yield();
                }
                None => {
                    inner.origins.remove(&id);
                }
            }
        }
        for ctl in inner.active.values() {
            if ctl.copy.as_ref().is_some_and(|c| c.source_id() == source) {
                ctl.request_yield();
            }
        }
        // Plans and endpoints resolved ahead may name its copies.
        inner.plans.clear();
        inner.preresolved.retain(
            |_, p| !matches!(p, spread::Pre::Ready { ep, .. } if ep.copy.source_id() == source),
        );
    }
    kick(state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_limit_inherits_or_overrides_the_live_default() {
        let ctl = TaskCtl::new(0, "test".into());
        assert_eq!(ctl.rate_limit(1024), Some(1024));
        assert_eq!(ctl.rate_limit(2048), Some(2048));
        assert_eq!(ctl.rate_limit(0), None);
        ctl.set_rate_limit(Some(4096));
        assert_eq!(ctl.rate_limit(1024), Some(4096));
        assert_eq!(ctl.rate_limit(0), Some(4096));
        ctl.set_rate_limit(Some(0));
        assert_eq!(ctl.rate_limit(1024), None);
        ctl.set_rate_limit(None);
        assert_eq!(ctl.rate_limit(1024), Some(1024));
    }

    #[test]
    fn holdings_sum_into_connections() {
        let ctl = TaskCtl::detached("a");
        assert_eq!(ctl.row_source, "a");
        assert!(ctl.copy.is_none());
        assert_eq!(ctl.holdings(), vec![("a".to_string(), 1)]);
        assert_eq!(ctl.connections(), 1);
        assert!(!ctl.set_held("a", 3));
        assert!(!ctl.set_held("b", 2));
        assert_eq!(ctl.connections(), 5);
        assert_eq!((ctl.held("a"), ctl.held("b"), ctl.held("c")), (3, 2, 0));
        assert!(ctl.set_held("b", 0), "a smaller sum asks for a pump");
        assert_eq!(ctl.holdings(), vec![("a".to_string(), 3)]);
        // The authority keeps its place even at zero.
        assert!(ctl.set_held("a", 0));
        assert!(!ctl.set_held("c", 1));
        assert_eq!(
            ctl.holdings(),
            vec![("a".to_string(), 0), ("c".to_string(), 1)]
        );
        assert_eq!(ctl.connections(), 1);
        assert!(!ctl.set_held("zz", 0));
        assert_eq!(ctl.holdings().len(), 2);
    }

    #[test]
    fn drops_count_per_source() {
        let ctl = TaskCtl::detached("a");
        assert_eq!(ctl.drops("a"), 0);
        ctl.note_drop("a");
        ctl.note_drop("b");
        ctl.note_drop("a");
        assert_eq!((ctl.drops("a"), ctl.drops("b")), (2, 1));
    }

    #[test]
    fn recent_notes_keep_the_last_five() {
        let ctl = TaskCtl::detached("a");
        assert!(ctl.recent_notes().is_empty());
        for limit in 1..=7 {
            ctl.push_note(TransferNote::ProbeAccepted {
                source_id: "a".into(),
                limit,
            });
        }
        let limits: Vec<i64> = ctl
            .recent_notes()
            .into_iter()
            .map(|n| match n {
                TransferNote::ProbeAccepted { limit, .. } => limit,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(limits, vec![3, 4, 5, 6, 7]);
        // A note older than a minute is gone.
        ctl.notes.lock().front_mut().unwrap().0 -= NOTE_TTL + Duration::from_secs(1);
        assert_eq!(ctl.recent_notes().len(), 4);
    }

    #[test]
    fn stats_are_published_per_running_transfer() {
        let mgr = DownloadManager::default();
        assert_eq!(mgr.transfer_stats(1), None);
        let ctl = TaskCtl::detached("a");
        mgr.inner.lock().active.insert(1, ctl.clone());
        assert_eq!(mgr.transfer_stats(1), None);
        let stats = TransferStats {
            id: 1,
            bytes_per_second: 10,
            connections: vec![],
            sources: vec![],
            limiting: None,
            notes: vec![],
        };
        ctl.publish_stats(stats.clone());
        assert_eq!(ctl.stats(), Some(stats.clone()));
        assert_eq!(mgr.transfer_stats(1), Some(stats));
        assert_eq!(mgr.sources_in_use(1), None);
        ctl.set_held("b", 1);
        assert_eq!(mgr.sources_in_use(1), Some(2));
        assert_eq!(mgr.served_by(1), None);
        let mut spread = TaskCtl::new(1, "b".into());
        spread.row_source = "a".into();
        mgr.inner.lock().active.insert(2, Arc::new(spread));
        assert_eq!(mgr.served_by(2).as_deref(), Some("b"));
        assert_eq!(mgr.sources_in_use(9), None);
        assert_eq!(mgr.served_by(9), None);
    }

    fn record(limit: i64) -> LimitRecord {
        LimitRecord {
            version: 1,
            limit,
            reported: Some(1),
            mode: crate::model::ConnectionLimitMode::Refuse,
            probed_at: "2026-11-17T00:00:00Z".into(),
            next_probe_at: "2099-01-01T00:00:00Z".into(),
            history: Vec::new(),
        }
    }

    fn known(mgr: &DownloadManager, source: &str, limit: Option<i64>, learned: Option<i64>) {
        let mut inner = mgr.inner.lock();
        inner.limits.insert(source.into(), Limit::Known(limit));
        inner.info.insert(
            source.into(),
            Info::Known {
                probeable: true,
                record: learned.map(record),
            },
        );
    }

    #[test]
    fn mirror_allowance_gives_way_to_playback_queue_and_refusals() {
        let mgr = DownloadManager::default();
        known(&mgr, "a", Some(1), None);
        known(&mgr, "b", Some(3), None);
        let ctl = TaskCtl::detached("a");
        mgr.inner.lock().active.insert(1, ctl.clone());
        assert_eq!(mgr.allowance_on(&ctl, "a"), mgr.connection_allowance(&ctl));
        // Reported 3 keeps one free: 2 for downloads.
        assert_eq!(mgr.allowance_on(&ctl, "b"), 2);
        assert_eq!(
            mgr.limit_reason(&ctl, "b"),
            Some(Limiting::AccountLimit {
                source_id: "b".into(),
                limit: 3,
            })
        );
        // Its own holding there counts; another transfer's leaves less.
        ctl.set_held("b", 2);
        assert_eq!(mgr.allowance_on(&ctl, "b"), 2);
        let other = TaskCtl::detached("b");
        mgr.inner.lock().active.insert(2, other.clone());
        assert_eq!(mgr.allowance_on(&ctl, "b"), 1);
        assert_eq!(mgr.holders("b"), 2);
        assert_eq!(
            mgr.spare_on("a", "b"),
            0,
            "a new holder gets what is left after both"
        );
        assert_eq!(mgr.spare_on("b", "b"), 0);
        mgr.inner.lock().active.remove(&2);
        assert_eq!(mgr.spare_on("a", "b"), 0, "ctl still holds 2 there");
        ctl.set_held("b", 0);
        assert_eq!(mgr.spare_on("a", "b"), 2);
        let now = Instant::now();
        // Playback on the mirror: nothing.
        mgr.inner.lock().leases.insert(
            "player".into(),
            Lease {
                sources: vec!["b".into()],
                until: now + Duration::from_secs(60),
            },
        );
        assert_eq!(mgr.allowance_on(&ctl, "b"), 0);
        assert_eq!(
            mgr.limit_reason(&ctl, "b"),
            Some(Limiting::Playback {
                source_id: "b".into()
            })
        );
        mgr.inner.lock().leases.clear();
        // A recording: nothing.
        mgr.inner.lock().recordings.insert("b".into(), 1);
        assert_eq!(mgr.allowance_on(&ctl, "b"), 0);
        mgr.inner.lock().recordings.clear();
        // A row queued for that source starts there first.
        {
            let mut inner = mgr.inner.lock();
            inner.queue.push_back(7);
            inner.queued_from.insert(7, "b".into());
        }
        assert_eq!(mgr.allowance_on(&ctl, "b"), 0);
        assert_eq!(
            mgr.limit_reason(&ctl, "b"),
            Some(Limiting::OtherDownloads {
                source_id: "b".into()
            })
        );
        {
            let mut inner = mgr.inner.lock();
            inner.queue.clear();
            inner.queued_from.clear();
        }
        assert_eq!(mgr.allowance_on(&ctl, "b"), 2);
        // A refused mirror connection: two minutes without.
        mgr.mirror_refused("b");
        assert_eq!(mgr.allowance_on(&ctl, "b"), 0);
        assert_eq!(
            mgr.limit_reason(&ctl, "b"),
            Some(Limiting::Refused {
                source_id: "b".into()
            })
        );
        assert!(mgr.try_hold("b", HoldPurpose::Verify).is_none());
        mgr.inner.lock().cooldown.insert("b".into(), now);
        assert_eq!(mgr.allowance_on(&ctl, "b"), 2);
        // A limit still loading: nothing; an unknown one: 1 while unused.
        mgr.inner.lock().limits.insert("c".into(), Limit::Loading);
        assert_eq!(mgr.allowance_on(&ctl, "c"), 0);
        known(&mgr, "d", None, None);
        assert_eq!(mgr.allowance_on(&ctl, "d"), 1);
        let hold = mgr.try_hold("d", HoldPurpose::Fingerprint).unwrap();
        assert_eq!(mgr.allowance_on(&ctl, "d"), 0);
        drop(hold);
        assert_eq!(mgr.allowance_on(&ctl, "d"), 1);
    }

    #[test]
    fn holds_count_against_the_budget() {
        let mgr = DownloadManager::default();
        known(&mgr, "b", Some(2), None);
        let hold = mgr.try_hold("b", HoldPurpose::Verify).unwrap();
        assert_eq!(
            (hold.source.as_str(), hold.purpose),
            ("b", HoldPurpose::Verify)
        );
        assert!(mgr.try_hold("b", HoldPurpose::Verify).is_none(), "budget 1");
        assert_eq!(mgr.inner.lock().used("b"), 1);
        drop(hold);
        assert_eq!(mgr.inner.lock().used("b"), 0);
        assert!(mgr.try_hold("b", HoldPurpose::Fingerprint).is_some());
        // A transfer's mirror connections count on that account too.
        let ctl = TaskCtl::detached("a");
        ctl.set_held("b", 1);
        mgr.inner.lock().active.insert(1, ctl.clone());
        assert_eq!(mgr.inner.lock().used("b"), 1);
        assert!(mgr.try_hold("b", HoldPurpose::Verify).is_none());
        assert_eq!(mgr.allowance_on(&ctl, "b"), 1);
        assert!(!mgr.over_allowance("b"));
        // Playback there wins over the mirror connection.
        mgr.inner.lock().streams.insert("b".into(), 1);
        assert_eq!(mgr.allowance_on(&ctl, "b"), 0);
        assert!(mgr.over_allowance("b"));
    }

    #[test]
    fn learned_limit_raises_the_budget_without_a_reserve() {
        let mgr = DownloadManager::default();
        assert_eq!(mgr.effective_limit("a"), (None, LimitKind::Unknown));
        mgr.inner.lock().limits.insert("b".into(), Limit::Loading);
        assert_eq!(mgr.effective_limit("b"), (None, LimitKind::Unknown));
        known(&mgr, "a", Some(1), None);
        assert_eq!(mgr.effective_limit("a"), (Some(1), LimitKind::Reported));
        let ctl = TaskCtl::detached("a");
        mgr.inner.lock().active.insert(1, ctl.clone());
        assert_eq!(mgr.connection_allowance(&ctl), 1);
        known(&mgr, "a", Some(1), Some(3));
        assert_eq!(mgr.effective_limit("a"), (Some(3), LimitKind::Learned));
        assert_eq!(mgr.connection_allowance(&ctl), 3);
        assert_eq!(mgr.allowance_on(&ctl, "a"), 3);
        // A learned limit at or below the reported one changes nothing.
        known(&mgr, "a", Some(4), Some(3));
        assert_eq!(mgr.effective_limit("a"), (Some(4), LimitKind::Reported));
        assert_eq!(mgr.connection_allowance(&ctl), 3, "4 keeps one free");
    }

    #[test]
    fn preresolved_endpoints_are_taken_once_for_the_right_copy() {
        let mgr = DownloadManager::default();
        assert!(mgr.take_preresolved(1).is_none());
        let own = CopyRef::new(
            crate::model::ItemRef {
                source_id: "a".into(),
                content_type: crate::model::ContentType::Movie,
                item_id: "1".into(),
            },
            None,
        );
        let ep = Endpoint {
            copy: own.clone(),
            kind: SourceKind::Xtream,
            url: "http://127.0.0.1/movie/u/p/1.mp4".into(),
            headers: Default::default(),
        };
        let ready = |at: Instant, own: bool| spread::Pre::Ready {
            at,
            ep: ep.clone(),
            own,
        };
        mgr.inner.lock().active.insert(1, TaskCtl::detached("a"));
        mgr.inner
            .lock()
            .preresolved
            .insert(1, ready(Instant::now(), true));
        assert_eq!(mgr.take_preresolved(1).map(|e| e.copy), Some(own.clone()));
        assert!(mgr.take_preresolved(1).is_none(), "taken once");
        // Too old, or not the copy the run downloads.
        let old = Instant::now() - PRERESOLVE_TTL - Duration::from_secs(1);
        mgr.inner.lock().preresolved.insert(1, ready(old, true));
        assert!(mgr.take_preresolved(1).is_none());
        let spread = TaskCtl::placed(
            1,
            "b".into(),
            "a".into(),
            Some(CopyRef::new(
                crate::model::ItemRef {
                    source_id: "b".into(),
                    content_type: crate::model::ContentType::Movie,
                    item_id: "9".into(),
                },
                None,
            )),
        );
        mgr.inner.lock().active.insert(1, Arc::new(spread));
        mgr.inner
            .lock()
            .preresolved
            .insert(1, ready(Instant::now(), true));
        assert!(mgr.take_preresolved(1).is_none());
    }

    #[test]
    fn a_stopped_queued_row_is_forgotten() {
        let mgr = DownloadManager::default();
        {
            let mut inner = mgr.inner.lock();
            inner.queue.push_back(3);
            inner.queued_from.insert(3, "a".into());
            inner.batched.insert(3);
            inner.plans.insert(3, spread::PlanState::Loading);
        }
        assert!(matches!(mgr.stop(3, StopReason::Pause), Stopped::Dequeued));
        let inner = mgr.inner.lock();
        assert!(inner.plans.is_empty() && inner.batched.is_empty());
    }

    #[test]
    fn preempt_counts_what_transfers_hold_on_a_source() {
        let mgr = DownloadManager::default();
        known(&mgr, "a", Some(1), None);
        known(&mgr, "b", Some(3), None);
        let policy = Policy::of(&Settings::default());
        // The first row of `a` fetches only from mirror `b`: nothing on `a`.
        let mirrored = TaskCtl::detached("a");
        mirrored.set_held("b", 2);
        mirrored.set_held("a", 0);
        let next = TaskCtl::placed(2, "a".into(), "a".into(), None);
        let next = Arc::new(next);
        {
            let mut inner = mgr.inner.lock();
            inner.active.insert(1, mirrored.clone());
            inner.active.insert(2, next.clone());
            assert!(inner.preempt(Instant::now(), &policy).is_empty());
        }
        assert!(!mirrored.token.is_cancelled() && !next.token.is_cancelled());
        // Playback on `a` still makes the transfer holding it yield.
        let now = Instant::now();
        let mut inner = mgr.inner.lock();
        inner.leases.insert(
            "player".into(),
            Lease {
                sources: vec!["a".into()],
                until: now + Duration::from_secs(60),
            },
        );
        assert_eq!(inner.preempt(now, &policy).len(), 1);
        assert_eq!(next.reason(), StopReason::Yield);
        assert!(!mirrored.token.is_cancelled());
    }

    #[test]
    fn probes_need_a_transfer_that_may_split_and_back_off_after_an_abort() {
        let mgr = DownloadManager::default();
        known(&mgr, "a", Some(1), None);
        let ctl = TaskCtl::detached("a");
        mgr.inner.lock().active.insert(1, ctl.clone());
        let with = |f: fn(&mut Settings)| {
            let mut s = Settings::default();
            f(&mut s);
            Policy::of(&s)
        };
        let policy = with(|_| {});
        assert!(mgr.probe_due_with(&ctl, "a", &policy));
        // A speed cap (global or the row's), the source set to one
        // connection, or a run kept to one: no probe.
        assert!(!mgr.probe_due_with(&ctl, "a", &with(|s| s.download_rate_limit_bps = 1024)));
        ctl.set_rate_limit(Some(2048));
        assert!(!mgr.probe_due_with(&ctl, "a", &policy));
        ctl.set_rate_limit(None);
        let single = with(|s| s.download_single_connection = vec!["a".into()]);
        assert!(!mgr.probe_due_with(&ctl, "a", &single));
        ctl.set_one_connection(true);
        assert!(!mgr.probe_due_with(&ctl, "a", &policy));
        ctl.set_one_connection(false);
        assert!(mgr.probe_due_with(&ctl, "a", &policy));
        // An aborted round: none for ten minutes.
        mgr.probe_aborted("a");
        assert!(!mgr.probe_due_with(&ctl, "a", &policy));
        mgr.inner
            .lock()
            .expire(Instant::now() + PROBE_ABORT_BACKOFF);
        assert!(mgr.probe_due_with(&ctl, "a", &policy));
    }

    #[test]
    fn timings_default_and_override() {
        let mgr = DownloadManager::default();
        assert_eq!(
            mgr.ramp_timing(),
            RampTiming {
                gain_window: Duration::from_secs(1),
                recycle_after: Duration::from_secs(10),
            }
        );
        assert_eq!(mgr.probe_timing().step, Duration::from_secs(3));
        assert_eq!(
            mgr.probe_timing().retest_after,
            Duration::from_secs(7 * 24 * 3600)
        );
        mgr.set_ramp_timing(Duration::from_millis(50), Duration::from_millis(500));
        mgr.set_probe_timing(Duration::from_millis(20), Duration::from_secs(1));
        assert_eq!(mgr.ramp_timing().recycle_after, Duration::from_millis(500));
        assert_eq!(mgr.probe_timing().step, Duration::from_millis(20));
    }

    #[test]
    fn learned_budget_keeps_no_connection_free() {
        assert_eq!(learned_download_budget(3, 0, 0), 3);
        assert_eq!(learned_download_budget(3, 1, 1), 1);
        assert_eq!(learned_download_budget(2, 3, 0), 0);
        assert_eq!(learned_download_budget(-1, 0, 0), 0);
        // The reported rule keeps one free on the same account.
        assert_eq!(download_budget(Some(3), 0, 0), 2);
    }
}
