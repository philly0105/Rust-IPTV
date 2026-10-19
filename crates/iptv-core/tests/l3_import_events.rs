//! Loop 3 import events and user-initiated connects:
//!
//! - L3-perf-core-5: `sources.changed` names the source and the reason.
//! - L3-perf-core-4 / L3-app-3: the saving phase reports its `step` while
//!   the old catalog is deleted (`replacing`) and while indexes and counts
//!   are rebuilt (`indexing`).
//! - L3-app-2: adding or testing a source on an unreachable host fails after
//!   the short connect timeout, without retries.

use iptv_core::rpc::RpcRouter;
use iptv_core::AppEvent;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::broadcast::Receiver;

#[path = "xtream_stub.rs"]
mod stub;

/// Payloads of the events of `kind` received so far.
fn drain(rx: &mut Receiver<AppEvent>, kind: &str) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if ev.kind == kind {
            out.push(ev.payload);
        }
    }
    out
}

fn saving_steps(progress: &[Value], sid: &str) -> Vec<Value> {
    progress
        .iter()
        .filter(|p| p["sourceId"] == sid && p["phase"] == "saving" && p.get("step").is_some())
        .cloned()
        .collect()
}

#[tokio::test]
async fn xtream_import_reports_replacing_and_indexing_steps() {
    let srv = stub::stub().await;
    let (_dir, state, mut rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, stub::USER, stub::PASS).await;

    // First import: nothing to replace, then the index rebuild.
    iptv_core::sources::refresh(state.clone(), &sid)
        .await
        .unwrap();
    let progress = drain(&mut rx, "import.progress");
    let steps = saving_steps(&progress, &sid);
    assert!(
        steps.iter().all(|p| p["step"] != "replacing"),
        "a first import replaces nothing: {steps:?}"
    );
    let indexing = steps
        .iter()
        .find(|p| p["step"] == "indexing")
        .unwrap_or_else(|| panic!("an indexing step: {progress:?}"));
    assert_eq!(indexing["done"], 80, "{indexing}");
    assert_eq!(indexing["total"], 80, "{indexing}");
    // The indexing step comes after the last per-row saving event.
    let last_saving = progress
        .iter()
        .rposition(|p| p["phase"] == "saving")
        .unwrap();
    assert_eq!(progress[last_saving]["step"], "indexing");

    // Forget the stored fingerprints: the next refresh rewrites the catalog.
    let key = format!("xtream_fp:{sid}");
    state
        .db_call(move |c| {
            c.execute("DELETE FROM app_state WHERE key = ?1", [&key])?;
            Ok(())
        })
        .await
        .unwrap();
    iptv_core::sources::refresh(state.clone(), &sid)
        .await
        .unwrap();
    let progress = drain(&mut rx, "import.progress");
    let steps: Vec<Value> = saving_steps(&progress, &sid)
        .into_iter()
        .map(|p| p["step"].clone())
        .collect();
    assert_eq!(
        steps,
        [json!("replacing"), json!("indexing")],
        "{progress:?}"
    );
    let replacing = progress.iter().find(|p| p["step"] == "replacing").unwrap();
    assert_eq!(replacing["done"], 0);
    assert!(
        replacing.get("total").is_none_or(Value::is_null),
        "replacing has no total: {replacing}"
    );
    let replacing_at = progress
        .iter()
        .position(|p| p["step"] == "replacing")
        .unwrap();
    let first_row = progress
        .iter()
        .position(|p| p["phase"] == "saving" && p.get("step").is_none());
    if let Some(first_row) = first_row {
        assert!(replacing_at < first_row, "replacing comes before the rows");
    }
}

#[tokio::test]
async fn m3u_import_reports_saving_steps() {
    let (_dir, state, mut rx) = stub::state().await;
    iptv_core::m3u::init(state.clone()).await.unwrap();
    let text ="#EXTM3U\n#EXTINF:-1 group-title=\"G\",One\nhttp://h/1\n#EXTINF:-1 group-title=\"G\",Two\nhttp://h/2\n";
    let args = serde_json::from_value(json!({
        "kind": "m3u",
        "name": "Text",
        "m3u": { "text": text },
    }))
    .unwrap();
    let source = iptv_core::sources::add(state.clone(), args)
        .await
        .unwrap_or_else(|e| panic!("add failed: {:?}", e.error));
    let sid = source.id.clone();
    let progress = drain(&mut rx, "import.progress");
    let steps = saving_steps(&progress, &sid);
    assert_eq!(steps.len(), 1, "{progress:?}");
    assert_eq!(steps[0]["step"], "indexing");
    assert_eq!(steps[0]["done"], 2);
    assert_eq!(steps[0]["total"], 2);

    // Forget the stored hash: the next refresh rewrites the catalog.
    let id = sid.clone();
    state
        .db_call(move |c| {
            c.execute("UPDATE m3u_raw SET sha256 = '' WHERE source_id = ?1", [&id])?;
            Ok(())
        })
        .await
        .unwrap();
    iptv_core::sources::refresh(state.clone(), &sid)
        .await
        .unwrap();
    let progress = drain(&mut rx, "import.progress");
    let steps: Vec<Value> = saving_steps(&progress, &sid)
        .into_iter()
        .map(|p| p["step"].clone())
        .collect();
    assert_eq!(
        steps,
        [json!("replacing"), json!("indexing")],
        "{progress:?}"
    );
}

#[tokio::test]
async fn sources_changed_names_the_source_and_the_reason() {
    let srv = stub::stub().await;
    let (_dir, state, mut rx) = stub::state().await;
    let args = serde_json::from_value(json!({
        "kind": "xtream",
        "name": "Mock",
        "xtream": {
            "serverUrl": srv.server_url,
            "username": stub::USER,
            "password": stub::PASS,
        },
    }))
    .unwrap();
    let source = iptv_core::sources::add(state.clone(), args)
        .await
        .unwrap_or_else(|e| panic!("add failed: {:?}", e.error));
    let sid = source.id.clone();
    let changed = drain(&mut rx, "sources.changed");
    assert_eq!(
        changed,
        [
            json!({"sourceId": sid, "reason": "added"}),
            json!({"sourceId": sid, "reason": "catalog"}),
        ]
    );

    let patch = serde_json::from_value(json!({"name": "Renamed"})).unwrap();
    iptv_core::sources::update(&state, &sid, patch)
        .await
        .unwrap();
    let changed = drain(&mut rx, "sources.changed");
    assert_eq!(changed, [json!({"sourceId": sid, "reason": "config"})]);

    // ST-5: an auto-refresh toggle leaves every catalog reader alone.
    let patch = serde_json::from_value(json!({"autoRefresh": true})).unwrap();
    iptv_core::sources::update(&state, &sid, patch)
        .await
        .unwrap();
    let changed = drain(&mut rx, "sources.changed");
    assert_eq!(changed, [json!({"sourceId": sid, "reason": "status"})]);

    iptv_core::sources::remove(&state, &sid).await.unwrap();
    let changed = drain(&mut rx, "sources.changed");
    assert_eq!(changed, [json!({"sourceId": sid, "reason": "removed"})]);
}

#[tokio::test]
async fn failed_refresh_reports_a_status_change() {
    let (_dir, state, mut rx) = stub::state().await;
    // Nothing listens on port 9 of loopback: refused at once.
    let sid = stub::add_source(&state, "http://127.0.0.1:9/xtream", "u", "p").await;
    assert!(iptv_core::sources::refresh(state.clone(), &sid)
        .await
        .is_err());
    let changed = drain(&mut rx, "sources.changed");
    assert_eq!(changed, [json!({"sourceId": sid, "reason": "status"})]);
}

/// An address no host answers (TEST-NET style blackhole in a private range):
/// the connection attempt hangs until the connect timeout.
const UNREACHABLE: &str = "http://10.255.255.1:8080";

#[tokio::test]
async fn user_initiated_calls_give_up_on_an_unreachable_host_quickly() {
    let (_dir, state, _rx) = stub::state().await;
    assert!(!iptv_core::http::is_interactive());
    assert!(iptv_core::http::interactive(async { iptv_core::http::is_interactive() }).await);

    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    let started = Instant::now();
    let tested = r
        .dispatch(
            state.clone(),
            "xtream.test",
            json!({"config": {"serverUrl": UNREACHABLE, "username": "u", "password": "p"}}),
        )
        .await;
    let took = started.elapsed();
    let tested = tested.unwrap();
    assert_eq!(tested["ok"], false, "{tested}");
    let message = tested["message"].as_str().unwrap_or_default();
    assert!(message.contains("Could not reach"), "{message}");
    assert!(took < Duration::from_secs(8), "xtream.test took {took:?}");

    let args = serde_json::from_value(json!({
        "kind": "xtream",
        "name": "Unreachable",
        "xtream": {"serverUrl": UNREACHABLE, "username": "u", "password": "p"},
    }))
    .unwrap();
    let started = Instant::now();
    let added = iptv_core::sources::add(state.clone(), args).await;
    let took = started.elapsed();
    let err = added.expect_err("the add fails");
    assert!(took < Duration::from_secs(8), "sources.add took {took:?}");
    // A connect timeout (not a network that fails at once) is reported as a
    // failure a retry cannot fix.
    if took >= Duration::from_secs(2) {
        assert!(!err.error.is_retryable(), "{:?}", err.error);
    }

    // L4-settings-4: the add dialog's Try again and a card's Refresh go
    // through `sources.refresh`, which the user waits on too.
    let sid = err.source_id.expect("the failed add keeps its source");
    let started = Instant::now();
    let refreshed = iptv_core::sources::refresh(state.clone(), &sid).await;
    let took = started.elapsed();
    let err = refreshed.expect_err("the refresh fails");
    assert!(
        took < Duration::from_secs(8),
        "sources.refresh took {took:?}"
    );
    if took >= Duration::from_secs(2) {
        assert!(!err.is_retryable(), "{err:?}");
        assert!(err.to_string().contains("Could not reach"), "{err}");
    }
}

/// Background work keeps the long connect timeout: a task spawned from the
/// interactive scope (a follow-up fetch) does not inherit it.
#[tokio::test]
async fn spawned_work_is_not_interactive() {
    let in_spawned = iptv_core::http::interactive(async {
        tokio::spawn(async { iptv_core::http::is_interactive() })
            .await
            .unwrap()
    })
    .await;
    assert!(!in_spawned);
}
