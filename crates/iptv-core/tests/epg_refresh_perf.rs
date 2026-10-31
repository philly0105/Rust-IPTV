//! Refreshing a stored guide: how long the swap holds the write lock, how
//! much it writes to the WAL, and how far the database file grows. One
//! 120 MB feed is imported, refreshed unchanged, refreshed 12 h later (the
//! window moved on), 12 h after that with one title in 20 edited (spread
//! over the whole feed, so nearly every page changes), and refreshed with
//! every title edited; alone, and next to a stored 60 MB feed.
//!
//! Each refresh runs while another connection holds a read snapshot taken
//! before it, so the import's own checkpoint cannot fold the WAL back: the
//! WAL size afterwards is what the refresh wrote, and the time from the
//! "saving" progress call to the end is the swap and the search index
//! upkeep (the two steps that write the main database). The checkpoint is
//! then timed on its own.
//!
//! Release-only, one test at a time: `cargo test -p iptv-core --release --test
//! epg_refresh_perf -- --nocapture --test-threads=1`

use iptv_core::epg::{self, search, xmltv::Window};
use iptv_core::{AppState, NoopSink};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

const FEED_MB: usize = 120;
const MB: f64 = 1024.0 * 1024.0;
const HOUR: i64 = 3600;

/// A feed read line by line with every `every`-th programme title edited
/// (`every` 0 leaves it as it is).
struct EditTitles<R> {
    inner: R,
    every: usize,
    seen: usize,
    line: Vec<u8>,
    pos: usize,
}

impl<R: BufRead> EditTitles<R> {
    fn new(inner: R, every: usize) -> Self {
        Self {
            inner,
            every,
            seen: 0,
            line: Vec::new(),
            pos: 0,
        }
    }
}

impl<R: BufRead> Read for EditTitles<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = {
            let buf = self.fill_buf()?;
            let n = buf.len().min(out.len());
            out[..n].copy_from_slice(&buf[..n]);
            n
        };
        self.consume(n);
        Ok(n)
    }
}

impl<R: BufRead> BufRead for EditTitles<R> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.pos == self.line.len() {
            self.line.clear();
            self.pos = 0;
            self.inner.read_until(b'\n', &mut self.line)?;
            const TITLE: &[u8] = b"    <title lang=\"en\">";
            if self.every > 0 && self.line.starts_with(TITLE) {
                self.seen += 1;
                if self.seen.is_multiple_of(self.every) {
                    self.line.splice(TITLE.len()..TITLE.len(), *b"Edited ");
                }
            }
        }
        Ok(&self.line[self.pos..])
    }

    fn consume(&mut self, n: usize) {
        self.pos += n;
    }
}

struct Step {
    programs: u64,
    total_secs: f64,
    swap_secs: f64,
    wal_mb: f64,
    checkpoint_secs: f64,
    db_mb: f64,
    free_mb: f64,
}

fn file_mb(path: &Path) -> f64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) as f64 / MB
}

fn refresh(state: &Arc<AppState>, url: &str, path: &Path, window: Window, every: usize) -> Step {
    let db = state.db_path();
    let wal = db.with_file_name(format!("{}-wal", db.file_name().unwrap().to_string_lossy()));
    // A read snapshot from before the refresh keeps the WAL from being reset.
    let reader = state.db.get().unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM app_state;")
        .unwrap();
    let mut conn = state.db.get().unwrap();
    let file = BufReader::with_capacity(1 << 20, std::fs::File::open(path).unwrap());
    let started = Instant::now();
    let mut saving: Option<Instant> = None;
    let stats = epg::ingest::ingest_reader(
        &mut conn,
        url,
        EditTitles::new(file, every),
        window,
        None,
        &mut |phase, _| {
            if phase == "saving" {
                saving = Some(Instant::now());
            }
        },
    )
    .unwrap();
    let total_secs = started.elapsed().as_secs_f64();
    let swap_secs = saving.expect("saving reported").elapsed().as_secs_f64();
    let wal_mb = file_mb(&wal);
    reader.execute_batch("COMMIT").unwrap();
    drop(reader);
    let started = Instant::now();
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .unwrap();
    let checkpoint_secs = started.elapsed().as_secs_f64();
    let free: i64 = conn
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    let page: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .unwrap();
    Step {
        programs: stats.programs,
        total_secs,
        swap_secs,
        wal_mb,
        checkpoint_secs,
        db_mb: file_mb(&db),
        free_mb: (free * page) as f64 / MB,
    }
}

/// The index answers what a full rebuild answers: the same matches for a
/// few title words and one search row per programme.
fn index_snapshot(state: &Arc<AppState>) -> (Vec<Vec<i64>>, i64, i64) {
    let conn = state.db.get().unwrap();
    let matches = ["edited", "news", "kitchen", "world", "live"]
        .iter()
        .map(|w| {
            conn.prepare(
                "SELECT rowid FROM epg_programs_fts WHERE epg_programs_fts MATCH ?1 ORDER BY rowid",
            )
            .unwrap()
            .query_map([format!("\"{w}\"*")], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<i64>, _>>()
            .unwrap()
        })
        .collect();
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    (
        matches,
        count("SELECT count(*) FROM epg_search_rows"),
        count("SELECT count(*) FROM epg_programs"),
    )
}

/// Imports `other_mb` of a second feed first when given, then runs the
/// steps on the 120 MB feed and checks the index after each.
async fn run(label: &str, other_mb: Option<usize>) {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path().join("data"), Arc::new(NoopSink), false)
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let add_feed = |name: &str, mb: usize| {
        let path = tmp.path().join(name);
        iptv_fixtures::write_xmltv(&path, mb).unwrap();
        let url = path.to_string_lossy().into_owned();
        state
            .db
            .get()
            .unwrap()
            .execute("INSERT INTO epg_sources(url) VALUES (?1)", [&url])
            .unwrap();
        (url, path)
    };
    let mut steps = Vec::new();
    if let Some(mb) = other_mb {
        let (url, path) = add_feed("other.xml", mb);
        steps.push(("other feed", url, path, Window::around(now), 0));
    }
    let (url, path) = add_feed("feed.xml", FEED_MB);
    for (name, window, every) in [
        ("first import", Window::around(now), 0),
        ("unchanged", Window::around(now), 0),
        ("12 h later", Window::around(now + 12 * HOUR), 0),
        ("24 h later, 5% edited", Window::around(now + 24 * HOUR), 20),
        ("every title edited", Window::around(now + 24 * HOUR), 1),
    ] {
        steps.push((name, url.clone(), path.clone(), window, every));
    }
    for (name, url, path, window, every) in steps {
        let s = {
            let (state, url) = (state.clone(), url.clone());
            tokio::task::spawn_blocking(move || refresh(&state, &url, &path, window, every))
                .await
                .unwrap()
        };
        println!(
            "epg_refresh_perf: {label} | {name:<22} | {:>7} programmes | total {:>5.2} s | swap+index {:>5.2} s | WAL {:>6.1} MB | checkpoint {:>4.2} s | db {:>6.1} MB ({:>5.1} MB free)",
            s.programs, s.total_secs, s.swap_secs, s.wal_mb, s.checkpoint_secs, s.db_mb, s.free_mb
        );
        assert!(s.programs > 50_000, "{name}: {}", s.programs);
        let conn = state.db.get().unwrap();
        assert!(search::index_ready(&conn).unwrap(), "{name}");
        let stored: i64 = conn
            .query_row(
                "SELECT program_count FROM epg_sources WHERE url = ?1",
                [&url],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored as u64, s.programs, "{name}");
        conn.execute(
            "INSERT INTO epg_programs_fts(epg_programs_fts, rank) VALUES('integrity-check', 1)",
            [],
        )
        .unwrap();
    }
    // What the refreshes left equals a full rebuild of the index.
    let kept = index_snapshot(&state);
    assert_eq!(kept.1, kept.2);
    assert!(!kept.0[0].is_empty(), "edited titles are found");
    state
        .db_call(|c| {
            search::invalidate_index(c)?;
            search::ensure_index(c, false)
        })
        .await
        .unwrap();
    assert_eq!(index_snapshot(&state), kept);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[cfg_attr(debug_assertions, ignore = "timing; run with --release")]
async fn refreshing_a_stored_guide() {
    run("one feed ", None).await;
}

/// The same steps next to a stored 60 MB feed, which a refresh of the
/// other feed leaves alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[cfg_attr(debug_assertions, ignore = "timing; run with --release")]
async fn refreshing_one_of_two_feeds() {
    run("two feeds", Some(60)).await;
}
