//! Check 4 (B1): a 50k-channel M3U imported into a temp AppState in under
//! 3 s (release builds) with an RSS delta under 200 MB.
//!
//! Run: `cargo test -p iptv-core --release --test m3u_perf`

#[path = "m3u_support.rs"]
mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

const CHANNELS: usize = 50_000;
const RSS_LIMIT: usize = 200 * 1024 * 1024;

fn rss() -> usize {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem)
        .unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_50k_channels_fast_and_lean() {
    let env = env().await;
    let path = env.dir.path().join("perf.m3u");
    std::fs::write(&path, gen_m3u(CHANNELS, 40)).unwrap();

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
    let src = iptv_core::sources::add(env.state.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let elapsed = started.elapsed();
    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();

    assert_eq!(src.channel_count, CHANNELS as i64);
    let delta = peak.load(Ordering::Relaxed).saturating_sub(baseline);
    eprintln!(
        "m3u_perf: {CHANNELS} channels in {elapsed:?}, peak RSS delta {} MB",
        delta / (1024 * 1024)
    );
    assert!(delta < RSS_LIMIT, "RSS delta {delta} bytes exceeds 200 MB");
    #[cfg(not(debug_assertions))]
    assert!(elapsed < Duration::from_secs(3), "import took {elapsed:?}");
}

/// R7 F1: an ~80 MB playlist file imports with a peak RSS delta under 100 MB
/// (the text is streamed, never read whole, and not copied into `m3u_raw`).
/// Slow in debug builds, so ignored by default:
/// `cargo test -p iptv-core --release --test m3u_perf -- --ignored`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn import_80mb_playlist_with_flat_memory() {
    const BIG_CHANNELS: usize = 480_000;
    const BIG_RSS_LIMIT: usize = 100 * 1024 * 1024;
    let env = env().await;
    let path = env.dir.path().join("big.m3u");
    {
        use std::io::Write as _;
        let mut f = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        f.write_all(b"#EXTM3U\n").unwrap();
        for i in 0..BIG_CHANNELS {
            writeln!(
                f,
                "#EXTINF:-1 tvg-id=\"ch{i}.example\" tvg-name=\"Channel {i}\" tvg-logo=\"http://logo.example/{i}.png\" group-title=\"Group {}\",Channel {i}\nhttp://stream.example/live/{i}.ts",
                i % 200
            )
            .unwrap();
        }
    }
    let size = std::fs::metadata(&path).unwrap().len();
    assert!(size > 75 * 1024 * 1024, "fixture is {size} bytes");

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
    let src = iptv_core::sources::add(env.state.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let elapsed = started.elapsed();
    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();

    assert_eq!(src.channel_count, BIG_CHANNELS as i64);
    let delta = peak.load(Ordering::Relaxed).saturating_sub(baseline);
    eprintln!(
        "m3u_perf: {} MB playlist ({BIG_CHANNELS} channels) in {elapsed:?}, peak RSS delta {} MB",
        size / (1024 * 1024),
        delta / (1024 * 1024)
    );
    assert!(
        delta < BIG_RSS_LIMIT,
        "RSS delta {delta} bytes exceeds 100 MB"
    );
}
