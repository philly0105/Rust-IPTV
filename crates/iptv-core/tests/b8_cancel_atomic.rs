//! B8 (B9-D38, C8, C10): an Xtream refresh cancelled between content types
//! keeps the OLD catalog of every type (no partial result), records no
//! error, and rejects with `details: {sourceId, cancelled: true}`. A failed
//! subset sync records its error with the C10 code.
//!
//! Uses the embedded stub's `slow` user, whose `get_vod_streams` answer is
//! delayed: live is fetched (and used to be committed) before the cancel.

use iptv_core::catalog::{self, CategoryRow, ItemRow};
use iptv_core::error::RpcErrorCode;
use iptv_core::model::ContentType;
use iptv_core::rpc::RpcRouter;
use iptv_core::{sources, AppEvent, AppState};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

#[path = "xtream_stub.rs"]
mod stub;

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    iptv_core::sources::rpc::register(&mut r);
    r
}

fn phases(events: &[AppEvent], id: &str) -> Vec<String> {
    events
        .iter()
        .filter(|e| e.kind == "import.progress" && e.payload["sourceId"] == id)
        .map(|e| e.payload["phase"].as_str().unwrap_or_default().to_string())
        .collect()
}

/// Item ids of one content type of a source.
async fn ids(state: &AppState, id: &str, ct: ContentType) -> Vec<String> {
    let id = id.to_string();
    state
        .db_call(move |c| {
            let mut st = c.prepare(
                "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = ?2 ORDER BY item_id",
            )?;
            let v = st
                .query_map(rusqlite::params![id, ct.as_str()], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .await
        .unwrap()
}

/// Replaces the live catalog with 7 marker rows `old0..old6`.
async fn mark_live(state: &AppState, id: &str) {
    let id = id.to_string();
    state
        .db_call(move |c| {
            let cats = vec![CategoryRow {
                category_id: "g".into(),
                name: "G".into(),
                position: 0,
            }];
            let mut rows = (0..7).map(|i| ItemRow {
                source_id: id.clone(),
                content_type: ContentType::Live,
                item_id: format!("old{i}"),
                category_id: "g".into(),
                title: format!("old {i}"),
                position: i,
                ..ItemRow::default()
            });
            catalog::replace_catalog(c, &id, ContentType::Live, &cats, &mut rows)?;
            Ok(())
        })
        .await
        .unwrap();
}

/// A synced `slow` source whose live catalog is the 7 marker rows.
async fn synced_source(state: &Arc<AppState>, server_url: &str) -> (String, usize) {
    let sid = stub::add_source(state, server_url, "slow", stub::PASS).await;
    router()
        .dispatch(state.clone(), "xtream.sync", json!({ "sourceId": sid }))
        .await
        .expect("first sync");
    let movies = ids(state, &sid, ContentType::Movie).await.len();
    assert!(movies > 0);
    mark_live(state, &sid).await;
    (sid, movies)
}

/// Waits until the run for `id` starts fetching movies (live is done), then
/// cancels it like `sources.cancelImport`. Returns every event seen.
async fn cancel_at_movies(
    state: &AppState,
    rx: &mut tokio::sync::broadcast::Receiver<AppEvent>,
    id: &str,
) -> Vec<AppEvent> {
    let mut seen = Vec::new();
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("the run reached the movies fetch")
            .unwrap();
        let at_movies = ev.kind == "import.progress"
            && ev.payload["sourceId"] == id
            && ev.payload["phase"] == "fetching"
            && ev.payload["message"] == "movies";
        seen.push(ev);
        if at_movies {
            break;
        }
    }
    assert!(sources::cancel_import(state, id), "the run was active");
    seen
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<AppEvent>, into: &mut Vec<AppEvent>) {
    while let Ok(ev) = rx.try_recv() {
        into.push(ev);
    }
}

fn old_live() -> Vec<String> {
    (0..7).map(|i| format!("old{i}")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_refresh_cancelled_between_types_keeps_the_old_catalog() {
    let srv = stub::stub().await;
    let (_dir, state, mut rx) = stub::state().await;
    let (sid, movies) = synced_source(&state, &srv.server_url).await;
    while rx.try_recv().is_ok() {}

    let run = {
        let (state, sid) = (state.clone(), sid.clone());
        tokio::spawn(async move {
            router()
                .dispatch(state, "xtream.sync", json!({ "sourceId": sid }))
                .await
        })
    };
    let mut events = cancel_at_movies(&state, &mut rx, &sid).await;
    let err = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .expect("the cancelled run ended")
        .unwrap()
        .expect_err("a cancelled sync rejects");
    assert_eq!(err.code, RpcErrorCode::Conflict, "{err:?}");
    assert!(err.message.contains("cancelled"), "{}", err.message);
    let details = err.details.expect("cancel details");
    assert_eq!(details["sourceId"], sid.as_str());
    assert_eq!(details["cancelled"], true);

    // Live was fetched before the cancel but never committed.
    assert_eq!(ids(&state, &sid, ContentType::Live).await, old_live());
    assert_eq!(ids(&state, &sid, ContentType::Movie).await.len(), movies);
    let src = sources::get(&state, &sid).await.unwrap();
    assert_eq!(src.last_error, None, "a cancel is not an error");
    assert_eq!(src.last_error_code, None);
    drain(&mut rx, &mut events);
    let ph = phases(&events, &sid);
    assert_eq!(ph.last().map(String::as_str), Some("cancelled"), "{ph:?}");
    assert!(!ph.iter().any(|p| p == "error" || p == "saving"), "{ph:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subset_sync_cancelled_records_nothing_and_keeps_the_old_catalog() {
    let srv = stub::stub().await;
    let (_dir, state, mut rx) = stub::state().await;
    let (sid, movies) = synced_source(&state, &srv.server_url).await;
    while rx.try_recv().is_ok() {}

    let run = {
        let (state, sid) = (state.clone(), sid.clone());
        tokio::spawn(async move {
            router()
                .dispatch(
                    state,
                    "xtream.sync",
                    json!({ "sourceId": sid, "contentTypes": ["live", "movie"] }),
                )
                .await
        })
    };
    let mut events = cancel_at_movies(&state, &mut rx, &sid).await;
    let err = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .expect("the cancelled run ended")
        .unwrap()
        .expect_err("a cancelled sync rejects");
    assert_eq!(err.code, RpcErrorCode::Conflict, "{err:?}");
    assert!(err.message.contains("import stopped"), "{}", err.message);
    assert!(
        err.message.contains("cancelled by user"),
        "user cancel: {}",
        err.message
    );
    let details = err.details.expect("cancel details");
    assert_eq!(details["sourceId"], sid.as_str());
    assert_eq!(details["cancelled"], true);

    assert_eq!(ids(&state, &sid, ContentType::Live).await, old_live());
    assert_eq!(ids(&state, &sid, ContentType::Movie).await.len(), movies);
    let src = sources::get(&state, &sid).await.unwrap();
    assert_eq!(src.last_error, None, "a cancel is not an error");
    assert_eq!(src.last_error_code, None);
    drain(&mut rx, &mut events);
    let ph = phases(&events, &sid);
    assert_eq!(ph.last().map(String::as_str), Some("cancelled"), "{ph:?}");
    assert!(!ph.iter().any(|p| p == "error"), "{ph:?}");

    // Nothing stays cancelled: the next subset sync saves both types.
    router()
        .dispatch(
            state.clone(),
            "xtream.sync",
            json!({ "sourceId": sid, "contentTypes": ["live", "movie"] }),
        )
        .await
        .expect("sync after cancel");
    assert!(!ids(&state, &sid, ContentType::Live)
        .await
        .contains(&"old0".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subset_sync_failure_records_the_error_code() {
    let (_dir, state, mut rx) = stub::state().await;
    // Nothing listens on port 9: every request is refused.
    let sid = stub::add_source(&state, "http://127.0.0.1:9", stub::USER, stub::PASS).await;
    let err = router()
        .dispatch(
            state.clone(),
            "xtream.sync",
            json!({ "sourceId": sid, "contentTypes": ["movie"] }),
        )
        .await
        .expect_err("an unreachable panel fails");
    assert_eq!(err.code, RpcErrorCode::Network, "{err:?}");
    assert!(err.details.is_none_or(|d| d.get("cancelled").is_none()));

    let src = sources::get(&state, &sid).await.unwrap();
    assert!(src.last_error.is_some());
    assert_eq!(src.last_error_code, Some(RpcErrorCode::Network));
    let mut events = Vec::new();
    drain(&mut rx, &mut events);
    let error = events
        .iter()
        .find(|e| {
            e.kind == "import.progress"
                && e.payload["sourceId"] == sid
                && e.payload["phase"] == "error"
        })
        .expect("an error progress event");
    assert_eq!(
        error.payload["code"],
        serde_json::to_value(RpcErrorCode::Network).unwrap()
    );
}
