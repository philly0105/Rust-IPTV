//! Segmented transfers: one file over several Range connections, possibly
//! from several sources.
//!
//! A provider that caps each connection's speed delivers a file N times
//! faster over N connections. A transfer splits the rest of its file into
//! segments when the first answer is a `206` with a known total, the
//! source's "Connections per download" is Auto, and the source's budget has
//! connections no queued download or playback needs
//! (`DownloadManager::allowance_on`), or identical copies on other sources
//! (mirrors) can serve part of it. Each segment is fetched with `Range` (and
//! `If-Range` when the source has a validator), and a dedicated writer
//! (`segments/writer.rs`) puts its bytes at their place in the `.part`. A
//! sidecar next to the `.part` (`<name>.part.ranges`, version 2) records
//! each segment's start, end, how far it got, which source served it and
//! whether its bytes were compared with another source's, so a stopped
//! transfer resumes every segment where it was; while it exists, the
//! `.part`'s length means nothing.
//!
//! Bytes are never stitched from two versions of a file. An answer that is
//! not the exact range asked for, or overlapping bytes of the authority (the
//! source the run downloads from) that differ, drop the partial and restart
//! the file with one connection. Bytes of a mirror that differ from what
//! they overlap are discarded, and the mirror leaves the transfer. A file
//! completes only once every segment's bytes were compared with another
//! request (`checked`), or came from the authority under its validator.

use super::manager::{DownloadManager, TaskCtl};
use super::shared::{Endpoint, Fingerprint};
use crate::error::CoreError;
use crate::model::{CopyRef, RequestHeaders};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

mod engine;
pub(super) mod stats;
mod writer;

pub use engine::run;

/// Suffix of the sidecar after the `.part` path.
pub const RANGES_SUFFIX: &str = ".ranges";
/// The sidecar format this build writes.
pub const VERSION: u32 = 2;
/// Most connections one file uses, over all its sources.
pub const MAX_CONNECTIONS: usize = 8;
/// Smallest segment worth its own connection: splitting stops below twice
/// this, so the last few seconds of a file never open new connections.
pub const MIN_SEGMENT: i64 = 4 * 1024 * 1024;
/// A connection-limit probe runs only with this much of the file left. A
/// transfer on one connection enters the engine for a due probe only then.
pub const PROBE_MIN_LEFT: i64 = 32 * 1024 * 1024;
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
    /// Index in [`Ranges::sources`] of the source that wrote `start..pos`.
    #[serde(default)]
    pub src: u16,
    /// `start..pos` was compared with bytes of another request (or came
    /// from the authority under its validator).
    #[serde(default)]
    pub checked: bool,
}

/// A source the segments of a sidecar name. Never a URL: Xtream URLs carry
/// the account's credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegSource {
    /// `None`: the download row's own item.
    pub copy: Option<CopyRef>,
    pub validator: Option<String>,
}

/// The sidecar: what the segments cover, how far each got and who served
/// it. `sources[0]` is the authority of the run that wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ranges {
    pub version: u32,
    pub total: i64,
    pub sources: Vec<SegSource>,
    pub segments: Vec<Seg>,
}

/// The sidecar older builds wrote: one source with a validator, every
/// segment from it.
#[derive(Deserialize)]
struct V1 {
    total: i64,
    validator: String,
    segments: Vec<V1Seg>,
}

#[derive(Deserialize)]
struct V1Seg {
    start: i64,
    end: i64,
    pos: i64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OnDisk {
    V2(Ranges),
    V1(V1),
}

impl From<V1> for Ranges {
    fn from(v: V1) -> Self {
        Self {
            version: VERSION,
            total: v.total,
            sources: vec![SegSource {
                copy: None,
                validator: Some(v.validator),
            }],
            // Every request of a v1 transfer carried the validator.
            segments: v
                .segments
                .into_iter()
                .map(|s| Seg {
                    start: s.start,
                    end: s.end,
                    pos: s.pos,
                    src: 0,
                    checked: true,
                })
                .collect(),
        }
    }
}

impl Ranges {
    /// A plan for a file whose first `offset` bytes the authority already
    /// wrote (in one piece, from the answer the transfer goes on reading).
    pub fn new(total: i64, authority: SegSource, offset: i64) -> Self {
        let checked = authority.validator.is_some();
        Self {
            version: VERSION,
            total,
            sources: vec![authority],
            segments: vec![Seg {
                start: 0,
                end: total,
                pos: offset,
                src: 0,
                checked,
            }],
        }
    }

    /// Bytes written.
    pub fn done(&self) -> i64 {
        self.segments.iter().map(|s| s.pos - s.start).sum()
    }

    pub fn complete(&self) -> bool {
        self.segments.iter().all(|s| s.pos >= s.end)
    }

    /// Complete, and every written segment compared or under the
    /// authority's validator: the `.part` holds the file.
    pub fn verified(&self) -> bool {
        self.complete() && self.segments.iter().all(|s| s.checked || s.pos == s.start)
    }

    /// Covers `0..total` without gaps or overlaps, every `pos` in its
    /// segment, every `src` a listed source: a sidecar that is not is
    /// ignored. An emptied segment (a refused one handed back to the
    /// segment before it) covers nothing and stays in the plan, since
    /// workers address segments by index.
    pub fn is_consistent(&self) -> bool {
        if self
            .segments
            .iter()
            .any(|s| usize::from(s.src) >= self.sources.len())
        {
            return false;
        }
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
    pub fn split(&mut self) -> Option<usize> {
        self.split_by(|_, s| s.pos)
    }

    /// [`Ranges::split`] where `front` says how far each segment's bytes
    /// already got (written, or on their way to the writer).
    fn split_by(&mut self, front: impl Fn(usize, &Seg) -> i64) -> Option<usize> {
        let (i, from, left) = self
            .segments
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let from = front(i, s).clamp(s.pos, s.end);
                (i, from, s.end - from)
            })
            .max_by_key(|(_, _, left)| *left)?;
        if left < 2 * MIN_SEGMENT {
            return None;
        }
        let mid = from + left / 2;
        let tail = Seg {
            start: mid,
            end: self.segments[i].end,
            pos: mid,
            src: 0,
            checked: false,
        };
        self.segments[i].end = mid;
        self.segments.push(tail);
        Some(self.segments.len() - 1)
    }

    /// This layout for a run whose authority is `copy` (`None`: the row's
    /// own item): the authority moves to `sources[0]`. `checked` means
    /// compared with the current authority's file: every segment the new
    /// authority did not write needs a comparison again (all of them when
    /// the sidecar does not list it, and it joins with no validator). `validator` is the row's:
    /// it describes the last run's authority (`sources[0]`) only, so it is
    /// compared there alone, and None means that file changed and its
    /// bytes cannot be continued. Another listed copy keeps the validator
    /// it served under; the run's range requests check it (If-Range).
    pub fn adopt(mut self, copy: Option<&CopyRef>, validator: Option<&str>) -> Option<Ranges> {
        match self.sources.iter().position(|s| s.copy.as_ref() == copy) {
            Some(k) => {
                if k == 0 && self.sources[0].validator.as_deref() != validator {
                    return None;
                }
                if k != 0 {
                    self.sources.swap(0, k);
                    let k = k as u16;
                    for s in &mut self.segments {
                        if s.src == k {
                            s.src = 0;
                        } else {
                            if s.src == 0 {
                                s.src = k;
                            }
                            s.checked = false;
                        }
                    }
                }
            }
            None => {
                self.sources.insert(
                    0,
                    SegSource {
                        copy: copy.cloned(),
                        validator: None,
                    },
                );
                for s in &mut self.segments {
                    s.src += 1;
                    s.checked = false;
                }
            }
        }
        Some(self)
    }
}

/// The plan the coordinator, the workers and the writer share.
struct Plan {
    ranges: Ranges,
    /// Segment indexes a worker is on.
    taken: Vec<bool>,
    /// Bumped when a segment's bytes are discarded: blocks queued for it
    /// before then are dropped by the writer.
    epoch: Vec<u64>,
    /// How far each segment's bytes have been handed to the writer (ahead
    /// of `pos` while they wait in its queue).
    queued: Vec<i64>,
}

impl Plan {
    fn new(ranges: Ranges) -> Self {
        let n = ranges.segments.len();
        Self {
            queued: ranges.segments.iter().map(|s| s.pos).collect(),
            taken: vec![false; n],
            epoch: vec![0; n],
            ranges,
        }
    }

    fn push(&mut self, seg: Seg) -> usize {
        self.ranges.segments.push(seg);
        self.taken.push(false);
        self.epoch.push(0);
        self.queued.push(seg.pos);
        self.ranges.segments.len() - 1
    }

    /// Splits the segment with the most left past what its worker already
    /// handed to the writer.
    fn split(&mut self) -> Option<usize> {
        let queued = &self.queued;
        self.ranges.split_by(|i, s| queued[i].max(s.pos))?;
        let seg = self.ranges.segments.pop().expect("the split's tail");
        Some(self.push(seg))
    }

    /// Discards segment `i`'s bytes: it starts over from the authority.
    fn reset(&mut self, i: usize) {
        let s = &mut self.ranges.segments[i];
        s.pos = s.start;
        s.src = 0;
        s.checked = false;
        self.epoch[i] += 1;
        self.queued[i] = s.start;
    }

    /// A free segment for a new worker on source `src`, taken for it: an
    /// untouched one, one `src` already wrote part of, the rest of one
    /// another source wrote part of (cut off into a segment of its own),
    /// or the second half of the one with the most left.
    ///
    /// A segment whose worker ended can still have blocks in the writer's
    /// queue (`queued` ahead of `pos`). Those land later, so the segment
    /// keeps everything up to `queued`: a cut there, never at `pos`, keeps
    /// every `pos` within its `end`, and bytes one source handed are never
    /// recorded as another's.
    fn pick(&mut self, src: u16, validated: bool) -> Option<usize> {
        let free = |p: &Plan, want: &dyn Fn(&Seg, i64) -> bool| {
            p.ranges
                .segments
                .iter()
                .enumerate()
                .find(|(i, s)| {
                    let front = p.queued[*i].max(s.pos);
                    !p.taken[*i] && front < s.end && want(s, front)
                })
                .map(|(i, _)| i)
        };
        let i = if let Some(i) = free(self, &|s, front| front == s.start) {
            i
        } else if let Some(i) = free(self, &|s, front| s.src == src && front == s.pos) {
            i
        } else if let Some(i) = free(self, &|_, _| true) {
            let s = self.ranges.segments[i];
            let front = self.queued[i].max(s.pos);
            self.ranges.segments[i].end = front;
            self.push(Seg {
                start: front,
                end: s.end,
                pos: front,
                src,
                checked: false,
            })
        } else {
            self.split()?
        };
        let s = &mut self.ranges.segments[i];
        if s.pos == s.start {
            s.src = src;
            s.checked = validated;
        }
        self.taken[i] = true;
        Some(i)
    }

    /// Whether another connection could get a segment.
    fn can_grow(&self) -> bool {
        self.ranges
            .segments
            .iter()
            .enumerate()
            .any(|(i, s)| !self.taken[i] && self.queued[i].max(s.pos) < s.end)
            || self
                .ranges
                .segments
                .iter()
                .enumerate()
                .any(|(i, s)| s.end - self.queued[i].max(s.pos) >= 2 * MIN_SEGMENT)
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

/// A sidecar's contents: version 2, or version 1 read as one source.
fn parse(raw: &[u8]) -> Option<Ranges> {
    match serde_json::from_slice::<OnDisk>(raw).ok()? {
        OnDisk::V2(r) => (r.version == VERSION).then_some(r),
        OnDisk::V1(v) => Some(v.into()),
    }
}

/// The sidecar of `part`.
pub fn load(part: &Path) -> Sidecar {
    let raw = match std::fs::read(ranges_path(part)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Sidecar::None,
        Err(_) => return Sidecar::Invalid,
    };
    let Some(ranges) = parse(&raw).filter(Ranges::is_consistent) else {
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

/// [`save`] once the `.part` is on disk. A segment's `pos` is recorded once
/// its bytes reach the OS, and the sidecar can reach the disk before those
/// pages do: after an OS crash or a power cut it would mark bytes as written
/// that never were, and the finished file would have zeroed gaps. `ranges`
/// is a snapshot taken before the call, so the sync covers all it records.
pub fn save_synced(part: &Path, ranges: &Ranges) -> io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(part)?
        .sync_data()?;
    save(part, ranges)
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

/// Identical copies a segmented attempt may draw on (`mirrors`).
pub struct MirrorPlan {
    /// The authority's copy, the one mirrors must equal.
    pub item: CopyRef,
    /// The authority's fingerprint. `None`: the cached one no longer
    /// matches the file, and the attempt reads it again over a held
    /// connection before it looks for mirrors.
    pub fingerprint: Option<Fingerprint>,
}

/// What a segmented attempt needs from its transfer.
pub struct Job<'a> {
    pub id: i64,
    /// The authority's client, URL and headers.
    pub client: reqwest::Client,
    pub url: String,
    /// Where the first answer came from after redirects, when not `url`:
    /// segment requests go there first.
    pub pinned: Option<String>,
    pub headers: RequestHeaders,
    pub part: PathBuf,
    pub ctl: &'a TaskCtl,
    pub mgr: &'a DownloadManager,
    pub head_limit: Duration,
    pub idle_limit: Duration,
    pub host: String,
    /// Its settings ("Connections per download"), read every tick.
    pub state: &'a Arc<AppState>,
    /// The rest of the run uses one connection: set here when the provider
    /// refuses an extra segment, read back by the transfer.
    pub one_connection: &'a AtomicBool,
    /// The authority as a resolved copy: what probes ask and mismatches
    /// name. `None` when the source's kind is unknown (removed).
    pub authority: Option<Endpoint>,
    /// The authority's copy (the row's own item, or the copy the queue
    /// spread the row to).
    pub copy: CopyRef,
    /// The row's own copy: the sidecar names it `None` whether it served
    /// as the authority or as a mirror.
    pub own: CopyRef,
    /// The sidecar entry of the copy the row's bytes are: its origin, or
    /// `None` (its own copy).
    pub base: Option<CopyRef>,
    /// Mirrors to look for, when they apply to this transfer.
    pub mirrors: Option<MirrorPlan>,
}

/// How a segmented attempt ended.
pub enum SegEnd {
    /// Every segment is written and checked; the `.part` holds the whole
    /// file.
    Done(i64),
    /// The transfer was asked to stop; the sidecar holds the progress.
    Stopped(i64),
    /// The authority is the row's own copy, and an answer was not the
    /// range asked for or its bytes changed: the partial and its sidecar
    /// are gone, and the file starts over with one connection.
    Changed,
    /// A segment failed; the sidecar holds the progress.
    Error { err: CoreError, bytes: i64 },
    /// The authority is another copy than the row's own and it changed,
    /// or its bytes contradict the row's own: the sidecar keeps the bytes
    /// (less the authority's unchecked ones), and the row goes back to the
    /// queue.
    Respread(i64),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ContentType, ItemRef};

    const MIB: i64 = 1024 * 1024;

    fn etag() -> SegSource {
        SegSource {
            copy: None,
            validator: Some("\"e\"".into()),
        }
    }

    fn seg(start: i64, end: i64, pos: i64) -> Seg {
        Seg {
            start,
            end,
            pos,
            src: 0,
            checked: false,
        }
    }

    #[test]
    fn a_plan_splits_the_largest_remainder_while_halves_stay_large() {
        let mut r = Ranges::new(40 * MIB, etag(), 8 * MIB);
        assert_eq!(r.done(), 8 * MIB);
        assert!(r.is_consistent());
        assert!(r.segments[0].checked, "under the validator");
        // 32 MiB left in one segment: 16 + 16, then 8 + 8 of one half.
        assert_eq!(r.split(), Some(1));
        assert_eq!(r.segments[0].end, 24 * MIB);
        assert_eq!(r.segments[1], seg(24 * MIB, 40 * MIB, 24 * MIB));
        assert_eq!(r.split(), Some(2));
        assert_eq!(r.segments[1].end, 32 * MIB);
        assert_eq!(r.segments[2], seg(32 * MIB, 40 * MIB, 32 * MIB));
        assert!(r.is_consistent());
        // Only what is left is halved, and never below 4 MiB a half.
        r.segments[0].pos = 17 * MIB;
        r.segments[1].pos = 31 * MIB;
        r.segments[2].pos = 39 * MIB;
        assert_eq!(r.split(), None, "no remainder of 8 MiB or more");
        r.segments[0].pos = 12 * MIB;
        assert_eq!(r.split(), Some(3));
        assert_eq!(r.segments[0].end, 18 * MIB);
        assert!(r.is_consistent());
        assert!(!r.complete());
    }

    #[test]
    fn a_split_leaves_alone_what_waits_for_the_writer() {
        let mut p = Plan::new(Ranges::new(40 * MIB, etag(), 0));
        // 8 MiB written, 8 more queued: the half of the 24 MiB beyond.
        p.ranges.segments[0].pos = 8 * MIB;
        p.queued[0] = 16 * MIB;
        assert_eq!(p.split(), Some(1));
        assert_eq!(p.ranges.segments[0].end, 28 * MIB);
        assert_eq!(p.queued[1], 28 * MIB);
        assert_eq!(p.epoch.len(), 2);
    }

    #[test]
    fn a_new_worker_takes_fresh_bytes_then_its_own_then_cuts_off_another_sources() {
        let total = 64 * MIB;
        let mut r = Ranges::new(total, etag(), 0);
        r.sources.push(SegSource {
            copy: Some(CopyRef::new(
                ItemRef::new("b", ContentType::Movie, "7"),
                None,
            )),
            validator: None,
        });
        r.segments = vec![
            Seg {
                src: 0,
                checked: true,
                ..seg(0, 16 * MIB, 4 * MIB)
            },
            Seg {
                src: 1,
                ..seg(16 * MIB, 32 * MIB, 20 * MIB)
            },
            seg(32 * MIB, 64 * MIB, 32 * MIB),
        ];
        assert!(r.is_consistent());
        let mut p = Plan::new(r);
        // Untouched bytes first, taken for the mirror without a check.
        assert_eq!(p.pick(1, false), Some(2));
        assert_eq!(p.ranges.segments[2].src, 1);
        assert!(!p.ranges.segments[2].checked);
        // Then the mirror's own partial segment.
        assert_eq!(p.pick(1, false), Some(1));
        // The authority cuts off the rest of the mirror's segment.
        p.taken[1] = false;
        p.taken[0] = true;
        assert_eq!(p.pick(0, true), Some(3));
        assert_eq!(p.ranges.segments[1].end, 20 * MIB);
        assert_eq!(
            p.ranges.segments[3],
            Seg {
                src: 0,
                checked: true,
                ..seg(20 * MIB, 32 * MIB, 20 * MIB)
            }
        );
        assert!(p.ranges.is_consistent());
        // A discarded segment starts over from the authority.
        p.reset(1);
        assert_eq!(p.ranges.segments[1], seg(16 * MIB, 20 * MIB, 16 * MIB));
        assert_eq!(p.epoch[1], 1);
    }

    /// A sink that, while the writer is mid-write (the plan unlocked), lets
    /// the authority pick: the moment a multi-source run cut another
    /// source's segment at its recorded `pos`, so the block then recorded
    /// past the new end and the next split panicked (`min > max`).
    struct PickDuringWrite<'a> {
        plan: &'a parking_lot::Mutex<Plan>,
        picked: Option<usize>,
    }

    impl writer::Sink for PickDuringWrite<'_> {
        fn write_at(&mut self, _buf: &[u8], _at: u64) -> io::Result<()> {
            self.picked = self.plan.lock().pick(0, true);
            Ok(())
        }
    }

    #[test]
    fn a_cut_keeps_what_waits_for_the_writer_so_no_segment_passes_its_end() {
        let total = 64 * MIB;
        let mut r = Ranges::new(total, etag(), 0);
        r.sources.push(SegSource {
            copy: Some(CopyRef::new(
                ItemRef::new("b", ContentType::Movie, "7"),
                None,
            )),
            validator: None,
        });
        // The mirror's worker ended at 12 MiB; 10 MiB are recorded and the
        // last 2 wait in the writer's queue. The authority's segment is busy.
        r.segments = vec![
            Seg {
                src: 0,
                checked: true,
                ..seg(0, 8 * MIB, 4 * MIB)
            },
            Seg {
                src: 1,
                ..seg(8 * MIB, total, 10 * MIB)
            },
        ];
        let mut p = Plan::new(r);
        p.taken[0] = true;
        p.queued[1] = 12 * MIB;
        let plan = parking_lot::Mutex::new(p);
        let mut sink = PickDuringWrite {
            plan: &plan,
            picked: None,
        };
        let block = writer::Block {
            seg: 1,
            at: 10 * MIB,
            epoch: 0,
            data: vec![0; 2 * MIB as usize],
        };
        writer::apply(&mut sink, &plan, &block).unwrap();
        let mut p = plan.lock();
        assert_eq!(sink.picked, Some(2));
        assert_eq!(p.ranges.segments[1].end, 12 * MIB, "cut after the queue");
        assert_eq!(p.ranges.segments[1].pos, 12 * MIB);
        assert_eq!(p.ranges.segments[1].src, 1, "the mirror's bytes stay its");
        assert_eq!(
            p.ranges.segments[2],
            Seg {
                src: 0,
                checked: true,
                ..seg(12 * MIB, total, 12 * MIB)
            }
        );
        assert!(p.ranges.is_consistent());
        // The split that panicked on a `pos` past its `end`.
        p.taken[2] = true;
        assert!(p.split().is_some());
        assert!(p.ranges.is_consistent());
    }

    #[test]
    fn a_segment_whose_bytes_all_wait_for_the_writer_is_not_free() {
        let mut p = Plan::new(Ranges::new(40 * MIB, etag(), 0));
        p.ranges.segments[0].end = 8 * MIB;
        p.queued[0] = 8 * MIB;
        let tail = p.push(seg(8 * MIB, 40 * MIB, 8 * MIB));
        p.taken[tail] = true;
        // Segment 0 is not untouched (its bytes are queued) and has nothing
        // past them to fetch: the new worker splits the busy tail instead.
        assert_eq!(p.pick(0, true), Some(2));
        assert_eq!(p.ranges.segments[0].end, 8 * MIB);
        assert_eq!(p.ranges.segments[0].src, 0);
    }

    #[test]
    fn an_inconsistent_sidecar_is_ignored() {
        let mut small = Ranges::new(7 * MIB, etag(), 0);
        assert_eq!(small.split(), None, "no two halves of 4 MiB");
        let mut r = Ranges::new(10, etag(), 0);
        r.segments = vec![seg(0, 4, 4), seg(5, 10, 5)];
        assert!(!r.is_consistent(), "a gap");
        r.segments = vec![seg(0, 10, 11)];
        assert!(!r.is_consistent(), "pos past the end");
        r.segments = vec![Seg {
            src: 1,
            ..seg(0, 10, 3)
        }];
        assert!(!r.is_consistent(), "a source the sidecar does not list");
    }

    #[test]
    fn a_version_1_sidecar_loads_as_one_checked_source() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        std::fs::write(
            ranges_path(&part),
            br#"{"total":20,"validator":"\"e\"","segments":[{"start":0,"end":10,"pos":4},{"start":10,"end":20,"pos":12}]}"#,
        )
        .unwrap();
        std::fs::write(&part, [0u8; 12]).unwrap();
        let Sidecar::Valid(r) = load(&part) else {
            panic!("a v1 sidecar loads");
        };
        assert_eq!(r.version, VERSION);
        assert_eq!(r.sources, vec![etag()]);
        assert!(r.segments.iter().all(|s| s.src == 0 && s.checked));
        assert_eq!(r.done(), 6);
        // Written back as version 2 only.
        save(&part, &r).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(ranges_path(&part)).unwrap()).unwrap();
        assert_eq!(raw["version"], 2);
        assert!(raw.get("validator").is_none());
        assert_eq!(raw["sources"][0]["copy"], serde_json::Value::Null);
        assert_eq!(load(&part), Sidecar::Valid(r));
        // A version this build does not know is not this file's layout.
        let mut raw = raw;
        raw["version"] = 3.into();
        std::fs::write(ranges_path(&part), raw.to_string()).unwrap();
        assert_eq!(load(&part), Sidecar::Invalid);
    }

    #[test]
    fn a_resumed_layout_puts_the_runs_authority_first() {
        let b = CopyRef::new(ItemRef::new("b", ContentType::Movie, "7"), None);
        let mut r = Ranges::new(32 * MIB, etag(), 0);
        r.sources.push(SegSource {
            copy: Some(b.clone()),
            validator: Some("v-b".into()),
        });
        r.segments = vec![
            Seg {
                checked: true,
                ..seg(0, 16 * MIB, MIB)
            },
            Seg {
                src: 1,
                checked: true,
                ..seg(16 * MIB, 32 * MIB, 17 * MIB)
            },
        ];
        // The row's own item, validator unchanged: as it was.
        assert_eq!(r.clone().adopt(None, Some("\"e\"")), Some(r.clone()));
        // The file changed under the authority.
        assert_eq!(r.clone().adopt(None, Some("\"f\"")), None);
        assert_eq!(r.clone().adopt(None, None), None);
        // The queue spread the row to the mirror's copy. The row's
        // validator was the authority's, not B's: B keeps the one it
        // served under.
        let spread = r.clone().adopt(Some(&b), Some("\"e\"")).unwrap();
        assert_eq!(spread, r.clone().adopt(Some(&b), None).unwrap());
        assert_eq!(spread.sources[0].copy, Some(b.clone()));
        assert_eq!(spread.sources[0].validator.as_deref(), Some("v-b"));
        assert_eq!(spread.segments[0].src, 1);
        assert_eq!(spread.segments[1].src, 0);
        // The old authority's bytes were checked against its own file,
        // not B's: they are compared again. B's own stay checked.
        assert!(!spread.segments[0].checked);
        assert!(spread.segments[1].checked);
        assert!(spread.is_consistent());
        // A copy the sidecar does not list.
        let c = CopyRef::new(ItemRef::new("c", ContentType::Movie, "9"), None);
        let other = r.adopt(Some(&c), Some("v-c")).unwrap();
        assert_eq!(other.sources.len(), 3);
        assert_eq!(other.sources[0].validator, None);
        assert!(other.segments.iter().all(|s| s.src > 0 && !s.checked));
        assert!(other.is_consistent());
        assert!(!other.verified());
    }

    #[test]
    fn a_plan_with_a_refused_segment_handed_back_stays_consistent() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        let mut r = Ranges::new(32 * MIB, etag(), 0);
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
        let mut r = Ranges::new(20 * MIB, etag(), 0);
        r.split();
        save(&part, &r).unwrap();
        assert_eq!(load(&part), Sidecar::Valid(r));
        remove(&part);
        assert_eq!(load(&part), Sidecar::None);
        remove(&part);
    }

    #[test]
    fn a_synced_save_goes_through_the_part() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        let r = Ranges::new(20 * MIB, etag(), 0);
        // The `.part` is synced before the sidecar records its bytes: with
        // no `.part` to sync, no sidecar is written.
        assert!(save_synced(&part, &r).is_err());
        assert!(!ranges_path(&part).exists());
        std::fs::write(&part, b"").unwrap();
        save_synced(&part, &r).unwrap();
        assert_eq!(load(&part), Sidecar::Valid(r));
    }

    #[test]
    fn a_sidecar_the_part_does_not_back_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        let mut r = Ranges::new(20 * MIB, etag(), 0);
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
        let r = Ranges::new(20 * MIB, etag(), 0);
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
