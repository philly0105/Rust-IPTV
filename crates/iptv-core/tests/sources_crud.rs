//! Sources (B1): CRUD, reorder, validation, lastError, unsupported kinds,
//! refreshAll, counts, cascade on remove, startup init, joined refreshes.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::model::{ImportSummary, Source, SourceKind};
use iptv_core::sources::{self, Importer};
use iptv_core::{AppState, CoreResult, RpcErrorCode};
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use support::*;

const ONE: &str = "#EXTM3U\n#EXTINF:-1 group-title=\"G\",One\nhttp://h/1\n";
const TWO: &str = "#EXTM3U\n#EXTINF:-1 group-title=\"G\",One\nhttp://h/1\n#EXTINF:-1 group-title=\"G\",Two\nhttp://h/2\n";

#[tokio::test]
async fn add_list_get_update_reorder_remove_via_rpc() {
    let env = env().await;
    let r = router();
    let st = env.state.clone();
    let a = r
        .dispatch(
            st.clone(),
            "sources.add",
            json!({"kind": "m3u", "name": "A", "m3u": {"origin": "text", "text": ONE}}),
        )
        .await
        .unwrap();
    let b = r
        .dispatch(
            st.clone(),
            "sources.add",
            json!({"kind": "m3u", "name": "  ", "m3u": {"origin": "text", "text": TWO}}),
        )
        .await
        .unwrap();
    let c = r
        .dispatch(
            st.clone(),
            "sources.add",
            json!({"kind": "m3u", "name": "C", "m3u": {"origin": "text", "text": ONE}}),
        )
        .await
        .unwrap();
    assert_eq!(b["name"], "Pasted playlist");
    assert_eq!(b["channelCount"], 2);
    let (a, b, c) = (
        a["id"].as_str().unwrap(),
        b["id"].as_str().unwrap(),
        c["id"].as_str().unwrap(),
    );

    let list = r
        .dispatch(st.clone(), "sources.list", json!(null))
        .await
        .unwrap();
    let ids: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![a, b, c]);
    assert_eq!(list[1]["channelCount"], 2);

    r.dispatch(
        st.clone(),
        "sources.reorder",
        json!({"ids": [c, "unknown", a]}),
    )
    .await
    .unwrap();
    let list = sources::list(&st).await.unwrap();
    assert_eq!(
        list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        vec![c, a, b]
    );
    assert_eq!(
        list.iter().map(|s| s.position).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );

    let upd = r
        .dispatch(
            st.clone(),
            "sources.update",
            json!({"id": a, "patch": {"name": "Renamed", "autoRefresh": true, "position": 0,
                    "epg": {"manualUrls": [" http://e/x.xml ", "http://e/x.xml", ""]}}}),
        )
        .await
        .unwrap();
    assert_eq!(upd["name"], "Renamed");
    assert_eq!(upd["autoRefresh"], true);
    assert_eq!(upd["position"], 0);
    assert_eq!(upd["epg"]["manualUrls"], json!(["http://e/x.xml"]));
    assert!(upd["updatedAt"].is_string());
    let wrong_kind = r
        .dispatch(st.clone(), "sources.update", json!({"id": a, "patch": {"xtream": {"serverUrl": "http://h", "username": "u", "password": "p"}}}))
        .await
        .unwrap_err();
    assert_eq!(wrong_kind.code, RpcErrorCode::Invalid);

    let counts = r
        .dispatch(st.clone(), "sources.counts", json!({"id": b}))
        .await
        .unwrap();
    assert_eq!(
        counts,
        json!({"channelCount": 2, "radioCount": 0, "movieCount": 0, "seriesCount": 0})
    );

    r.dispatch(st.clone(), "sources.remove", json!({"id": b}))
        .await
        .unwrap();
    let leftover: i64 = st
        .db_call({
            let b = b.to_string();
            move |c| Ok(c.query_row("SELECT (SELECT COUNT(*) FROM items WHERE source_id = ?1) + (SELECT COUNT(*) FROM categories WHERE source_id = ?1) + (SELECT COUNT(*) FROM m3u_raw WHERE source_id = ?1) + (SELECT COUNT(*) FROM source_counts WHERE source_id = ?1)", [&b], |r| r.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(leftover, 0, "catalog, raw and counts cascade");
    // DB-2: the search index and the ranking rows went in bulk, the
    // triggers are live again, and the other sources' rows are intact.
    let (rank, suspended, rows): (i64, i64, i64) = st
        .db_call(|c| {
            c.execute(
                "INSERT INTO items_fts(items_fts, rank) VALUES ('integrity-check', 1)",
                [],
            )?;
            Ok(c.query_row(
                "SELECT (SELECT COUNT(*) FROM items_rank), (SELECT COUNT(*) FROM fts_suspend), (SELECT COUNT(*) FROM items)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(suspended, 0);
    assert_eq!(rank, rows, "items_rank holds one row per item left");
    let gone = r
        .dispatch(st.clone(), "sources.get", json!({"id": b}))
        .await
        .unwrap_err();
    assert_eq!(gone.code, RpcErrorCode::NotFound);
    let gone = r
        .dispatch(st.clone(), "sources.remove", json!({"id": b}))
        .await
        .unwrap_err();
    assert_eq!(gone.code, RpcErrorCode::NotFound);
}

#[tokio::test]
async fn validation_errors() {
    let env = env().await;
    let r = router();
    let st = env.state.clone();
    for args in [
        json!({"kind": "m3u", "m3u": {"origin": "url", "url": "not a url"}}),
        json!({"kind": "m3u", "m3u": {"origin": "url", "url": "ftp://h/x.m3u"}}),
        json!({"kind": "m3u", "m3u": {"origin": "text", "text": "   "}}),
        json!({"kind": "m3u"}),
        json!({"kind": "stalker", "stalker": {"portalUrl": "http://p", "macAddress": "nope"}}),
    ] {
        let err = r
            .dispatch(st.clone(), "sources.add", args.clone())
            .await
            .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Invalid, "{args}");
    }
    let err = r
        .dispatch(
            st.clone(),
            "sources.add",
            json!({"kind": "m3u", "m3u": {"origin": "file", "filePath": "Z:/does/not/exist.m3u"}}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
    // No importer registered for xtream in this state.
    let err = r
        .dispatch(st.clone(), "sources.add", json!({"kind": "xtream", "xtream": {"serverUrl": "http://h:8080/", "username": "u", "password": "p"}}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Unsupported);
    assert!(
        sources::list(&st).await.unwrap().is_empty(),
        "nothing inserted on validation errors"
    );
}

struct Counting {
    calls: AtomicU32,
    fail: bool,
}

#[async_trait::async_trait]
impl Importer for Counting {
    fn kind(&self) -> SourceKind {
        SourceKind::Xtream
    }
    async fn import(&self, _state: Arc<AppState>, _source: &Source) -> CoreResult<ImportSummary> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            Err(iptv_core::CoreError::Auth("bad credentials".into()))
        } else {
            Ok(ImportSummary::default())
        }
    }
}

#[tokio::test]
async fn importer_failure_keeps_source_with_last_error() {
    let mut env = env().await;
    let st = env.state.clone();
    sources::register_importer(
        &st,
        Arc::new(Counting {
            calls: AtomicU32::new(0),
            fail: true,
        }),
    );
    let err = router()
        .dispatch(st.clone(), "sources.add", json!({"kind": "xtream", "xtream": {"serverUrl": "http://h:8080/player_api.php", "username": "u", "password": "p"}}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Auth);
    let id = err.details.unwrap()["sourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let src = sources::get(&st, &id).await.unwrap();
    assert_eq!(src.last_error.as_deref(), Some("bad credentials"));
    assert_eq!(src.xtream.unwrap().server_url, "http://h:8080");
    let events = drain(&mut env.events);
    assert!(events
        .iter()
        .any(|e| e.kind == "import.progress" && e.payload["phase"] == "error"));
}

#[tokio::test]
async fn refresh_all_only_auto_refresh_and_reports_failures() {
    let env = env().await;
    let st = env.state.clone();
    let stub = stub(ONE).await;
    let auto = sources::add(st.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let manual = add_text(&st, "manual", ONE).await;
    let broken_stub = support::stub(ONE).await;
    let broken = sources::add(st.clone(), url_args(&broken_stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    broken_stub.set_fail(true);

    let res = router()
        .dispatch(st.clone(), "sources.refreshAll", json!(null))
        .await
        .unwrap();
    assert_eq!(res["refreshed"], json!([auto.id]));
    assert_eq!(res["failed"][0]["id"], broken.id.as_str());
    assert!(res["failed"][0]["error"].as_str().unwrap().len() > 3);
    assert!(sources::get(&st, &manual.id)
        .await
        .unwrap()
        .last_error
        .is_none());
}

/// ST-1: the startup pass waits about 30 s and re-imports only the sources
/// that are due; a source refreshed moments ago is not fetched again.
#[tokio::test]
async fn startup_pass_skips_a_fresh_source() {
    let env = env().await;
    let st = env.state.clone();
    let stub = stub(ONE).await;
    sources::add(st.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let before = stub.hits();
    assert_eq!(
        sources::STARTUP_REFRESH_DELAY,
        std::time::Duration::from_secs(30)
    );
    sources::init(st.clone()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(stub.hits(), before, "nothing before the startup delay");

    // The pass itself, without the delay: the source was refreshed just now.
    let r = sources::schedule::startup(
        &st,
        &sources::schedule::SystemClock,
        std::time::Duration::ZERO,
    )
    .await;
    assert!(r.refreshed.is_empty(), "{r:?}");
    assert_eq!(stub.hits(), before, "a fresh source is not fetched again");
}

/// ST-2: a refresh of a source that is importing waits for that import and
/// returns its result; the source is imported once.
#[tokio::test]
async fn concurrent_refreshes_share_one_import() {
    let mut env = env().await;
    let st = env.state.clone();
    let src = add_text(&st, "T", TWO).await;
    drain(&mut env.events);
    let (a, b) = tokio::join!(
        sources::refresh(st.clone(), &src.id),
        sources::refresh(st.clone(), &src.id)
    );
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(a.unwrap().id, b.unwrap().id);
    assert_eq!(sources::get(&st, &src.id).await.unwrap().channel_count, 2);
    let runs = drain(&mut env.events)
        .into_iter()
        .filter(|e| {
            e.kind == "import.progress"
                && e.payload["sourceId"] == src.id.as_str()
                && e.payload["phase"] == "connecting"
        })
        .count();
    assert_eq!(runs, 1, "the second refresh joined the first import");

    // Once it is over, a refresh imports again.
    sources::refresh(st.clone(), &src.id).await.unwrap();
    let runs = drain(&mut env.events)
        .into_iter()
        .filter(|e| e.kind == "import.progress" && e.payload["phase"] == "connecting")
        .count();
    assert_eq!(runs, 1);
}

/// ST-2: one import decodes and saves at a time; the next waits for the slot.
#[tokio::test]
async fn one_import_saves_at_a_time() {
    let env = env().await;
    let first = sources::save_slot(&env.state).await.unwrap();
    let waiting = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        sources::save_slot(&env.state),
    )
    .await;
    assert!(waiting.is_err(), "a second import waits for the slot");
    drop(first);
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        sources::save_slot(&env.state),
    )
    .await
    .expect("the slot is free again")
    .unwrap();
}
