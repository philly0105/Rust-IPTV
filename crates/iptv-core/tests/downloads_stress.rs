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
//! Rows are Xtream movies (`/movie/` route, catalog rows written through the
//! import path), so they split, and the download speed work's paths run
//! too: copies of every file on up to two more panels (mirrors, sometimes
//! one planted with bytes that differ outside the fingerprint windows),
//! panels with no validator, redirects with short-lived tokens, panels that
//! kick the oldest connection instead of refusing, connection-limit probes
//! (and their refusals), playback on a mirror's account, settings that turn
//! mirrors off or cap connections per file, and a mirror that vanishes for
//! good.
//!
//! Checked: whenever no task runs for a row (paused, or the app killed), its
//! `.part` holds the file's bytes wherever its sidecar (or, without one, its
//! length) says it does, and a sidecar is never invalid unless the `.part`
//! was deleted by hand; at the end every row, resumed with the faults gone,
//! completes byte-exact under its own name with no `.part` or sidecar left.
//! Sidecar v2 segments marked `checked: false` are unverified mirror bytes:
//! only in a scenario with a planted bad mirror may they (or segments served
//! by that mirror) hold its bytes, and a finished file may then be wholly
//! the planted copy (a row spread to it), never a stitch of both.
//!
//! Seeded: scenario `i` uses seed `DL_STRESS_SEED + i` (default seed below)
//! for its plan and its panels' faults; timing still varies between runs.
//! `DL_STRESS_SCENARIOS=<n>` runs more (default 4), `DL_STRESS_PARALLEL=<n>`
//! that many at once (default 2). A failure prints its seed and event log;
//! rerun one with `DL_STRESS_SEED=<seed> DL_STRESS_SCENARIOS=1`.

mod dl_panel;
mod fuzz_common;

use dl_panel::{
    add_movie, add_xtream_source, variant_content, Faults, LimitMode, Panel, PanelOptions,
    Redirect, Validators, Variant,
};
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
const SETTLE: Duration = Duration::from_secs(180);
/// Smallest file a connection-limit probe runs on (32 MiB left).
const PROBE_MIN: u64 = 32 * MIB;

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// Engine timings a scenario runs with, applied again after each restart.
#[derive(Debug, Clone, Copy)]
struct Tuning {
    gain_window: Duration,
    recycle_after: Duration,
    probe_step: Duration,
}

/// One app lifetime: its own runtime, so a restart drops every task.
struct App {
    rt: tokio::runtime::Runtime,
    state: Arc<AppState>,
    router: RpcRouter,
}

impl App {
    fn start(data: &Path, tuning: Tuning) -> App {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(3)
            .enable_all()
            .build()
            .unwrap();
        let state = rt.block_on(async {
            let state = AppState::new(data.to_path_buf(), Arc::new(iptv_core::NoopSink), false)
                .await
                .unwrap();
            iptv_core::xtream::init(state.clone()).await.unwrap();
            // Short waits, so a scenario sees many of them; the 2 h limit
            // never runs out in one.
            iptv_core::downloads::set_wait_timing(
                &state,
                Duration::from_millis(100),
                Duration::from_secs(3600),
            );
            iptv_core::downloads::set_idle_timeout(&state, Some(Duration::from_millis(1500)));
            // Fast ramps and recycles, and probes that step quickly, so a
            // scenario's few seconds see them; a learned limit lasts the run.
            iptv_core::downloads::set_ramp_timing(&state, tuning.gain_window, tuning.recycle_after);
            iptv_core::downloads::set_probe_timing(
                &state,
                tuning.probe_step,
                Duration::from_secs(7 * 24 * 3600),
            );
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

    fn settings(&self, change: impl FnOnce(&mut iptv_core::model::Settings)) {
        let mut next = self.state.settings_snapshot();
        change(&mut next);
        self.rt
            .block_on(iptv_core::settings::save(&self.state, next))
            .unwrap();
    }

    fn single_connection(&self, on: bool) {
        self.settings(|s| {
            s.download_single_connection = if on { vec![SOURCE.into()] } else { vec![] };
        });
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

fn part_of(final_path: &str) -> PathBuf {
    PathBuf::from(format!("{final_path}.part"))
}

/// The first offset where `data` (bytes from `offset` of `variant`'s copy
/// of `file`) differs from that copy.
fn first_wrong_in(file: File, variant: Variant, offset: u64, data: &[u8]) -> Option<u64> {
    if variant == Variant::Same {
        return dl_panel::first_wrong(file.id, offset, data);
    }
    const STEP: usize = 1 << 20;
    for (i, piece) in data.chunks(STEP).enumerate() {
        let at = offset + (i * STEP) as u64;
        let want = variant_content(file.id, variant, file.size, at, piece.len());
        if let Some(j) = piece.iter().zip(&want).position(|(a, b)| a != b) {
            return Some(at + j as u64);
        }
    }
    None
}

/// What a scenario's planted mirror (if any) is: the source id whose copy
/// of every file differs outside the fingerprint windows.
#[derive(Debug, Clone, Default)]
struct Planted {
    source: Option<String>,
}

impl Planted {
    fn any(&self) -> bool {
        self.source.is_some()
    }
}

/// The fields sidecar v2 adds to each segment, read straight from the JSON
/// (so this harness reads v1 and v2 alike): whether its bytes were
/// verified, and the source id they came from (`None`: the row's own).
#[derive(Debug, Clone, Default)]
struct SegMeta {
    checked: bool,
    source: Option<String>,
}

fn seg_meta(part: &Path) -> Result<Vec<SegMeta>, String> {
    let raw = std::fs::read(segments::ranges_path(part)).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let version = v["version"].as_u64().unwrap_or(1);
    let sources: Vec<Option<String>> = v["sources"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| s["copy"]["ref"]["sourceId"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let segs = v["segments"].as_array().cloned().unwrap_or_default();
    segs.iter()
        .map(|s| {
            if version < 2 {
                return Ok(SegMeta {
                    checked: true,
                    source: None,
                });
            }
            let src = s["src"].as_u64().unwrap_or(0) as usize;
            if src >= sources.len() {
                return Err(format!(
                    "segment {s} names source {src} of {}",
                    sources.len()
                ));
            }
            Ok(SegMeta {
                checked: s["checked"].as_bool().unwrap_or(false),
                source: sources[src].clone(),
            })
        })
        .collect()
}

/// What the `.part` of a row with no task running says it holds must be the
/// file's bytes. Returns how it said so.
///
/// With a planted mirror in the scenario, bytes the engine has not verified
/// (`checked: false`) or that came from the planted source may be the
/// planted copy's instead, but each segment must then be wholly one copy.
fn check_part(
    file: File,
    final_path: &str,
    hand_deleted: bool,
    planted: &Planted,
) -> Result<&'static str, String> {
    let part = part_of(final_path);
    let either = |offset: u64, data: &[u8], may_be_planted: bool| -> Result<bool, u64> {
        match first_wrong_in(file, Variant::Same, offset, data) {
            None => Ok(false),
            Some(_) if may_be_planted => {
                match first_wrong_in(file, Variant::DiffersOutsideSamples, offset, data) {
                    None => Ok(true),
                    Some(at) => Err(at),
                }
            }
            Some(at) => Err(at),
        }
    };
    match segments::load(&part) {
        Sidecar::Valid(r) => {
            if r.total as u64 != file.size {
                return Err(format!("sidecar total {} for {} bytes", r.total, file.size));
            }
            let meta = seg_meta(&part)?;
            if meta.len() != r.segments.len() {
                return Err(format!(
                    "{} segments, {} with v2 fields",
                    r.segments.len(),
                    meta.len()
                ));
            }
            let data = std::fs::read(&part).map_err(|e| format!("{}: {e}", part.display()))?;
            let mut how = "sidecar";
            for (s, m) in r
                .segments
                .iter()
                .zip(&meta)
                .filter(|(s, _)| s.pos > s.start)
            {
                let (a, b) = (s.start as usize, s.pos as usize);
                if b > data.len() {
                    return Err(format!(
                        "segment {s:?} past the .part's {} bytes",
                        data.len()
                    ));
                }
                let may_be_planted = planted.any() && (!m.checked || m.source == planted.source);
                match either(a as u64, &data[a..b], may_be_planted) {
                    Ok(false) => {}
                    Ok(true) => how = "sidecar-planted",
                    Err(at) => {
                        return Err(format!(
                            "segment {s:?} ({m:?}) recorded as written: wrong byte at {at}"
                        ))
                    }
                }
            }
            Ok(how)
        }
        Sidecar::None => match std::fs::read(&part) {
            Ok(data) => {
                if data.len() as u64 > file.size {
                    return Err(format!(".part of {} bytes for {}", data.len(), file.size));
                }
                // One stream from one copy: a row spread to the planted
                // mirror holds its bytes.
                match either(0, &data, planted.any()) {
                    Ok(false) => Ok("single"),
                    Ok(true) => Ok("single-planted"),
                    Err(at) => Err(format!(".part without sidecar: wrong byte at {at}")),
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
fn rows_on_disk(db: &Path) -> Vec<(i64, Option<String>, String)> {
    let conn = rusqlite::Connection::open(db).unwrap();
    let mut stmt = conn
        .prepare("SELECT id, file_path, status FROM downloads ORDER BY id")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[derive(Default, Debug)]
struct Tally {
    actions: HashMap<&'static str, u32>,
    checks: HashMap<&'static str, u32>,
}

/// A panel holding copies of the scenario's files on another account.
struct Mirror {
    source: String,
    /// `None` once it vanished.
    panel: Option<Panel>,
    variant: Variant,
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

    fn options(&mut self, seed: u64) -> PanelOptions {
        let validators = *self.rng.pick(&[
            Validators::ETag,
            Validators::ETag,
            Validators::LastModified,
            Validators::Both,
            Validators::None,
        ]);
        let limit_mode = if self.rng.chance(1, 4) {
            LimitMode::KickOldest
        } else {
            LimitMode::Refuse
        };
        let redirect = match self.rng.below(5) {
            0 => Some(Redirect::SameHost {
                token_ttl: Duration::from_millis(1500 + self.rng.below(6000) as u64),
            }),
            1 => Some(Redirect::EdgeHost {
                token_ttl: Duration::from_millis(1500 + self.rng.below(6000) as u64),
            }),
            _ => None,
        };
        PanelOptions {
            seed,
            validators,
            limit_mode,
            redirect,
            line: None,
        }
    }

    /// Adds a file to every panel and the catalogs and starts its download
    /// from the scenario's own source; returns the row.
    #[allow(clippy::too_many_arguments)]
    fn start_file(
        &mut self,
        app: &App,
        panel: &Panel,
        mirrors: &[Mirror],
        probing: bool,
        files: &mut Vec<File>,
        ids: &mut HashMap<i64, File>,
    ) -> Result<i64, String> {
        let id = files.len() as u32 + 1;
        // Mostly files worth splitting (8 MiB and up), sometimes one that is
        // not, and with probing on some long enough to probe; odd sizes, so
        // no segment ends on a round number.
        let size = if self.rng.chance(1, 5) {
            MIB + self.rng.below(6 * MIB as usize) as u64
        } else if probing && self.rng.chance(1, 3) {
            PROBE_MIN + 2 * MIB + self.rng.below(12 * MIB as usize) as u64
        } else {
            8 * MIB + self.rng.below(24 * MIB as usize) as u64
        };
        let kbps = 2048 + self.rng.below(6144) as u64;
        panel.file(id, size, kbps);
        // The catalog title is the file's own, so copies on other sources
        // are this file; the row's title (its file name) often repeats.
        let catalog_title = format!("Stress Film {id}");
        app.rt.block_on(add_movie(
            &app.state,
            SOURCE,
            id,
            &catalog_title,
            None,
            "mp4",
        ));
        for m in mirrors {
            if let Some(p) = &m.panel {
                let mk = 2048 + self.rng.below(6144) as u64;
                p.file_variant(id, size, mk, m.variant);
            }
            app.rt.block_on(add_movie(
                &app.state,
                &m.source,
                id,
                &catalog_title,
                None,
                "mp4",
            ));
        }
        let file = File { id, size };
        files.push(file);
        let title = *self.rng.pick(&["Movie", "Movie", "Film", "Show"]);
        let d: Download = serde_json::from_value(
            app.rpc(
                "downloads.start",
                json!({
                    "ref": {"sourceId": SOURCE, "contentType": "movie", "itemId": id.to_string()},
                    "title": title,
                    "url": panel.movie_url(id),
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
        let opts = self.options(self.seed);
        self.note(format!("panel {opts:?}"));
        let panel = panel_rt.block_on(Panel::with(opts));
        let reported = 2 + self.rng.below(4);
        panel.set_reported(reported);
        let lag = *self.rng.pick(&[0u64, 0, 50, 150]);
        panel.set_lag(Duration::from_millis(lag));
        self.note(format!(
            "panel reports {reported} connections, lag {lag} ms"
        ));

        // Copies on other accounts: none, one or two, one of them sometimes
        // planted (identical in the fingerprint windows only).
        let mirror_count = self.rng.below(3);
        let planted_at =
            (mirror_count > 0 && self.rng.chance(1, 3)).then(|| self.rng.below(mirror_count));
        let mut mirrors = Vec::new();
        for i in 0..mirror_count {
            let opts = self.options(self.seed.wrapping_mul(31).wrapping_add(i as u64 + 1));
            let p = panel_rt.block_on(Panel::with(opts.clone()));
            let n = 1 + self.rng.below(3);
            p.set_reported(n);
            p.set_enforced(n);
            p.set_lag(Duration::from_millis(*self.rng.pick(&[0u64, 50])));
            let variant = if planted_at == Some(i) {
                Variant::DiffersOutsideSamples
            } else {
                Variant::Same
            };
            let source = format!("xm{}", i + 1);
            self.note(format!(
                "mirror {source}: {variant:?}, {n} connections, {opts:?}"
            ));
            mirrors.push(Mirror {
                source,
                panel: Some(p),
                variant,
            });
        }
        let planted = Planted {
            source: planted_at.map(|i| mirrors[i].source.clone()),
        };
        let probing = self.rng.chance(1, 2);
        let tuning = Tuning {
            gain_window: Duration::from_millis(200 + self.rng.below(400) as u64),
            recycle_after: Duration::from_millis(1500 + self.rng.below(3000) as u64),
            probe_step: Duration::from_millis(100 + self.rng.below(200) as u64),
        };
        self.note(format!("probing {probing}, {tuning:?}"));

        let mut app = App::start(&data, tuning);
        let db = app.state.db_path();
        app.rt.block_on(async {
            // Caches each account's limit, as a sync does.
            add_xtream_source(&app.state, SOURCE, &panel).await;
            for m in &mirrors {
                add_xtream_source(&app.state, &m.source, m.panel.as_ref().unwrap()).await;
            }
        });
        let every: Vec<String> = std::iter::once(SOURCE.to_string())
            .chain(mirrors.iter().map(|m| m.source.clone()))
            .collect();
        if !probing {
            let all = every.clone();
            app.settings(|s| s.download_probe_disabled = all);
        }

        let mut files = Vec::new();
        let mut ids: HashMap<i64, File> = HashMap::new();
        let mut hand_deleted: HashSet<i64> = HashSet::new();
        for _ in 0..1 + self.rng.below(3) {
            self.start_file(&app, &panel, &mirrors, probing, &mut files, &mut ids)?;
        }

        let steps = 10 + self.rng.below(16);
        let mut restarts = 0;
        let mut single = false;
        for _ in 0..steps {
            std::thread::sleep(Duration::from_millis(30 + self.rng.below(700) as u64));
            let rows = app.list();
            // The panel an action aims at: the scenario's own, or a mirror
            // that is still there.
            let live: Vec<&Panel> = std::iter::once(&panel)
                .chain(mirrors.iter().filter_map(|m| m.panel.as_ref()))
                .collect();
            let target = self.rng.below(live.len());
            match self.rng.below(26) {
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
                            let how = check_part(ids[&id], p, hand_deleted.contains(&id), &planted)
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
                    // Mostly the scenario's own account; sometimes a mirror's,
                    // whose transfers must give it up within a tick.
                    let players = 1 + self.rng.below(reported);
                    let sources: Vec<&String> =
                        (0..players).map(|_| self.rng.pick(&every)).collect();
                    let r = app.rpc(
                        "downloads.playback",
                        json!({"clientId": "player", "sourceIds": sources}),
                    );
                    self.act("playback", format!("{sources:?}: {r:?}"));
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
                    // Another device takes some of an account's connections,
                    // or lets them go.
                    let enforced = if self.rng.chance(1, 3) {
                        0
                    } else {
                        1 + self.rng.below(reported)
                    };
                    live[target].set_enforced(enforced);
                    self.act(
                        "panel-allows",
                        format!("panel {target}: {enforced} (0: no limit)"),
                    );
                }
                13 => {
                    let ms = 200 + self.rng.below(1300) as u64;
                    live[target].outage(Duration::from_millis(ms));
                    self.act("outage", format!("panel {target}: {ms} ms"));
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
                    live[target].set_faults(faults);
                    self.act("faults", format!("panel {target}: {faults:?}"));
                }
                16 => {
                    let f = *self.rng.pick(&files);
                    let kbps = 1024 + self.rng.below(8192) as u64;
                    live[target].set_speed(f.id, kbps);
                    self.act(
                        "speed",
                        format!("panel {target}: file {} at {kbps} KiB/s", f.id),
                    );
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
                    let id =
                        self.start_file(&app, &panel, &mirrors, probing, &mut files, &mut ids)?;
                    self.act("start", format!("row {id}"));
                }
                19 => {
                    // Mirrors off or on, or another cap on connections per
                    // file (0: Auto).
                    if self.rng.chance(1, 2) {
                        let on = !app.state.settings_snapshot().download_use_mirrors;
                        app.settings(|s| s.download_use_mirrors = on);
                        self.act("setting", format!("use other sources: {on}"));
                    } else {
                        let max = self.rng.below(9) as u8;
                        app.settings(|s| s.download_max_connections = max);
                        self.act("setting", format!("max connections per file: {max}"));
                    }
                }
                20 => {
                    // A panel switches between refusing one connection too
                    // many and kicking the oldest.
                    let mode = if self.rng.chance(1, 2) {
                        LimitMode::KickOldest
                    } else {
                        LimitMode::Refuse
                    };
                    live[target].set_limit_mode(mode);
                    self.act("limit-mode", format!("panel {target}: {mode:?}"));
                }
                21 => {
                    // A mirror's provider goes away for good.
                    let Some(m) = mirrors.iter_mut().find(|m| m.panel.is_some()) else {
                        continue;
                    };
                    if !self.rng.chance(1, 2) {
                        continue;
                    }
                    drop(m.panel.take());
                    let source = m.source.clone();
                    self.act("mirror-gone", source);
                }
                22 => {
                    // The user asks for an account's limit to be probed again.
                    let source = self.rng.pick(&every).clone();
                    let r = app.rpc(
                        "downloads.resetConnectionLimit",
                        json!({"sourceId": source}),
                    );
                    self.act("reset-limit", format!("{source}: {r:?}"));
                }
                _ => {
                    if restarts >= 3 {
                        continue;
                    }
                    restarts += 1;
                    app.kill();
                    self.act("restart", String::new());
                    for (id, path, status) in rows_on_disk(&db) {
                        if status == "completed" {
                            continue;
                        }
                        let Some(path) = path else { continue };
                        let how = check_part(ids[&id], &path, hand_deleted.contains(&id), &planted)
                            .map_err(|e| format!("row {id} ({status}) after a kill: {e}"))?;
                        self.checked(how);
                    }
                    app = App::start(&data, tuning);
                    // The settings are stored; the player went with the app.
                }
            }
        }

        // The faults go, the other devices leave, playback stops: every row
        // must now complete byte-exact.
        let live: Vec<&Panel> = std::iter::once(&panel)
            .chain(mirrors.iter().filter_map(|m| m.panel.as_ref()))
            .collect();
        for p in &live {
            p.set_faults(Faults::default());
            p.outage(Duration::ZERO);
            p.set_enforced(0);
        }
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
                        .map(|d| (
                            d.id,
                            d.status,
                            d.bytes_downloaded,
                            d.connections,
                            d.sources,
                            d.error_message.clone()
                        ))
                        .collect::<Vec<_>>()
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let mut paths = HashSet::new();
        for d in &done {
            let path = d.file_path.clone().unwrap();
            let file = ids[&d.id];
            if let Err(e) = dl_panel::is_exact(file.id, file.size, Path::new(&path)) {
                // A row spread to the planted copy holds it wholly: the
                // fingerprint cannot tell, and nothing was stitched.
                let data = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
                let wholly_planted = planted.any()
                    && data.len() as u64 == file.size
                    && first_wrong_in(file, Variant::DiffersOutsideSamples, 0, &data).is_none();
                if !wholly_planted {
                    return Err(format!("row {} ({path}): {e}", d.id));
                }
                self.checked("completed-planted");
            } else {
                self.checked("completed");
            }
            if part_of(&path).exists() || segments::ranges_path(&part_of(&path)).exists() {
                return Err(format!("row {}: a .part or sidecar is left", d.id));
            }
            if !paths.insert(path.clone()) {
                return Err(format!("two rows completed into {path}"));
            }
        }
        let summary: Vec<String> = live
            .iter()
            .map(|p| {
                format!(
                    "{} requests, peak {}, kicked {}, {:?}",
                    p.log().len(),
                    p.peak(),
                    p.kicked(),
                    p.counts()
                )
            })
            .collect();
        self.note(format!("done: {summary:?}"));
        app.kill();
        drop(live);
        drop(mirrors);
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
