//! B9 (C8): `sources.cancelImport` stops a running import or refresh, emits
//! `import.progress` `phase: "cancelled"`, records no `lastError`, and leaves
//! the previous catalog intact; the next refresh works normally.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::{self, CategoryRow, ItemRow};
use iptv_core::error::RpcErrorCode;
use iptv_core::model::{ContentType, ImportSummary, Source, SourceKind, XtreamSourceConfig};
use iptv_core::sources::{self, store, store::SourceConfig, Importer};
use iptv_core::{AppEvent, AppState, CoreError, CoreResult};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A playlist server that answers `body` at once, or (when `slow`) sends the
/// head and then drips one byte every 300 ms forever.
struct Toggle {
    url: String,
    slow: Arc<AtomicBool>,
    hits: Arc<AtomicU32>,
}

async fn toggle_server(body: String) -> Toggle {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let slow = Arc::new(AtomicBool::new(false));
    let hits = Arc::new(AtomicU32::new(0));
    let (s2, h2) = (slow.clone(), hits.clone());
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let slow = s2.load(Ordering::SeqCst);
            h2.fetch_add(1, Ordering::SeqCst);
            let body = body.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                if slow {
                    let _ = s
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/x-mpegurl\r\nContent-Length: 100000000\r\n\r\n#EXTM3U\n")
                        .await;
                    loop {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        if s.write_all(b"#").await.is_err() {
                            break;
                        }
                    }
                } else {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: audio/x-mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = s.write_all(head.as_bytes()).await;
                    let _ = s.write_all(body.as_bytes()).await;
                    let _ = s.shutdown().await;
                }
            });
        }
    });
    Toggle {
        url: format!("http://{addr}/list.m3u"),
        slow,
        hits,
    }
}

fn phases(events: &[AppEvent], id: &str) -> Vec<String> {
    events
        .iter()
        .filter(|e| e.kind == "import.progress" && e.payload["sourceId"] == id)
        .map(|e| e.payload["phase"].as_str().unwrap_or_default().to_string())
        .collect()
}

async fn channel_count(state: &AppState, id: &str) -> i64 {
    sources::get(state, id).await.unwrap().channel_count
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_import_is_false_when_nothing_runs() {
    let env = env().await;
    let r = router();
    let v = r
        .dispatch(
            env.state.clone(),
            "sources.cancelImport",
            json!({ "id": "nope" }),
        )
        .await
        .unwrap();
    assert_eq!(v, json!(false));
    // Missing id is an invalid call, not a panic.
    let e = r
        .dispatch(env.state.clone(), "sources.cancelImport", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Invalid);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_a_refresh_mid_download_keeps_the_previous_catalog() {
    let mut env = env().await;
    let srv = toggle_server(gen_m3u(25, 3)).await;
    let src = sources::add(env.state.clone(), url_args(&srv.url, false))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, 25);
    drain(&mut env.events);

    srv.slow.store(true, Ordering::SeqCst);
    let st = env.state.clone();
    let id = src.id.clone();
    let refresh = tokio::spawn(async move { sources::refresh(st, &id).await });
    let deadline = Instant::now() + Duration::from_secs(10);
    while srv.hits.load(Ordering::SeqCst) < 2 || !sources::is_import_running(&env.state, &src.id) {
        assert!(Instant::now() < deadline, "the refresh never started");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    let started = Instant::now();
    let v = router()
        .dispatch(
            env.state.clone(),
            "sources.cancelImport",
            json!({ "id": src.id }),
        )
        .await
        .unwrap();
    assert_eq!(v, json!(true));
    let err = tokio::time::timeout(Duration::from_secs(5), refresh)
        .await
        .expect("the refresh kept running after cancelImport")
        .unwrap()
        .expect_err("a cancelled refresh fails");
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(sources::is_cancelled_error(&err), "{err:?}");
    assert!(err.to_string().contains("import stopped"), "{err}");
    assert!(err.to_string().contains("cancelled by user"), "{err}");
    assert!(!err.to_string().contains("removed"), "{err}");
    let rpc = sources::cancel_aware_rpc_error(err);
    assert_eq!(rpc.details.as_ref().unwrap()["cancelled"], true);

    let after = sources::get(&env.state, &src.id).await.unwrap();
    assert_eq!(after.channel_count, 25, "previous catalog intact");
    assert_eq!(after.last_error, None, "a cancel is not an error");
    assert_eq!(after.last_error_code, None);
    let evs = drain(&mut env.events);
    let ph = phases(&evs, &src.id);
    assert_eq!(ph.last().map(String::as_str), Some("cancelled"), "{ph:?}");
    assert!(!ph.iter().any(|p| p == "error"), "{ph:?}");
    assert!(!sources::is_import_running(&env.state, &src.id));

    // Nothing left cancelled: the next refresh imports normally.
    srv.slow.store(false, Ordering::SeqCst);
    let again = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(again.channel_count, 25);
    // Cancelling after the run ended is a no-op.
    assert!(!sources::cancel_import(&env.state, &src.id));
}

// ---------------------------------------------------------------------------
// Fake importers (save-phase cancel, stuck importer)
// ---------------------------------------------------------------------------

fn rows(source: &str, n: usize, prefix: &str) -> Vec<ItemRow> {
    (0..n)
        .map(|i| ItemRow {
            source_id: source.to_string(),
            content_type: ContentType::Live,
            item_id: format!("{prefix}{i}"),
            category_id: "g".into(),
            title: format!("{prefix} channel {i}"),
            url: Some(format!("http://stream.example/{prefix}/{i}.ts")),
            position: i as i64,
            ..ItemRow::default()
        })
        .collect()
}

fn cats() -> Vec<CategoryRow> {
    vec![CategoryRow {
        category_id: "g".into(),
        name: "G".into(),
        position: 0,
    }]
}

/// Writes 5000 new rows; cancels its own run after 1500 (as if the user
/// pressed Cancel during "saving").
struct CancelsWhileSaving;

#[async_trait::async_trait]
impl Importer for CancelsWhileSaving {
    fn kind(&self) -> SourceKind {
        SourceKind::Xtream
    }
    async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary> {
        let id = source.id.clone();
        let st = state.clone();
        let n = state
            .db_call(move |c| {
                let mut it = rows(&id, 5000, "new")
                    .into_iter()
                    .enumerate()
                    .map(|(i, r)| {
                        if i == 1500 {
                            assert!(sources::cancel_import(&st, &id));
                        }
                        r
                    });
                catalog::replace_catalog(c, &id, ContentType::Live, &cats(), &mut it)
            })
            .await?;
        Ok(ImportSummary {
            channels: n as i64,
            movies: 0,
            series: 0,
        })
    }
}

/// Never finishes and ignores the cancel token.
struct Stuck;

#[async_trait::async_trait]
impl Importer for Stuck {
    fn kind(&self) -> SourceKind {
        SourceKind::Xtream
    }
    async fn import(&self, _state: Arc<AppState>, _source: &Source) -> CoreResult<ImportSummary> {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        Err(CoreError::invalid("unreachable"))
    }
}

async fn xtream_source(state: &AppState, id: &str, with_rows: usize) {
    let id = id.to_string();
    state
        .db_call(move |c| {
            let cfg = SourceConfig::Xtream(XtreamSourceConfig {
                server_url: "http://127.0.0.1:9".into(),
                username: "u".into(),
                password: "p".into(),
            });
            store::insert(c, &id, "X", true, &cfg, None)?;
            let mut it = rows(&id, with_rows, "old").into_iter();
            catalog::replace_catalog(c, &id, ContentType::Live, &cats(), &mut it)?;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_during_save_rolls_the_catalog_back() {
    let mut env = env().await;
    sources::register_importer(&env.state, Arc::new(CancelsWhileSaving));
    let id = format!("b9-save-{}", uuid::Uuid::new_v4());
    xtream_source(&env.state, &id, 40).await;
    assert_eq!(channel_count(&env.state, &id).await, 40);
    drain(&mut env.events);

    let err = sources::refresh(env.state.clone(), &id)
        .await
        .expect_err("cancelled while saving");
    assert!(sources::is_cancelled_error(&err), "{err:?}");
    // Every old row is still there and no new row was committed.
    let titles: Vec<String> = env
        .state
        .db_call({
            let id = id.clone();
            move |c| {
                let mut st = c.prepare("SELECT item_id FROM items WHERE source_id = ?1")?;
                let v = st
                    .query_map([&id], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            }
        })
        .await
        .unwrap();
    assert_eq!(titles.len(), 40);
    assert!(titles.iter().all(|t| t.starts_with("old")));
    assert_eq!(channel_count(&env.state, &id).await, 40);
    let ph = phases(&drain(&mut env.events), &id);
    assert_eq!(ph.last().map(String::as_str), Some("cancelled"), "{ph:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_importer_that_ignores_the_cancel_is_dropped_after_the_grace() {
    let mut env = env().await;
    sources::register_importer(&env.state, Arc::new(Stuck));
    let id = format!("b9-stuck-{}", uuid::Uuid::new_v4());
    xtream_source(&env.state, &id, 3).await;
    let st = env.state.clone();
    let id2 = id.clone();
    let run = tokio::spawn(async move { sources::refresh(st, &id2).await });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !sources::is_import_running(&env.state, &id) {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let started = Instant::now();
    assert!(sources::cancel_import(&env.state, &id));
    // A second cancel while it is stopping still reports "cancelling".
    assert!(sources::cancel_import(&env.state, &id));
    let err = tokio::time::timeout(sources::CANCEL_GRACE + Duration::from_secs(3), run)
        .await
        .expect("the stuck import was not dropped")
        .unwrap()
        .unwrap_err();
    let took = started.elapsed();
    assert!(took >= sources::CANCEL_GRACE, "{took:?}");
    assert!(sources::is_cancelled_error(&err));
    assert_eq!(channel_count(&env.state, &id).await, 3);
    assert!(phases(&drain(&mut env.events), &id).contains(&"cancelled".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refresh_all_does_not_report_a_cancelled_source_as_failed() {
    let env = env().await;
    sources::register_importer(&env.state, Arc::new(Stuck));
    let id = format!("b9-all-{}", uuid::Uuid::new_v4());
    xtream_source(&env.state, &id, 1).await;
    let st = env.state.clone();
    let all = tokio::spawn(async move { sources::refresh_all(st).await });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !sources::is_import_running(&env.state, &id) {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(sources::cancel_import(&env.state, &id));
    let out = tokio::time::timeout(Duration::from_secs(10), all)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert!(out.refreshed.is_empty());
}

/// C8 ruling: a cancelled `sources.add` rejects with `conflict`, a message
/// saying the import stopped, and `details.sourceId` so the UI can delete
/// the orphan source.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_an_add_rejects_with_conflict_and_the_source_id() {
    let mut env = env().await;
    let srv = toggle_server(gen_m3u(5, 1)).await;
    srv.slow.store(true, Ordering::SeqCst);
    let r = router();
    let st = env.state.clone();
    let url = srv.url.clone();
    let add = tokio::spawn(async move {
        router()
            .dispatch(
                st,
                "sources.add",
                json!({ "kind": "m3u", "name": "", "m3u": { "origin": "url", "url": url } }),
            )
            .await
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let id = loop {
        assert!(Instant::now() < deadline, "the add never started");
        let listed = sources::list(&env.state).await.unwrap();
        if let Some(s) = listed.first() {
            if sources::is_import_running(&env.state, &s.id) && srv.hits.load(Ordering::SeqCst) > 0
            {
                break s.id.clone();
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let v = r
        .dispatch(
            env.state.clone(),
            "sources.cancelImport",
            json!({ "id": id }),
        )
        .await
        .unwrap();
    assert_eq!(v, json!(true));
    let err = tokio::time::timeout(Duration::from_secs(5), add)
        .await
        .expect("the add kept running after cancelImport")
        .unwrap()
        .expect_err("a cancelled add rejects");
    assert_eq!(err.code, RpcErrorCode::Conflict, "{err:?}");
    assert!(err.message.contains("import stopped"), "{err:?}");
    assert!(err.message.contains("cancelled by user"), "{err:?}");
    let details = err.details.as_ref().expect("details");
    assert_eq!(details["sourceId"], id.as_str());
    assert_eq!(details["cancelled"], true);
    let ph = phases(&drain(&mut env.events), &id);
    assert_eq!(ph.last().map(String::as_str), Some("cancelled"), "{ph:?}");
    let src = sources::get(&env.state, &id).await.unwrap();
    assert_eq!(src.last_error, None);
}

/// Two app states (tests, server next to desktop) with the same source id:
/// cancelling one run must not reach the other run's catalog writer. B
/// starts first, so a process-wide "newest token for this id" lookup would
/// hand B's writer A's cancelled token.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn writer_cancel_tokens_are_per_database() {
    let a = env().await;
    let b = env().await;
    bare_source(&a.state, "same-id").await;
    bare_source(&b.state, "same-id").await;
    let (b_started_tx, b_started) = tokio::sync::oneshot::channel::<()>();
    let (b_check_tx, b_check) = tokio::sync::oneshot::channel::<()>();
    let sb = b.state.clone();
    let run_b = tokio::spawn(async move {
        sources::run_import_with(&sb, "same-id", async {
            let _ = b_started_tx.send(());
            let _ = b_check.await;
            sb.db_call(|c| Ok(sources::writer_cancel_token(c, "same-id")))
                .await
                .unwrap()
        })
        .await
    });
    b_started.await.unwrap();
    let (a_started_tx, a_started) = tokio::sync::oneshot::channel::<()>();
    let sa = a.state.clone();
    let run_a = tokio::spawn(async move {
        sources::run_import_with(&sa, "same-id", async {
            let _ = a_started_tx.send(());
            tokio::time::sleep(Duration::from_secs(30)).await;
        })
        .await
    });
    a_started.await.unwrap();
    assert!(sources::cancel_import(&a.state, "same-id"));
    b_check_tx.send(()).unwrap();
    let token = run_b
        .await
        .unwrap()
        .expect("b's writer finds its own token");
    assert!(!token.is_cancelled(), "a's cancel reached b's writer");
    let _ = tokio::time::timeout(Duration::from_secs(5), run_a).await;
}

/// A settings change (not the user) stopping a refresh keeps the
/// removed-or-changed wording; a user cancel says so plainly. Both say
/// "import stopped", and the cancelled progress carries the same message.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_messages_name_the_cause() {
    let mut env = env().await;
    let srv = toggle_server(gen_m3u(5, 1)).await;
    let src = sources::add(env.state.clone(), url_args(&srv.url, false))
        .await
        .map_err(|e| e.error)
        .unwrap();
    srv.slow.store(true, Ordering::SeqCst);
    drain(&mut env.events);

    let st = env.state.clone();
    let id = src.id.clone();
    let refresh = tokio::spawn(async move { sources::refresh(st, &id).await });
    let deadline = Instant::now() + Duration::from_secs(10);
    while srv.hits.load(Ordering::SeqCst) < 2 || !sources::is_import_running(&env.state, &src.id) {
        assert!(Instant::now() < deadline, "the refresh never started");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let other = format!("{}?changed=1", srv.url);
    router()
        .dispatch(
            env.state.clone(),
            "sources.update",
            json!({ "id": src.id, "patch": { "m3u": { "origin": "url", "url": other } } }),
        )
        .await
        .unwrap();
    let err = tokio::time::timeout(Duration::from_secs(5), refresh)
        .await
        .expect("the refresh kept running after the settings change")
        .unwrap()
        .expect_err("a changed source stops the refresh");
    let msg = err.to_string();
    assert!(msg.contains("import stopped"), "{msg}");
    assert!(msg.contains("removed or its settings changed"), "{msg}");
    assert!(!msg.contains("cancelled by user"), "{msg}");
    let evs = drain(&mut env.events);
    let cancelled = evs
        .iter()
        .rfind(|e| e.kind == "import.progress" && e.payload["phase"] == "cancelled")
        .expect("cancelled progress");
    assert!(
        cancelled.payload["message"]
            .as_str()
            .unwrap_or_default()
            .contains("settings changed"),
        "{}",
        cancelled.payload
    );
}

/// Review round 1: a capped body read (Xtream/Stalker/TMDB JSON) stops as
/// soon as its import run is cancelled, not after [`sources::CANCEL_GRACE`].
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_stops_a_trickling_capped_body_read_at_once() {
    let env = env().await;
    bare_source(&env.state, "trickle").await;
    let srv = toggle_server(String::new()).await;
    srv.slow.store(true, Ordering::SeqCst);
    let (st, url) = (env.state.clone(), srv.url.clone());
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let run = tokio::spawn(async move {
        sources::run_import_with(&st, "trickle", async {
            let resp = reqwest::get(&url).await.map_err(CoreError::from)?;
            let _ = tx.send(());
            iptv_core::http::read_capped(resp, "Xtream get_vod_streams", 512 << 20)
                .await
                .map(|_| ())
        })
        .await
    });
    rx.await.unwrap();
    let started = Instant::now();
    assert!(sources::cancel_import(&env.state, "trickle"));
    let out = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .expect("the run stopped")
        .unwrap();
    assert!(sources::is_cancelled_error(&out.unwrap_err()));
    assert!(
        started.elapsed() < sources::CANCEL_GRACE,
        "the body read ignored the cancel ({:?})",
        started.elapsed()
    );
}

/// Review round 1: a partial sync (`xtream.sync` with `contentTypes`) that
/// ignores the cancel is dropped after the grace period, rejects as a user
/// cancel, and frees the source for the next refresh.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_import_with_drops_a_run_that_ignores_cancel() {
    let mut env = env().await;
    bare_source(&env.state, "stuck").await;
    let st = env.state.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let run = tokio::spawn(async move {
        sources::run_import_with(&st, "stuck", async {
            let _ = tx.send(());
            std::future::pending::<CoreResult<()>>().await
        })
        .await
    });
    rx.await.unwrap();
    assert!(sources::cancel_import(&env.state, "stuck"));
    let out = tokio::time::timeout(sources::CANCEL_GRACE * 4, run)
        .await
        .expect("a cancelled run that ignores the token is dropped")
        .unwrap();
    let err = out.unwrap_err();
    assert!(sources::is_cancelled_error(&err), "{err:?}");
    assert!(err.to_string().contains("cancelled by user"), "{err}");
    let ph = phases(&drain(&mut env.events), "stuck");
    assert_eq!(ph.last().map(String::as_str), Some("cancelled"), "{ph:?}");
    // The per-source lock is free again.
    let next = tokio::time::timeout(
        Duration::from_secs(5),
        sources::run_import_with(&env.state, "stuck", async { Ok::<_, CoreError>(7) }),
    )
    .await
    .expect("the next run is not blocked");
    assert_eq!(next.unwrap(), 7);
}

/// Review round 1: the whole-request deadline of a metadata request also
/// bounds `read_capped`'s body reads; a trickling answer fails with Timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_deadline_bounds_the_capped_body_read() {
    let srv = toggle_server(String::new()).await;
    srv.slow.store(true, Ordering::SeqCst);
    let started = Instant::now();
    let resp = reqwest::Client::new()
        .get(&srv.url)
        .timeout(Duration::from_millis(800))
        .send()
        .await
        .unwrap();
    let err = iptv_core::http::read_capped(resp, "Xtream get_vod_streams", 512 << 20)
        .await
        .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(err.code(), RpcErrorCode::Timeout, "{err:?}");
    assert!(
        err.to_string()
            .contains("Xtream get_vod_streams: the server took too long"),
        "{err}"
    );
}

/// Review round 2: an error raised inside a user-cancelled run (the HTTP
/// helpers only see the token) names the user cancel, not "removed or its
/// settings changed".
#[tokio::test]
async fn errors_inside_a_user_cancelled_run_name_the_user_cancel() {
    let env = env().await;
    bare_source(&env.state, "dl").await;
    let st = env.state.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let run = tokio::spawn(async move {
        sources::run_import_with(&st, "dl", async {
            let _ = tx.send(());
            iptv_core::http::cancellable(std::future::pending::<()>()).await
        })
        .await
    });
    rx.await.unwrap();
    assert!(sources::cancel_import(&env.state, "dl"));
    let err = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(sources::is_cancelled_error(&err), "{err:?}");
    assert!(err.to_string().contains("cancelled by user"), "{err}");
    assert!(!err.to_string().contains("removed"), "{err}");
    // Outside a run the generic cause stays.
    assert!(sources::import_cancelled_error()
        .to_string()
        .contains("removed or its settings changed"));
}

/// Review round 2: like `run_import`, `run_import_with` does not start a
/// run queued behind one that a remove cancelled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_import_with_skips_a_run_queued_behind_a_remove() {
    let env = env().await;
    bare_source(&env.state, "gone").await;
    let st = env.state.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let first = tokio::spawn(async move {
        sources::run_import_with(&st, "gone", async {
            let _ = tx.send(());
            iptv_core::http::cancellable(std::future::pending::<()>()).await
        })
        .await
    });
    rx.await.unwrap();
    let ran = Arc::new(AtomicBool::new(false));
    let (st, ran2) = (env.state.clone(), ran.clone());
    let queued = tokio::spawn(async move {
        sources::run_import_with(&st, "gone", async move {
            ran2.store(true, Ordering::SeqCst);
            Ok::<_, CoreError>(())
        })
        .await
    });
    // Let the queued run wait on the per-source lock before the remove.
    tokio::time::sleep(Duration::from_millis(200)).await;
    sources::remove(&env.state, "gone").await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), queued)
        .await
        .unwrap()
        .unwrap();
    assert!(!ran.load(Ordering::SeqCst), "the queued run must not start");
    let err = out.unwrap_err();
    assert!(sources::is_cancelled_error(&err), "{err:?}");
}
