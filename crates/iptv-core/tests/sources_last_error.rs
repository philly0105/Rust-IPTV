//! A refresh that cannot reach the host records a `lastError` that names the
//! host ("Could not reach <host>...") for every source kind, never reqwest's
//! bare "error sending request".

#[path = "m3u_support.rs"]
mod support;

use iptv_core::model::{SourceKind, StalkerSourceConfig, XtreamSourceConfig};
use iptv_core::sources::{self, AddSourceArgs};
use serde_json::json;
use support::*;

/// A loopback port nothing listens on (bound, then released).
fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

async fn last_error_after_add(args: AddSourceArgs) -> String {
    let env = env().await;
    iptv_core::xtream::init(env.state.clone()).await.unwrap();
    iptv_core::stalker::init(env.state.clone()).await.unwrap();
    let err = sources::add(env.state.clone(), args)
        .await
        .expect_err("the host is down");
    let id = err.source_id.expect("the source is kept with lastError");
    let src = sources::get(&env.state, &id).await.unwrap();
    src.last_error.expect("lastError recorded")
}

fn assert_names_host(msg: &str) {
    assert!(msg.starts_with("Could not reach "), "{msg}");
    assert!(msg.contains("127.0.0.1"), "{msg}");
    assert!(!msg.contains("error sending request"), "{msg}");
}

#[tokio::test]
async fn m3u_refresh_failure_names_the_host() {
    let url = format!("http://127.0.0.1:{}/list.m3u", dead_port());
    let msg = last_error_after_add(url_args(&url, false)).await;
    assert_names_host(&msg);
}

#[tokio::test]
async fn xtream_refresh_failure_names_the_host() {
    let cfg: XtreamSourceConfig = serde_json::from_value(json!({
        "serverUrl": format!("http://127.0.0.1:{}", dead_port()),
        "username": "u",
        "password": "p",
    }))
    .unwrap();
    let msg = last_error_after_add(AddSourceArgs {
        kind: SourceKind::Xtream,
        name: String::new(),
        auto_refresh: None,
        m3u: None,
        xtream: Some(cfg),
        stalker: None,
    })
    .await;
    assert_names_host(&msg);
}

#[tokio::test]
async fn stalker_refresh_failure_names_the_host() {
    let cfg: StalkerSourceConfig = serde_json::from_value(json!({
        "portalUrl": format!("http://127.0.0.1:{}/c/", dead_port()),
        "macAddress": "00:1A:79:00:00:01",
    }))
    .unwrap();
    let msg = last_error_after_add(AddSourceArgs {
        kind: SourceKind::Stalker,
        name: String::new(),
        auto_refresh: None,
        m3u: None,
        xtream: None,
        stalker: Some(cfg),
    })
    .await;
    assert_names_host(&msg);
}
