//! Benchmark of the guide search index's upkeep on a large guide: what a
//! guide refresh, the startup build and a new catalog cost, and how long a
//! user write (a favourite toggle) issued meanwhile waits for the database
//! write lock. 200k live channels; a guide of 3,000 channels over nine days
//! (828k programmes) in one feed and 500 channels over two days (48k) in a
//! second, both refreshed from XMLTV files. Prints wall time, process CPU
//! time and peak memory (VmHWM, reset before each case) of each case, and
//! the toggles' latencies; asserts nothing. Ignored by default (about a
//! minute in a release build, and 200 MB of XMLTV in the temp directory).
//!
//! cargo test -p iptv-core --release --test guide_rebuild_bench -- --ignored --nocapture
//!
//! Environment: `ROUNDS=<n>` repeats the rebuild case (default 3),
//! `BENCH=<substring>` runs the matching cases only (`rebuild`, `startup`,
//! `refresh small`, `refresh big`, `new catalog`).

#[path = "m3u_support.rs"]
mod support;

use serde_json::{json, Value};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

const CHANNELS: usize = 200_000;
const GROUPS: usize = 1_000;
const GUIDE_CHANNELS: usize = 3_000;
const DAYS: i64 = 7;

const TITLES: [&str; 8] = [
    "World News Today",
    "The Great Bake Off",
    "Morning Show",
    "Football Live",
    "The Late Film",
    "Cooking Hour",
    "Market Watch",
    "Nature Trails",
];

fn xmltv_ts(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .format("%Y%m%d%H%M%S +0000")
        .to_string()
}

/// Writes the two feeds as the read benchmark's guide: half-hour and hour
/// programmes alternating on 3,000 channels, and hourly ones on 500
/// channels a day either side of now.
fn write_feeds(dir: &std::path::Path, base: i64) -> (String, String) {
    let big = dir.join("guide.xml");
    let small = dir.join("second.xml");
    let mut f = std::io::BufWriter::new(std::fs::File::create(&big).unwrap());
    writeln!(f, "<?xml version=\"1.0\"?><tv>").unwrap();
    for k in 0..GUIDE_CHANNELS {
        writeln!(
            f,
            "<channel id=\"ch{k}.example\"><display-name>Channel {k}</display-name></channel>"
        )
        .unwrap();
    }
    for k in 0..GUIDE_CHANNELS {
        let mut t = base;
        let mut n = 0usize;
        while t < base + (DAYS + 2) * 86_400 {
            let len = if n.is_multiple_of(2) { 1800 } else { 3600 };
            writeln!(
                f,
                "<programme start=\"{}\" stop=\"{}\" channel=\"ch{k}.example\"><title>{}</title><desc>A description of the programme, about as long as guides write them, and then some more words.</desc><category>Talk</category></programme>",
                xmltv_ts(t),
                xmltv_ts(t + len),
                TITLES[(k + n) % 8]
            )
            .unwrap();
            t += len;
            n += 1;
        }
    }
    writeln!(f, "</tv>").unwrap();
    f.flush().unwrap();
    let mut f = std::io::BufWriter::new(std::fs::File::create(&small).unwrap());
    writeln!(f, "<?xml version=\"1.0\"?><tv>").unwrap();
    for k in 0..500 {
        writeln!(
            f,
            "<channel id=\"ch{k}.example\"><display-name>Channel {k}</display-name></channel>"
        )
        .unwrap();
        let mut t = base + 86_400;
        while t < base + 3 * 86_400 {
            writeln!(
                f,
                "<programme start=\"{}\" stop=\"{}\" channel=\"ch{k}.example\"><title>Second</title></programme>",
                xmltv_ts(t),
                xmltv_ts(t + 3600)
            )
            .unwrap();
            t += 3600;
        }
    }
    writeln!(f, "</tv>").unwrap();
    f.flush().unwrap();
    (
        big.to_string_lossy().into_owned(),
        small.to_string_lossy().into_owned(),
    )
}

/// User plus system CPU time of the process.
fn cpu() -> Duration {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let after = &stat[stat.rfind(')').unwrap() + 2..];
    let f: Vec<&str> = after.split_whitespace().collect();
    let ticks: u64 = f[11].parse::<u64>().unwrap() + f[12].parse::<u64>().unwrap();
    Duration::from_millis(ticks * 10)
}

fn status_kb(key: &str) -> u64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap();
    s.lines()
        .find(|l| l.starts_with(key))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Resets the peak RSS; returns the current RSS in MB.
fn reset_peak() -> f64 {
    let _ = std::fs::write("/proc/self/clear_refs", "5");
    status_kb("VmRSS:") as f64 / 1024.0
}

fn peak_mb() -> f64 {
    status_kb("VmHWM:") as f64 / 1024.0
}

/// Toggles a favourite every 20 ms until stopped; returns each toggle's
/// latency.
fn toggler(
    state: Arc<iptv_core::AppState>,
    r: Arc<iptv_core::rpc::RpcRouter>,
    sid: String,
    stop: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<Vec<Duration>> {
    tokio::spawn(async move {
        let mut lat = Vec::new();
        let rf = json!({"sourceId": sid, "contentType": "live", "itemId": "ch7.example"});
        while !stop.load(Ordering::SeqCst) {
            let t = Instant::now();
            r.dispatch(
                state.clone(),
                "favorites.toggle",
                json!({"ref": rf, "snapshot": {"title": "Channel 7", "contentType": "live"}}),
            )
            .await
            .unwrap();
            lat.push(t.elapsed());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        lat
    })
}

fn summary(mut v: Vec<Duration>) -> String {
    if v.is_empty() {
        return "no toggles".into();
    }
    v.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let over = v.iter().filter(|d| d.as_millis() >= 100).count();
    format!(
        "toggles {} p50 {:.1} ms p99 {:.1} ms max {:.1} ms (>=100 ms: {over})",
        v.len(),
        ms(v[v.len() / 2]),
        ms(v[(v.len() * 99 / 100).min(v.len() - 1)]),
        ms(v[v.len() - 1])
    )
}

async fn search_ms(
    r: &iptv_core::rpc::RpcRouter,
    state: &Arc<iptv_core::AppState>,
    sid: &str,
) -> (f64, usize) {
    let t = Instant::now();
    let v: Value = r
        .dispatch(
            state.clone(),
            "epg.search",
            json!({"sourceId": sid, "query": "news"}),
        )
        .await
        .unwrap();
    (
        t.elapsed().as_secs_f64() * 1000.0,
        v.as_array().map_or(0, Vec::len),
    )
}

async fn ready(state: &Arc<iptv_core::AppState>) -> bool {
    state
        .db_call(|c| iptv_core::epg::search::index_ready(c))
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore]
async fn guide_index_upkeep_on_a_large_guide() {
    let env = env().await;
    let state = env.state.clone();
    let r = Arc::new(iptv_core::rpc::build_router());
    let filter = std::env::var("BENCH").ok();
    let run = |name: &str| filter.as_deref().is_none_or(|f| name.contains(f));
    let rounds: usize = std::env::var("ROUNDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    let t0 = Instant::now();
    let live = add_text(&state, "live", &gen_m3u(CHANNELS, GROUPS)).await;
    let sid = live.id.clone();
    let now = chrono::Utc::now().timestamp();
    let base = now - now % 3600 - 2 * 86_400;
    let (big, small) = write_feeds(env.dir.path(), base);
    let t = Instant::now();
    let stats = iptv_core::epg::refresh_now(state.clone(), &big)
        .await
        .unwrap();
    eprintln!(
        "first refresh big: {} programmes in {:.2} s",
        stats.programs,
        t.elapsed().as_secs_f64()
    );
    let t = Instant::now();
    let stats = iptv_core::epg::refresh_now(state.clone(), &small)
        .await
        .unwrap();
    eprintln!(
        "first refresh small: {} programmes in {:.2} s",
        stats.programs,
        t.elapsed().as_secs_f64()
    );
    let (ms, n) = search_ms(&r, &state, &sid).await;
    eprintln!(
        "fixture in {:.1} s; first search {ms:.1} ms ({n} hits)",
        t0.elapsed().as_secs_f64()
    );

    let case = |name: &str, wall: Duration, cpu: Duration, rss: f64, toggles: Vec<Duration>| {
        eprintln!(
            "{name:<16} wall {:>8.1} ms  cpu {:>8.1} ms  peak +{:>6.1} MB  {}",
            wall.as_secs_f64() * 1000.0,
            cpu.as_secs_f64() * 1000.0,
            peak_mb() - rss,
            summary(toggles)
        );
    };

    if run("rebuild") {
        for _ in 0..rounds {
            state
                .db_call(|c| iptv_core::epg::search::invalidate_index(c))
                .await
                .unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let tog = toggler(state.clone(), r.clone(), sid.clone(), stop.clone());
            tokio::time::sleep(Duration::from_millis(50)).await;
            let rss = reset_peak();
            let (t, c) = (Instant::now(), cpu());
            state
                .db_call(|c| iptv_core::epg::search::ensure_index(c, false))
                .await
                .unwrap();
            let (wall, used) = (t.elapsed(), cpu() - c);
            tokio::time::sleep(Duration::from_millis(50)).await;
            stop.store(true, Ordering::SeqCst);
            case("rebuild", wall, used, rss, tog.await.unwrap());
        }
    }

    if run("breakdown") {
        // The steps of a rebuild one by one, in raw SQL, for where the time
        // goes (`BENCH=breakdown`).
        let lines = state
            .db_call(|c| {
                c.create_scalar_function(
                    "bench_fold",
                    1,
                    rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                    |ctx| Ok(iptv_core::epg::search::fold(&ctx.get::<String>(0)?)),
                )?;
                let mut out = Vec::new();
                let mut step = |name: &str, sql: &str| -> iptv_core::CoreResult<()> {
                    let (t, u) = (Instant::now(), cpu());
                    c.execute_batch(sql)?;
                    out.push(format!(
                        "  {name:<40} wall {:>7.1} ms cpu {:>7.1} ms",
                        t.elapsed().as_secs_f64() * 1000.0,
                        (cpu() - u).as_secs_f64() * 1000.0
                    ));
                    Ok(())
                };
                for store in ["MEMORY", "FILE"] {
                    step(
                        &format!("sort into temp ({store})"),
                        &format!(
                            "PRAGMA temp_store={store}; DROP TABLE IF EXISTS temp.s;
                             CREATE TEMP TABLE s AS SELECT p.rowid AS prog, p.start AS start, p.stop AS stop, f.rowid AS feed,
                               p.channel_id AS channel_id, bench_fold(p.title) AS title
                             FROM epg_programs p JOIN epg_sources f ON f.url = p.epg_url ORDER BY p.start, f.rowid, p.rowid"
                        ),
                    )?;
                }
                step(
                    "sort, no fold",
                    "DROP TABLE IF EXISTS temp.s2;
                     CREATE TEMP TABLE s2 AS SELECT p.rowid AS prog, p.start AS start, p.stop AS stop, f.rowid AS feed,
                       p.channel_id AS channel_id, p.title AS title
                     FROM epg_programs p JOIN epg_sources f ON f.url = p.epg_url ORDER BY p.start, f.rowid, p.rowid;
                     DROP TABLE temp.s2;",
                )?;
                step(
                    "search rows",
                    "BEGIN IMMEDIATE; CREATE TABLE bench_rows (id INTEGER PRIMARY KEY, prog INTEGER NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, feed INTEGER NOT NULL, channel_id TEXT NOT NULL);
                     INSERT INTO bench_rows SELECT rowid, prog, start, stop, feed, channel_id FROM temp.s; COMMIT;",
                )?;
                for (name, opts) in [
                    ("fts", ""),
                    ("fts columnsize=0", ", columnsize=0"),
                    ("fts detail=column", ", detail=column"),
                ] {
                    step(
                        name,
                        &format!(
                            "BEGIN IMMEDIATE; CREATE VIRTUAL TABLE bench_fts USING fts5(title, content='epg_programs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'{opts});
                             INSERT INTO bench_fts(rowid, title) SELECT rowid, title FROM temp.s; COMMIT;"
                        ),
                    )?;
                    step(&format!("  drop {name}"), "DROP TABLE bench_fts;")?;
                }
                for chunk in [20_000, 50_000] {
                    let n: i64 = c.query_row("SELECT max(rowid) FROM temp.s", [], |r| r.get(0))?;
                    let (t, u) = (Instant::now(), cpu());
                    c.execute_batch(
                        "CREATE VIRTUAL TABLE bench_fts USING fts5(title, content='epg_programs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');",
                    )?;
                    let mut lo = 1;
                    let mut worst = Duration::ZERO;
                    while lo <= n {
                        let tc = Instant::now();
                        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                        tx.execute(
                            "INSERT INTO bench_fts(rowid, title) SELECT rowid, title FROM temp.s WHERE rowid >= ?1 AND rowid < ?2",
                            [lo, lo + chunk],
                        )?;
                        tx.commit()?;
                        worst = worst.max(tc.elapsed());
                        lo += chunk;
                    }
                    out.push(format!(
                        "  fts in chunks of {chunk:<22} wall {:>7.1} ms cpu {:>7.1} ms worst chunk {:.1} ms",
                        t.elapsed().as_secs_f64() * 1000.0,
                        (cpu() - u).as_secs_f64() * 1000.0,
                        worst.as_secs_f64() * 1000.0
                    ));
                    c.execute_batch("DROP TABLE bench_fts;")?;
                }
                c.execute_batch("DROP TABLE bench_rows; DROP TABLE temp.s; PRAGMA temp_store=MEMORY;")?;
                Ok(out)
            })
            .await
            .unwrap();
        eprintln!("breakdown:\n{}", lines.join("\n"));
    }

    if run("startup") {
        state
            .db_call(|c| iptv_core::epg::search::invalidate_index(c))
            .await
            .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let tog = toggler(state.clone(), r.clone(), sid.clone(), stop.clone());
        let rss = reset_peak();
        let (t, c) = (Instant::now(), cpu());
        iptv_core::epg::search::spawn_startup_build(&state);
        let mut searches = Vec::new();
        while !ready(&state).await {
            searches.push(search_ms(&r, &state, &sid).await.0);
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(t.elapsed() < Duration::from_secs(120));
        }
        let (wall, used) = (t.elapsed(), cpu() - c);
        stop.store(true, Ordering::SeqCst);
        case("startup", wall, used, rss, tog.await.unwrap());
        eprintln!(
            "  searches meanwhile (ms): {:?}",
            searches.iter().map(|m| m.round()).collect::<Vec<_>>()
        );
    }

    for (name, url) in [("refresh small", &small), ("refresh big", &big)] {
        if !run(name) {
            continue;
        }
        for _ in 0..2 {
            let stop = Arc::new(AtomicBool::new(false));
            let tog = toggler(state.clone(), r.clone(), sid.clone(), stop.clone());
            tokio::time::sleep(Duration::from_millis(50)).await;
            let rss = reset_peak();
            let (t, c) = (Instant::now(), cpu());
            iptv_core::epg::refresh_now(state.clone(), url)
                .await
                .unwrap();
            let (wall, used) = (t.elapsed(), cpu() - c);
            stop.store(true, Ordering::SeqCst);
            case(name, wall, used, rss, tog.await.unwrap());
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let first = search_ms(&r, &state, &sid).await.0;
            let second = search_ms(&r, &state, &sid).await.0;
            eprintln!("  search after it: first {first:.1} ms, then {second:.1} ms");
        }
    }

    if run("new catalog") {
        let t = Instant::now();
        let other = add_text(&state, "other", &gen_m3u(CHANNELS, GROUPS)).await;
        eprintln!("new catalog import {:.2} s", t.elapsed().as_secs_f64());
        tokio::time::sleep(Duration::from_millis(3000)).await;
        let first = search_ms(&r, &state, &other.id).await.0;
        let second = search_ms(&r, &state, &other.id).await.0;
        eprintln!("new catalog search: first {first:.1} ms, then {second:.1} ms");
    }
}
