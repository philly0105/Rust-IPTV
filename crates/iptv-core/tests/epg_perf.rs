//! Check 5 (SC3): a 120 MB XMLTV file is ingested in under 15 s (release
//! builds) with a peak RSS delta under 150 MB, proving the parser streams.
//!
//! Run: `cargo test -p iptv-core --release --test epg_perf -- --nocapture`

use iptv_core::epg;
use iptv_core::{AppState, NoopSink};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TARGET_MB: usize = 120;
const MAX_SECS: f64 = 15.0;
const MAX_RSS_DELTA_MB: usize = 150;

/// Streams a realistic XMLTV file of at least `megabytes` MB: 400 channels,
/// 30-minute programmes in time order starting a day ago, with titles,
/// descriptions, categories, icons, entities and offsets.
fn write_own_xmltv(path: &Path, megabytes: usize) -> std::io::Result<()> {
    let target = (megabytes * 1024 * 1024) as u64;
    let mut w = BufWriter::with_capacity(1 << 20, std::fs::File::create(path)?);
    let mut written: u64 = 0;
    fn put(w: &mut BufWriter<std::fs::File>, written: &mut u64, s: &str) -> std::io::Result<()> {
        *written += s.len() as u64;
        w.write_all(s.as_bytes())
    }
    put(&mut w, &mut written, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE tv SYSTEM \"xmltv.dtd\">\n<tv generator-info-name=\"epg_perf\">\n")?;
    let channels = 400;
    for c in 0..channels {
        put(
            &mut w,
            &mut written,
            &format!(
                "  <channel id=\"ch{c}.perf\">\n    <display-name lang=\"en\">Perf Channel {c} HD</display-name>\n    <icon src=\"http://logos.example/ch{c}.png\" />\n  </channel>\n"
            ),
        )?;
    }
    let now = chrono::Utc::now().timestamp();
    let base = now - now % 1800 - 86_400;
    let mut slot: i64 = 0;
    let fmt = |t: i64| {
        chrono::DateTime::from_timestamp(t, 0)
            .unwrap()
            .with_timezone(&chrono::FixedOffset::east_opt(3600).unwrap())
            .format("%Y%m%d%H%M%S %z")
            .to_string()
    };
    'outer: loop {
        let start = fmt(base + slot * 1800);
        let stop = fmt(base + (slot + 1) * 1800);
        for c in 0..channels {
            let s = format!(
                "  <programme start=\"{start}\" stop=\"{stop}\" channel=\"ch{c}.perf\">\n    <title lang=\"en\">Programme {slot} on channel {c} &amp; friends</title>\n    <desc lang=\"en\">Episode {slot}: a description long enough to look like a real guide entry, with an entity &quot;here&quot; and some more words.</desc>\n    <category lang=\"en\">Entertainment</category>\n    <icon src=\"http://img.example/p/{c}/{slot}.jpg\" />\n  </programme>\n"
            );
            put(&mut w, &mut written, &s)?;
            if written >= target {
                break 'outer;
            }
        }
        slot += 1;
    }
    put(&mut w, &mut written, "</tv>\n")?;
    w.flush()
}

fn rss() -> usize {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem)
        .unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ingest_120mb_xmltv_streaming() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("large.xml");

    // Prefer B11's generator when it exists and produces a full-size file.
    let from_fixtures = iptv_fixtures::write_xmltv(&path, TARGET_MB).is_ok()
        && std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            >= (TARGET_MB as u64 * 1024 * 1024) * 9 / 10;
    if !from_fixtures {
        write_own_xmltv(&path, TARGET_MB).unwrap();
    }
    let size = std::fs::metadata(&path).unwrap().len();
    assert!(
        size >= (TARGET_MB as u64) * 1024 * 1024 * 9 / 10,
        "fixture is {size} bytes"
    );

    let state = AppState::new(tmp.path().join("data"), Arc::new(NoopSink), false)
        .await
        .unwrap();
    let url = path.to_string_lossy().into_owned();
    state.settings.write().epg_urls = vec![url.clone()];

    // Sample RSS in the background to catch the peak, not just the end state.
    let baseline = rss();
    let peak = Arc::new(AtomicUsize::new(baseline));
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (peak, stop) = (peak.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                peak.fetch_max(rss(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };

    let started = Instant::now();
    let stats = epg::refresh_now(state.clone(), &url).await.unwrap();
    let secs = started.elapsed().as_secs_f64();
    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    let delta_mb = peak.load(Ordering::Relaxed).saturating_sub(baseline) / (1024 * 1024);

    println!(
        "epg_perf: {:.1} MB ({}) -> {} channels, {} programmes kept, {} outside window, {:.2} s, peak RSS delta {} MB",
        size as f64 / 1_048_576.0,
        if from_fixtures { "iptv_fixtures::write_xmltv" } else { "own generator" },
        stats.channels,
        stats.programs,
        stats.skipped_window,
        secs,
        delta_mb
    );

    assert!(stats.channels > 0);
    assert!(
        stats.programs + stats.skipped_window > 100_000,
        "whole file parsed"
    );
    if !from_fixtures {
        assert!(
            stats.programs > 100_000,
            "programmes inside the 2-day/14-day window are kept"
        );
    }
    let stored: i64 = state
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(stored as u64, stats.programs);
    assert!(
        delta_mb < MAX_RSS_DELTA_MB,
        "peak RSS delta {delta_mb} MB >= {MAX_RSS_DELTA_MB} MB: the parser is not streaming"
    );
    #[cfg(not(debug_assertions))]
    assert!(
        secs < MAX_SECS,
        "ingest took {secs:.2} s (limit {MAX_SECS} s)"
    );
    #[cfg(debug_assertions)]
    let _ = MAX_SECS;
}
