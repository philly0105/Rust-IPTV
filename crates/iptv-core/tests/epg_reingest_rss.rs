//! P2-EPGRS-1: refreshing a feed over its own stored guide keeps memory
//! flat. The swap replaces every stored row, and the statement journal of
//! the copy (a page for each page it reuses from the deleted rows, about the
//! size of the guide) goes to a temp file with the staged rows. Before, the
//! re-key UPDATE journaled every staged page in memory. `epg_perf` ingests
//! into an empty guide, where the swap journals next to nothing.
//!
//! Measured on Colab (2 vCPUs), 172,923 programmes, the refresh over the
//! stored guide: peak RSS delta 33-39 MB, 92 MB before.
//!
//! Release-only: `cargo test -p iptv-core --release --test epg_reingest_rss -- --nocapture`

use iptv_core::epg;
use iptv_core::{AppState, NoopSink};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MB: usize = 1024 * 1024;
const FEED_MB: usize = 120;
const MAX_AGAIN_RSS_DELTA_MB: usize = 64;

fn rss() -> usize {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem)
        .unwrap_or(0)
}

/// Runs `refresh_now` for `url`; returns its stats, seconds and peak RSS
/// delta in MB.
async fn refresh_measured(state: &Arc<AppState>, url: &str) -> (epg::IngestStats, f64, usize) {
    let baseline = rss();
    let peak = Arc::new(AtomicUsize::new(baseline));
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (peak, stop) = (peak.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                peak.fetch_max(rss(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    let started = Instant::now();
    let stats = epg::refresh_now(state.clone(), url).await.unwrap();
    let secs = started.elapsed().as_secs_f64();
    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    let delta = peak.load(Ordering::Relaxed).saturating_sub(baseline) / MB;
    (stats, secs, delta)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[cfg_attr(debug_assertions, ignore = "RSS check; run with --release")]
async fn refreshing_over_a_stored_guide_stays_flat() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("feed.xml");
    iptv_fixtures::write_xmltv(&path, FEED_MB).unwrap();
    let state = AppState::new(tmp.path().join("data"), Arc::new(NoopSink), false)
        .await
        .unwrap();
    let url = path.to_string_lossy().into_owned();
    state.settings.write().epg_urls = vec![url.clone()];

    let (first, first_secs, first_mb) = refresh_measured(&state, &url).await;
    let (again, again_secs, again_mb) = refresh_measured(&state, &url).await;
    println!(
        "epg_reingest_rss: {} programmes; first {first_secs:.2} s, peak RSS delta {first_mb} MB; again {again_secs:.2} s, peak RSS delta {again_mb} MB",
        first.programs
    );

    assert!(first.programs > 100_000, "{first:?}");
    assert!(!again.not_modified);
    assert_eq!(again.programs, first.programs);
    let stored: i64 = state
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(stored as u64, again.programs);
    assert!(
        again_mb < MAX_AGAIN_RSS_DELTA_MB,
        "peak RSS delta {again_mb} MB >= {MAX_AGAIN_RSS_DELTA_MB} MB refreshing over the stored guide: the swap journals in memory"
    );
}
