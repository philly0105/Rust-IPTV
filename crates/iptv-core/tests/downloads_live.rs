//! SC10: what the user's real providers do, measured through the app's own
//! code paths. Ignored: it reaches real IPTV providers, so only the lead
//! runs it, by hand, on a COPY of the app data dir:
//!
//! ```text
//! DL_LIVE_DATA_DIR=<copy of the data dir> cargo test -p iptv-core \
//!     --test downloads_live -- --ignored --nocapture
//! ```
//!
//! It never opens the real data dir (`%APPDATA%\com.philly.tsrustiptv`)
//! and refuses to start on it. Steps:
//! - Pick up to 3 movies whose title exists on two or more sources
//!   (`catalog::same_title`), preferring large files.
//! - Fingerprint every copy (`shared::resolve`, `mirrors::fingerprint`) and
//!   compare the fingerprints across sources.
//! - Per source, stream one movie on one connection for about 15 s (at most
//!   150 MB), then open a second, concurrent Range connection and report
//!   whether the provider accepted it, refused it (status code only) or
//!   kicked the first.
//!
//! No source gets more than about 480 MB in total. Output carries only
//! source indexes (1, 2, ...), sizes, sample hashes cut to 12 hex
//! characters, MB/s and outcomes: never a URL, host, username, password or
//! title, and no error text (reqwest and core errors can quote URLs).

use iptv_core::catalog;
use iptv_core::downloads::{mirrors, shared};
use iptv_core::model::{ContentType, CopyRef, ItemRef};
use iptv_core::AppState;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MB: u64 = 1_000_000;
/// Every byte this run may take from one provider.
const SOURCE_CAP: u64 = 480 * MB;
/// The single-connection measurement: whichever ends first.
const MEASURE_FOR: Duration = Duration::from_secs(15);
const MEASURE_CAP: u64 = 150 * MB;
/// How long both connections stay open once the second one is accepted.
const BOTH_FOR: Duration = Duration::from_secs(4);
const BOTH_CAP: u64 = 40 * MB;
/// What one fingerprint costs, rounded up (three 64 KiB windows plus
/// whatever the provider sends past a window before the body is dropped).
const FINGERPRINT_COST: u64 = 2 * MB;
/// Title groups considered, and how many of them get a size check.
const GROUPS_SCANNED: usize = 40;
const GROUPS_SIZED: usize = 10;
const MOVIES: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(20);

/// Refuses to run anywhere near the real data dir.
fn data_dir() -> PathBuf {
    let Some(raw) = std::env::var_os("DL_LIVE_DATA_DIR") else {
        panic!("set DL_LIVE_DATA_DIR to a COPY of the app data dir");
    };
    let dir =
        std::fs::canonicalize(&raw).unwrap_or_else(|_| panic!("DL_LIVE_DATA_DIR does not exist"));
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let real = Path::new(&appdata).join("com.philly.tsrustiptv");
        let real = std::fs::canonicalize(&real).unwrap_or(real);
        assert!(
            !dir.starts_with(&real) && !real.starts_with(&dir),
            "DL_LIVE_DATA_DIR is the real data dir (or holds it); point it at a copy"
        );
    }
    assert!(
        dir.join(iptv_core::db::DB_FILE).exists(),
        "DL_LIVE_DATA_DIR holds no database"
    );
    dir
}

/// Bytes taken from each source so far.
#[derive(Default)]
struct Budget(HashMap<String, u64>);

impl Budget {
    fn left(&self, source: &str) -> u64 {
        SOURCE_CAP.saturating_sub(*self.0.get(source).unwrap_or(&0))
    }
    fn take(&mut self, source: &str, n: u64) {
        *self.0.entry(source.to_string()).or_default() += n;
    }
}

/// Source ids as printed: 1, 2, ... in the order first met.
#[derive(Default)]
struct Names(BTreeMap<String, usize>);

impl Names {
    fn of(&mut self, source: &str) -> usize {
        let next = self.0.len() + 1;
        *self.0.entry(source.to_string()).or_insert(next)
    }
}

fn short(hash: &str) -> &str {
    &hash[..hash.len().min(12)]
}

fn mb(n: i64) -> String {
    format!("{:.1} MB", n as f64 / MB as f64)
}

/// What one reqwest failure was, without its text.
fn kind(e: &reqwest::Error) -> String {
    if let Some(s) = e.status() {
        format!("status {}", s.as_u16())
    } else if e.is_timeout() {
        "timeout".into()
    } else if e.is_connect() {
        "connect failed".into()
    } else if e.is_body() || e.is_decode() {
        "body error".into()
    } else {
        "request failed".into()
    }
}

/// One copy of a title.
struct Candidate {
    copy: CopyRef,
    source: String,
}

/// Movies on two or more sources: each group is one title's copies, one
/// per source.
async fn title_groups(state: &Arc<AppState>) -> Vec<Vec<Candidate>> {
    let refs: Vec<ItemRef> = state
        .db_call(|c| {
            let mut stmt = c.prepare(
                "SELECT source_id, item_id FROM items WHERE content_type = 'movie' \
                 AND title_base IS NOT NULL AND title_base <> '' \
                 GROUP BY title_base COLLATE NOCASE \
                 HAVING COUNT(DISTINCT source_id) >= 2 \
                 ORDER BY COUNT(DISTINCT source_id) DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map([GROUPS_SCANNED as i64], |r| {
                    Ok(ItemRef::new(
                        r.get::<_, String>(0)?,
                        ContentType::Movie,
                        r.get::<_, String>(1)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap_or_else(|_| panic!("the catalog query failed"));
    let mut groups = Vec::new();
    for r in refs {
        let first = r.clone();
        let others = state
            .db_call(move |c| catalog::same_title(c, &first, None))
            .await;
        let Ok(others) = others else { continue };
        let mut group = vec![Candidate {
            source: r.source_id.clone(),
            copy: CopyRef::new(r, None),
        }];
        for o in others {
            if group.iter().any(|g| g.source == o.row.source_id) {
                continue;
            }
            group.push(Candidate {
                source: o.row.source_id.clone(),
                copy: CopyRef::new(
                    ItemRef::new(o.row.source_id.clone(), ContentType::Movie, o.row.item_id),
                    None,
                ),
            });
        }
        if group.len() >= 2 {
            groups.push(group);
        }
    }
    groups
}

async fn fingerprint(
    state: &Arc<AppState>,
    budget: &mut Budget,
    c: &Candidate,
) -> Result<shared::Fingerprint, &'static str> {
    if budget.left(&c.source) < FINGERPRINT_COST {
        return Err("source budget spent");
    }
    let ep = shared::resolve(state, &c.copy)
        .await
        .map_err(|_| "resolve failed")?;
    budget.take(&c.source, FINGERPRINT_COST);
    tokio::time::timeout(TIMEOUT * 3, mirrors::fingerprint(state, &ep))
        .await
        .map_err(|_| "fingerprint timed out")?
        .map_err(|_| "fingerprint failed")
}

/// How the second connection went.
enum Second {
    Accepted,
    Refused(u16),
    /// The second was accepted and the first ended.
    Kicked,
    Failed(String),
}

impl std::fmt::Display for Second {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Second::Accepted => write!(f, "accepted"),
            Second::Refused(s) => write!(f, "refused (status {s})"),
            Second::Kicked => write!(f, "kicked the first connection"),
            Second::Failed(k) => write!(f, "failed ({k})"),
        }
    }
}

async fn open(
    state: &Arc<AppState>,
    ep: &shared::Endpoint,
    from: i64,
) -> Result<reqwest::Response, String> {
    let client = iptv_core::http::source_client(state, &ep.copy.item_ref.source_id, &ep.url).await;
    let req = client
        .get(&ep.url)
        .header(reqwest::header::RANGE, format!("bytes={from}-"));
    let req = iptv_core::http::apply_source_headers(req, &ep.headers);
    tokio::time::timeout(TIMEOUT, req.send())
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| kind(&e))
}

/// Reads `resp` until `until`, `cap` bytes, or its end. Returns the bytes
/// read and whether it ended (or failed) before the deadline and cap.
async fn drain(resp: &mut reqwest::Response, until: Instant, cap: u64) -> (u64, bool) {
    let mut n = 0u64;
    while n < cap {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return (n, false);
        }
        match tokio::time::timeout(left.min(TIMEOUT), resp.chunk()).await {
            Ok(Ok(Some(c))) => n += c.len() as u64,
            Ok(Ok(None)) | Ok(Err(_)) => return (n, true),
            Err(_) if Instant::now() >= until => return (n, false),
            Err(_) => return (n, true),
        }
    }
    (n, false)
}

/// One source's speed on one connection, then what a second one does.
async fn measure(
    state: &Arc<AppState>,
    budget: &mut Budget,
    index: usize,
    c: &Candidate,
    total: i64,
) {
    let cap = budget.left(&c.source);
    if cap < 10 * MB {
        println!("source {index}: budget spent, not measured");
        return;
    }
    let Ok(ep) = shared::resolve(state, &c.copy).await else {
        println!("source {index}: resolve failed");
        return;
    };
    let mut first = match open(state, &ep, 0).await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            println!(
                "source {index}: first connection refused (status {})",
                r.status().as_u16()
            );
            return;
        }
        Err(k) => {
            println!("source {index}: first connection failed ({k})");
            return;
        }
    };
    let began = Instant::now();
    let measure_cap = MEASURE_CAP.min(cap.saturating_sub(BOTH_CAP));
    let (got, ended) = drain(&mut first, began + MEASURE_FOR, measure_cap).await;
    let secs = began.elapsed().as_secs_f64().max(0.001);
    budget.take(&c.source, got);
    println!(
        "source {index}: one connection {:.2} MB/s ({} in {secs:.1} s{})",
        got as f64 / MB as f64 / secs,
        mb(got as i64),
        if ended { ", ended early" } else { "" }
    );
    if ended {
        println!("source {index}: second connection not tried (the first ended)");
        return;
    }
    // A second connection while the first is still open, from the middle.
    let second = match open(state, &ep, (total / 2).max(0)).await {
        Ok(r) if r.status().is_success() => Ok(r),
        Ok(r) => Err(Second::Refused(r.status().as_u16())),
        Err(k) => Err(Second::Failed(k)),
    };
    let outcome = match second {
        Err(o) => o,
        Ok(mut second) => {
            let until = Instant::now() + BOTH_FOR;
            let half = BOTH_CAP / 2;
            let ((a, first_ended), (b, _)) = tokio::join!(
                drain(&mut first, until, half),
                drain(&mut second, until, half)
            );
            budget.take(&c.source, a + b);
            println!(
                "source {index}: both open for {:.1} s: first {}, second {}",
                BOTH_FOR.as_secs_f64(),
                mb(a as i64),
                mb(b as i64)
            );
            if first_ended {
                Second::Kicked
            } else {
                Second::Accepted
            }
        }
    };
    println!("source {index}: second connection {outcome}");
}

#[test]
#[ignore = "reaches real IPTV providers; run by hand with DL_LIVE_DATA_DIR"]
fn live_providers_split_and_mirror() {
    let dir = data_dir();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        let state = AppState::new(dir, Arc::new(iptv_core::NoopSink), false)
            .await
            .unwrap_or_else(|_| panic!("could not open the data dir copy"));
        let mut budget = Budget::default();
        let mut names = Names::default();

        let groups = title_groups(&state).await;
        println!("{} titles on two or more sources", groups.len());

        // Size the first copy of some groups, keep the largest titles.
        let mut sized: Vec<(i64, Vec<Candidate>)> = Vec::new();
        for group in groups.into_iter().take(GROUPS_SIZED) {
            if let Ok(f) = fingerprint(&state, &mut budget, &group[0]).await {
                sized.push((f.total, group));
            }
        }
        sized.sort_by_key(|(total, _)| std::cmp::Reverse(*total));
        sized.truncate(MOVIES);

        // Every copy of each chosen title, compared across sources.
        let mut per_source: BTreeMap<usize, (i64, usize, usize)> = BTreeMap::new();
        for (m, (_, group)) in sized.iter().enumerate() {
            println!("movie {}:", m + 1);
            let mut prints = Vec::new();
            for c in group {
                let index = names.of(&c.source);
                match fingerprint(&state, &mut budget, c).await {
                    Ok(f) => {
                        println!(
                            "  source {index}: {}, samples {} {} {}, validator {}",
                            mb(f.total),
                            short(&f.samples[0]),
                            short(&f.samples[1]),
                            short(&f.samples[2]),
                            if f.validator.is_some() { "yes" } else { "no" }
                        );
                        // The largest copy per source is what gets measured.
                        let e = per_source.entry(index).or_insert((f.total, m, 0));
                        if f.total > e.0 {
                            *e = (f.total, m, e.2);
                        }
                        prints.push((index, f));
                    }
                    Err(why) => println!("  source {index}: {why}"),
                }
            }
            for (i, (a, fa)) in prints.iter().enumerate() {
                for (b, fb) in &prints[i + 1..] {
                    let verdict = if fa.total == fb.total && fa.samples == fb.samples {
                        "identical"
                    } else if fa.total == fb.total {
                        "same size, samples differ"
                    } else {
                        "differ"
                    };
                    println!("  source {a} vs source {b}: {verdict}");
                }
            }
        }

        // One movie per source: one connection, then a second.
        let sources: Vec<(usize, i64, usize)> = per_source
            .iter()
            .map(|(index, (total, m, _))| (*index, *total, *m))
            .collect();
        for (index, total, m) in sources {
            let group = &sized[m].1;
            let Some(c) = group.iter().find(|c| names.of(&c.source) == index) else {
                continue;
            };
            measure(&state, &mut budget, index, c, total).await;
        }

        for (source, index) in &names.0 {
            let used = SOURCE_CAP - budget.left(source);
            println!(
                "source {index}: {} used of {}",
                mb(used as i64),
                mb(SOURCE_CAP as i64)
            );
        }
    });
    rt.shutdown_timeout(Duration::from_secs(5));
}
