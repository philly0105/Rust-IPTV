//! Segmented transfers: one file over several Range connections.
//!
//! A provider that caps each connection's speed delivers a file N times
//! faster over N connections. A transfer splits the rest of its file into
//! segments only when the first answer is a `206` with a known total and a
//! strong validator, the source's "Connections per download" is Auto, and
//! the source's budget has connections no queued download or playback needs
//! (`DownloadManager::connection_allowance`). Each segment is fetched with
//! `Range` and `If-Range` and written at its place in the `.part` through its
//! own file handle. A sidecar next to the `.part` (`<name>.part.ranges`)
//! records each segment's start, end and how far it got, so a stopped
//! transfer resumes every segment where it was; while it exists, the
//! `.part`'s length means nothing. Any answer that is not the exact range
//! asked for (the file changed, ranges no longer work) drops the partial and
//! restarts the file with one connection. A segment request the provider
//! refuses while another connection works drops the transfer to one.

use super::manager::{DownloadManager, TaskCtl};
use crate::error::CoreError;
use crate::model::RequestHeaders;
use crate::state::AppState;
use bytes::Bytes;
use futures::stream::{BoxStream, FuturesUnordered, StreamExt};
use parking_lot::Mutex;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// Suffix of the sidecar after the `.part` path.
pub const RANGES_SUFFIX: &str = ".ranges";
/// Most connections one file uses.
pub const MAX_CONNECTIONS: usize = 4;
/// Smallest segment worth its own connection: splitting stops below twice
/// this, so the last few seconds of a file never open new connections.
pub const MIN_SEGMENT: i64 = 4 * 1024 * 1024;
/// Bytes a segment buffers before writing at its place in the `.part`.
const WRITE_CHUNK: usize = 256 * 1024;
/// How often the coordinator saves the sidecar, reports progress and
/// re-reads how many connections it may hold.
const TICK: Duration = Duration::from_millis(250);
/// The tick until the first new bytes are reported: like a single stream's
/// first chunk, they show at once where the transfer starts.
const FIRST_TICK: Duration = Duration::from_millis(20);
const SAVE_EVERY: Duration = Duration::from_secs(2);
/// How long a segment's request waits after another connection of the
/// transfer closed: a panel counts a closed connection a moment longer, and
/// a request sooner can be refused.
const CLOSE_GRACE: Duration = Duration::from_millis(300);

/// One segment: bytes `start..end` of the file, written up to `pos`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seg {
    pub start: i64,
    pub end: i64,
    pub pos: i64,
}

impl Seg {
    fn left(&self) -> i64 {
        self.end - self.pos
    }
}

/// The sidecar: what the segments cover and how far each got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ranges {
    pub total: i64,
    pub validator: String,
    pub segments: Vec<Seg>,
}

impl Ranges {
    /// A plan for a file whose first `offset` bytes are already written.
    pub fn new(total: i64, validator: String, offset: i64) -> Self {
        let mut segments = Vec::new();
        if offset > 0 {
            segments.push(Seg {
                start: 0,
                end: offset,
                pos: offset,
            });
        }
        segments.push(Seg {
            start: offset,
            end: total,
            pos: offset,
        });
        Self {
            total,
            validator,
            segments,
        }
    }

    /// Bytes written.
    pub fn done(&self) -> i64 {
        self.segments.iter().map(|s| s.pos - s.start).sum()
    }

    pub fn complete(&self) -> bool {
        self.segments.iter().all(|s| s.pos >= s.end)
    }

    /// Covers `0..total` without gaps or overlaps, every `pos` in its
    /// segment: a sidecar that is not is ignored. An emptied segment (a
    /// refused one handed back to the segment before it) covers nothing and
    /// stays in the plan, since workers address segments by index.
    pub fn is_consistent(&self) -> bool {
        let mut segs: Vec<Seg> = self
            .segments
            .iter()
            .filter(|s| !(s.start == s.end && s.pos == s.start))
            .copied()
            .collect();
        segs.sort_by_key(|s| s.start);
        let mut at = 0;
        for s in &segs {
            if s.start != at || s.end < s.start || s.pos < s.start || s.pos > s.end {
                return false;
            }
            at = s.end;
        }
        at == self.total && self.total > 0
    }

    /// Splits the unfinished segment with the most left in two, when both
    /// halves get at least [`MIN_SEGMENT`]. Returns the new segment's index.
    fn split(&mut self) -> Option<usize> {
        let (i, seg) = self
            .segments
            .iter()
            .enumerate()
            .max_by_key(|(_, s)| s.left())?;
        if seg.left() < 2 * MIN_SEGMENT {
            return None;
        }
        let mid = seg.pos + seg.left() / 2;
        let tail = Seg {
            start: mid,
            end: seg.end,
            pos: mid,
        };
        self.segments[i].end = mid;
        self.segments.push(tail);
        Some(self.segments.len() - 1)
    }
}

/// Sidecar path of a `.part`.
pub fn ranges_path(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_owned();
    s.push(RANGES_SUFFIX);
    PathBuf::from(s)
}

/// What lies next to a `.part`.
#[derive(Debug, PartialEq, Eq)]
pub enum Sidecar {
    /// No sidecar: the `.part` was written in one piece and its length is
    /// what it holds.
    None,
    Valid(Ranges),
    /// A sidecar that cannot be read, does not cover a whole file, or
    /// records bytes past the end of the `.part` (one deleted and reserved
    /// again): neither it nor the `.part`'s length says what was written.
    Invalid,
}

/// The sidecar of `part`.
pub fn load(part: &Path) -> Sidecar {
    let raw = match std::fs::read(ranges_path(part)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Sidecar::None,
        Err(_) => return Sidecar::Invalid,
    };
    let Some(ranges) = serde_json::from_slice::<Ranges>(&raw)
        .ok()
        .filter(Ranges::is_consistent)
    else {
        return Sidecar::Invalid;
    };
    // A segment's bytes reach the `.part` before its `pos` is recorded, so
    // the `.part` is at least as long as the furthest of them.
    let written = ranges
        .segments
        .iter()
        .filter(|s| s.pos > s.start)
        .map(|s| s.pos)
        .max()
        .unwrap_or(0);
    let len = super::naming::regular_file_len(part)
        .ok()
        .flatten()
        .unwrap_or(0);
    if (len as i64) < written {
        return Sidecar::Invalid;
    }
    Sidecar::Valid(ranges)
}

/// Replaces the sidecar of `part` (written beside it, then renamed over it).
pub fn save(part: &Path, ranges: &Ranges) -> io::Result<()> {
    let path = ranges_path(part);
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, serde_json::to_vec(ranges).map_err(io::Error::other)?)?;
    std::fs::rename(&tmp, &path)
}

/// Deletes `part`, then its sidecar once `part` is gone (true when there
/// was a `.part` to delete). A `.part` written in segments has holes: left
/// without its sidecar (deleting it failed, a locked file on Windows), a
/// later run would trust its length.
pub fn remove_part(part: &Path) -> io::Result<bool> {
    let removed = super::naming::remove_regular_file(part)?;
    remove(part);
    Ok(removed)
}

/// Deletes the sidecar of `part` (missing is fine).
pub fn remove(part: &Path) {
    let path = ranges_path(part);
    if let Err(e) = std::fs::remove_file(&path) {
        if e.kind() != io::ErrorKind::NotFound {
            tracing::warn!(error = %e, "could not delete a download's ranges file");
        }
    }
}

/// Lets writes far past the end of the `.part` leave a hole. On NTFS a
/// write beyond the valid data length otherwise zero-fills everything up to
/// it first, a synchronous multi-gigabyte write. False when the file system
/// cannot do it (exFAT, FAT): the transfer then keeps one connection, and
/// so do the other systems' file systems that zero-fill.
#[cfg(windows)]
pub fn make_sparse(part: &Path) -> bool {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            device: *mut core::ffi::c_void,
            code: u32,
            in_buf: *const core::ffi::c_void,
            in_len: u32,
            out_buf: *mut core::ffi::c_void,
            out_len: u32,
            returned: *mut u32,
            overlapped: *mut core::ffi::c_void,
        ) -> i32;
    }
    const FSCTL_SET_SPARSE: u32 = 0x0009_00c4;
    let Ok(file) = std::fs::OpenOptions::new().write(true).open(part) else {
        return false;
    };
    let mut returned = 0u32;
    // SAFETY: the handle is open for the call; no buffers are passed (a
    // missing input buffer means "set sparse").
    unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        ) != 0
    }
}

/// Linux leaves holes on its own, except on the file systems that
/// zero-fill a gap a write leaves past the end (FAT, exFAT, HFS, HFS+) and
/// on mounts whose holes depend on a server or a userspace driver (SMB, 9p
/// as WSL and VMs share Windows folders, VirtualBox shares, FUSE: exfat-fuse
/// among them).
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn make_sparse(part: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(part.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: an all-zero statfs is valid; `path` is a C string and `st` a
    // statfs for the call to fill.
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut st) } != 0 {
        return false;
    }
    // The magic is 32 bits whatever the field's type (signed on some ABIs).
    leaves_holes((st.f_type as u64) & 0xffff_ffff)
}

/// `statfs` magic numbers (Linux) of the file systems [`make_sparse`]
/// refuses.
#[cfg(any(target_os = "linux", target_os = "android", test))]
const NO_HOLES: [u64; 10] = [
    0x4d44,      // MSDOS_SUPER_MAGIC: FAT, vfat
    0x2011_bab0, // EXFAT_SUPER_MAGIC
    0x4244,      // HFS_SUPER_MAGIC
    0x482b,      // HFSPLUS_SUPER_MAGIC
    0x517b,      // SMB_SUPER_MAGIC
    0xff53_4d42, // CIFS_MAGIC_NUMBER
    0xfe53_4d42, // SMB2_MAGIC_NUMBER
    0x0102_1997, // V9FS_MAGIC
    0x786f_4256, // VBOXSF_SUPER_MAGIC
    0x6573_5546, // FUSE_SUPER_MAGIC
];

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn leaves_holes(fs_type: u64) -> bool {
    !NO_HOLES.contains(&fs_type)
}

/// On macOS only APFS (and ZFS) leave holes: HFS+, FAT and exFAT zero-fill
/// the gap, and a network share depends on its server.
#[cfg(target_os = "macos")]
pub fn make_sparse(part: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(part.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: an all-zero statfs is valid; `path` is a C string and `st` a
    // statfs for the call to fill.
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut st) } != 0 {
        return false;
    }
    // SAFETY: the kernel fills `f_fstypename` with a NUL-terminated name.
    let name = unsafe { std::ffi::CStr::from_ptr(st.f_fstypename.as_ptr()) };
    matches!(name.to_bytes(), b"apfs" | b"zfs")
}

/// Other systems leave holes on their own.
#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "android",
    target_os = "macos"
)))]
pub fn make_sparse(_part: &Path) -> bool {
    true
}

/// What a segmented attempt needs from its transfer.
pub struct Job<'a> {
    pub id: i64,
    pub client: reqwest::Client,
    pub url: String,
    pub headers: RequestHeaders,
    pub part: PathBuf,
    pub ctl: &'a TaskCtl,
    pub mgr: &'a DownloadManager,
    pub head_limit: Duration,
    pub idle_limit: Duration,
    pub host: String,
    /// Its settings ("Connections per download"), read every tick.
    pub state: &'a AppState,
    /// The rest of the run uses one connection: set here when the provider
    /// refuses an extra segment, read back by the transfer.
    pub one_connection: &'a AtomicBool,
}

/// How a segmented attempt ended.
pub enum SegEnd {
    /// Every segment is written; the `.part` holds the whole file.
    Done(i64),
    /// The transfer was asked to stop; the sidecar holds the progress.
    Stopped(i64),
    /// An answer was not the range asked for: the partial and its sidecar
    /// are gone, and the file starts over with one connection.
    Changed,
    /// A segment failed; the sidecar holds the progress.
    Error { err: CoreError, bytes: i64 },
}

/// The plan the workers share.
struct Plan {
    ranges: Ranges,
    /// Segment indexes a worker is on.
    taken: Vec<bool>,
}

enum WorkerEnd {
    /// Its segment is written.
    Finished,
    /// Asked to give its connection back, or its stream stopped short of an
    /// end that moved on; its segment is free again.
    Retired,
}

enum WorkerError {
    Failed(CoreError),
    /// The request for the segment got no body: a refusal, a server error,
    /// no connection.
    Refused(CoreError),
    /// The answer was not the range asked for.
    Changed(String),
}

/// Runs `ranges` to completion over as many connections as the transfer may
/// hold, re-read every [`TICK`]. `first` is the open answer of the attempt
/// and the offset it serves from.
pub async fn run(
    job: Job<'_>,
    ranges: Ranges,
    first: Option<(BoxStream<'static, reqwest::Result<Bytes>>, i64)>,
    mut progress: impl FnMut(i64, i64),
) -> SegEnd {
    let total = ranges.total;
    let validator = ranges.validator.clone();
    let taken = vec![false; ranges.segments.len()];
    let plan = Arc::new(Mutex::new(Plan { ranges, taken }));
    let job = &job;
    let mut workers = FuturesUnordered::new();
    // Per worker: its segment and the token that retires it, newest last.
    let mut running: Vec<(usize, CancellationToken)> = Vec::new();
    let all = CancellationToken::new();

    let spawn = |seg: usize,
                 stream: Option<BoxStream<'static, reqwest::Result<Bytes>>>,
                 wait: Duration,
                 running: &mut Vec<(usize, CancellationToken)>| {
        let retire = all.child_token();
        running.push((seg, retire.clone()));
        let plan = Arc::clone(&plan);
        let validator = validator.clone();
        async move {
            let end = worker(job, &plan, seg, total, &validator, stream, wait, &retire).await;
            plan.lock().taken[seg] = false;
            (seg, end)
        }
    };

    let mut first = first.and_then(|(stream, at)| {
        let mut p = plan.lock();
        let i = p
            .ranges
            .segments
            .iter()
            .position(|s| s.pos == at && s.pos < s.end)?;
        p.taken[i] = true;
        Some((i, stream))
    });
    // The segment the attempt's open answer serves: it reads on past its
    // end when the segment after it is given back.
    let mut open_ended = first.as_ref().map(|(i, _)| *i);
    // When a connection of the transfer last closed.
    let mut closed_at: Option<Instant> = None;
    // The plan is on disk before any segment writes past what the `.part`
    // already holds: a `.part` with holes and no sidecar would resume from
    // its length.
    let mut saved_plan = 0;

    let mut last_save = Instant::now();
    let began = plan.lock().ranges.done();
    let mut reported = false;
    let mut failure: Option<WorkerError> = None;
    let mut stopping = false;
    loop {
        if !stopping {
            // As many connections as the transfer may hold: start free
            // segments (splitting the largest when none is free), or retire
            // the newest workers. "Connections per download: 1", a speed cap
            // and a refused segment keep one (resuming a split file one
            // segment after another).
            let one = job.one_connection.load(Ordering::Relaxed);
            let cap = if super::transfer::may_split(job.state, &job.ctl.source, job.mgr, one) {
                MAX_CONNECTIONS
            } else {
                1
            };
            let allowed = job
                .mgr
                .connection_allowance(job.ctl)
                .min(cap)
                .clamp(1, MAX_CONNECTIONS);
            let mut starting: Vec<(usize, Option<BoxStream<'static, reqwest::Result<Bytes>>>)> =
                first
                    .take()
                    .map(|(i, s)| (i, Some(s)))
                    .into_iter()
                    .collect();
            while running.len() + starting.len() < allowed {
                let next = {
                    let mut p = plan.lock();
                    let free = p
                        .ranges
                        .segments
                        .iter()
                        .enumerate()
                        .find(|(i, s)| !p.taken[*i] && s.pos < s.end)
                        .map(|(i, _)| i);
                    let next = free.or_else(|| {
                        let i = p.ranges.split()?;
                        p.taken.push(false);
                        Some(i)
                    });
                    if let Some(i) = next {
                        p.taken[i] = true;
                    }
                    next
                };
                let Some(seg) = next else { break };
                starting.push((seg, None));
            }
            let segments = plan.lock().ranges.segments.len();
            if !starting.is_empty() && segments != saved_plan {
                saved_plan = segments;
                let (part, snapshot) = (job.part.clone(), plan.lock().ranges.clone());
                let saved = tokio::task::spawn_blocking(move || save(&part, &snapshot)).await;
                if let Ok(Err(e)) | Err(e) = saved.map_err(io::Error::other) {
                    // Without the sidecar a split `.part` could not resume:
                    // end the attempt before anything writes.
                    plan.lock().taken.iter_mut().for_each(|t| *t = false);
                    failure = Some(WorkerError::Failed(CoreError::Io(e)));
                    stopping = true;
                    all.cancel();
                    starting.clear();
                }
            }
            let wait =
                closed_at.map_or(Duration::ZERO, |t| CLOSE_GRACE.saturating_sub(t.elapsed()));
            for (seg, stream) in starting {
                workers.push(spawn(seg, stream, wait, &mut running));
            }
            while running.len() > allowed {
                let (_, retire) = running.pop().expect("more running than allowed");
                retire.cancel();
            }
            let held = running.len().max(1);
            if job.ctl.connections.swap(held, Ordering::Relaxed) > held {
                // Another download of the source may be waiting for it.
                job.mgr.released();
            }
        }

        tokio::select! {
            biased;
            _ = job.ctl.token.cancelled(), if !stopping => {
                stopping = true;
                all.cancel();
            }
            ended = workers.next() => match ended {
                Some((seg, end)) => {
                    running.retain(|(s, _)| *s != seg);
                    closed_at = Some(Instant::now());
                    if open_ended == Some(seg) {
                        open_ended = None;
                    }
                    match end {
                        Ok(WorkerEnd::Finished | WorkerEnd::Retired) => {}
                        Err(WorkerError::Refused(err)) if !running.is_empty() => {
                            // The account has fewer free connections than
                            // its limit says (another device holds one):
                            // the rest goes over one connection. A refused
                            // segment that follows the open answer's goes
                            // back to it, so that stream reads on and no
                            // new request is needed.
                            tracing::info!(id = job.id, error = %err, "the provider refused another connection; going on with one");
                            job.one_connection.store(true, Ordering::Relaxed);
                            let mut p = plan.lock();
                            let refused = p.ranges.segments[seg];
                            if let Some(o) = open_ended.filter(|o| {
                                refused.pos == refused.start
                                    && p.ranges.segments[*o].end == refused.start
                            }) {
                                p.ranges.segments[o].end = refused.end;
                                p.ranges.segments[seg].end = refused.start;
                            }
                        }
                        Err(e) => {
                            if failure.is_none() {
                                failure = Some(e);
                            }
                            stopping = true;
                            all.cancel();
                        }
                    }
                }
                None => {
                    if stopping || plan.lock().ranges.complete() {
                        break;
                    }
                }
            },
            _ = tokio::time::sleep(if reported { TICK } else { FIRST_TICK }) => {}
        }

        let (done, snapshot) = {
            let p = plan.lock();
            (p.ranges.done(), p.ranges.clone())
        };
        job.ctl.bytes.store(done, Ordering::Relaxed);
        progress(done, total);
        reported |= done > began;
        if last_save.elapsed() >= SAVE_EVERY {
            last_save = Instant::now();
            let part = job.part.clone();
            let saved = tokio::task::spawn_blocking(move || save(&part, &snapshot)).await;
            if let Ok(Err(e)) | Err(e) = saved.map_err(io::Error::other) {
                tracing::warn!(id = job.id, error = %e, "could not save download ranges");
            }
        }
        if stopping && workers.is_empty() {
            break;
        }
    }
    job.ctl.connections.store(1, Ordering::Relaxed);

    let ranges = plan.lock().ranges.clone();
    let done = ranges.done();
    let part = job.part.clone();
    if let Some(WorkerError::Changed(why)) = &failure {
        tracing::info!(
            id = job.id,
            why,
            "segment answer did not match; restarting with one connection"
        );
        let _ = tokio::task::spawn_blocking(move || {
            // The sidecar goes only once the `.part` is empty.
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&part)?;
            remove(&part);
            Ok::<_, io::Error>(())
        })
        .await;
        return SegEnd::Changed;
    }
    if ranges.complete() {
        let _ = tokio::task::spawn_blocking(move || remove(&part)).await;
        return SegEnd::Done(total);
    }
    let saved = tokio::task::spawn_blocking(move || save(&part, &ranges)).await;
    if let Ok(Err(e)) | Err(e) = saved.map_err(io::Error::other) {
        tracing::warn!(id = job.id, error = %e, "could not save download ranges");
    }
    match failure {
        Some(WorkerError::Failed(err) | WorkerError::Refused(err)) => {
            SegEnd::Error { err, bytes: done }
        }
        _ => SegEnd::Stopped(done),
    }
}

/// Fetches segment `seg` (from `stream` when given, else with its own
/// request, sent after `wait`) until it is written, the worker is retired,
/// or it fails.
#[allow(clippy::too_many_arguments)]
async fn worker(
    job: &Job<'_>,
    plan: &Mutex<Plan>,
    seg: usize,
    total: i64,
    validator: &str,
    stream: Option<BoxStream<'static, reqwest::Result<Bytes>>>,
    wait: Duration,
    retire: &CancellationToken,
) -> Result<WorkerEnd, WorkerError> {
    let (mut pos, end) = {
        let p = plan.lock();
        let s = p.ranges.segments[seg];
        (s.pos, s.end)
    };
    if pos >= end {
        return Ok(WorkerEnd::Finished);
    }
    let mut stream = match stream {
        Some(s) => s,
        None => {
            if !wait.is_zero() {
                tokio::select! {
                    _ = retire.cancelled() => return Ok(WorkerEnd::Retired),
                    _ = tokio::time::sleep(wait) => {}
                }
            }
            let req = crate::http::apply_source_headers(job.client.get(&job.url), &job.headers)
                .header(ACCEPT_ENCODING, "identity")
                .header(RANGE, format!("bytes={pos}-{}", end - 1))
                .header(IF_RANGE, validator);
            let resp = tokio::select! {
                _ = retire.cancelled() => return Ok(WorkerEnd::Retired),
                r = crate::http::send_within(req, job.head_limit) => r.map_err(WorkerError::Refused)?,
            };
            check_range(&resp, pos, total)?;
            resp.bytes_stream().boxed()
        }
    };
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&job.part)
        .await
        .map_err(|e| WorkerError::Failed(CoreError::Io(e)))?;
    file.seek(std::io::SeekFrom::Start(pos as u64))
        .await
        .map_err(|e| WorkerError::Failed(CoreError::Io(e)))?;
    let mut buf: Vec<u8> = Vec::with_capacity(WRITE_CHUNK);
    let mut outcome = Ok(WorkerEnd::Finished);
    // A speed cap set in flight applies at once, shared by the workers until
    // the extra ones are retired.
    let share = || {
        let workers = job.ctl.connections.load(Ordering::Relaxed).max(1) as u64;
        job.mgr.rate_limit().map(|bps| (bps / workers).max(1))
    };
    let mut pace = super::transfer::Pace::new(share(), pos);
    loop {
        // A split may have moved this segment's end closer.
        let end = plan.lock().ranges.segments[seg].end;
        if pos + buf.len() as i64 >= end {
            break;
        }
        let next = tokio::select! {
            biased;
            _ = retire.cancelled() => {
                outcome = Ok(WorkerEnd::Retired);
                break;
            }
            n = tokio::time::timeout(job.idle_limit, stream.next()) => n,
        };
        match next {
            Ok(Some(Ok(chunk))) => {
                let room = (end - pos - buf.len() as i64).max(0) as usize;
                buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
                if chunk.len() > room {
                    // Bytes past the end were dropped, so the stream's next
                    // byte no longer belongs where the next write would put
                    // it: this stream is done even if the end has moved on
                    // meanwhile (a refused segment handed back), and what
                    // is left gets its own request.
                    outcome = Ok(WorkerEnd::Retired);
                    break;
                }
                if buf.len() >= WRITE_CHUNK {
                    if let Err(e) = write_at(&mut file, &mut buf, &mut pos, plan, seg).await {
                        outcome = Err(WorkerError::Failed(CoreError::Io(e)));
                        break;
                    }
                }
                let at = pos + buf.len() as i64;
                let mut retired = false;
                while let Some(wait) = pace.delay(share(), at, Instant::now()) {
                    tokio::select! {
                        biased;
                        _ = retire.cancelled() => {
                            retired = true;
                            break;
                        }
                        _ = tokio::time::sleep(wait.min(super::transfer::THROTTLE_SLICE)) => {}
                    }
                }
                if retired {
                    outcome = Ok(WorkerEnd::Retired);
                    break;
                }
            }
            Ok(Some(Err(e))) => {
                outcome = Err(WorkerError::Failed(crate::http::transport_error(
                    &job.host, e,
                )));
                break;
            }
            Ok(None) => {
                outcome = Err(WorkerError::Failed(CoreError::Network(
                    "Transfer ended before the advertised size".into(),
                )));
                break;
            }
            Err(_) => {
                outcome = Err(WorkerError::Failed(CoreError::Timeout(format!(
                    "{} stopped sending data in the middle of the download (nothing for {} s). Check that the server is online, then try again.",
                    job.host,
                    job.idle_limit.as_secs()
                ))));
                break;
            }
        }
    }
    // The connection closes before the last write and the sync, which a
    // slow disk can hold up while playback waits for it.
    drop(stream);
    let flushed = async {
        write_at(&mut file, &mut buf, &mut pos, plan, seg).await?;
        file.sync_data().await
    }
    .await;
    if let Err(e) = flushed {
        return Err(WorkerError::Failed(CoreError::Io(e)));
    }
    if matches!(outcome, Ok(WorkerEnd::Finished)) && pos < plan.lock().ranges.segments[seg].end {
        // A refused segment was handed back after this stream reached the
        // old end: the rest is free for its own request.
        return Ok(WorkerEnd::Retired);
    }
    outcome
}

/// Writes `buf` at `pos` and records the new position in the plan.
async fn write_at(
    file: &mut tokio::fs::File,
    buf: &mut Vec<u8>,
    pos: &mut i64,
    plan: &Mutex<Plan>,
    seg: usize,
) -> io::Result<()> {
    if buf.is_empty() {
        return Ok(());
    }
    file.write_all(buf).await?;
    // tokio hands the write to a blocking thread; flushing waits for it, so
    // the position recorded below is on disk (in the OS's cache) when the
    // sidecar says so.
    file.flush().await?;
    *pos += buf.len() as i64;
    buf.clear();
    plan.lock().ranges.segments[seg].pos = *pos;
    Ok(())
}

/// A segment answer must be a `206` for exactly `pos..` of a file of
/// `total` bytes; anything else (a `200` because If-Range saw a change or
/// ranges stopped working, another start or total) is not what the plan
/// holds.
fn check_range(resp: &reqwest::Response, pos: i64, total: i64) -> Result<(), WorkerError> {
    let status = resp.status();
    if status == StatusCode::PARTIAL_CONTENT {
        let range = resp
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(super::transfer::parse_content_range);
        return match range {
            Some((start, Some(t))) if start == pos && t == total => Ok(()),
            other => Err(WorkerError::Changed(format!(
                "asked for byte {pos} of {total}, got {other:?}"
            ))),
        };
    }
    if status.is_success() || status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Err(WorkerError::Changed(format!(
            "answered {status} to a range"
        )));
    }
    Err(WorkerError::Refused(super::transfer::http_status_error(
        status,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: i64 = 1024 * 1024;

    #[test]
    fn a_plan_splits_the_largest_remainder_while_halves_stay_large() {
        let mut r = Ranges::new(40 * MIB, "\"e\"".into(), 8 * MIB);
        assert_eq!(r.done(), 8 * MIB);
        assert!(r.is_consistent());
        // 32 MiB left in one segment: 16 + 16, then 8 + 8 of one half.
        assert_eq!(r.split(), Some(2));
        assert_eq!(r.segments[1].end, 24 * MIB);
        assert_eq!(
            r.segments[2],
            Seg {
                start: 24 * MIB,
                end: 40 * MIB,
                pos: 24 * MIB
            }
        );
        assert_eq!(r.split(), Some(3));
        assert_eq!(r.segments[2].end, 32 * MIB);
        assert_eq!(
            r.segments[3],
            Seg {
                start: 32 * MIB,
                end: 40 * MIB,
                pos: 32 * MIB
            }
        );
        assert!(r.is_consistent());
        // Only what is left is halved, and never below 4 MiB a half.
        r.segments[1].pos = 17 * MIB;
        r.segments[2].pos = 31 * MIB;
        r.segments[3].pos = 39 * MIB;
        assert_eq!(r.split(), None, "no remainder of 8 MiB or more");
        r.segments[1].pos = 12 * MIB;
        assert_eq!(r.split(), Some(4));
        assert_eq!(r.segments[1].end, 18 * MIB);
        assert!(r.is_consistent());
        assert!(!r.complete());
    }

    #[test]
    fn an_inconsistent_sidecar_is_ignored() {
        let mut small = Ranges::new(7 * MIB, "\"e\"".into(), 0);
        assert_eq!(small.split(), None, "no two halves of 4 MiB");
        let r = Ranges {
            total: 10,
            validator: "v".into(),
            segments: vec![
                Seg {
                    start: 0,
                    end: 4,
                    pos: 4,
                },
                Seg {
                    start: 5,
                    end: 10,
                    pos: 5,
                },
            ],
        };
        assert!(!r.is_consistent(), "a gap");
        let r = Ranges {
            total: 10,
            validator: "v".into(),
            segments: vec![Seg {
                start: 0,
                end: 10,
                pos: 11,
            }],
        };
        assert!(!r.is_consistent(), "pos past the end");
    }

    #[test]
    fn a_plan_with_a_refused_segment_handed_back_stays_consistent() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        let mut r = Ranges::new(32 * MIB, "\"e\"".into(), 0);
        let tail = r.split().unwrap();
        // The tail was refused untouched: the open answer's segment takes
        // its range and the tail is left empty at its old start.
        r.segments[0].end = r.segments[tail].end;
        r.segments[tail].end = r.segments[tail].start;
        r.segments[0].pos = 5 * MIB;
        assert!(r.is_consistent());
        save(&part, &r).unwrap();
        std::fs::File::create(&part)
            .unwrap()
            .set_len(5 * MIB as u64)
            .unwrap();
        assert_eq!(load(&part), Sidecar::Valid(r.clone()), "resumes at 5 MiB");
        // An empty segment never hides a gap.
        r.segments[0].end = 30 * MIB;
        assert!(!r.is_consistent());
    }

    #[test]
    fn file_systems_that_zero_fill_a_gap_keep_one_connection() {
        // ext4, XFS, Btrfs, tmpfs, overlayfs (Docker), NFS leave holes.
        for fs in [
            0xef53,
            0x5846_5342,
            0x9123_683e,
            0x0102_1994,
            0x794c_7630,
            0x6969,
        ] {
            assert!(leaves_holes(fs), "{fs:#x}");
        }
        // FAT, exFAT, HFS+, SMB, 9p (WSL), FUSE do not.
        for fs in [
            0x4d44,
            0x2011_bab0,
            0x482b,
            0xff53_4d42,
            0x0102_1997,
            0x6573_5546,
        ] {
            assert!(!leaves_holes(fs), "{fs:#x}");
        }
        #[cfg(target_os = "linux")]
        {
            let dir = tempfile::tempdir().unwrap();
            let part = dir.path().join("Movie.mp4.part");
            std::fs::write(&part, b"").unwrap();
            assert!(
                make_sparse(&part),
                "the test folder's file system leaves holes"
            );
            assert!(!make_sparse(&dir.path().join("missing.part")));
        }
    }

    #[test]
    fn the_sidecar_round_trips_next_to_the_part() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        assert!(ranges_path(&part).ends_with("Movie.mp4.part.ranges"));
        assert_eq!(load(&part), Sidecar::None);
        let mut r = Ranges::new(20 * MIB, "\"e\"".into(), 0);
        r.split();
        save(&part, &r).unwrap();
        assert_eq!(load(&part), Sidecar::Valid(r));
        remove(&part);
        assert_eq!(load(&part), Sidecar::None);
        remove(&part);
    }

    #[test]
    fn a_sidecar_the_part_does_not_back_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        let mut r = Ranges::new(20 * MIB, "\"e\"".into(), 0);
        r.split();
        r.segments[0].pos = 3 * MIB;
        r.segments[1].pos = 12 * MIB;
        save(&part, &r).unwrap();
        // The `.part` holds the writes up to 12 MiB: the layout stands.
        std::fs::File::create(&part)
            .unwrap()
            .set_len(12 * MIB as u64)
            .unwrap();
        assert_eq!(load(&part), Sidecar::Valid(r.clone()));
        // Deleted and reserved again, or cut short: the sidecar no longer
        // says what the `.part` holds.
        std::fs::File::create(&part).unwrap();
        assert_eq!(load(&part), Sidecar::Invalid);
        std::fs::remove_file(&part).unwrap();
        assert_eq!(load(&part), Sidecar::Invalid);
        // Unreadable or not a whole file: never "no sidecar".
        std::fs::write(ranges_path(&part), b"{not json").unwrap();
        assert_eq!(load(&part), Sidecar::Invalid);
        r.segments.pop();
        save(&part, &r).unwrap();
        assert_eq!(load(&part), Sidecar::Invalid);
    }

    #[test]
    fn a_part_that_cannot_be_deleted_keeps_its_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        let r = Ranges::new(20 * MIB, "\"e\"".into(), 0);
        // Something that is not a regular file sits at the `.part` path, so
        // deleting it fails (as a locked file does on Windows).
        std::fs::create_dir(&part).unwrap();
        save(&part, &r).unwrap();
        assert!(remove_part(&part).is_err());
        assert!(
            ranges_path(&part).is_file(),
            "the sidecar stays with its .part"
        );
        std::fs::remove_dir(&part).unwrap();
        std::fs::write(&part, b"partial").unwrap();
        assert!(remove_part(&part).unwrap());
        assert!(!part.exists() && !ranges_path(&part).exists());
        assert!(!remove_part(&part).unwrap(), "nothing left to delete");
    }
}
