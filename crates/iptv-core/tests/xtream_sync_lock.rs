//! `xtream.sync` with a `contentTypes` subset runs under the per-source
//! import lock (`sources::run_import_with`), so a concurrent full refresh
//! (`sources.refresh` -> `sources::run_import`) waits for it instead of
//! interleaving. Uses the embedded stub's `slow` user, whose
//! `get_vod_streams` answer is delayed.

use iptv_core::rpc::RpcRouter;
use iptv_core::AppEvent;
use serde_json::{json, Value};
use std::time::Duration;

#[path = "xtream_stub.rs"]
mod stub;

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    iptv_core::sources::rpc::register(&mut r);
    r
}

fn phase(ev: &AppEvent) -> Option<(String, Option<String>)> {
    (ev.kind == "import.progress").then(|| {
        (
            ev.payload["phase"].as_str().unwrap_or_default().to_string(),
            ev.payload["message"].as_str().map(str::to_string),
        )
    })
}

#[tokio::test]
async fn subset_sync_serializes_against_a_full_refresh() {
    let srv = stub::stub().await;
    let (_dir, state, mut rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, "slow", stub::PASS).await;
    let r = std::sync::Arc::new(router());

    // Start the slow subset sync and wait until it is inside the lock (its
    // first progress event is emitted from within `run_import_with`).
    let subset = {
        let (r, state, sid) = (r.clone(), state.clone(), sid.clone());
        tokio::spawn(async move {
            r.dispatch(
                state,
                "xtream.sync",
                json!({"sourceId": sid, "contentTypes": ["movie"]}),
            )
            .await
        })
    };
    let mut events: Vec<AppEvent> = Vec::new();
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("subset sync started")
            .unwrap();
        let started = phase(&ev).is_some();
        events.push(ev);
        if started {
            break;
        }
    }

    // A full refresh requested now must wait for the subset to finish.
    let refresh = {
        let (r, state, sid) = (r.clone(), state.clone(), sid.clone());
        tokio::spawn(async move {
            r.dispatch(state, "sources.refresh", json!({"id": sid}))
                .await
        })
    };

    let subset_out: Value = subset.await.unwrap().expect("subset sync ok");
    let refreshed: Value = refresh.await.unwrap().expect("refresh ok");
    assert_eq!(subset_out["movies"], 30);
    assert_eq!(subset_out["channels"], 0);
    assert_eq!(refreshed["channelCount"], 40, "{refreshed}");
    assert_eq!(refreshed["movieCount"], 30, "{refreshed}");
    assert_eq!(refreshed["seriesCount"], 10, "{refreshed}");
    assert!(refreshed["lastRefreshAt"].is_string(), "{refreshed}");
    assert!(
        refreshed.get("lastError").is_none_or(Value::is_null),
        "{refreshed}"
    );

    while let Ok(ev) = rx.try_recv() {
        events.push(ev);
    }
    let phases: Vec<(String, Option<String>)> = events.iter().filter_map(phase).collect();
    let outcomes: Vec<&str> = phases
        .iter()
        .map(|(p, _)| p.as_str())
        .filter(|p| *p == "done" || *p == "error")
        .collect();
    assert_eq!(outcomes, ["done", "done"], "{phases:?}");

    // No interleaving: the refresh's first request (the account check)
    // comes only after the subset's `done`.
    let first_done = phases.iter().position(|(p, _)| p == "done").unwrap();
    let account_checks: Vec<usize> = phases
        .iter()
        .enumerate()
        .filter(|(_, (p, m))| p == "fetching" && m.as_deref() == Some("account"))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(account_checks.len(), 2, "{phases:?}");
    assert!(account_checks[0] < first_done, "{phases:?}");
    assert!(
        account_checks[1] > first_done,
        "refresh interleaved: {phases:?}"
    );

    // One `sources.changed` per outcome.
    let changed = events
        .iter()
        .filter(|e| e.kind == "sources.changed")
        .count();
    assert_eq!(changed, 2);
}

#[tokio::test]
async fn subset_sync_failure_is_recorded_under_the_lock() {
    let srv = stub::stub().await;
    let (_dir, state, mut rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, "nobody", stub::PASS).await;
    let r = router();

    let err = r
        .dispatch(
            state.clone(),
            "xtream.sync",
            json!({"sourceId": sid, "contentTypes": ["live"]}),
        )
        .await
        .unwrap_err();
    assert!(!err.message.is_empty());

    let list = r
        .dispatch(state.clone(), "sources.list", json!({}))
        .await
        .unwrap();
    let src = &list.as_array().unwrap()[0];
    assert!(src["lastError"].is_string(), "{src}");
    let mut outcomes = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let Some((p, _)) = phase(&ev) {
            if p == "done" || p == "error" {
                outcomes.push(p);
            }
        }
    }
    assert_eq!(outcomes, ["error"]);

    // The lock was released: a second attempt does not hang.
    tokio::time::timeout(
        Duration::from_secs(10),
        r.dispatch(
            state.clone(),
            "xtream.sync",
            json!({"sourceId": sid, "contentTypes": ["live"]}),
        ),
    )
    .await
    .expect("lock released after a failed subset sync")
    .unwrap_err();
}
