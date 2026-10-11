//! Guards for reading a playlist download body: a minimum average throughput,
//! so a server that drips a byte every few seconds (which keeps resetting the
//! idle timeout) cannot hold an import open forever.

use crate::error::{CoreError, CoreResult};
use std::time::{Duration, Instant};

/// Length of one throughput window.
#[cfg(not(test))]
pub const MIN_RATE_WINDOW: Duration = Duration::from_secs(60);
#[cfg(test)]
pub const MIN_RATE_WINDOW: Duration = Duration::from_secs(2);
/// Average bytes per second a download must reach over each window.
pub const MIN_RATE_BYTES_PER_SEC: u64 = 1024;

/// Fails a download whose body averaged under `bytes_per_sec` over a whole
/// window. Windows are consecutive: each starts when the previous one ended.
pub struct MinRate {
    window: Duration,
    bytes_per_sec: u64,
    since: Instant,
    bytes: u64,
}

impl MinRate {
    pub fn new(window: Duration, bytes_per_sec: u64) -> Self {
        Self {
            window,
            bytes_per_sec,
            since: Instant::now(),
            bytes: 0,
        }
    }

    /// [`MIN_RATE_WINDOW`] at [`MIN_RATE_BYTES_PER_SEC`].
    pub fn standard() -> Self {
        Self::new(MIN_RATE_WINDOW, MIN_RATE_BYTES_PER_SEC)
    }

    /// Records `n` bytes that just arrived from `host`. Errors with `Timeout`
    /// once a whole window passed below the minimum rate.
    pub fn on_bytes(&mut self, n: usize, host: &str) -> CoreResult<()> {
        self.bytes += n as u64;
        let elapsed = self.since.elapsed();
        if elapsed < self.window {
            return Ok(());
        }
        let needed = self.bytes_per_sec.saturating_mul(elapsed.as_secs().max(1));
        if self.bytes < needed {
            return Err(CoreError::Timeout(format!(
                "{host} is sending the playlist too slowly (under {} KB/s for {} s). Check your connection and that the server is online, then try again later.",
                (self.bytes_per_sec / 1024).max(1),
                elapsed.as_secs()
            )));
        }
        self.since = Instant::now();
        self.bytes = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_window_fails_and_fast_window_resets() {
        let mut r = MinRate::new(Duration::from_millis(0), 1024);
        // A zero-length window is judged as one second.
        assert!(r.on_bytes(2048, "h").is_ok());
        let err = r.on_bytes(10, "h").unwrap_err();
        assert!(
            matches!(err, CoreError::Timeout(ref m) if m.contains("too slowly") && m.contains("try again")),
            "{err:?}"
        );
        let mut r = MinRate::new(Duration::from_secs(3600), 1024);
        assert!(r.on_bytes(1, "h").is_ok(), "window not over yet");
    }
}
