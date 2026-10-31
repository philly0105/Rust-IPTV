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

/// Peak RSS over a span, sampled every 5 ms on a thread of its own.
struct PeakRss {
    baseline: usize,
    peak: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    sampler: std::thread::JoinHandle<()>,
}

impl PeakRss {
    fn start() -> Self {
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
        Self {
            baseline,
            peak,
            stop,
            sampler,
        }
    }

    /// Bytes the peak rose above the RSS at [`PeakRss::start`].
    fn delta(self) -> usize {
        self.stop.store(true, Ordering::Relaxed);
        self.sampler.join().unwrap();
        self.peak
            .load(Ordering::Relaxed)
            .saturating_sub(self.baseline)
    }
}

/// Writes an Xtream-shaped `get.php?type=m3u_plus` list: `live` channels,
/// `movies` `/movie/` entries and `shows` series of `episodes` `/series/`
/// entries each, every entry with a logo of its own. `rev` changes every
/// URL token, as a provider rotating them between refreshes does.
fn write_m3u_plus(
    path: &std::path::Path,
    live: usize,
    movies: usize,
    shows: usize,
    episodes: usize,
    rev: u32,
) {
    use std::io::Write as _;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    f.write_all(b"#EXTM3U\n").unwrap();
    let host = "http://panel.example:8080";
    for i in 0..live {
        writeln!(
            f,
            "#EXTINF:-1 tvg-id=\"ch{i}.example\" tvg-name=\"UK: Channel {i} HD\" tvg-logo=\"http://logo.example/live/{i}.png\" group-title=\"UK | Group {}\",UK: Channel {i} HD\n{host}/u/p{rev}/{i}.ts",
            i % 100
        )
        .unwrap();
    }
    for i in 0..movies {
        writeln!(
            f,
            "#EXTINF:-1 tvg-id=\"\" tvg-name=\"EN - Movie Title {i} ({})\" tvg-logo=\"http://img.example/movie/{i}.jpg\" group-title=\"VOD | Genre {}\",EN - Movie Title {i} ({})\n{host}/movie/u/p{rev}/{}.mkv",
            1980 + i % 45,
            i % 60,
            1980 + i % 45,
            100_000 + i
        )
        .unwrap();
    }
    for s in 0..shows {
        let year = 1990 + s % 35;
        for e in 0..episodes {
            let (season, ep) = (1 + e / 10, 1 + e % 10);
            writeln!(
                f,
                "#EXTINF:-1 tvg-id=\"\" tvg-name=\"EN - Show Name {s} ({year}) S{season:02} E{ep:02}\" tvg-logo=\"http://img.example/series/{s}/{e}.jpg\" group-title=\"Series | Genre {}\",EN - Show Name {s} ({year}) S{season:02} E{ep:02}\n{host}/series/u/p{rev}/{}.mkv",
                s % 40,
                1_000_000 + s * episodes + e
            )
            .unwrap();
        }
    }
    f.flush().unwrap();
}

/// CPU time of the whole process so far (every thread), where the platform
/// tells; a contention-proof companion to wall-clock times.
fn cpu_time() -> Duration {
    #[cfg(unix)]
    {
        // SAFETY: getrusage only writes the struct it is given.
        let mut u: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) } == 0 {
            let tv = |t: libc::timeval| {
                Duration::from_secs(t.tv_sec as u64) + Duration::from_micros(t.tv_usec as u64)
            };
            return tv(u.ru_utime) + tv(u.ru_stime);
        }
    }
    Duration::ZERO
}

/// sha256 over every catalog row and category of `source_id`, in insert
/// order: two imports of one playlist wrote the same catalog when it matches.
async fn catalog_digest(state: &Arc<iptv_core::AppState>, source_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let sid = source_id.to_string();
    state
        .db_call(move |c| {
            let mut h = Sha256::new();
            let mut stmt = c.prepare(
                "SELECT content_type, item_id, category_id, title, title_base, number, logo_url,
                        poster_url, year, epg_channel_id, url, container_extension, is_radio,
                        archive_hours, extra_json, position, non_english, quality
                 FROM items WHERE source_id = ?1 ORDER BY rowid",
            )?;
            let mut rows = stmt.query([&sid])?;
            while let Some(r) = rows.next()? {
                for i in 0..18 {
                    let v: rusqlite::types::Value = r.get(i)?;
                    h.update(format!("{v:?}\u{1}").as_bytes());
                }
                h.update(b"\n");
            }
            let mut stmt = c.prepare(
                "SELECT content_type, category_id, name, position, hidden, item_count
                 FROM categories WHERE source_id = ?1 ORDER BY content_type, position, category_id",
            )?;
            let mut rows = stmt.query([&sid])?;
            while let Some(r) = rows.next()? {
                for i in 0..6 {
                    let v: rusqlite::types::Value = r.get(i)?;
                    h.update(format!("{v:?}\u{1}").as_bytes());
                }
                h.update(b"\n");
            }
            Ok(hex::encode(h.finalize()))
        })
        .await
        .unwrap()
}

/// An m3u_plus list with series episodes (50k channels, 100k movies, 300k
/// episodes of 10k shows) imported, then refreshed with every URL token
/// rotated. Prints time, CPU time and peak RSS delta of both, and a digest
/// of the catalog each wrote; slow, so ignored:
/// `cargo test -p iptv-core --release --test m3u_perf -- --ignored`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn import_m3u_plus_with_series_episodes() {
    const LIVE: usize = 50_000;
    const MOVIES: usize = 100_000;
    const SHOWS: usize = 10_000;
    const EPISODES: usize = 30;
    const SERIES_RSS_LIMIT: usize = 320 * 1024 * 1024;
    let env = env().await;
    let path = env.dir.path().join("plus.m3u");
    write_m3u_plus(&path, LIVE, MOVIES, SHOWS, EPISODES, 1);
    let size = std::fs::metadata(&path).unwrap().len();

    let peak = PeakRss::start();
    let (started, cpu) = (Instant::now(), cpu_time());
    let src = iptv_core::sources::add(env.state.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let (elapsed, cpu) = (started.elapsed(), cpu_time() - cpu);
    let delta = peak.delta();
    assert_eq!(src.channel_count, LIVE as i64);
    assert_eq!(src.movie_count, MOVIES as i64);
    assert_eq!(src.series_count, SHOWS as i64);
    let digest = catalog_digest(&env.state, &src.id).await;
    eprintln!(
        "m3u_perf: {} MB m3u_plus ({} episodes) added in {elapsed:?} (CPU {cpu:?}), peak RSS delta {} MB, catalog {}",
        size / (1024 * 1024),
        SHOWS * EPISODES,
        delta / (1024 * 1024),
        digest
    );
    // About 215 MB once each show's row is written as it is built; holding
    // every series row through the index rebuild took about 420 MB.
    assert!(
        delta < SERIES_RSS_LIMIT,
        "RSS delta {delta} bytes exceeds 320 MB"
    );

    write_m3u_plus(&path, LIVE, MOVIES, SHOWS, EPISODES, 2);
    let peak = PeakRss::start();
    let (started, cpu) = (Instant::now(), cpu_time());
    let src = iptv_core::sources::refresh(env.state.clone(), &src.id)
        .await
        .unwrap();
    let (elapsed, cpu) = (started.elapsed(), cpu_time() - cpu);
    let delta = peak.delta();
    assert_eq!(src.series_count, SHOWS as i64);
    eprintln!(
        "m3u_perf: m3u_plus refreshed in {elapsed:?} (CPU {cpu:?}), peak RSS delta {} MB, catalog {}",
        delta / (1024 * 1024),
        catalog_digest(&env.state, &src.id).await
    );
}

/// Parsing and row building alone, without the database, over the m3u_plus
/// list of [`import_m3u_plus_with_series_episodes`]: the part of an import
/// that does not need the connection. Best of three; ignored:
/// `cargo test -p iptv-core --release --test m3u_perf -- --ignored`
#[test]
#[ignore]
fn parse_and_build_m3u_plus_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plus.m3u");
    write_m3u_plus(&path, 50_000, 100_000, 10_000, 30, 1);
    let bytes = std::fs::read(&path).unwrap();
    let mut best = Duration::MAX;
    for _ in 0..3 {
        let started = Instant::now();
        let mut b = iptv_core::m3u::RowBuilder::new("s");
        // The writer stores each row's extra as text.
        let mut extra = 0usize;
        let mut rows = 0usize;
        for e in iptv_core::m3u::M3uReader::new(&bytes[..]) {
            if let Some(row) = b.push(e) {
                extra += row.extra.to_string().len();
                rows += 1;
            }
        }
        let (series, _) = b.take_series();
        for row in &series {
            extra += row.extra.to_string().len();
        }
        best = best.min(started.elapsed());
        assert_eq!((rows, series.len()), (150_000, 10_000));
        assert!(extra > 0);
    }
    eprintln!("m3u_perf: m3u_plus parsed and built in {best:?}");
}
