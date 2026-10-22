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
//! restarts the file with one connection.

use super::manager::{DownloadManager, TaskCtl};
use crate::error::CoreError;
use crate::model::RequestHeaders;
use bytes::Bytes;
use futures::stream::{BoxStream, FuturesUnordered, StreamExt};
use parking_lot::Mutex;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
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
const SAVE_EVERY: Duration = Duration::from_secs(2);

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
    /// segment: a sidecar that is not is ignored.
    pub fn is_consistent(&self) -> bool {
        let mut segs = self.segments.clone();
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

/// The sidecar of `part`, when there is a readable, consistent one.
pub fn load(part: &Path) -> Option<Ranges> {
    let raw = std::fs::read(ranges_path(part)).ok()?;
    serde_json::from_slice::<Ranges>(&raw)
        .ok()
        .filter(Ranges::is_consistent)
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
/// cannot do it (exFAT, FAT): the transfer then keeps one connection.
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

/// Other systems leave holes on their own.
#[cfg(not(windows))]
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
    /// Most connections the source's setting allows (1 for "1", resuming
    /// a split file one segment after another).
    pub cap: usize,
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
    /// Asked to give its connection back; its segment is free again.
    Retired,
}

enum WorkerError {
    Failed(CoreError),
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
                 running: &mut Vec<(usize, CancellationToken)>| {
        let retire = all.child_token();
        running.push((seg, retire.clone()));
        let plan = Arc::clone(&plan);
        let validator = validator.clone();
        async move {
            let end = worker(job, &plan, seg, total, &validator, stream, &retire).await;
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
    // The plan is on disk before any segment writes past what the `.part`
    // already holds: a `.part` with holes and no sidecar would resume from
    // its length.
    let mut saved_plan = 0;

    let mut last_save = Instant::now();
    let mut failure: Option<WorkerError> = None;
    let mut stopping = false;
    loop {
        if !stopping {
            // As many connections as the transfer may hold: start free
            // segments (splitting the largest when none is free), or retire
            // the newest workers.
            // A speed cap paces one stream: a capped transfer keeps one.
            let cap = if job.mgr.rate_limit().is_some() {
                1
            } else {
                job.cap
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
            for (seg, stream) in starting {
                workers.push(spawn(seg, stream, &mut running));
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
                    match end {
                        Ok(WorkerEnd::Finished | WorkerEnd::Retired) => {}
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
            _ = tokio::time::sleep(TICK) => {}
        }

        let (done, snapshot) = {
            let p = plan.lock();
            (p.ranges.done(), p.ranges.clone())
        };
        job.ctl.bytes.store(done, Ordering::Relaxed);
        progress(done, total);
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
            remove(&part);
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&part)
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
        Some(WorkerError::Failed(err)) => SegEnd::Error { err, bytes: done },
        _ => SegEnd::Stopped(done),
    }
}

/// Fetches segment `seg` (from `stream` when given, else with its own
/// request) until it is written, the worker is retired, or it fails.
async fn worker(
    job: &Job<'_>,
    plan: &Mutex<Plan>,
    seg: usize,
    total: i64,
    validator: &str,
    stream: Option<BoxStream<'static, reqwest::Result<Bytes>>>,
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
            let req = crate::http::apply_source_headers(job.client.get(&job.url), &job.headers)
                .header(ACCEPT_ENCODING, "identity")
                .header(RANGE, format!("bytes={pos}-{}", end - 1))
                .header(IF_RANGE, validator);
            let resp = tokio::select! {
                _ = retire.cancelled() => return Ok(WorkerEnd::Retired),
                r = crate::http::send_within(req, job.head_limit) => r.map_err(WorkerError::Failed)?,
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
    let flushed = async {
        write_at(&mut file, &mut buf, &mut pos, plan, seg).await?;
        file.sync_data().await
    }
    .await;
    if let Err(e) = flushed {
        return Err(WorkerError::Failed(CoreError::Io(e)));
    }
    if matches!(outcome, Ok(WorkerEnd::Finished)) && pos < plan.lock().ranges.segments[seg].end {
        // Reached the end of what was asked for, but a split never moved it:
        // the stream ended early.
        return Err(WorkerError::Failed(CoreError::Network(
            "Transfer ended before the advertised size".into(),
        )));
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
    Err(WorkerError::Failed(super::transfer::http_status_error(
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
    fn the_sidecar_round_trips_next_to_the_part() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        assert!(ranges_path(&part).ends_with("Movie.mp4.part.ranges"));
        assert_eq!(load(&part), None);
        let mut r = Ranges::new(20 * MIB, "\"e\"".into(), 0);
        r.split();
        save(&part, &r).unwrap();
        assert_eq!(load(&part), Some(r));
        remove(&part);
        assert_eq!(load(&part), None);
        remove(&part);
    }
}
