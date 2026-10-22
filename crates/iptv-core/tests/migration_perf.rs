//! Migration 0007 (unique EPG slot index) on a large v6 database. A user
//! upgrading with a big guide cache runs it before the window shows. Review
//! round 2 made the dedupe index-backed (10.3 s / 277 MB to 8.6 s / 8 MB at
//! 3.3M rows, debug), but the reviewer's run still took 21 s; round 3 drops
//! the cached guide instead (it is refetched), so the upgrade must take
//! well under 3 s.
//!
//! `cargo test -p iptv-core --test migration_perf -- --ignored --nocapture`
//! measures the full 3.3M-row case; the default run uses 600k rows.

use iptv_core::db::{migrate, schema_version, MIGRATIONS};
use rusqlite::{params, Connection};
use std::time::{Duration, Instant};

const FEEDS: usize = 2;

/// Builds a v6 database at `path` holding `rows` programmes, `dups` of
/// which repeat an earlier (feed, channel, start) slot.
fn build_v6(path: &std::path::Path, rows: usize, dups: usize) {
    let mut c = Connection::open(path).unwrap();
    iptv_core::db::configure(&mut c).unwrap();
    let tx = c.transaction().unwrap();
    for m in MIGRATIONS.iter().filter(|m| m.version <= 6) {
        tx.execute_batch(m.sql).unwrap();
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
            [m.version],
        )
        .unwrap();
    }
    for f in 0..FEEDS {
        tx.execute(
            "INSERT INTO epg_sources(url, last_fetch_at, etag, status, program_count)
             VALUES (?1, '2026-10-01T00:00:00Z', 'W/\"v1\"', 'ok', 1)",
            [format!("http://guide.example/feed-{f}.xml.gz")],
        )
        .unwrap();
    }
    {
        let mut ins = tx
            .prepare(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title, description)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .unwrap();
        let unique = rows - dups;
        let per_channel = 110;
        let slot = |i: usize| {
            let feed = i % FEEDS;
            let n = i / FEEDS;
            let channel = n / per_channel;
            let start = 1_790_000_000 + (n % per_channel) as i64 * 1800;
            (
                format!("http://guide.example/feed-{feed}.xml.gz"),
                format!("channel{channel}.example"),
                start,
            )
        };
        for i in 0..rows {
            // Duplicates are spread through the table (a later run of the
            // same feed wrote the slot again).
            let src = if i >= unique {
                (i - unique) * (unique / dups.max(1))
            } else {
                i
            };
            let (url, ch, start) = slot(src);
            ins.execute(params![
                url,
                ch,
                start,
                start + 1800,
                format!("Programme {src}"),
                "A description long enough to look like a real guide entry."
            ])
            .unwrap();
        }
    }
    tx.commit().unwrap();
    assert_eq!(schema_version(&c).unwrap(), 6);
}

/// Runs the pending migrations on `path`; returns the time taken and
/// SQLite's heap high-water mark during them.
fn upgrade(path: &std::path::Path) -> (Duration, i64) {
    let mut c = Connection::open(path).unwrap();
    iptv_core::db::configure(&mut c).unwrap();
    // SAFETY: plain reads of SQLite's global memory counters.
    unsafe { rusqlite::ffi::sqlite3_memory_highwater(1) };
    let base = unsafe { rusqlite::ffi::sqlite3_memory_used() };
    let started = Instant::now();
    migrate(&mut c).unwrap();
    let took = started.elapsed();
    let peak = unsafe { rusqlite::ffi::sqlite3_memory_highwater(0) } - base;
    assert_eq!(schema_version(&c).unwrap(), iptv_core::db::latest_version());
    (took, peak)
}

/// After 0007 the guide cache is empty, the slot index is unique, every
/// feed will be fetched again, and the feeds and channels are kept.
fn check(path: &std::path::Path) {
    let c = Connection::open(path).unwrap();
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "the cached guide is dropped");
    let unique: bool = c
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = 'idx_epg_programs_slot' AND sql LIKE 'CREATE UNIQUE%'",
            [],
            |_| Ok(true),
        )
        .unwrap();
    assert!(unique);
    let (feeds, stale): (i64, i64) = c
        .query_row(
            "SELECT COUNT(*), SUM(last_fetch_at IS NULL AND etag IS NULL AND program_count = 0) FROM epg_sources",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (feeds, stale),
        (FEEDS as i64, FEEDS as i64),
        "every feed refetches"
    );
}

fn run(rows: usize, dups: usize, budget: Duration, mem_budget: i64) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v6.db");
    let t = Instant::now();
    build_v6(&path, rows, dups);
    eprintln!(
        "migration_perf: built v6 with {rows} rows ({dups} duplicates) in {:?}",
        t.elapsed()
    );
    let (took, peak) = upgrade(&path);
    eprintln!(
        "migration_perf: 0007+0008 on {rows} rows took {took:?}, SQLite heap peak {} MB",
        peak >> 20
    );
    check(&path);
    assert!(took < budget, "upgrade took {took:?} (budget {budget:?})");
    assert!(
        peak < mem_budget,
        "upgrade used {} MB of SQLite heap (budget {} MB)",
        peak >> 20,
        mem_budget >> 20
    );
}

/// 600k rows, 60k duplicates. Before round 3 (index-backed dedupe): 1.4 s.
#[test]
fn migration_0007_upgrades_a_large_guide_quickly() {
    run(600_000, 60_000, Duration::from_secs(1), 16 << 20);
}

/// The reported case: 3.3M rows, 300k duplicates. Must stay well under the
/// 3 s boot budget (debug profile; before round 3: 8.6 s here, 21 s on the
/// reviewer's machine).
#[test]
#[ignore = "large: run with --ignored to measure"]
fn migration_0007_on_3_3m_rows() {
    run(3_300_000, 300_000, Duration::from_secs(3), 16 << 20);
}

/// A database that already ran the earlier form of 0007 (rows deduped,
/// index present, versions 7 and 8 recorded) keeps its guide: 0007 is not
/// run again.
#[test]
fn a_database_that_already_ran_0007_keeps_its_guide() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v8.db");
    build_v6(&path, 1_000, 0);
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE UNIQUE INDEX idx_epg_programs_slot ON epg_programs(epg_url, channel_id, start);
             DROP INDEX IF EXISTS idx_epg_programs_url;
             INSERT INTO schema_migrations(version) VALUES (7), (8);",
        )
        .unwrap();
    }
    upgrade(&path);
    let c = Connection::open(&path).unwrap();
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1_000);
    let fetched: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM epg_sources WHERE last_fetch_at IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fetched, FEEDS as i64);
}

/// Migration 0020 on a 220k-item library (95k channels on one source, 105k
/// movies and 20k series on another, schema 19): it fills `items_rank` with
/// one row per item, equal to the projection of `items`. The timed upgrade
/// runs the later migrations too, and is mostly 0022's and 0024's. 0022 adds
/// `quality` to both tables (-1 until the boot backfill) and rebuilds four
/// indexes, about 0.7-0.9 s in release on an N150, where 0020 takes about
/// 0.1 s. 0024 builds the category date-added index and idx_items_cat again:
/// the release upgrade went from about 0.8 s to 1.1 s in a 4 vCPU
/// sandbox. A debug build on CI's Windows runner took 12.6 s before 0024.
#[test]
fn migration_0020_fills_items_rank_on_a_220k_library() {
    #[cfg(debug_assertions)]
    const BUDGET: Duration = Duration::from_secs(30);
    #[cfg(not(debug_assertions))]
    const BUDGET: Duration = Duration::from_secs(2);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v19.db");
    let built = Instant::now();
    {
        let mut c = Connection::open(&path).unwrap();
        iptv_core::db::configure(&mut c).unwrap();
        let tx = c.transaction().unwrap();
        for m in MIGRATIONS.iter().filter(|m| m.version <= 19) {
            tx.execute_batch(m.sql).unwrap();
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
                [m.version],
            )
            .unwrap();
        }
        tx.execute_batch(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('live', 'm3u', 'Live', '{}'), ('vod', 'xtream', 'VOD', '{}');
             INSERT INTO fts_suspend(source_id) VALUES ('live'), ('vod');",
        )
        .unwrap();
        {
            let mut ins = tx
                .prepare(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, url, extra_json, position, non_english)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .unwrap();
            for (sid, ct, n) in [
                ("live", "live", 95_000),
                ("vod", "movie", 105_000),
                ("vod", "series", 20_000),
            ] {
                for i in 0..n {
                    ins.execute(params![
                        sid,
                        ct,
                        format!("{ct}{i}"),
                        format!("c{}", i % 150),
                        format!("UK The Title Number {i}"),
                        format!("http://stream.example/{ct}/{i}.ts"),
                        r#"{"plot":"A plot line as wide as a provider's."}"#,
                        i,
                        i % 4 == 0,
                    ])
                    .unwrap();
                }
            }
        }
        tx.execute("DELETE FROM fts_suspend", []).unwrap();
        tx.commit().unwrap();
        assert_eq!(schema_version(&c).unwrap(), 19);
    }
    eprintln!(
        "migration_perf: built v19 with 220k items in {:?}",
        built.elapsed()
    );
    let (took, peak) = upgrade(&path);
    eprintln!(
        "migration_perf: upgrade from 19 on 220k items took {took:?}, SQLite heap peak {} MB",
        peak >> 20
    );
    let c = Connection::open(&path).unwrap();
    let (items, rank, wrong): (i64, i64, i64) = c
        .query_row(
            "SELECT (SELECT count(*) FROM items), (SELECT count(*) FROM items_rank), \
             (SELECT count(*) FROM items i LEFT JOIN items_rank r ON r.id = i.rowid \
              WHERE r.id IS NULL OR r.source_id IS NOT i.source_id OR r.content_type IS NOT i.content_type \
              OR r.category_id IS NOT i.category_id OR r.non_english IS NOT i.non_english \
              OR r.title_len IS NOT length(i.title) OR r.position IS NOT i.position \
              OR r.quality IS NOT i.quality)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((items, rank, wrong), (220_000, 220_000, 0));
    assert!(
        took < BUDGET,
        "upgrade from 19 took {took:?} (budget {BUDGET:?})"
    );
}
