//! Fix wave 3 (R5-r3 F1, F2) through the HTTP API: a source's own private
//! `host:port` is trusted only for requests on behalf of that source. Using
//! it (proxy, `xtream.test`) never opens it to `/api/proxy` without a
//! source, to another source, or to a download for an unknown source, and a
//! redirect from one source into another's private host is refused.
//!
//! `localhost` stands in for a host name that resolves privately; the second
//! upstream listens on 127.0.0.2.

use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
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
    server: Server,
    _tmp: tempfile::TempDir,
}

async fn start() -> Harness {
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
    let server = Server::new(app, Arc::new(build_router()), tx, ServerOptions::new(dist));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let router = iptv_server::router(server.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Harness {
        base: format!("http://{addr}"),
        http: reqwest::Client::new(),
        server,
        _tmp: tmp,
    }
}

impl Harness {
    async fn add_source(&self, id: &str, kind: &str, config: serde_json::Value) {
        let (id, kind, config) = (id.to_owned(), kind.to_owned(), config.to_string());
        self.server
            .app
            .db_call(move |c| {
                c.execute(
                    "INSERT INTO sources(id, kind, name, config_json) VALUES (?1, ?2, ?1, ?3)",
                    [&id, &kind, &config],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn proxy(&self, target: &str, source_id: Option<&str>) -> (u16, String) {
        let mut u = url::Url::parse(&format!("{}/api/proxy", self.base)).unwrap();
        u.query_pairs_mut().append_pair("url", target);
        if let Some(id) = source_id {
            u.query_pairs_mut().append_pair("sourceId", id);
        }
        let r = self.http.get(u).send().await.unwrap();
        (r.status().as_u16(), r.text().await.unwrap_or_default())
    }

    async fn rpc(&self, cmd: &str, args: serde_json::Value) -> (u16, serde_json::Value) {
        let r = self
            .http
            .post(format!("{}/api/rpc/{cmd}", self.base))
            .json(&args)
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        (status, r.json().await.unwrap_or(serde_json::Value::Null))
    }
}

/// `/secret*` answers with its path, `/redir?to=` redirects, the rest 404.
async fn upstream(req: Request) -> Response {
    let path = req.uri().path().to_string();
    if path == "/redir" {
        let to = url::form_urlencoded::parse(req.uri().query().unwrap_or_default().as_bytes())
            .find(|(k, _)| k == "to")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        return (StatusCode::FOUND, [(header::LOCATION, to)]).into_response();
    }
    if path.starts_with("/secret") {
        return (
            [(header::CONTENT_TYPE, "video/mp2t")],
            format!("SECRET-BODY {path}"),
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, "nope").into_response()
}

async fn spawn_upstream(ip: &str) -> Option<u16> {
    let listener = tokio::net::TcpListener::bind((ip, 0)).await.ok()?;
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(upstream))
            .await
            .unwrap()
    });
    Some(port)
}

#[tokio::test]
async fn fix3_net_proxy_trust_does_not_leak_across_sources() {
    let port = spawn_upstream("127.0.0.1").await.unwrap();
    let h = start().await;
    let named = format!("http://localhost:{port}");
    let secret = format!("{named}/secret-after");

    let (status, _) = h.proxy(&secret, None).await;
    assert_eq!(status, 403, "before any trust");

    h.add_source(
        "nas",
        "m3u",
        serde_json::json!({ "url": format!("{named}/list.m3u") }),
    )
    .await;
    h.add_source(
        "other",
        "m3u",
        serde_json::json!({ "url": "http://cdn.example.com/x.m3u" }),
    )
    .await;
    let (status, body) = h.proxy(&secret, Some("nas")).await;
    assert_eq!((status, body.as_str()), (200, "SECRET-BODY /secret-after"));

    // The trust used just now does not reach other requests.
    let (status, body) = h.proxy(&secret, None).await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = h.proxy(&secret, Some("other")).await;
    assert_eq!(status, 403, "{body}");
    let (status, v) = h
        .rpc(
            "downloads.start",
            serde_json::json!({
                "ref": { "sourceId": "nope", "contentType": "movie", "itemId": "1" },
                "title": "Probe",
                "url": format!("{named}/secret-dl-nosource"),
            }),
        )
        .await;
    assert_eq!(status, 400, "{v}");
}

#[tokio::test]
async fn fix3_net_proxy_trust_does_not_survive_xtream_test() {
    let port = spawn_upstream("127.0.0.1").await.unwrap();
    let h = start().await;
    let named = format!("http://localhost:{port}");
    let (status, v) = h
        .rpc(
            "xtream.test",
            serde_json::json!({ "config": { "serverUrl": named, "username": "u", "password": "p" } }),
        )
        .await;
    assert_eq!(status, 200, "{v}");
    let (status, body) = h.proxy(&format!("{named}/secret-after-xtest"), None).await;
    assert_eq!(status, 403, "{body}");
}

#[tokio::test]
async fn fix3_net_proxy_cross_source_redirect_refused() {
    let pa = spawn_upstream("127.0.0.1").await.unwrap();
    let Some(pb) = spawn_upstream("127.0.0.2").await else {
        eprintln!("skipped: cannot listen on 127.0.0.2");
        return;
    };
    let h = start().await;
    let a = format!("http://127.0.0.1:{pa}");
    let b = format!("http://127.0.0.2:{pb}");
    h.add_source(
        "A",
        "m3u",
        serde_json::json!({ "url": format!("{a}/list.m3u") }),
    )
    .await;
    h.add_source(
        "B",
        "m3u",
        serde_json::json!({ "url": format!("{b}/list.m3u") }),
    )
    .await;
    let (status, _) = h.proxy(&format!("{a}/secret-own"), Some("A")).await;
    assert_eq!(status, 200);
    let (status, body) = h
        .proxy(&format!("{b}/redir?to={a}/secret-cross"), Some("B"))
        .await;
    assert_eq!(status, 403, "{body}");
}
