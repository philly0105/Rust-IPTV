//! Server guard regressions from review round 2 (R5-r2 F5-F7): the proxy
//! never echoes an upstream playlist content type, invalid header overrides
//! are a 400, and IPTV_ALLOW_PRIVATE_TARGETS accepts common truthy values.

use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::rpc::build_router;
use iptv_core::AppState;
use iptv_server::{Server, ServerOptions};
use std::sync::Arc;
use tokio::sync::broadcast;

struct Harness {
    base: String,
    http: reqwest::Client,
    _tmp: tempfile::TempDir,
}

async fn start(allow_private: bool) -> Harness {
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
    let mut opts = ServerOptions::new(dist);
    opts.allow_private_targets = allow_private;
    let server = Server::new(app, Arc::new(build_router()), tx, opts);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let router = iptv_server::router(server);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Harness {
        base: format!("http://{addr}"),
        http: reqwest::Client::new(),
        _tmp: tmp,
    }
}

impl Harness {
    fn proxy_url(&self, target: &str, extra: &[(&str, &str)]) -> String {
        let mut u = url::Url::parse(&format!("{}/api/proxy", self.base)).unwrap();
        u.query_pairs_mut().append_pair("url", target);
        for (k, v) in extra {
            u.query_pairs_mut().append_pair(k, v);
        }
        u.to_string()
    }
}

async fn spawn_upstream() -> String {
    let app = Router::new().route(
        "/phish.m3u8",
        get(|| async {
            (
                [(header::CONTENT_TYPE, "text/html; x=mpegurl")],
                "#EXTM3U\n#<h1>PHISH</h1>\nseg.ts\n",
            )
                .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn server_guard_playlist_content_type_is_never_echoed() {
    let up = spawn_upstream().await;
    let h = start(true).await;
    let r = h
        .http
        .get(h.proxy_url(&format!("{up}/phish.m3u8"), &[]))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()[header::CONTENT_TYPE],
        "application/vnd.apple.mpegurl"
    );
}

#[tokio::test]
async fn server_guard_invalid_header_override_is_400() {
    let up = spawn_upstream().await;
    let h = start(true).await;
    for key in ["ua", "referer", "origin"] {
        let r = h
            .http
            .get(h.proxy_url(&format!("{up}/phish.m3u8"), &[(key, "a\r\nX-Inj: 1")]))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400, "{key}");
        let v: serde_json::Value = r.json().await.unwrap();
        let msg = v["message"].as_str().unwrap();
        assert!(msg.contains("invalid header override"), "{msg}");
        assert!(msg.contains(key), "{msg}");
    }
}

/// `--health` against a port with no server exits 1; a rejected env value
/// would exit 2 (clap usage error) before probing.
#[test]
fn server_guard_allow_private_targets_env_accepts_boolish_values() {
    for value in ["1", "0", "yes", "no", "on", "off", "true", "false"] {
        let status = std::process::Command::new(env!("CARGO_BIN_EXE_iptv-server"))
            .args(["--health", "--port", "7201"])
            .env("IPTV_ALLOW_PRIVATE_TARGETS", value)
            .env("IPTV_HOST", "127.0.0.1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_ne!(status.code(), Some(2), "value {value:?} was rejected");
    }
}
