//! A shared line: one byte budget that paces every body of every panel it is
//! given to, the way the user's own line caps the sum of every provider
//! connection (`Line::new(24 MiB/s)` shared by four panels in SC1).

use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How far behind real time the line's clock may fall before an idle line
/// stops banking bytes: covers timer lateness (Windows sleeps overshoot by
/// up to a tick) without letting a long idle spell turn into a burst.
const BURST: Duration = Duration::from_millis(50);

/// A token bucket shared by clones. Bodies take bytes in arrival order, so
/// connections share the line about evenly, as on a real line.
#[derive(Clone, Debug)]
pub struct Line(Arc<Inner>);

#[derive(Debug)]
struct Inner {
    bytes_per_second: u64,
    /// When the bytes taken so far have all gone out.
    free_at: Mutex<Instant>,
    served: AtomicU64,
}

impl Line {
    /// A line carrying `bytes_per_second` (0: unlimited, counted only).
    pub fn new(bytes_per_second: u64) -> Line {
        Line(Arc::new(Inner {
            bytes_per_second,
            free_at: Mutex::new(Instant::now()),
            served: AtomicU64::new(0),
        }))
    }

    /// Body bytes sent through this line so far, over every panel.
    pub fn served(&self) -> u64 {
        self.0.served.load(Ordering::SeqCst)
    }

    pub fn bytes_per_second(&self) -> u64 {
        self.0.bytes_per_second
    }

    /// Waits until `n` more bytes fit on the line, then counts them.
    pub(super) async fn pass(&self, n: u64) {
        let rate = self.0.bytes_per_second;
        if rate > 0 {
            let due = {
                let mut free_at = self.0.free_at.lock();
                let now = Instant::now();
                let floor = now.checked_sub(BURST).unwrap_or(now);
                let start = (*free_at).max(floor);
                *free_at = start + Duration::from_secs_f64(n as f64 / rate as f64);
                *free_at
            };
            tokio::time::sleep_until(due.into()).await;
        }
        self.0.served.fetch_add(n, Ordering::SeqCst);
    }
}
