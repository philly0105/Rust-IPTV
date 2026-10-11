//! End-to-end tests of the server router over real sockets (SPEC check 17).

use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::rpc::build_router;
use iptv_core::AppState;
use iptv_server::{Server, ServerOptions};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

const INDEX: &str = "<!doctype html><title>spa-index</title>";
const ASSET: &str = "/assets/index-Bk3a9_zQ.js";

struct Harness {
    base: String,
    addr: std::net::SocketAddr,
    http: reqwest::Client,
    server: Server,
    _tmp: tempfile::TempDir,
}

async fn start_with(configure: impl FnOnce(&mut ServerOptions)) -> Harness {
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), INDEX).unwrap();
    std::fs::write(dist.join(ASSET.trim_start_matches('/')), "console.log(1)").unwrap();

    let (tx, _) = broadcast::channel::<AppEvent>(64);
    let app = AppState::new(
        tmp.path().join("data"),
        Arc::new(BroadcastSink(tx.clone())),
        false,
    )
    .await
    .unwrap();
    let mut opts = ServerOptions::new(dist);
    configure(&mut opts);
    let server = Server::new(app, Arc::new(build_router()), tx, opts);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let router = iptv_server::router(server.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Harness {
        base: format!("http://{addr}"),
        addr,
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        server,
        _tmp: tmp,
    }
}

async fn start() -> Harness {
    start_with(|_| {}).await
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

    fn proxy_url(&self, target: &str, source_id: Option<&str>) -> String {
        let mut u = url::Url::parse(&format!("{}/api/proxy", self.base)).unwrap();
        u.query_pairs_mut().append_pair("url", target);
        if let Some(id) = source_id {
            u.query_pairs_mut().append_pair("sourceId", id);
        }
        u.to_string()
    }
}

// ---------------------------------------------------------------------------
// Upstream stub: playlists, segments, redirects and a Range-capable file.
// ---------------------------------------------------------------------------

const PLAYLIST: &str = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\nseg1.ts\n#EXTINF:2.0,\n/abs/seg2.ts\n#EXT-X-ENDLIST\n";

fn bytes_1000() -> Vec<u8> {
    (0..1000u32).map(|i| (i % 251) as u8).collect()
}

/// `Some(rejection)` unless the source headers arrived.
fn require_headers(h: &HeaderMap) -> Option<Response> {
    let ua = h.get(header::USER_AGENT).and_then(|v| v.to_str().ok());
    let referer = h.get(header::REFERER).and_then(|v| v.to_str().ok());
    if ua == Some("TestUA/1") && referer == Some("http://ref.example/") {
        None
    } else {
        Some((StatusCode::FORBIDDEN, "missing source headers").into_response())
    }
}

async fn serve_bytes(req: Request) -> Response {
    let data = bytes_1000();
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .map(|(a, b)| {
            let start: usize = a.parse().unwrap();
            let end: usize = if b.is_empty() {
                data.len() - 1
            } else {
                b.parse().unwrap()
            };
            (start, end.min(data.len() - 1))
        });
    match range {
        Some((start, end)) => Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, "video/mp4")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{}", data.len()),
            )
            .body(axum::body::Body::from(data[start..=end].to_vec()))
            .unwrap(),
        None => Response::builder()
            .header(header::CONTENT_TYPE, "video/mp4")
            .header(header::ACCEPT_RANGES, "bytes")
            .body(axum::body::Body::from(data))
            .unwrap(),
    }
}

async fn spawn_stub() -> String {
    let app = Router::new()
        .route(
            "/live/index.m3u8",
            get(|h: HeaderMap| async move {
                if let Some(r) = require_headers(&h) {
                    return r;
                }
                (
                    [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
                    PLAYLIST,
                )
                    .into_response()
            }),
        )
        .route(
            "/live/plain",
            get(|| async { ([(header::CONTENT_TYPE, "text/plain")], PLAYLIST) }),
        )
        .route(
            "/live/seg1.ts",
            get(|h: HeaderMap| async move {
                if let Some(r) = require_headers(&h) {
                    return r;
                }
                ([(header::CONTENT_TYPE, "video/mp2t")], "SEGMENT-ONE").into_response()
            }),
        )
        .route(
            "/redirect",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/live/plain")]) }),
        )
        .route(
            "/redirect-private",
            get(|| async {
                (
                    StatusCode::FOUND,
                    [(header::LOCATION, "http://10.255.255.1/x.ts")],
                )
            }),
        )
        .route("/bytes", get(serve_bytes))
        .route("/gone", get(|| async { StatusCode::NOT_FOUND }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

fn decode_proxy_target(line: &str) -> String {
    let u = url::Url::parse(&format!("http://x{line}")).unwrap();
    assert_eq!(u.path(), "/api/proxy", "not a proxy path: {line}");
    u.query_pairs()
        .find(|(k, _)| k == "url")
        .map(|(_, v)| v.into_owned())
        .unwrap()
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_reports_ok_and_version() {
    let h = start().await;
    let r = h
        .http
        .get(format!("{}/api/health", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["version"], AppState::version());
}

#[tokio::test]
async fn rpc_app_info_and_error_mapping() {
    let h = start().await;
    let r = h
        .http
        .post(format!("{}/api/rpc/app.info", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["isDesktop"], false);
    assert!(v["version"].is_string());

    let r = h
        .http
        .post(format!("{}/api/rpc/nope.nope", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["code"], "not_found");

    let r = h
        .http
        .post(format!("{}/api/rpc/app.ping", h.base))
        .body("{bad")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(
        r.json::<serde_json::Value>().await.unwrap()["code"],
        "invalid"
    );

    let r = h
        .http
        .get(format!("{}/api/unknown", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
}

#[tokio::test]
async fn spa_fallback_and_cache_headers() {
    let h = start().await;
    for path in ["/", "/s/abc/live", "/settings/general"] {
        let r = h
            .http
            .get(format!("{}{path}", h.base))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "{path}");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-cache", "{path}");
        assert_eq!(r.text().await.unwrap(), INDEX, "{path}");
    }
    let r = h
        .http
        .get(format!("{}{ASSET}", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");

    let r = h
        .http
        .get(format!("{}/assets/missing-AAAAAAAA.js", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404, "missing assets must not fall back to HTML");
    let r = h
        .http
        .get(format!("{}/missing.png", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let r = h
        .http
        .delete(format!("{}/s/abc", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 405);
}

#[tokio::test]
async fn proxy_rewrites_playlist_and_injects_source_headers() {
    let stub = spawn_stub().await;
    let h = start().await;
    h.add_source(
        "m3u-1",
        "m3u",
        serde_json::json!({
            "origin": "url",
            "url": format!("{stub}/list.m3u"),
            "headers": { "userAgent": "TestUA/1", "referrer": "http://ref.example/" }
        }),
    )
    .await;

    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/live/index.m3u8"), Some("m3u-1")))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()[header::CONTENT_TYPE],
        "application/vnd.apple.mpegurl"
    );
    let text = r.text().await.unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "#EXTM3U");
    let key = lines[2].split('"').nth(1).unwrap();
    assert_eq!(decode_proxy_target(key), format!("{stub}/live/key.bin"));
    assert!(key.ends_with("&sourceId=m3u-1"));
    let map = lines[3].split('"').nth(1).unwrap();
    assert_eq!(decode_proxy_target(map), format!("{stub}/live/init.mp4"));
    assert_eq!(
        decode_proxy_target(lines[5]),
        format!("{stub}/live/seg1.ts")
    );
    assert_eq!(decode_proxy_target(lines[7]), format!("{stub}/abs/seg2.ts"));
    for line in text
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
    {
        assert!(
            line.starts_with("/api/proxy?url="),
            "unproxied URI line: {line}"
        );
    }

    // Following a rewritten segment URI goes back through the proxy with headers.
    let r = h
        .http
        .get(format!("{}{}", h.base, lines[5]))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp2t");
    assert_eq!(r.text().await.unwrap(), "SEGMENT-ONE");

    // Without the source the upstream rejects the request (no headers) and the
    // loopback target is refused outright.
    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/live/index.m3u8"), None))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
}

#[tokio::test]
async fn proxy_sniffs_untyped_playlists_and_follows_redirects() {
    let stub = spawn_stub().await;
    let h = start().await;
    h.add_source(
        "x-1",
        "xtream",
        serde_json::json!({ "serverUrl": stub, "username": "u", "password": "p" }),
    )
    .await;
    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/redirect"), Some("x-1")))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()[header::CONTENT_TYPE],
        "application/vnd.apple.mpegurl"
    );
    let text = r.text().await.unwrap();
    let seg = text.lines().nth(5).unwrap();
    // Relative URIs resolve against the final (post-redirect) URL.
    assert_eq!(decode_proxy_target(seg), format!("{stub}/live/seg1.ts"));

    // A redirect into a private network is refused even from a trusted host.
    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/redirect-private"), Some("x-1")))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    // Upstream 404 passes through as 404 with an RpcError body.
    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/gone"), Some("x-1")))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["details"]["upstreamStatus"], 404);
}

#[tokio::test]
async fn proxy_passes_range_through() {
    let stub = spawn_stub().await;
    let h = start().await;
    h.add_source(
        "x-1",
        "xtream",
        serde_json::json!({ "serverUrl": stub, "username": "u", "password": "p" }),
    )
    .await;
    let url = h.proxy_url(&format!("{stub}/bytes"), Some("x-1"));

    let r = h
        .http
        .get(&url)
        .header(header::RANGE, "bytes=100-199")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 100-199/1000");
    assert_eq!(r.headers()[header::CONTENT_LENGTH], "100");
    assert_eq!(r.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp4");
    assert_eq!(r.bytes().await.unwrap().as_ref(), &bytes_1000()[100..200]);

    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()[header::CONTENT_LENGTH], "1000");
    assert_eq!(r.bytes().await.unwrap().as_ref(), bytes_1000().as_slice());

    let r = h.http.head(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()[header::CONTENT_LENGTH], "1000");
}

#[tokio::test]
async fn proxy_rejects_private_and_malformed_targets() {
    let stub = spawn_stub().await;
    let h = start().await;
    h.add_source(
        "remote",
        "m3u",
        serde_json::json!({ "origin": "url", "url": "http://playlists.example.com/a.m3u", "headers": {} }),
    )
    .await;

    for (target, source, status) in [
        ("http://192.168.1.5/stream.ts", None, 403),
        ("http://169.254.169.254/latest/meta-data/", None, 403),
        ("http://[::1]:7180/api/health", None, 403),
        ("http://localhost:7180/api/health", None, 403),
        (&format!("{stub}/bytes") as &str, Some("remote"), 403),
        ("http://10.0.0.1/x.ts", Some("remote"), 403),
        ("http://user:pass@example.com/x.ts", None, 400),
        ("ftp://example.com/x.ts", None, 400),
        ("file:///etc/passwd", None, 400),
        ("not a url", None, 400),
        ("https://example.com/x.ts", Some("missing-source"), 404),
    ] {
        let r = h
            .http
            .get(h.proxy_url(target, source))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), status, "{target} via {source:?}");
        let v: serde_json::Value = r.json().await.unwrap();
        assert!(v["message"].is_string(), "{target}: RpcError body");
    }
    let r = h
        .http
        .get(format!("{}/api/proxy", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
}

#[tokio::test]
async fn proxy_allows_private_targets_when_configured() {
    let stub = spawn_stub().await;
    let h = start_with(|o| o.allow_private_targets = true).await;
    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/bytes"), None))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
}

#[tokio::test]
async fn proxy_rewrites_mock_xtream_playlist() {
    let mock = iptv_fixtures::spawn_mock().await;
    let target = format!("{}/xtream/live/demo/secret/101.m3u8", mock.base);
    let direct = reqwest::get(&target).await.unwrap();
    if !direct.status().is_success() {
        // B11's mock routes land in parallel; the stub-based tests above cover
        // the same behavior until they do.
        eprintln!(
            "SKIP: mock has no {target} yet (status {})",
            direct.status()
        );
        return;
    }
    let h = start().await;
    h.add_source(
        "mock-x",
        "xtream",
        serde_json::json!({ "serverUrl": mock.base, "username": "demo", "password": "secret" }),
    )
    .await;
    let r = h
        .http
        .get(h.proxy_url(&target, Some("mock-x")))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let text = r.text().await.unwrap();
    assert!(text.starts_with("#EXTM3U"));
    let uris: Vec<&str> = text
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .collect();
    assert!(!uris.is_empty(), "mock playlist has segments");
    for uri in &uris {
        assert!(uri.starts_with("/api/proxy?url="), "unproxied: {uri}");
        assert!(decode_proxy_target(uri).starts_with(&mock.base));
    }
    let seg = h
        .http
        .get(format!("{}{}", h.base, uris[0]))
        .send()
        .await
        .unwrap();
    assert_eq!(seg.status(), 200);
    assert!(!seg.bytes().await.unwrap().is_empty());
}

#[tokio::test]
async fn files_serve_completed_downloads_with_range() {
    let h = start().await;
    let dir = h.server.app.downloads_dir();
    let file = dir.join("Movie (2020).mp4");
    std::fs::write(&file, bytes_1000()).unwrap();
    let path = file.to_string_lossy().into_owned();
    let folder = dir.to_string_lossy().into_owned();
    h.server
        .app
        .db_call(move |c| {
            c.execute(
                "INSERT INTO downloads(id, source_id, content_type, item_id, title, url, file_name, file_path, status)
                 VALUES (1, 's', 'movie', '1', 'Movie', 'http://x/1.mp4', 'Movie (2020).mp4', ?1, 'completed'),
                        (2, 's', 'movie', '2', 'Other', 'http://x/2.mp4', 'o.mp4', ?1, 'downloading'),
                        (3, 's', 'movie', '3', 'Dir', 'http://x/3.mp4', 'd', ?2, 'completed'),
                        (4, 's', 'movie', '4', 'Gone', 'http://x/4.mp4', 'g.mp4', ?3, 'completed')",
                [&path, &folder, &format!("{folder}/nope.mp4")],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let r = h
        .http
        .get(format!("{}/api/files/1", h.base))
        .header(header::RANGE, "bytes=10-19")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 10-19/1000");
    assert!(r.headers()[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("inline; filename=\"Movie (2020).mp4\""));
    assert_eq!(r.bytes().await.unwrap().as_ref(), &bytes_1000()[10..20]);

    let r = h
        .http
        .get(format!("{}/api/files/1", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(r.bytes().await.unwrap().len(), 1000);

    for (id, status) in [
        ("2", 409),
        ("3", 404),
        ("4", 404),
        ("99", 404),
        ("abc", 400),
    ] {
        let r = h
            .http
            .get(format!("{}/api/files/{id}", h.base))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), status, "download {id}");
    }
}

#[tokio::test]
async fn cross_origin_writes_are_refused() {
    let h = start().await;
    let url = format!("{}/api/rpc/app.ping", h.base);
    let r = h
        .http
        .post(&url)
        .header(header::ORIGIN, "http://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = h
        .http
        .post(&url)
        .header("sec-fetch-site", "cross-site")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = h
        .http
        .post(&url)
        .header(header::ORIGIN, h.base.as_str())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    // Reads without an Origin stay open (curl, health probes).
    let r = h
        .http
        .get(format!("{}/api/health", h.base))
        .header(header::ORIGIN, "http://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
}

#[tokio::test]
async fn loopback_bind_rejects_foreign_host_headers() {
    let h = start_with(|o| o.loopback_host_only = true).await;
    let url = format!("{}/api/health", h.base);
    let r = h
        .http
        .get(&url)
        .header(header::HOST, "rebind.evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let r = h
        .http
        .get(&url)
        .header(header::HOST, "localhost:7180")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
}

/// Minimal WebSocket client: handshake, then read one server text frame.
async fn ws_connect(
    addr: std::net::SocketAddr,
    origin: Option<&str>,
) -> (tokio::net::TcpStream, String) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let origin = origin
        .map(|o| format!("Origin: {o}\r\n"))
        .unwrap_or_default();
    let req = format!(
        "GET /api/events HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{origin}\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        s.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    (s, String::from_utf8(head).unwrap())
}

async fn ws_read_text(s: &mut tokio::net::TcpStream) -> String {
    loop {
        let mut hdr = [0u8; 2];
        s.read_exact(&mut hdr).await.unwrap();
        let opcode = hdr[0] & 0x0f;
        let mut len = (hdr[1] & 0x7f) as u64;
        if len == 126 {
            let mut b = [0u8; 2];
            s.read_exact(&mut b).await.unwrap();
            len = u16::from_be_bytes(b) as u64;
        } else if len == 127 {
            let mut b = [0u8; 8];
            s.read_exact(&mut b).await.unwrap();
            len = u64::from_be_bytes(b);
        }
        let mut payload = vec![0u8; len as usize];
        s.read_exact(&mut payload).await.unwrap();
        if opcode == 1 {
            return String::from_utf8(payload).unwrap();
        }
    }
}

#[tokio::test]
async fn events_socket_broadcasts_and_guards_origin() {
    let h = start().await;
    let (_, head) = ws_connect(h.addr, Some("http://evil.example")).await;
    assert!(head.starts_with("HTTP/1.1 403"), "{head}");

    let (mut s, head) = ws_connect(h.addr, Some(&h.base)).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    // Wait until the socket task subscribed, then emit through the core sink.
    for _ in 0..100 {
        if h.server.event_clients() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    h.server.app.emit("sources.changed", serde_json::json!({}));
    let text = tokio::time::timeout(std::time::Duration::from_secs(5), ws_read_text(&mut s))
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["type"], "sources.changed");

    // Shutdown closes the socket with a close frame.
    h.server.begin_shutdown();
    let mut hdr = [0u8; 2];
    tokio::time::timeout(std::time::Duration::from_secs(5), s.read_exact(&mut hdr))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hdr[0] & 0x0f, 8, "expected a close frame");
}
