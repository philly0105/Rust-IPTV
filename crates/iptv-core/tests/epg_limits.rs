//! Hostile-feed bounds (R7 F2): a small `.xml.gz` that inflates to one huge
//! text node must not be buffered whole, and a feed past the decompressed
//! size cap fails cleanly with an Invalid error.
//!
//! Run: `cargo test -p iptv-core --release --test epg_limits -- --nocapture`

use flate2::write::GzEncoder;
use flate2::Compression;
use iptv_core::epg;
use iptv_core::{AppState, CoreError, NoopSink};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MB: usize = 1024 * 1024;

/// Writes `head`, then `fill_bytes` copies of `fill`, then `tail`, gzip-compressed.
fn write_gz(path: &Path, head: &str, fill: u8, fill_bytes: u64, tail: &str) {
    let file = BufWriter::new(std::fs::File::create(path).unwrap());
    let mut gz = GzEncoder::new(file, Compression::fast());
    gz.write_all(head.as_bytes()).unwrap();
    let chunk = vec![fill; MB];
    let mut left = fill_bytes;
    while left > 0 {
        let n = left.min(MB as u64) as usize;
        gz.write_all(&chunk[..n]).unwrap();
        left -= n as u64;
    }
    gz.write_all(tail.as_bytes()).unwrap();
    gz.finish().unwrap().flush().unwrap();
}

fn rss() -> usize {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem)
        .unwrap_or(0)
}

/// Runs `refresh_now` on a local file while sampling peak RSS; returns the
/// result, the peak RSS delta in MB and the elapsed seconds.
async fn refresh_measured(
    dir: &Path,
    path: &Path,
) -> (Result<epg::IngestStats, CoreError>, usize, f64) {
    let state = AppState::new(dir.join("data"), Arc::new(NoopSink), false)
        .await
        .unwrap();
    let url = path.to_string_lossy().into_owned();
    state.settings.write().epg_urls = vec![url.clone()];
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
    let result = epg::refresh_now(state.clone(), &url).await;
    let secs = started.elapsed().as_secs_f64();
    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    let delta = peak.load(Ordering::Relaxed).saturating_sub(baseline) / MB;
    (result, delta, secs)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn huge_text_node_in_small_gz_is_streamed() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("bomb.xml.gz");
    let now = chrono::Utc::now();
    let fmt = |d: chrono::DateTime<chrono::Utc>| d.format("%Y%m%d%H%M%S +0000").to_string();
    let head = format!(
        r#"<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel><programme start="{}" stop="{}" channel="a"><title>"#,
        fmt(now - chrono::Duration::hours(1)),
        fmt(now + chrono::Duration::hours(1)),
    );
    write_gz(
        &path,
        &head,
        b'A',
        300 * MB as u64,
        "</title></programme></tv>",
    );
    let gz_kb = std::fs::metadata(&path).unwrap().len() / 1024;

    let (result, delta_mb, secs) = refresh_measured(tmp.path(), &path).await;
    println!("epg_limits: 300 MB title node in {gz_kb} KB gz -> {result:?}, peak RSS delta {delta_mb} MB, {secs:.2} s");
    let stats = result.expect("ingest completes");
    assert_eq!(stats.channels, 1);
    assert_eq!(stats.programs, 1);
    assert!(
        delta_mb < 64,
        "peak RSS delta {delta_mb} MB >= 64 MB: the text node was buffered"
    );
}

/// 2 GB of whitespace after a valid start: the decompressed cap stops it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decompressed_size_cap_is_an_invalid_error() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("whitespace.xml.gz");
    let head =
        r#"<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel>"#;
    let started = Instant::now();
    write_gz(
        &path,
        head,
        b' ',
        iptv_core::epg::xmltv::MAX_DOCUMENT_BYTES + MB as u64,
        "</tv>",
    );
    let gen_secs = started.elapsed().as_secs_f64();

    let (result, delta_mb, secs) = refresh_measured(tmp.path(), &path).await;
    println!("epg_limits: 2 GB whitespace gz (generated in {gen_secs:.2} s) -> {result:?}, peak RSS delta {delta_mb} MB, {secs:.2} s");
    match result {
        Err(CoreError::Invalid(m)) => assert!(m.contains("decompressed"), "{m}"),
        other => panic!("expected an Invalid error, got {other:?}"),
    }
    assert!(delta_mb < 64, "peak RSS delta {delta_mb} MB");
}
