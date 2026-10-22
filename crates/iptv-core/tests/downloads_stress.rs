//! Randomized stress test of segmented downloads. Two review rounds found
//! silent-corruption paths in files split over several connections, so this
//! runs scenarios that mix everything a real account does to them: files
//! whose every byte is known (`dl_panel`), served with a speed cap per
//! connection by a panel whose account allows fewer connections than it
//! reports (another device), with refusals, 503s, bodies that stall or drop,
//! pauses and resumes, playback that makes downloads yield, changes of the
//! source's "Connections per download", a `.part` deleted by hand while
//! paused, and app restarts (every task dropped where it is, then the state
//! re-created from the same data dir) at random moments.
//!
//! Checked: whenever no task runs for a row (paused, or the app killed), its
//! `.part` holds the file's bytes wherever its sidecar (or, without one, its
//! length) says it does, and a sidecar is never invalid unless the `.part`
//! was deleted by hand; at the end every row, resumed with the faults gone,
//! completes byte-exact under its own name with no `.part` or sidecar left.
//!
//! Seeded: scenario `i` uses seed `DL_STRESS_SEED + i` (default seed below)
//! for its plan and its panel's faults; timing still varies between runs.
//! `DL_STRESS_SCENARIOS=<n>` runs more (default 4), `DL_STRESS_PARALLEL=<n>`
//! that many at once (default 2). A failure prints its seed and event log;
//! rerun one with `DL_STRESS_SEED=<seed> DL_STRESS_SCENARIOS=1`.

mod dl_panel;
mod fuzz_common;

use dl_panel::{Faults, Panel};
use fuzz_common::Rng;
use iptv_core::downloads::segments::{self, Sidecar};
use iptv_core::model::{Download, DownloadStatus};
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;
const SOURCE: &str = "xt";
const DEFAULT_SEED: u64 = 0x5eed_d0e5;
/// How long the faults-gone phase may take to complete every row.
const SETTLE: Duration = Duration::from_secs(120);

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// One app lifetime: its own runtime, so a restart drops every task.
struct App {
    rt: tokio::runtime::Runtime,
    state: Arc<AppState>,
    router: RpcRouter,
}

impl App {
    fn start(data: &Path) -> App {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(3)
            .enable_all()
            .build()
            .unwrap();
        let state = rt.block_on(async {
            let state = AppState::new(data.to_path_buf(), Arc::new(iptv_core::NoopSink), false)
                .await
                .unwrap();
            // Short waits, so a scenario sees many of them; the 2 h limit
            // never runs out in one.
            iptv_core::downloads::set_wait_timing(
                &state,
                Duration::from_millis(100),
                Duration::from_secs(3600),
            );
            iptv_core::downloads::set_idle_timeout(&state, Some(Duration::from_millis(1500)));
            iptv_core::downloads::init(state.clone()).await.unwrap();
            state
        });
        let mut router = RpcRouter::new();
        iptv_core::downloads::rpc::register(&mut router);
        App { rt, state, router }
    }

    fn rpc(&self, cmd: &str, args: Value) -> Result<Value, String> {
        self.rt
            .block_on(self.router.dispatch(self.state.clone(), cmd, args))
            .map_err(|e| e.to_string())
    }

    fn list(&self) -> Vec<Download> {
        serde_json::from_value(self.rpc("downloads.list", Value::Null).unwrap()).unwrap()
    }

    fn get(&self, id: i64) -> Download {
        serde_json::from_value(self.rpc("downloads.get", json!({"id": id})).unwrap()).unwrap()
    }

    fn single_connection(&self, on: bool) {
        let mut next = self.state.settings_snapshot();
        next.download_single_connection = if on { vec![SOURCE.into()] } else { vec![] };
        self.rt
            .block_on(iptv_core::settings::save(&self.state, next))
            .unwrap();
    }

    /// Ends the app the way a crash does: every task is dropped where it
    /// is (blocking file writes in flight finish first, as the OS would
    /// finish a write call).
    fn kill(self) {
        let App { rt, state, router } = self;
        drop(router);
        rt.shutdown_timeout(Duration::from_secs(10));
        drop(state);
    }
}

#[derive(Debug, Clone, Copy)]
struct File {
    id: u32,
    size: u64,
}

/// The panel file a row downloads (`.../f/<id>`).
fn file_of(url: &str) -> u32 {
    url.rsplit('/').next().unwrap().parse().unwrap()
}

fn part_of(final_path: &str) -> PathBuf {
    PathBuf::from(format!("{final_path}.part"))
}

/// What the `.part` of a row with no task running says it holds must be the
/// file's bytes. Returns how it said so.
fn check_part(file: File, final_path: &str, hand_deleted: bool) -> Result<&'static str, String> {
    let part = part_of(final_path);
    match segments::load(&part) {
        Sidecar::Valid(r) => {
            if r.total as u64 != file.size {
                return Err(format!("sidecar total {} for {} bytes", r.total, file.size));
            }
            let data = std::fs::read(&part).map_err(|e| format!("{}: {e}", part.display()))?;
            for s in r.segments.iter().filter(|s| s.pos > s.start) {
                let (a, b) = (s.start as usize, s.pos as usize);
                if b > data.len() {
                    return Err(format!(
                        "segment {s:?} past the .part's {} bytes",
                        data.len()
                    ));
                }
                if let Some(at) = dl_panel::first_wrong(file.id, a as u64, &data[a..b]) {
                    return Err(format!(
                        "segment {s:?} recorded as written: wrong byte at {at}"
                    ));
                }
            }
            Ok("sidecar")
        }
        Sidecar::None => match std::fs::read(&part) {
            Ok(data) => {
                if data.len() as u64 > file.size {
                    return Err(format!(".part of {} bytes for {}", data.len(), file.size));
                }
                match dl_panel::first_wrong(file.id, 0, &data) {
                    Some(at) => Err(format!(".part without sidecar: wrong byte at {at}")),
                    None => Ok("single"),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("none"),
            Err(e) => Err(format!("{}: {e}", part.display())),
        },
        // Progress thrown away: only expected once the `.part` went by hand.
        Sidecar::Invalid if hand_deleted => Ok("invalid"),
        Sidecar::Invalid => Err(format!(
            "the sidecar is invalid, so a resume starts over: {} next to a .part of {:?} bytes",
            std::fs::read_to_string(segments::ranges_path(&part)).unwrap_or_default(),
            std::fs::metadata(&part).map(|m| m.len()).ok()
        )),
    }
}

/// Rows as the database has them while no app runs.
fn rows_on_disk(db: &Path) -> Vec<(i64, String, Option<String>, String)> {
    let conn = rusqlite::Connection::open(db).unwrap();
    let mut stmt = conn
        .prepare("SELECT id, url, file_path, status FROM downloads ORDER BY id")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[derive(Default, Debug)]
struct Tally {
    actions: HashMap<&'static str, u32>,
    checks: HashMap<&'static str, u32>,
}

struct Scenario {
    seed: u64,
    rng: Rng,
    log: Vec<String>,
    began: Instant,
    tally: Tally,
}

impl Scenario {
    fn note(&mut self, what: String) {
        self.log.push(format!(
            "{:>7.3}s {what}",
            self.began.elapsed().as_secs_f64()
        ));
    }

    fn act(&mut self, what: &'static str, detail: String) {
        *self.tally.actions.entry(what).or_default() += 1;
        self.note(format!("{what} {detail}"));
    }

    fn checked(&mut self, how: &'static str) {
        *self.tally.checks.entry(how).or_default() += 1;
    }

    /// Adds a file to the panel and starts its download; returns the row.
    fn start_file(
        &mut self,
        app: &App,
        panel: &Panel,
        files: &mut Vec<File>,
        ids: &mut HashMap<i64, File>,
    ) -> Result<i64, String> {
        let id = files.len() as u32 + 1;
        // Mostly files worth splitting (8 MiB and up), sometimes one that is
        // not; odd sizes, so no segment ends on a round number.
        let size = if self.rng.chance(1, 5) {
            MIB + self.rng.below(6 * MIB as usize) as u64
        } else {
            8 * MIB + self.rng.below(24 * MIB as usize) as u64
        };
        let kbps = 2048 + self.rng.below(6144) as u64;
        panel.file(id, size, kbps);
        let file = File { id, size };
        files.push(file);
        // Catch-up refs keep the URL they were given (an Xtream movie's
        // would be re-resolved to the panel's movie path).
        let title = *self.rng.pick(&["Movie", "Movie", "Film", "Show"]);
        let d: Download = serde_json::from_value(
            app.rpc(
                "downloads.start",
                json!({
                    "ref": {"sourceId": SOURCE, "contentType": "live", "itemId": format!("ch{id}")},
                    "episodeId": format!("catchup:{id}"),
                    "title": title,
                    "url": panel.url(id),
                }),
            )
            .map_err(|e| format!("start: {e}"))?,
        )
        .unwrap();
        ids.insert(d.id, file);
        self.note(format!(
            "file {id}: {size} bytes at {kbps} KiB/s, \"{title}\", row {}",
            d.id
        ));
        Ok(d.id)
    }

    fn run(&mut self) -> Result<(), String> {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let panel_rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let panel = panel_rt.block_on(Panel::spawn(self.seed));
        let reported = 2 + self.rng.below(4);
        panel.set_reported(reported);
        let lag = *self.rng.pick(&[0u64, 0, 50, 150]);
        panel.set_lag(Duration::from_millis(lag));

        self.note(format!(
            "panel reports {reported} connections, lag {lag} ms"
        ));

        let mut app = App::start(&data);
        let db = app.state.db_path();
        let cfg = json!({"serverUrl": panel.base, "username": "u", "password": "p"}).to_string();
        app.rt.block_on(async {
            app.state
                .db_call(move |c| {
                    c.execute(
                        "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', 'Panel', ?2)",
                        rusqlite::params![SOURCE, cfg],
                    )?;
                    Ok(())
                })
                .await
                .unwrap();
            // Caches the account's limit, as a sync does.
            iptv_core::account::status(&app.state, SOURCE, true)
                .await
                .unwrap();
        });

        let mut files = Vec::new();
        let mut ids: HashMap<i64, File> = HashMap::new();
        let mut hand_deleted: HashSet<i64> = HashSet::new();
        for _ in 0..1 + self.rng.below(3) {
            self.start_file(&app, &panel, &mut files, &mut ids)?;
        }

        let steps = 10 + self.rng.below(16);
        let mut restarts = 0;
        let mut single = false;
        for _ in 0..steps {
            std::thread::sleep(Duration::from_millis(30 + self.rng.below(700) as u64));
            let rows = app.list();
            match self.rng.below(21) {
                0..=2 => {
                    let open: Vec<&Download> = rows
                        .iter()
                        .filter(|d| {
                            matches!(
                                d.status,
                                DownloadStatus::Queued | DownloadStatus::Downloading
                            )
                        })
                        .collect();
                    if open.is_empty() {
                        continue;
                    }
                    let id = self.rng.pick(&open).id;
                    let r = app.rpc("downloads.pause", json!({"id": id}));
                    self.act("pause", format!("{id}: {r:?}"));
                    let d = app.get(id);
                    if d.status == DownloadStatus::Paused {
                        if let Some(p) = &d.file_path {
                            let how = check_part(ids[&id], p, hand_deleted.contains(&id))
                                .map_err(|e| format!("row {id} paused: {e}"))?;
                            self.checked(how);
                        }
                    }
                }
                3..=5 => {
                    let stopped: Vec<&Download> = rows
                        .iter()
                        .filter(|d| {
                            matches!(d.status, DownloadStatus::Paused | DownloadStatus::Failed)
                        })
                        .collect();
                    if stopped.is_empty() {
                        continue;
                    }
                    let d = self.rng.pick(&stopped);
                    let r = app.rpc("downloads.resume", json!({"id": d.id}));
                    self.act("resume", format!("{} ({:?}): {r:?}", d.id, d.status));
                }
                6 | 7 => {
                    let players = 1 + self.rng.below(reported);
                    let sources = vec![SOURCE; players];
                    let r = app.rpc(
                        "downloads.playback",
                        json!({"clientId": "player", "sourceIds": sources}),
                    );
                    self.act("playback", format!("{players} players: {r:?}"));
                }
                8 | 9 => {
                    let r = app.rpc(
                        "downloads.playback",
                        json!({"clientId": "player", "sourceIds": []}),
                    );
                    self.act("playback-stop", format!("{r:?}"));
                }
                10 => {
                    single = !single;
                    app.single_connection(single);
                    self.act("setting", format!("one connection: {single}"));
                }
                11 | 12 => {
                    // Another device takes some of the account's connections,
                    // or lets them go.
                    let enforced = if self.rng.chance(1, 3) {
                        0
                    } else {
                        1 + self.rng.below(reported)
                    };
                    panel.set_enforced(enforced);
                    self.act("panel-allows", format!("{enforced} (0: no limit)"));
                }
                13 => {
                    let ms = 200 + self.rng.below(1300) as u64;
                    panel.outage(Duration::from_millis(ms));
                    self.act("outage", format!("{ms} ms"));
                }
                14 | 15 => {
                    let faults = if self.rng.chance(1, 3) {
                        Faults::default()
                    } else {
                        Faults {
                            refuse: self.rng.below(80) as u32,
                            unavailable: self.rng.below(60) as u32,
                            stall: self.rng.below(80) as u32,
                            drop: self.rng.below(80) as u32,
                        }
                    };
                    panel.set_faults(faults);
                    self.act("faults", format!("{faults:?}"));
                }
                16 => {
                    let f = *self.rng.pick(&files);
                    let kbps = 1024 + self.rng.below(8192) as u64;
                    panel.set_speed(f.id, kbps);
                    self.act("speed", format!("file {} at {kbps} KiB/s", f.id));
                }
                17 => {
                    // The user frees space by deleting a paused partial.
                    let paused: Vec<&Download> = rows
                        .iter()
                        .filter(|d| d.status == DownloadStatus::Paused && d.file_path.is_some())
                        .collect();
                    if paused.is_empty() || !self.rng.chance(1, 2) {
                        continue;
                    }
                    let d = self.rng.pick(&paused);
                    let part = part_of(d.file_path.as_deref().unwrap());
                    let r = std::fs::remove_file(&part);
                    hand_deleted.insert(d.id);
                    self.act("delete-part", format!("{}: {r:?}", d.id));
                }
                18 => {
                    // Another file, maybe with a title already in the list.
                    if files.len() >= 4 {
                        continue;
                    }
                    let id = self.start_file(&app, &panel, &mut files, &mut ids)?;
                    self.act("start", format!("row {id}"));
                }
                _ => {
                    if restarts >= 3 {
                        continue;
                    }
                    restarts += 1;
                    app.kill();
                    self.act("restart", String::new());
                    for (id, url, path, status) in rows_on_disk(&db) {
                        if status == "completed" {
                            continue;
                        }
                        let Some(path) = path else { continue };
                        let file = files[file_of(&url) as usize - 1];
                        let how = check_part(file, &path, hand_deleted.contains(&id))
                            .map_err(|e| format!("row {id} ({status}) after a kill: {e}"))?;
                        self.checked(how);
                    }
                    app = App::start(&data);
                    // The setting is stored; the player went with the app.
                }
            }
        }

        // The faults go, the other device leaves, playback stops: every row
        // must now complete byte-exact.
        panel.set_faults(Faults::default());
        panel.outage(Duration::ZERO);
        panel.set_enforced(0);
        app.rpc(
            "downloads.playback",
            json!({"clientId": "player", "sourceIds": []}),
        )
        .unwrap();
        self.note("faults gone".into());
        let deadline = Instant::now() + SETTLE;
        let done = loop {
            let rows = app.list();
            if rows.iter().all(|d| d.status == DownloadStatus::Completed) {
                break rows;
            }
            for d in &rows {
                if matches!(d.status, DownloadStatus::Paused | DownloadStatus::Failed) {
                    let r = app.rpc("downloads.resume", json!({"id": d.id}));
                    self.note(format!(
                        "settle resume {} ({:?}): {r:?}",
                        d.id, d.error_message
                    ));
                }
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "rows never completed: {:?}",
                    rows.iter()
                        .map(|d| (d.id, d.status, d.bytes_downloaded, d.error_message.clone()))
                        .collect::<Vec<_>>()
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let mut paths = HashSet::new();
        for d in &done {
            let path = d.file_path.clone().unwrap();
            let file = ids[&d.id];
            dl_panel::is_exact(file.id, file.size, Path::new(&path))
                .map_err(|e| format!("row {} ({path}): {e}", d.id))?;
            if part_of(&path).exists() || segments::ranges_path(&part_of(&path)).exists() {
                return Err(format!("row {}: a .part or sidecar is left", d.id));
            }
            if !paths.insert(path.clone()) {
                return Err(format!("two rows completed into {path}"));
            }
        }
        let counts = panel.counts();
        self.note(format!(
            "done: {} requests, panel {counts:?}, peak {} open",
            panel.log().len(),
            panel.peak()
        ));
        app.kill();
        drop(panel);
        panel_rt.shutdown_timeout(Duration::from_secs(5));
        Ok(())
    }
}

#[test]
fn split_downloads_stay_byte_exact_through_random_faults() {
    let base = env_u64("DL_STRESS_SEED", DEFAULT_SEED);
    let count = env_u64("DL_STRESS_SCENARIOS", 4);
    let parallel = env_u64("DL_STRESS_PARALLEL", 2).max(1);
    let next = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let results = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let started = Instant::now();
    let workers: Vec<_> = (0..parallel)
        .map(|_| {
            let (next, results) = (Arc::clone(&next), Arc::clone(&results));
            std::thread::spawn(move || loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if i >= count {
                    return;
                }
                let seed = base.wrapping_add(i);
                let mut s = Scenario {
                    seed,
                    rng: Rng::new(seed),
                    log: Vec::new(),
                    began: Instant::now(),
                    tally: Tally::default(),
                };
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.run()))
                    .unwrap_or_else(|p| {
                        Err(p
                            .downcast_ref::<String>()
                            .cloned()
                            .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_else(|| "panicked".into()))
                    });
                eprintln!(
                    "scenario seed {seed}: {} in {:.1} s, actions {:?}, checks {:?}",
                    if outcome.is_ok() { "ok" } else { "FAILED" },
                    s.began.elapsed().as_secs_f64(),
                    s.tally.actions,
                    s.tally.checks,
                );
                results.lock().push((seed, outcome, s.log));
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    let results = results.lock();
    let failed: Vec<_> = results.iter().filter(|(_, o, _)| o.is_err()).collect();
    eprintln!(
        "{} of {count} scenarios passed in {:.1} s (base seed {base})",
        results.len() - failed.len(),
        started.elapsed().as_secs_f64()
    );
    for (seed, outcome, log) in &failed {
        eprintln!("--- seed {seed}: {}", outcome.as_ref().unwrap_err());
        for line in log {
            eprintln!("    {line}");
        }
    }
    assert!(
        failed.is_empty(),
        "{} scenarios failed; rerun one with DL_STRESS_SEED=<seed> DL_STRESS_SCENARIOS=1: {:?}",
        failed.len(),
        failed.iter().map(|(s, _, _)| s).collect::<Vec<_>>()
    );
}
