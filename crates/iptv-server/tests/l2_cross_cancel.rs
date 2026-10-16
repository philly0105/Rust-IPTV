//! L2-perf-desktop-6 (server half): read-only queries the UI aborts run
//! inline under `cancel_on_drop`, so a dropped request stops its SQL; every
//! write stays detached (L1-sources-home-3, `l2_import_detached.rs`).

use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::rpc::build_router;
use iptv_core::AppState;
use iptv_server::api::{cancels_on_disconnect, CANCEL_ON_DISCONNECT};
use iptv_server::{Server, ServerOptions};
use std::sync::Arc;
use tokio::sync::broadcast;

#[test]
fn only_registered_read_only_queries_cancel_on_disconnect() {
    let router = build_router();
    for cmd in CANCEL_ON_DISCONNECT {
        assert!(router.contains(cmd), "{cmd} is not a command");
        let verb = cmd.split('.').nth(1).unwrap();
        assert!(
            !["set", "add", "remove", "refresh", "toggle", "update", "clear", "import"]
                .iter()
                .any(|w| verb.starts_with(w)),
            "{cmd} looks like a write"
        );
    }
    for cmd in [
        "epg.grid",
        "epg.programs",
        "epg.search",
        "catalog.search",
        "catalog.channels",
        "catalog.movies",
        "catalog.series",
    ] {
        assert!(cancels_on_disconnect(cmd), "{cmd}");
    }
    for cmd in [
        "sources.add",
        "sources.refresh",
        "favorites.toggle",
        "positions.set",
        "recent.add",
        "settings.update",
        "epg.refresh",
        "epg.setMapping",
        "backup.import",
        "catalog.setCategoryHidden",
    ] {
        assert!(!cancels_on_disconnect(cmd), "{cmd} must run detached");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_inline_query_answers_over_http() {
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let (tx, _) = broadcast::channel::<AppEvent>(64);
    let app = AppState::new(
        tmp.path().join("data"),
        Arc::new(BroadcastSink(tx.clone())),
        false,
    )
    .await
    .unwrap();
    let server = Server::new(
        app.clone(),
        Arc::new(build_router()),
        tx,
        ServerOptions::new(dist),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let router = iptv_server::router(server);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let client = reqwest::Client::new();
    let res = client
        .post(format!("http://{addr}/api/rpc/epg.grid"))
        .json(&serde_json::json!({
            "refs": [],
            "from": "2026-10-16T00:00:00Z",
            "to": "2026-10-16T03:00:00Z",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({})
    );
    // Errors keep their mapping on the inline path.
    let res = client
        .post(format!("http://{addr}/api/rpc/epg.search"))
        .json(&serde_json::json!({ "sourceId": "s", "query": "" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}
