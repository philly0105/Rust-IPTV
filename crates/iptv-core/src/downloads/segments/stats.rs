//! Per-connection meters and the transfer breakdown (`downloads.stats`),
//! shared by segmented attempts and single streams.

use super::super::manager::{DownloadManager, TaskCtl};
use crate::model::{Limiting, SourceRole, SourceStat, TransferStats};
use crate::state::AppState;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How often a transfer publishes its breakdown.
pub(crate) const STATS_EVERY: Duration = Duration::from_secs(1);

/// What one connection served.
pub(crate) struct Meter {
    bytes: AtomicI64,
    started: Instant,
    /// URL host, and the address it was pinned to.
    peer: Mutex<(String, Option<String>)>,
    /// When the speed was last sampled, the bytes then, and that speed.
    sample: Mutex<(Instant, i64, i64)>,
}

impl Meter {
    pub(crate) fn new(host: &str) -> Arc<Self> {
        let now = Instant::now();
        Arc::new(Self {
            bytes: AtomicI64::new(0),
            started: now,
            peer: Mutex::new((host.to_string(), None)),
            sample: Mutex::new((now, 0, 0)),
        })
    }

    pub(crate) fn add(&self, n: usize) {
        self.bytes.fetch_add(n as i64, Ordering::Relaxed);
    }

    pub(crate) fn bytes(&self) -> i64 {
        self.bytes.load(Ordering::Relaxed)
    }

    pub(crate) fn age(&self) -> Duration {
        self.started.elapsed()
    }

    pub(crate) fn set_peer(&self, host: String, address: Option<String>) {
        *self.peer.lock() = (host, address);
    }

    pub(crate) fn peer(&self) -> (String, Option<String>) {
        self.peer.lock().clone()
    }

    /// The speed since the last sample (bytes per second), kept for
    /// [`Meter::speed`].
    pub(crate) fn sample(&self, now: Instant) -> i64 {
        let bytes = self.bytes();
        let mut s = self.sample.lock();
        let secs = now.duration_since(s.0).as_secs_f64();
        if secs >= 0.05 {
            s.2 = ((bytes - s.1) as f64 / secs).round().max(0.0) as i64;
            s.0 = now;
            s.1 = bytes;
        }
        s.2
    }

    /// The speed the last sample measured.
    pub(crate) fn speed(&self) -> i64 {
        self.sample.lock().2
    }
}

/// Position of a limiting factor in the order of [`Limiting`]: when several
/// apply, the lowest wins.
pub(crate) fn rank(l: &Limiting) -> u8 {
    match l {
        Limiting::SpeedLimit { .. } => 0,
        Limiting::NoRanges => 1,
        Limiting::SmallFile => 2,
        Limiting::SingleConnection { .. } => 3,
        Limiting::MaxConnections { .. } => 4,
        Limiting::Playback { .. } => 5,
        Limiting::OtherDownloads { .. } => 6,
        Limiting::Refused { .. } => 7,
        Limiting::Line { .. } => 8,
        Limiting::PerConnection { .. } => 9,
        Limiting::AccountLimit { .. } => 10,
    }
}

/// The factor that wins among `found`.
pub(crate) fn first(found: impl IntoIterator<Item = Limiting>) -> Option<Limiting> {
    found.into_iter().min_by_key(rank)
}

/// Factors every transfer from `source` reports, whatever its stage: the
/// speed cap and "Connections per download: 1".
pub(crate) fn settings_reasons(state: &AppState, ctl: &TaskCtl, source: &str) -> Vec<Limiting> {
    let settings = state.settings.read();
    let mut found = Vec::new();
    if let Some(bps) = ctl.rate_limit(settings.download_rate_limit_bps) {
        found.push(Limiting::SpeedLimit {
            bytes_per_second: bps.min(i64::MAX as u64) as i64,
        });
    }
    if settings
        .download_single_connection
        .iter()
        .any(|s| s == source)
    {
        found.push(Limiting::SingleConnection {
            source_id: source.to_string(),
        });
    }
    found
}

/// One source's line of the breakdown.
pub(crate) fn source_stat(
    mgr: &DownloadManager,
    source_id: &str,
    role: SourceRole,
    connections: usize,
    bytes_per_second: i64,
    bytes: i64,
) -> SourceStat {
    let (limit, limit_kind) = mgr.effective_limit(source_id);
    SourceStat {
        source_id: source_id.to_string(),
        role,
        connections: connections as i64,
        bytes_per_second,
        bytes,
        limit,
        limit_kind,
    }
}

/// Stores `s` as the transfer's latest breakdown and sends it.
pub(crate) fn publish(state: &AppState, ctl: &TaskCtl, s: TransferStats) {
    ctl.publish_stats(s.clone());
    state.emit("downloads.stats", s);
}

/// The median of `speeds` (the upper one of an even count).
pub(crate) fn median(speeds: &[i64]) -> i64 {
    let mut sorted = speeds.to_vec();
    sorted.sort_unstable();
    sorted.get(sorted.len() / 2).copied().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_factor_in_the_documented_order_wins() {
        let line = Limiting::Line {
            bytes_per_second: 5,
        };
        let playback = Limiting::Playback {
            source_id: "a".into(),
        };
        let account = Limiting::AccountLimit {
            source_id: "a".into(),
            limit: 1,
        };
        assert_eq!(
            first([account.clone(), line.clone(), playback.clone()]),
            Some(playback)
        );
        assert_eq!(first([account.clone(), line.clone()]), Some(line));
        assert_eq!(first(Vec::new()), None);
        assert_eq!(median(&[5, 1, 9]), 5);
        assert_eq!(median(&[]), 0);
    }

    #[test]
    fn a_meter_reports_what_it_served_since_its_last_sample() {
        let m = Meter::new("h");
        let t0 = Instant::now();
        m.add(1000);
        let bps = m.sample(t0 + Duration::from_secs(1));
        assert!((900..=1100).contains(&bps), "{bps}");
        assert_eq!(m.speed(), bps);
        assert_eq!(m.bytes(), 1000);
        assert_eq!(m.peer(), ("h".to_string(), None));
    }
}
