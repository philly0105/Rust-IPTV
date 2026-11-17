//! The writer of a segmented attempt: one blocking thread owns the `.part`'s
//! write handle and puts the workers' blocks at their place. A block lands
//! only where its segment's recorded position is, in the segment's current
//! epoch, and never past the segment's end; its bytes are recorded (`pos`)
//! once the write returned, so a sidecar snapshot never claims bytes the OS
//! does not have. The thread syncs the file and closes its handle before
//! the attempt ends, so the transfer can rename or delete the `.part` (a
//! file open elsewhere cannot be, on Windows).

use super::Plan;
use parking_lot::Mutex;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

/// Bytes a worker gathers before it hands them to the writer.
pub(super) const BLOCK: usize = 1024 * 1024;
/// Blocks waiting for the writer, all workers together.
const QUEUE: usize = 16;

/// Bytes of segment `seg` that belong at offset `at`.
pub(super) struct Block {
    pub seg: usize,
    pub at: i64,
    /// The segment's epoch when the worker started: a block from before a
    /// reset is dropped.
    pub epoch: u64,
    pub data: Vec<u8>,
}

pub(super) type Sender = tokio::sync::mpsc::Sender<Block>;

/// Where blocks go: the `.part`, or a fake one in tests.
pub(super) trait Sink {
    fn write_at(&mut self, buf: &[u8], at: u64) -> io::Result<()>;
}

impl Sink for std::fs::File {
    #[cfg(windows)]
    fn write_at(&mut self, mut buf: &[u8], mut at: u64) -> io::Result<()> {
        use std::os::windows::fs::FileExt;
        while !buf.is_empty() {
            match self.seek_write(buf, at) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(n) => {
                    buf = &buf[n..];
                    at += n as u64;
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    #[cfg(unix)]
    fn write_at(&mut self, buf: &[u8], at: u64) -> io::Result<()> {
        std::os::unix::fs::FileExt::write_all_at(self, buf, at)
    }
}

/// Writes `b` where it belongs and records it. A block whose segment was
/// reset, or that does not continue what the segment holds (a block before
/// it failed), is dropped: a write that failed part way may have stored
/// some of its bytes, and none of it was recorded, so the segment fetches
/// them again.
pub(super) fn apply<S: Sink>(sink: &mut S, plan: &Mutex<Plan>, b: &Block) -> io::Result<()> {
    let len = {
        let p = plan.lock();
        let s = p.ranges.segments[b.seg];
        if p.epoch[b.seg] != b.epoch || s.pos != b.at {
            return Ok(());
        }
        // A split may have moved the end closer since the block was cut.
        (s.end - b.at).clamp(0, b.data.len() as i64) as usize
    };
    if len == 0 {
        return Ok(());
    }
    sink.write_at(&b.data[..len], b.at as u64)?;
    let mut p = plan.lock();
    if p.epoch[b.seg] == b.epoch && p.ranges.segments[b.seg].pos == b.at {
        p.ranges.segments[b.seg].pos = b.at + len as i64;
    }
    Ok(())
}

/// The running writer.
pub(super) struct Writer {
    thread: tokio::task::JoinHandle<io::Result<()>>,
    failed: Arc<Mutex<Option<(io::ErrorKind, String)>>>,
}

impl Writer {
    /// Opens `part` on a blocking thread fed by the returned sender. The
    /// thread ends once every sender is gone.
    pub(super) fn start(part: PathBuf, plan: Arc<Mutex<Plan>>) -> (Writer, Sender) {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Block>(QUEUE);
        let failed: Arc<Mutex<Option<(io::ErrorKind, String)>>> = Arc::default();
        let seen = Arc::clone(&failed);
        let thread = tokio::task::spawn_blocking(move || {
            let fail = |e: &io::Error| {
                seen.lock().get_or_insert_with(|| (e.kind(), e.to_string()));
            };
            let mut file = match std::fs::OpenOptions::new().write(true).open(&part) {
                Ok(f) => Some(f),
                Err(e) => {
                    fail(&e);
                    None
                }
            };
            let mut error = None;
            while let Some(block) = rx.blocking_recv() {
                let Some(f) = file.as_mut().filter(|_| error.is_none()) else {
                    continue;
                };
                if let Err(e) = apply(f, &plan, &block) {
                    fail(&e);
                    error = Some(e);
                }
            }
            if let Some(e) = error {
                return Err(e);
            }
            let Some(file) = file else {
                let (kind, msg) = seen
                    .lock()
                    .clone()
                    .unwrap_or((io::ErrorKind::Other, String::new()));
                return Err(io::Error::new(kind, msg));
            };
            let synced = file.sync_data();
            // Closed here, before the transfer renames or deletes the `.part`.
            drop(file);
            synced
        });
        (Writer { thread, failed }, tx)
    }

    /// The first write that failed, while the writer runs.
    pub(super) fn failed(&self) -> Option<io::Error> {
        self.failed
            .lock()
            .as_ref()
            .map(|(kind, msg)| io::Error::new(*kind, msg.clone()))
    }

    /// Waits for the thread once every sender is dropped: the queued blocks
    /// are written, the file synced and its handle closed.
    pub(super) async fn finish(self) -> io::Result<()> {
        self.thread.await.map_err(io::Error::other)?
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Ranges, SegSource};
    use super::*;

    /// A file that stores `short` bytes of the first write and then fails,
    /// the way write(2) does on a disk that fills up mid-call, and takes
    /// every write after that. Records where each byte landed.
    struct ShortThenOk {
        short: usize,
        failed: bool,
        data: Vec<u8>,
    }

    impl Sink for ShortThenOk {
        fn write_at(&mut self, buf: &[u8], at: u64) -> io::Result<()> {
            let at = at as usize;
            let n = if self.failed {
                buf.len()
            } else {
                self.failed = true;
                self.short.min(buf.len())
            };
            if self.data.len() < at + n {
                self.data.resize(at + n, 0);
            }
            self.data[at..at + n].copy_from_slice(&buf[..n]);
            if n < buf.len() {
                return Err(io::ErrorKind::StorageFull.into());
            }
            Ok(())
        }
    }

    fn plan(total: i64) -> Mutex<Plan> {
        let authority = SegSource {
            copy: None,
            validator: Some("\"e\"".into()),
        };
        Mutex::new(Plan::new(Ranges::new(total, authority, 0)))
    }

    fn block(at: i64, epoch: u64, data: Vec<u8>) -> Block {
        Block {
            seg: 0,
            at,
            epoch,
            data,
        }
    }

    #[test]
    fn a_write_that_failed_part_way_is_not_written_again_shifted() {
        let plan = plan(1024);
        let mut file = ShortThenOk {
            short: 100,
            failed: false,
            data: Vec::new(),
        };
        let first: Vec<u8> = (0..=255).collect();
        assert!(apply(&mut file, &plan, &block(0, 0, first)).is_err());
        assert_eq!(plan.lock().ranges.segments[0].pos, 0, "nothing recorded");
        // The block after it does not continue what the segment holds.
        apply(&mut file, &plan, &block(256, 0, vec![7; 256])).unwrap();
        assert_eq!(plan.lock().ranges.segments[0].pos, 0);
        assert_eq!(file.data.len(), 100, "nothing written past the short write");
    }

    #[test]
    fn blocks_land_in_order_and_never_past_the_end_or_after_a_reset() {
        let plan = plan(1000);
        let mut file = ShortThenOk {
            short: usize::MAX,
            failed: true,
            data: Vec::new(),
        };
        apply(&mut file, &plan, &block(0, 0, vec![1; 400])).unwrap();
        assert_eq!(plan.lock().ranges.segments[0].pos, 400);
        // A split moved the end to 600 meanwhile.
        plan.lock().ranges.segments[0].end = 600;
        apply(&mut file, &plan, &block(400, 0, vec![2; 400])).unwrap();
        assert_eq!(plan.lock().ranges.segments[0].pos, 600);
        assert_eq!(file.data.len(), 600);
        // Reset: blocks of the old epoch are dropped.
        plan.lock().reset(0);
        apply(&mut file, &plan, &block(0, 0, vec![3; 10])).unwrap();
        assert_eq!(plan.lock().ranges.segments[0].pos, 0);
        assert_eq!(file.data[0], 1);
        apply(&mut file, &plan, &block(0, 1, vec![4; 10])).unwrap();
        assert_eq!(plan.lock().ranges.segments[0].pos, 10);
        assert_eq!(file.data[0], 4);
    }

    #[tokio::test]
    async fn the_writer_syncs_and_lets_the_part_go_when_its_senders_are_gone() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Movie.mp4.part");
        std::fs::write(&part, b"").unwrap();
        let plan = Arc::new(plan(8));
        let (writer, tx) = Writer::start(part.clone(), Arc::clone(&plan));
        tx.send(block(0, 0, b"abcd".to_vec())).await.unwrap();
        tx.send(block(4, 0, b"efgh".to_vec())).await.unwrap();
        drop(tx);
        writer.finish().await.unwrap();
        assert_eq!(plan.lock().ranges.segments[0].pos, 8);
        assert_eq!(std::fs::read(&part).unwrap(), b"abcdefgh");
        // The handle is closed: the `.part` can be renamed at once.
        std::fs::rename(&part, dir.path().join("Movie.mp4")).unwrap();
    }

    #[tokio::test]
    async fn a_part_that_cannot_be_opened_fails_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let (writer, tx) = Writer::start(dir.path().join("gone.part"), Arc::new(plan(8)));
        tx.send(block(0, 0, b"abcd".to_vec())).await.unwrap();
        drop(tx);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(writer.failed().is_some());
        assert!(writer.finish().await.is_err());
    }
}
