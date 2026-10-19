//! Scheduled auto-refresh (`sources::schedule`): which sources a pass
//! refreshes, failure backoff and `lastErrorAt`, the import lock and cancel.
//! A fixed clock drives the decisions; no test sleeps longer than a moment.

#[path = "m3u_support.rs"]
mod support;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use iptv_core::error::{CoreError, CoreResult};
use iptv_core::model::{
    ImportSummary, M3uOrigin, M3uSourceConfig, RequestHeaders, Source, SourceKind,
};
use iptv_core::sources::schedule::{self, Clock};
use iptv_core::sources::{self, store, store::SourceConfig, Importer};
use iptv_core::AppState;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use support::*;

struct FixedClock(Mutex<DateTime<Utc>>);

impl FixedClock {
    fn new() -> Self {
        Self(Mutex::new(Utc::now()))
    }
    fn advance(&self, d: ChronoDuration) {
        let mut t = self.0.lock();
        *t += d;
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Ok,
    Fail,
    /// Runs until its import is cancelled.
    WaitForCancel,
}

struct FakeImporter {
    mode: Mutex<Mode>,
    calls: AtomicU32,
}

#[async_trait::async_trait]
impl Importer for FakeImporter {
    fn kind(&self) -> SourceKind {
        SourceKind::M3u
    }
    async fn import(&self, _state: Arc<AppState>, _source: &Source) -> CoreResult<ImportSummary> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mode = *self.mode.lock();
        match mode {
            Mode::Ok => Ok(ImportSummary::default()),
            Mode::Fail => Err(CoreError::Network("Could not reach 127.0.0.1".into())),
            Mode::WaitForCancel => {
                sources::import_cancel()
                    .expect("runs inside an import")
                    .cancelled()
                    .await;
                Err(sources::import_cancelled_error())
            }
        }
    }
}

struct Setup {
    _env: Env,
    state: Arc<AppState>,
    imp: Arc<FakeImporter>,
    clock: FixedClock,
}

async fn setup() -> Setup {
    let env = env().await;
    let state = env.state.clone();
    let imp = Arc::new(FakeImporter {
        mode: Mutex::new(Mode::Ok),
        calls: AtomicU32::new(0),
    });
    sources::register_importer(&state, imp.clone());
    Setup {
        _env: env,
        state,
        imp,
        clock: FixedClock::new(),
    }
}

/// Inserts an m3u URL source without importing it; `refreshed_ago` sets
/// `last_refresh_at` that long before now.
async fn source(state: &AppState, id: &str, auto: bool, refreshed_ago: Option<ChronoDuration>) {
    let id = id.to_string();
    state
        .db_call(move |c| {
            let cfg = SourceConfig::M3u(M3uSourceConfig {
                origin: M3uOrigin::Url,
                url: Some(format!("http://127.0.0.1:9/{id}.m3u")),
                file_path: None,
                headers: RequestHeaders::default(),
                catchup: None,
            });
            store::insert(c, &id, &id, auto, &cfg, None)?;
            if let Some(ago) = refreshed_ago {
                let at = (Utc::now() - ago).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                c.execute(
                    "UPDATE sources SET last_refresh_at = ?2 WHERE id = ?1",
                    rusqlite::params![id, at],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
}

async fn set_interval(state: &Arc<AppState>, hours: u32) {
    iptv_core::settings::update(
        state,
        serde_json::json!({ "sourceRefreshIntervalHours": hours }),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn refreshes_due_sources_only() {
    let s = setup().await;
    assert_eq!(
        s.state.settings_snapshot().source_refresh_interval_hours,
        12,
        "default"
    );
    source(&s.state, "never", true, None).await;
    source(&s.state, "old", true, Some(ChronoDuration::hours(13))).await;
    source(&s.state, "fresh", true, Some(ChronoDuration::hours(1))).await;
    source(&s.state, "manual", false, Some(ChronoDuration::days(30))).await;

    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    let mut done = r.refreshed.clone();
    done.sort();
    assert_eq!(done, vec!["never", "old"]);
    assert_eq!(s.imp.calls.load(Ordering::SeqCst), 2);
    assert!(r.failed.is_empty() && r.busy.is_empty());

    // Nothing is due ten minutes later.
    s.clock.advance(ChronoDuration::minutes(10));
    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    assert!(r.refreshed.is_empty(), "{r:?}");

    // Eleven hours later "fresh" (refreshed 1 h before the start) is due.
    s.clock.advance(ChronoDuration::hours(11));
    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r.refreshed, vec!["fresh"]);
    assert_eq!(s.imp.calls.load(Ordering::SeqCst), 3);
}

/// ST-1: the startup pass re-imports a source only when it was never
/// refreshed or is older than a day (or than a shorter interval), also with
/// the interval at 0 ("Only at startup").
#[tokio::test]
async fn startup_pass_refreshes_only_due_sources() {
    let s = setup().await;
    source(&s.state, "never", true, None).await;
    source(&s.state, "old", true, Some(ChronoDuration::hours(13))).await;
    source(&s.state, "fresh", true, Some(ChronoDuration::hours(1))).await;
    source(&s.state, "manual", false, Some(ChronoDuration::days(30))).await;
    // Default interval (12 h): as a scheduler pass.
    let r = schedule::startup(&s.state, &s.clock, Duration::ZERO).await;
    let mut done = r.refreshed.clone();
    done.sort();
    assert_eq!(done, vec!["never", "old"]);

    // Interval 0: a day. "day" is due, "half" is not.
    set_interval(&s.state, 0).await;
    source(&s.state, "day", true, Some(ChronoDuration::hours(25))).await;
    source(&s.state, "half", true, Some(ChronoDuration::hours(13))).await;
    let r = schedule::startup(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r.refreshed, vec!["day"]);
    // The scheduler itself still schedules nothing at 0.
    assert_eq!(
        schedule::tick(&s.state, &s.clock, Duration::ZERO).await,
        schedule::TickReport::default()
    );

    // Interval 48 h: startup still refreshes past a day ("half" is 13 h old).
    set_interval(&s.state, 48).await;
    source(&s.state, "long", true, Some(ChronoDuration::hours(30))).await;
    let r = schedule::startup(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r.refreshed, vec!["long"]);
    assert!(schedule::tick(&s.state, &s.clock, Duration::ZERO)
        .await
        .refreshed
        .is_empty());
}

/// HO-4: app exit cancels every running import.
#[tokio::test]
async fn cancel_all_imports_stops_every_run() {
    let s = setup().await;
    *s.imp.mode.lock() = Mode::WaitForCancel;
    source(&s.state, "a", true, None).await;
    let st = s.state.clone();
    let run = tokio::spawn(async move { sources::run_import(st, "a").await });
    for _ in 0..200 {
        if sources::is_import_running(&s.state, "a") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(sources::cancel_all_imports(&s.state), 1);
    let err = run.await.unwrap().unwrap_err();
    assert!(sources::is_cancelled_error(&err), "{err:?}");
    assert_eq!(sources::cancel_all_imports(&s.state), 0);
}

#[tokio::test]
async fn interval_zero_schedules_nothing() {
    let s = setup().await;
    set_interval(&s.state, 0).await;
    source(&s.state, "a", true, None).await;
    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r, schedule::TickReport::default());
    assert_eq!(s.imp.calls.load(Ordering::SeqCst), 0);
    let view = sources::schedule::view(&s.state).await.unwrap();
    assert_eq!(view.interval_hours, 0);
    assert!(view.sources.is_empty());
}

#[tokio::test]
async fn failures_record_last_error_at_and_back_off() {
    let s = setup().await;
    *s.imp.mode.lock() = Mode::Fail;
    source(&s.state, "a", true, Some(ChronoDuration::days(2))).await;

    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r.failed, vec!["a"]);
    let src = sources::get(&s.state, "a").await.unwrap();
    assert!(src
        .last_error
        .as_deref()
        .unwrap()
        .contains("Could not reach"));
    assert!(src.last_error_code.is_some());
    let at = DateTime::parse_from_rfc3339(src.last_error_at.as_deref().expect("lastErrorAt"))
        .unwrap()
        .with_timezone(&Utc);
    assert!((Utc::now() - at).num_seconds().abs() < 60);
    let mem = schedule::memory(&s.state)
        .get("a")
        .map(|a| a.clone())
        .unwrap();
    assert_eq!(mem.failures, 1);

    // The schedule says it is a retry, 30 min out.
    let view = sources::schedule::view(&s.state).await.unwrap();
    assert_eq!(view.sources.len(), 1);
    assert!(view.sources[0].retrying);

    // Not retried before the 30 min backoff, retried after it.
    s.clock.advance(ChronoDuration::minutes(20));
    assert!(schedule::tick(&s.state, &s.clock, Duration::ZERO)
        .await
        .failed
        .is_empty());
    assert_eq!(s.imp.calls.load(Ordering::SeqCst), 1);
    s.clock.advance(ChronoDuration::minutes(11));
    assert_eq!(
        schedule::tick(&s.state, &s.clock, Duration::ZERO)
            .await
            .failed,
        vec!["a"]
    );
    assert_eq!(schedule::memory(&s.state).get("a").unwrap().failures, 2);

    // The second failure waits an hour.
    s.clock.advance(ChronoDuration::minutes(50));
    assert!(schedule::tick(&s.state, &s.clock, Duration::ZERO)
        .await
        .failed
        .is_empty());
    s.clock.advance(ChronoDuration::minutes(11));
    *s.imp.mode.lock() = Mode::Ok;
    assert_eq!(
        schedule::tick(&s.state, &s.clock, Duration::ZERO)
            .await
            .refreshed,
        vec!["a"]
    );
    // Success clears the error, its time and the backoff.
    let src = sources::get(&s.state, "a").await.unwrap();
    assert!(src.last_error.is_none() && src.last_error_at.is_none());
    assert!(schedule::memory(&s.state).get("a").is_none());
}

#[tokio::test]
async fn skips_a_source_whose_import_lock_is_held() {
    let s = setup().await;
    source(&s.state, "a", true, None).await;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
    let st = s.state.clone();
    let holder = tokio::spawn(async move {
        sources::run_import_with(&st, "a", async move {
            let _ = started_tx.send(());
            let _ = rx.await;
        })
        .await;
    });
    started_rx.await.unwrap();

    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r.busy, vec!["a"]);
    assert_eq!(s.imp.calls.load(Ordering::SeqCst), 0);
    // try_run_import never queues behind the lock either.
    assert!(sources::try_run_import(s.state.clone(), "a")
        .await
        .is_none());

    tx.send(()).unwrap();
    holder.await.unwrap();
    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r.refreshed, vec!["a"]);
}

#[tokio::test]
async fn a_cancelled_scheduled_refresh_is_not_a_failure() {
    let s = setup().await;
    *s.imp.mode.lock() = Mode::WaitForCancel;
    source(&s.state, "a", true, Some(ChronoDuration::days(1))).await;

    let st = s.state.clone();
    let clock = Arc::new(FixedClock::new());
    let c2 = clock.clone();
    let pass = tokio::spawn(async move { schedule::tick(&st, c2.as_ref(), Duration::ZERO).await });
    // Wait (briefly) for the run to start, then cancel it like the UI does.
    for _ in 0..200 {
        if sources::is_import_running(&s.state, "a") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(sources::cancel_import(&s.state, "a"));
    let r = pass.await.unwrap();
    assert_eq!(r.cancelled, vec!["a"]);
    assert!(r.failed.is_empty());

    let src = sources::get(&s.state, "a").await.unwrap();
    assert!(src.last_error.is_none(), "a cancel records no error");
    let mem = schedule::memory(&s.state)
        .get("a")
        .map(|a| a.clone())
        .unwrap();
    assert_eq!(mem.failures, 0);
    // It waits a full interval before the next try.
    assert_eq!(
        mem.retry_after,
        Some(clock.now() + ChronoDuration::hours(12))
    );
    clock.advance(ChronoDuration::hours(11));
    *s.imp.mode.lock() = Mode::Ok;
    assert!(schedule::tick(&s.state, clock.as_ref(), Duration::ZERO)
        .await
        .refreshed
        .is_empty());
    clock.advance(ChronoDuration::hours(1));
    assert_eq!(
        schedule::tick(&s.state, clock.as_ref(), Duration::ZERO)
            .await
            .refreshed,
        vec!["a"]
    );
}

#[tokio::test]
async fn schedule_view_reports_next_refresh() {
    let s = setup().await;
    set_interval(&s.state, 6).await;
    source(&s.state, "a", true, Some(ChronoDuration::hours(1))).await;
    source(&s.state, "b", false, Some(ChronoDuration::hours(1))).await;
    let view = sources::schedule::view(&s.state).await.unwrap();
    assert_eq!(view.interval_hours, 6);
    assert_eq!(view.sources.len(), 1, "auto-refresh sources only");
    let e = &view.sources[0];
    assert_eq!(e.source_id, "a");
    assert!(!e.retrying);
    let at = DateTime::parse_from_rfc3339(&e.next_refresh_at)
        .unwrap()
        .with_timezone(&Utc);
    let in_h = (at - Utc::now()).num_minutes();
    assert!((295..=300).contains(&in_h), "{in_h} min");
}

#[tokio::test]
async fn settings_reject_out_of_range_values() {
    let s = setup().await;
    for patch in [
        serde_json::json!({ "sourceRefreshIntervalHours": 169 }),
        serde_json::json!({ "accountExpiryWarnDays": 61 }),
        serde_json::json!({ "accountExpiryWarnDays": -1 }),
    ] {
        assert!(
            iptv_core::settings::update(&s.state, patch.clone())
                .await
                .is_err(),
            "{patch}"
        );
    }
    let ok = iptv_core::settings::update(
        &s.state,
        serde_json::json!({ "sourceRefreshIntervalHours": 48, "accountExpiryWarnDays": 0 }),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            ok.source_refresh_interval_hours,
            ok.account_expiry_warn_days
        ),
        (48, 0)
    );
}

#[tokio::test]
async fn refresh_settings_survive_a_backup_round_trip() {
    let a = env().await;
    iptv_core::settings::update(
        &a.state,
        serde_json::json!({ "sourceRefreshIntervalHours": 24, "accountExpiryWarnDays": 14 }),
    )
    .await
    .unwrap();
    let mut r = iptv_core::rpc::RpcRouter::new();
    iptv_core::backup::rpc::register(&mut r);
    let out = r
        .dispatch(
            a.state.clone(),
            "backup.export",
            serde_json::json!({ "includeSecrets": false }),
        )
        .await
        .unwrap();
    let json = out["json"].as_str().unwrap().to_string();
    let manifest: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(manifest["settings"]["sourceRefreshIntervalHours"], 24);
    assert_eq!(manifest["settings"]["accountExpiryWarnDays"], 14);

    let b = env().await;
    r.dispatch(
        b.state.clone(),
        "backup.import",
        serde_json::json!({ "json": json, "mode": "merge" }),
    )
    .await
    .unwrap();
    let s = b.state.settings_snapshot();
    assert_eq!(
        (s.source_refresh_interval_hours, s.account_expiry_warn_days),
        (24, 14)
    );
}

/// `sources.changed` events waiting in `events`.
fn changed_events(events: &mut tokio::sync::broadcast::Receiver<iptv_core::AppEvent>) -> usize {
    let mut n = 0;
    while let Ok(ev) = events.try_recv() {
        if ev.kind == "sources.changed" {
            n += 1;
        }
    }
    n
}

#[tokio::test]
async fn the_schedule_is_announced_again_after_the_backoff_is_stored() {
    let mut s = setup().await;
    *s.imp.mode.lock() = Mode::Fail;
    source(&s.state, "a", true, Some(ChronoDuration::days(2))).await;
    source(&s.state, "b", false, None).await;
    changed_events(&mut s._env.events);
    // What the import alone announces.
    let _ = sources::try_run_import(s.state.clone(), "b").await;
    let by_import = changed_events(&mut s._env.events);
    assert!(by_import > 0);

    let r = schedule::tick(&s.state, &s.clock, Duration::ZERO).await;
    assert_eq!(r.failed, vec!["a"]);
    assert_eq!(
        changed_events(&mut s._env.events),
        by_import + 1,
        "one more sources.changed once the retry time is stored"
    );
    assert!(schedule::memory(&s.state)
        .get("a")
        .unwrap()
        .retry_after
        .is_some());
}

#[tokio::test]
async fn a_catchup_only_edit_keeps_a_running_refresh() {
    let s = setup().await;
    *s.imp.mode.lock() = Mode::WaitForCancel;
    source(&s.state, "a", true, None).await;
    let st = s.state.clone();
    let run = tokio::spawn(async move { sources::run_import(st, "a").await });
    for _ in 0..200 {
        if sources::is_import_running(&s.state, "a") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(sources::is_import_running(&s.state, "a"));

    let mut m3u = serde_json::to_value(sources::get(&s.state, "a").await.unwrap().m3u).unwrap();
    m3u["catchup"] = serde_json::json!({"type": "none"});
    let patch: sources::SourcePatch =
        serde_json::from_value(serde_json::json!({ "m3u": m3u })).unwrap();
    let updated = sources::update(&s.state, "a", patch).await.unwrap();
    assert_eq!(updated.m3u.unwrap().catchup.unwrap().kind, "none");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        sources::is_import_running(&s.state, "a"),
        "the catch-up override needs no re-import, so the refresh carries on"
    );

    // A new URL still stops it.
    m3u["url"] = serde_json::json!("http://127.0.0.1:9/other.m3u");
    let patch: sources::SourcePatch =
        serde_json::from_value(serde_json::json!({ "m3u": m3u })).unwrap();
    sources::update(&s.state, "a", patch).await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .expect("the import stops")
        .unwrap();
    assert!(res.is_err());
}
