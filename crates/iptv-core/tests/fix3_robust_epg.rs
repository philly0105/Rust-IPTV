//! Fix wave 3 (R7-r3 F1..F3): XMLTV memory and size bounds.
//!
//! - F1: stop-less programmes past the window are skipped before they are
//!   held, and the held set is capped (the oldest gets the default duration).
//! - F2: unclosed start tags do not grow quick-xml's stack of open names.
//! - F3: over-long channel ids / programme channels are skipped, over-long
//!   icon URLs dropped, so they never reach the store.
//!
//! The parser tests run in debug. The RSS / database-size checks are
//! release-only (payloads of at most 100 MB):
//! `cargo test -p iptv-core --release --test fix3_robust_epg -- --nocapture`

use flate2::write::GzEncoder;
use flate2::Compression;
use iptv_core::epg;
use iptv_core::epg::xmltv::{
    parse, ParseStats, Window, XmltvItem, XmltvProgramme, DEFAULT_DURATION_SECS, MAX_ID_BYTES,
    MAX_PENDING, MAX_URL_BYTES,
};
use iptv_core::{AppState, CoreError, NoopSink};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MB: usize = 1024 * 1024;
const T0: i64 = 1_700_000_000;

fn xml_time(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .format("%Y%m%d%H%M%S +0000")
        .to_string()
}

fn run(xml: &[u8], window: Window) -> (Vec<XmltvItem>, ParseStats) {
    let mut items = Vec::new();
    let stats = parse(xml, window, &mut |i| {
        items.push(i);
        Ok(())
    })
    .expect("parse");
    (items, stats)
}

fn programmes(items: &[XmltvItem]) -> Vec<&XmltvProgramme> {
    items
        .iter()
        .filter_map(|i| match i {
            XmltvItem::Programme(p) => Some(p),
            _ => None,
        })
        .collect()
}

/// F1: a stop-less programme starting after the window is skipped at once;
/// stop inference inside the window is unchanged.
#[test]
fn stopless_programme_past_the_window_is_not_held() {
    let window = Window {
        min_stop: T0 - 1000,
        max_start: T0 + 10_000,
    };
    let xml = format!(
        r#"<tv><programme channel="a" start="{}"/><programme channel="a" start="{}"/><programme channel="b" start="{}"/></tv>"#,
        xml_time(T0),
        xml_time(T0 + 600),
        xml_time(T0 + 20_000),
    );
    let (items, stats) = run(xml.as_bytes(), window);
    let progs = programmes(&items);
    assert_eq!(progs.len(), 2, "{stats:?}");
    assert_eq!((progs[0].start, progs[0].stop), (T0, T0 + 600));
    assert_eq!(progs[1].stop, T0 + 600 + DEFAULT_DURATION_SECS);
    assert_eq!(stats.skipped_window, 1, "{stats:?}");
}

/// F1: more distinct stop-less channels than the cap: every programme still
/// comes out, the oldest held one with the default duration once the cap is
/// passed, the rest with stops inferred as before.
#[test]
fn held_stopless_programmes_are_capped() {
    let n = MAX_PENDING + 5_000;
    let mut xml = String::with_capacity(n * 64);
    xml.push_str("<tv>");
    // The oldest held programme: evicted when the cap is passed.
    xml.push_str(&format!(
        r#"<programme channel="x" start="{}"/>"#,
        xml_time(T0)
    ));
    let later = xml_time(T0 + 60);
    for i in 0..n {
        xml.push_str(&format!(r#"<programme channel="c{i}" start="{later}"/>"#));
    }
    // A second programme on "x": the first was already evicted, so it cannot
    // lend its start as the first one's stop.
    xml.push_str(&format!(
        r#"<programme channel="x" start="{}"/></tv>"#,
        xml_time(T0 + 100)
    ));
    let (items, stats) = run(xml.as_bytes(), Window::unbounded());
    let progs = programmes(&items);
    assert_eq!(progs.len(), n + 2, "{stats:?}");
    assert_eq!(stats.inferred_stop, (n + 2) as u64);
    let x: Vec<_> = progs.iter().filter(|p| p.channel == "x").collect();
    assert_eq!(x.len(), 2);
    assert_eq!(
        x[0].stop,
        T0 + DEFAULT_DURATION_SECS,
        "evicted with the default duration"
    );
}

/// F2: stray unclosed tags inside descriptions (more than the nesting bound)
/// keep every programme and its text.
#[test]
fn unclosed_tags_in_descriptions_keep_parsing() {
    let mut xml = String::from(r#"<tv><channel id="a"><display-name>A</display-name></channel>"#);
    for i in 0..1000 {
        xml.push_str(&format!(
            r#"<programme channel="a" start="{}" stop="{}"><title>T{i}</title><desc>one<br>two</desc></programme>"#,
            xml_time(T0 + i * 60),
            xml_time(T0 + i * 60 + 60),
        ));
    }
    xml.push_str("</tv>");
    let (items, stats) = run(xml.as_bytes(), Window::unbounded());
    let progs = programmes(&items);
    assert_eq!(progs.len(), 1000, "{stats:?}");
    assert_eq!(stats.channels, 1);
    assert!(stats.truncated.is_none(), "{stats:?}");
    assert_eq!(progs[999].title, "T999");
    assert_eq!(progs[999].description.as_deref(), Some("onetwo"));
}

/// F2: a run of unclosed start tags (a nesting bomb, here 3 MB) is read
/// through; programmes after it still parse.
#[test]
fn nesting_bomb_is_read_through() {
    let mut xml = format!(
        r#"<tv><programme channel="a" start="{}" stop="{}"><title>Before</title></programme>"#,
        xml_time(T0),
        xml_time(T0 + 60)
    )
    .into_bytes();
    xml.extend(b"<a>".repeat(MB));
    // Long names too: the stack is bounded by bytes as well as depth.
    let long = format!("<{}>", "n".repeat(10_000));
    xml.extend(long.repeat(100).as_bytes());
    xml.extend(
        format!(
            r#"<programme channel="a" start="{}" stop="{}"><title>After</title></programme></tv>"#,
            xml_time(T0 + 60),
            xml_time(T0 + 120)
        )
        .as_bytes(),
    );
    let (items, stats) = run(&xml, Window::unbounded());
    let titles: Vec<_> = programmes(&items).iter().map(|p| p.title.clone()).collect();
    assert_eq!(titles, ["Before", "After"], "{stats:?}");
}

/// F3: ids over [`MAX_ID_BYTES`] skip the element (counted invalid), icons
/// over [`MAX_URL_BYTES`] are dropped, values at the limits are kept.
#[test]
fn long_ids_and_icons_are_capped() {
    let ok_id = "i".repeat(MAX_ID_BYTES);
    let long_id = "i".repeat(MAX_ID_BYTES + 1);
    let ok_icon = format!("http://x/{}", "p".repeat(MAX_URL_BYTES - 9));
    let long_icon = format!("http://x/{}", "p".repeat(MAX_URL_BYTES));
    let (start, stop) = (xml_time(T0), xml_time(T0 + 60));
    let xml = format!(
        r#"<tv>
<channel id="{long_id}"><display-name>Long</display-name></channel>
<channel id="{ok_id}"><display-name>Ok</display-name><icon src="{long_icon}"/></channel>
<channel id="b"><icon src="{ok_icon}"/></channel>
<programme channel="{long_id}" start="{start}" stop="{stop}"><title>L</title></programme>
<programme channel="{ok_id}" start="{start}" stop="{stop}"><title>O</title><icon src="{long_icon}"/></programme>
</tv>"#
    );
    let (items, stats) = run(xml.as_bytes(), Window::unbounded());
    let channels: Vec<_> = items
        .iter()
        .filter_map(|i| match i {
            XmltvItem::Channel(c) => Some(c),
            _ => None,
        })
        .collect();
    assert_eq!(channels.len(), 2, "{stats:?}");
    assert_eq!(channels[0].id, ok_id);
    assert_eq!(channels[0].icon, None, "over-long icon dropped");
    assert_eq!(channels[1].icon.as_deref(), Some(ok_icon.as_str()));
    let progs = programmes(&items);
    assert_eq!(progs.len(), 1);
    assert_eq!(progs[0].channel, ok_id);
    assert_eq!(progs[0].icon, None);
    assert_eq!(stats.skipped_invalid, 2, "long channel + long programme");
}

// ---------------------------------------------------------------------------
// Release-only RSS / database-size checks through `epg::refresh_now`.
// ---------------------------------------------------------------------------

fn rss() -> usize {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem)
        .unwrap_or(0)
}

fn gz(path: &Path, f: impl FnOnce(&mut dyn Write)) -> u64 {
    let file = BufWriter::new(std::fs::File::create(path).unwrap());
    let mut g = GzEncoder::new(file, Compression::fast());
    f(&mut g);
    g.finish().unwrap().flush().unwrap();
    std::fs::metadata(path).unwrap().len() / 1024
}

fn head() -> String {
    let now = chrono::Utc::now().timestamp();
    format!(
        r#"<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel><programme start="{}" stop="{}" channel="a"><title>T</title></programme>"#,
        xml_time(now),
        xml_time(now + 3600)
    )
}

struct Measured {
    result: Result<epg::IngestStats, CoreError>,
    rss_mb: usize,
    db_mb: u64,
    secs: f64,
}

async fn refresh_measured(dir: &Path, path: &Path) -> Measured {
    let data = dir.join("data");
    let state = AppState::new(data.clone(), Arc::new(NoopSink), false)
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
    let mut db = 0u64;
    for e in std::fs::read_dir(&data).unwrap().flatten() {
        if e.file_name().to_string_lossy().starts_with("iptv.db") {
            db += e.metadata().unwrap().len();
        }
    }
    Measured {
        result,
        rss_mb: peak.load(Ordering::Relaxed).saturating_sub(baseline) / MB,
        db_mb: db / MB as u64,
        secs,
    }
}

/// F2: 100 MB of unclosed `<a>` (a few hundred KB of gzip) at flat memory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[cfg_attr(debug_assertions, ignore = "RSS check; run with --release")]
async fn nesting_bomb_stays_flat() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("n.xml.gz");
    let unit = b"<a>".repeat(MB / 3);
    let kb = gz(&path, |w| {
        w.write_all(head().as_bytes()).unwrap();
        for _ in 0..100 {
            w.write_all(&unit).unwrap();
        }
        w.write_all(b"</tv>").unwrap();
    });
    let m = refresh_measured(d.path(), &path).await;
    println!(
        "fix3 nesting bomb 100 MB ({kb} KB gz): {:.2} s, peak RSS delta {} MB, {:?}",
        m.secs, m.rss_mb, m.result
    );
    let stats = m.result.expect("parses");
    assert_eq!(stats.channels, 1);
    assert!(m.rss_mb < 64, "peak RSS delta {} MB", m.rss_mb);
}

/// F1: 100 MB of stop-less programmes on distinct channels, 400 days old.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[cfg_attr(debug_assertions, ignore = "RSS check; run with --release")]
async fn pending_bomb_stays_bounded() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("p.xml.gz");
    let start = xml_time(chrono::Utc::now().timestamp() - 400 * 86_400);
    let mut n = 0u64;
    let kb = gz(&path, |w| {
        w.write_all(head().as_bytes()).unwrap();
        let mut bytes = 0usize;
        while bytes < 100 * MB {
            let s = format!(r#"<programme channel="c{n}" start="{start}"/>"#);
            bytes += s.len();
            n += 1;
            w.write_all(s.as_bytes()).unwrap();
        }
        w.write_all(b"</tv>").unwrap();
    });
    let m = refresh_measured(d.path(), &path).await;
    println!(
        "fix3 pending bomb 100 MB, {n} stop-less programmes ({kb} KB gz): {:.2} s, peak RSS delta {} MB, db {} MB, {:?}",
        m.secs, m.rss_mb, m.db_mb, m.result
    );
    let stats = m.result.expect("parses");
    assert_eq!(stats.skipped_window, n);
    // The cap holds 100k small programmes: tens of MB at most.
    assert!(m.rss_mb < 150, "peak RSS delta {} MB", m.rss_mb);
}

/// F3: 15 channels and programmes with 3 MB ids and icons (90 MB of
/// attributes) store nothing over the caps and hold little memory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[cfg_attr(debug_assertions, ignore = "RSS / DB-size check; run with --release")]
async fn long_attributes_do_not_reach_the_store() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("c.xml.gz");
    let now = chrono::Utc::now().timestamp();
    let big = "a".repeat(3 * MB);
    let kb = gz(&path, |w| {
        w.write_all(head().as_bytes()).unwrap();
        for i in 0..15 {
            write!(
                w,
                r#"<channel id="{big}{i}"><icon src="{big}"/></channel><programme channel="{big}{i}" start="{}" stop="{}"><icon src="{big}"/></programme><programme channel="s{i}" start="{}"><icon src="{big}"/></programme>"#,
                xml_time(now),
                xml_time(now + 3600),
                xml_time(now),
            )
            .unwrap();
        }
        w.write_all(b"</tv>").unwrap();
    });
    let m = refresh_measured(d.path(), &path).await;
    println!(
        "fix3 long attributes 15 x 3 MB ({kb} KB gz): {:.2} s, peak RSS delta {} MB, db {} MB, {:?}",
        m.secs, m.rss_mb, m.db_mb, m.result
    );
    let stats = m.result.expect("parses");
    assert_eq!(stats.channels, 1, "only the head channel");
    assert_eq!(stats.programs, 16, "head + 15 short-channel programmes");
    assert_eq!(stats.skipped_invalid, 30);
    assert!(m.db_mb < 20, "db {} MB", m.db_mb);
    assert!(m.rss_mb < 100, "peak RSS delta {} MB", m.rss_mb);
}
