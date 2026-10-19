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
        .route(
            "/live/ranged-playlist",
            get(|h: HeaderMap| async move {
                // Honors Range like a static file server would.
                let ct = [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")];
                match h.get(header::RANGE).and_then(|v| v.to_str().ok()) {
                    Some(_) => (
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                            (
                                header::CONTENT_RANGE,
                                &*format!("bytes 10-19/{}", PLAYLIST.len()),
                            ),
                        ],
                        PLAYLIST[10..20].to_string(),
                    )
                        .into_response(),
                    None => (ct, PLAYLIST).into_response(),
                }
            }),
        )
        .route(
            "/page.html",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/html")],
                    "<script>alert(1)</script>",
                )
            }),
        )
        .route(
            "/headers.ts",
            get(|h: HeaderMap| async move {
                let get = |n: header::HeaderName| {
                    h.get(n)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_owned()
                };
                (
                    [(header::CONTENT_TYPE, "video/mp2t")],
                    format!(
                        "{}|{}|{}",
                        get(header::USER_AGENT),
                        get(header::REFERER),
                        get(header::ORIGIN)
                    ),
                )
            }),
        )
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

type RangeLog = Arc<std::sync::Mutex<Vec<Option<String>>>>;

/// A 1000-byte movie whose first answer drops after 300 bytes; later answers
/// honour Range. `ranges: false` leaves `Accept-Ranges` out of the first
/// answer. Returns the base URL and the Range header of every request.
async fn spawn_dropping_movie(ranges: bool) -> (String, RangeLog) {
    use futures::StreamExt;
    let log = RangeLog::default();
    let seen = Arc::clone(&log);
    let app = Router::new().route(
        "/movie/u/p/1.mp4",
        get(move |req: Request| {
            let seen = Arc::clone(&seen);
            async move {
                let range = req.headers().get(header::RANGE);
                let range = range.and_then(|v| v.to_str().ok()).map(str::to_owned);
                let first = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(range);
                    seen.len() == 1
                };
                if !first {
                    return serve_bytes(req).await;
                }
                let head = bytes::Bytes::copy_from_slice(&bytes_1000()[..300]);
                let head = futures::stream::once(async move { Ok::<_, std::io::Error>(head) });
                // The pause lets the 300 bytes go out before the connection drops.
                let cut = futures::stream::once(async {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    Err::<bytes::Bytes, _>(std::io::Error::other("connection dropped"))
                });
                let body = axum::body::Body::from_stream(head.chain(cut));
                let mut res = Response::builder()
                    .header(header::CONTENT_TYPE, "video/mp4")
                    .header(header::CONTENT_LENGTH, "1000");
                if ranges {
                    res = res.header(header::ACCEPT_RANGES, "bytes");
                }
                res.body(body).unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), log)
}

#[tokio::test]
async fn proxy_resumes_a_movie_whose_connection_drops() {
    let (stub, ranges) = spawn_dropping_movie(true).await;
    let h = start().await;
    h.add_source(
        "x-1",
        "xtream",
        serde_json::json!({ "serverUrl": stub, "username": "u", "password": "p" }),
    )
    .await;
    let url = h.proxy_url(&format!("{stub}/movie/u/p/1.mp4"), Some("x-1"));

    // The player gets one whole answer; the proxy asked for the rest itself.
    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()[header::CONTENT_LENGTH], "1000");
    assert_eq!(r.bytes().await.unwrap().as_ref(), bytes_1000().as_slice());
    let ranges = ranges.lock().unwrap().clone();
    assert_eq!(ranges.len(), 2, "{ranges:?}");
    assert_eq!(ranges[0], None);
    assert_eq!(ranges[1].as_deref(), Some("bytes=300-999"));
}

#[tokio::test]
async fn proxy_passes_a_drop_on_when_the_server_takes_no_ranges() {
    let (stub, ranges) = spawn_dropping_movie(false).await;
    let h = start().await;
    h.add_source(
        "x-1",
        "xtream",
        serde_json::json!({ "serverUrl": stub, "username": "u", "password": "p" }),
    )
    .await;
    let url = h.proxy_url(&format!("{stub}/movie/u/p/1.mp4"), Some("x-1"));

    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.bytes().await.is_err());
    assert_eq!(ranges.lock().unwrap().len(), 1);
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
    // B9: a cross-site page cannot embed the GET routes either.
    for path in [
        "/api/files/1",
        "/api/proxy?url=http%3A%2F%2Fexample.com%2F",
        "/api/img?url=http%3A%2F%2Fexample.com%2Fposter.png",
        "/api/health",
    ] {
        let r = h
            .http
            .get(format!("{}{path}", h.base))
            .header("sec-fetch-site", "cross-site")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 403, "{path}");
    }
    let r = h
        .http
        .get(format!("{}/api/health", h.base))
        .header("sec-fetch-site", "same-origin")
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

// ---------------------------------------------------------------------------
// Fix wave 1 (B10-fix1): CSP, Host allowlist, server-mode guard, overrides.
// ---------------------------------------------------------------------------

async fn rpc(h: &Harness, cmd: &str, args: serde_json::Value) -> (u16, serde_json::Value) {
    let r = h
        .http
        .post(format!("{}/api/rpc/{cmd}", h.base))
        .json(&args)
        .send()
        .await
        .unwrap();
    let status = r.status().as_u16();
    (status, r.json().await.unwrap_or(serde_json::Value::Null))
}

#[tokio::test]
async fn proxy_and_files_never_serve_active_content() {
    let stub = spawn_stub().await;
    let h = start_with(|o| o.allow_private_targets = true).await;

    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/page.html"), None))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(r.headers()[header::CONTENT_DISPOSITION], "attachment");
    assert_eq!(
        r.headers()[header::CONTENT_SECURITY_POLICY],
        "sandbox; default-src 'none'"
    );
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");

    // Media keeps its type and is still sandboxed.
    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/bytes"), None))
        .send()
        .await
        .unwrap();
    assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp4");
    assert!(r.headers().get(header::CONTENT_DISPOSITION).is_none());
    assert_eq!(
        r.headers()[header::CONTENT_SECURITY_POLICY],
        "sandbox; default-src 'none'"
    );

    // A downloaded HTML page is an attachment with the sandbox CSP.
    let dir = h.server.app.downloads_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("page.html"), "<script>alert(1)</script>").unwrap();
    std::fs::write(dir.join("clip.mp4"), bytes_1000()).unwrap();
    let page = dir.join("page.html").to_string_lossy().into_owned();
    let clip = dir.join("clip.mp4").to_string_lossy().into_owned();
    h.server
        .app
        .db_call(move |c| {
            c.execute(
                "INSERT INTO downloads(id, source_id, content_type, item_id, title, url, file_name, file_path, status)
                 VALUES (7, 's', 'movie', '7', 'Page', 'http://x/p', 'page.html', ?1, 'completed'),
                        (8, 's', 'movie', '8', 'Clip', 'http://x/c', 'clip.mp4', ?2, 'completed')",
                [&page, &clip],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let r = h
        .http
        .get(format!("{}/api/files/7", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let cd = r.headers()[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(cd.starts_with("attachment"), "{cd}");
    assert_eq!(
        r.headers()[header::CONTENT_SECURITY_POLICY],
        "sandbox; default-src 'none'"
    );
    let r = h
        .http
        .get(format!("{}/api/files/8", h.base))
        .send()
        .await
        .unwrap();
    let cd = r.headers()[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(cd.starts_with("inline"), "{cd}");
    assert!(r.headers().contains_key(header::CONTENT_SECURITY_POLICY));

    // The SPA carries the site CSP.
    let r = h.http.get(format!("{}/", h.base)).send().await.unwrap();
    let csp = r.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap();
    assert!(csp.starts_with("default-src 'self'"), "{csp}");
    assert!(csp.contains("script-src 'self'"), "{csp}");
}

#[tokio::test]
async fn rebinding_host_is_refused_on_any_bind() {
    // The Host guard does not look at the bind address. The only thing a
    // non-loopback bind (0.0.0.0, as in Docker) changes is that main.rs adds
    // the machine host name to the allowed hosts, so this test sets the
    // options the same way and listens on loopback. Binding a wildcard address
    // in a test pops a Windows Firewall prompt.
    let tmp = tempfile::tempdir().unwrap();
    let (tx, _) = broadcast::channel::<AppEvent>(8);
    let app = AppState::new(
        tmp.path().join("data"),
        Arc::new(BroadcastSink(tx.clone())),
        false,
    )
    .await
    .unwrap();
    let mut opts = ServerOptions::new(tmp.path().join("dist"));
    let mut hosts = iptv_server::guard::AllowedHosts::parse("tv.example.com");
    hosts.add_machine_hostname();
    let machine = hosts
        .names()
        .iter()
        .find(|n| n.as_str() != "tv.example.com")
        .cloned();
    opts.allowed_hosts = hosts;
    let server = Server::new(app, Arc::new(build_router()), tx, opts);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = iptv_server::router(server);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let url = format!("http://127.0.0.1:{port}/api/health");
    let http = reqwest::Client::new();
    for (host, status) in [
        ("rebind.evil.example", 403),
        ("rebind.evil.example:7180", 403),
        ("localhost:7180", 200),
        ("192.168.1.20:7180", 200),
        ("tv.example.com", 200),
    ] {
        let r = http
            .get(&url)
            .header(header::HOST, host)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), status, "Host: {host}");
    }
    let r = http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    // The machine name added for a non-loopback bind is accepted.
    if let Some(name) = machine {
        let r = http
            .get(&url)
            .header(header::HOST, format!("{name}:7180"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "Host: {name}");
    }
}

#[tokio::test]
async fn proxy_refusal_explains_allow_private_targets() {
    let h = start().await;
    let r = h
        .http
        .get(h.proxy_url("http://192.168.1.5/stream.ts", None))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let v: serde_json::Value = r.json().await.unwrap();
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains("--allow-private-targets"),
        "{v}"
    );
}

#[tokio::test]
async fn proxy_query_headers_override_source_headers() {
    let stub = spawn_stub().await;
    let h = start().await;
    h.add_source(
        "plain",
        "m3u",
        serde_json::json!({ "origin": "url", "url": format!("{stub}/list.m3u"),
            "headers": { "userAgent": "SourceUA/1", "referrer": "http://source.example/" } }),
    )
    .await;

    // Source headers alone.
    let r = h
        .http
        .get(h.proxy_url(&format!("{stub}/headers.ts"), Some("plain")))
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.text().await.unwrap(),
        "SourceUA/1|http://source.example/|"
    );

    // Query overrides win; an empty value keeps the source's.
    let url = format!(
        "{}&ua=ChannelUA%2F2&referer=&origin=https%3A%2F%2Fchan.example",
        h.proxy_url(&format!("{stub}/headers.ts"), Some("plain"))
    );
    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(
        r.text().await.unwrap(),
        "ChannelUA/2|http://source.example/|https://chan.example"
    );

    // Overrides are carried into rewritten playlists and used by segments.
    let url = format!(
        "{}&ua=TestUA%2F1&referer=http%3A%2F%2Fref.example%2F",
        h.proxy_url(&format!("{stub}/live/index.m3u8"), Some("plain"))
    );
    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let text = r.text().await.unwrap();
    let seg = text
        .lines()
        .find(|l| l.contains("seg1.ts"))
        .unwrap()
        .to_owned();
    assert!(seg.contains("ua=TestUA%2F1"), "{seg}");
    assert!(seg.contains("referer=http%3A%2F%2Fref.example%2F"), "{seg}");
    let r = h.http.get(format!("{}{seg}", h.base)).send().await.unwrap();
    assert_eq!(r.status(), 200);
}

fn download_args(source_id: &str, url: &str) -> serde_json::Value {
    serde_json::json!({
        "ref": { "sourceId": source_id, "contentType": "movie", "itemId": "1" },
        "title": "Probe",
        "url": url,
    })
}

#[tokio::test]
async fn server_mode_downloads_are_guarded() {
    let stub = spawn_stub().await;
    let h = start().await;

    // A loopback download for an unknown source is refused.
    let (status, v) = rpc(
        &h,
        "downloads.start",
        download_args("nope", &format!("{stub}/bytes")),
    )
    .await;
    assert_eq!(status, 400, "{v}");
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains("--allow-private-targets"),
        "{v}"
    );

    // The source's own host:port is trusted.
    h.add_source(
        "lan",
        "xtream",
        serde_json::json!({ "serverUrl": stub, "username": "u", "password": "p" }),
    )
    .await;
    let (status, v) = rpc(
        &h,
        "downloads.start",
        download_args("lan", &format!("{stub}/bytes")),
    )
    .await;
    assert_eq!(status, 200, "{v}");

    // ...but not another port on the same host.
    let other = format!("http://127.0.0.1:{}/x.mp4", h.addr.port());
    let (status, v) = rpc(&h, "downloads.start", download_args("lan2", &other)).await;
    assert_eq!(status, 400, "{v}");
}

#[tokio::test]
async fn desktop_downloads_may_reach_loopback() {
    let stub = spawn_stub().await;
    let tmp = tempfile::tempdir().unwrap();
    let app = AppState::new(
        tmp.path().to_path_buf(),
        Arc::new(iptv_core::NoopSink),
        true,
    )
    .await
    .unwrap();
    assert!(!iptv_core::http::is_server_mode(&app));
    let d = iptv_core::downloads::start(
        &app,
        iptv_core::downloads::StartRequest {
            item_ref: Some(iptv_core::model::ItemRef::new(
                "nope",
                iptv_core::model::ContentType::Movie,
                "1",
            )),
            title: "Probe".into(),
            url: format!("{stub}/bytes"),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(d.file_name.as_deref(), Some("Probe.mp4"));
    let _ = iptv_core::downloads::cancel(&app, d.id).await;
}

#[tokio::test]
async fn server_mode_refuses_server_paths() {
    let h = start().await;
    let (status, v) = rpc(
        &h,
        "downloads.setDir",
        serde_json::json!({ "path": "/tmp/elsewhere" }),
    )
    .await;
    assert_eq!(status, 501, "{v}");
    assert!(v["message"].as_str().unwrap().contains("IPTV_DATA_DIR"));

    let (status, v) = rpc(
        &h,
        "settings.update",
        serde_json::json!({ "patch": { "downloadsDir": "/etc" } }),
    )
    .await;
    assert_eq!(status, 501, "{v}");
    // Leaving it unchanged passes.
    let (status, v) = rpc(
        &h,
        "settings.update",
        serde_json::json!({ "patch": { "downloadsDir": null } }),
    )
    .await;
    assert_eq!(status, 200, "{v}");

    for m3u in [
        serde_json::json!({ "origin": "file", "filePath": "/etc/passwd" }),
        serde_json::json!({ "origin": "url", "url": "file:///etc/passwd" }),
    ] {
        let (status, v) = rpc(
            &h,
            "sources.add",
            serde_json::json!({ "kind": "m3u", "name": "x", "m3u": m3u }),
        )
        .await;
        assert_eq!(status, 501, "{v}");
        assert!(v["message"]
            .as_str()
            .unwrap()
            .contains("Upload the playlist text"));
    }
    let (status, _) = rpc(
        &h,
        "sources.update",
        serde_json::json!({ "id": "x", "patch": { "m3u": { "origin": "file", "filePath": "/x" } } }),
    )
    .await;
    assert_eq!(status, 501);

    // A backup's filePathHint is ignored; the embedded text is imported.
    let hint = h._tmp.path().join("list.m3u");
    std::fs::write(&hint, "#EXTM3U\n").unwrap();
    let backup = serde_json::json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [{
            "portalType": "m3u", "exportedId": "file-one", "title": "File",
            "source": { "kind": "file",
                        "rawM3u": "#EXTM3U\n#EXTINF:-1,One\nhttp://a.example/1.ts\n",
                        "filePathHint": hint.to_string_lossy() }
        }]
    });
    let (status, v) = rpc(
        &h,
        "backup.import",
        serde_json::json!({ "json": backup.to_string(), "mode": "merge" }),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    assert!(
        v["warnings"].to_string().contains("file path was ignored"),
        "{v}"
    );
    let origin: String = h
        .server
        .app
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT json_extract(config_json, '$.origin') FROM sources",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(origin, "text");
}

// ---------------------------------------------------------------------------
// B9: contracts C7, C8 and C10 over HTTP.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http_exposes_cancel_import_viewed_at_and_error_codes() {
    let h = start().await;
    // C8: nothing running -> false.
    let (status, v) = rpc(
        &h,
        "sources.cancelImport",
        serde_json::json!({ "id": "none" }),
    )
    .await;
    assert_eq!((status, v), (200, serde_json::json!(false)));
    let (status, v) = rpc(&h, "sources.cancelImport", serde_json::json!({})).await;
    assert_eq!(status, 400);
    assert_eq!(v["code"], "invalid");

    // C7: viewedAt restores the date; garbage is a 400 `invalid`.
    h.add_source("s7", "m3u", serde_json::json!({ "origin": "text" }))
        .await;
    let entry = |viewed_at: serde_json::Value| {
        serde_json::json!({
            "ref": { "sourceId": "s7", "contentType": "live", "itemId": "c1" },
            "snapshot": { "title": "Channel", "contentType": "live" },
            "viewedAt": viewed_at,
        })
    };
    let (status, _) = rpc(&h, "recent.add", entry("2026-02-03T04:05:06Z".into())).await;
    assert_eq!(status, 200);
    let (_, list) = rpc(&h, "recent.list", serde_json::json!({ "sourceId": "s7" })).await;
    assert_eq!(list[0]["viewedAt"], "2026-02-03T04:05:06.000Z");
    let (status, v) = rpc(&h, "recent.add", entry("not a date".into())).await;
    assert_eq!(status, 400);
    assert_eq!(v["code"], "invalid");

    // C10: a source's recorded code is served as camelCase `lastErrorCode`.
    h.server
        .app
        .db_call(|c| {
            c.execute(
                "UPDATE sources SET last_error = 'down', last_error_code = 'timeout' WHERE id = 's7'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let (status, v) = rpc(&h, "sources.get", serde_json::json!({ "id": "s7" })).await;
    assert_eq!(status, 200);
    assert_eq!(v["lastError"], "down");
    assert_eq!(v["lastErrorCode"], "timeout");
}

#[tokio::test]
async fn proxy_never_serves_a_slice_of_a_playlist() {
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
        .get(h.proxy_url(&format!("{stub}/live/ranged-playlist"), Some("x-1")))
        .header(header::RANGE, "bytes=10-19")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()[header::CONTENT_TYPE],
        "application/vnd.apple.mpegurl"
    );
    assert!(r.headers().get(header::CONTENT_RANGE).is_none());
    let body = r.text().await.unwrap();
    assert!(body.starts_with("#EXTM3U"), "{body}");
    assert!(body.contains("/api/proxy?url="), "{body}");
}

// ---------------------------------------------------------------------------
// /api/img: the image cache route (Run 3 C2, check 4).
// ---------------------------------------------------------------------------

impl Harness {
    fn img_url(&self, target: &str, source_id: Option<&str>) -> String {
        let mut u = url::Url::parse(&format!("{}/api/img", self.base)).unwrap();
        u.query_pairs_mut().append_pair("url", target);
        if let Some(id) = source_id {
            u.query_pairs_mut().append_pair("sourceId", id);
        }
        u.to_string()
    }
}

/// Upstream requests the mock has seen for `path`.
async fn mock_hits(mock: &iptv_fixtures::MockHandle, path: &str) -> u64 {
    let v: serde_json::Value = reqwest::get(mock.url("/__mock/stats"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["requests"][path].as_u64().unwrap_or(0)
}

/// Asserts the sandbox headers every `/api/img` response carries.
fn assert_sandboxed(r: &reqwest::Response) {
    assert_eq!(
        r.headers()[header::CONTENT_SECURITY_POLICY],
        iptv_server::proxy::SANDBOX_CSP,
        "{}",
        r.url()
    );
    assert_eq!(r.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
}

#[tokio::test]
async fn img_serves_svg_posters_from_the_cache_with_sandbox_headers() {
    let mock = iptv_fixtures::spawn_mock().await;
    let h = start_with(|o| o.allow_private_targets = true).await;
    let path = "/img/poster/the-matrix.svg";
    let url = h.img_url(&mock.url(path), None);

    let mut bodies = Vec::new();
    for expected in ["miss", "hit"] {
        let r = h.http.get(&url).send().await.unwrap();
        assert_eq!(r.status(), 200, "{expected}");
        assert_eq!(r.headers()[header::CONTENT_TYPE], "image/svg+xml");
        assert_eq!(r.headers()["x-image-cache"], expected);
        assert_eq!(
            r.headers()[header::CACHE_CONTROL],
            "private, max-age=604800"
        );
        assert!(r.headers().contains_key(header::LAST_MODIFIED));
        assert_sandboxed(&r);
        let body = r.bytes().await.unwrap();
        assert!(body.starts_with(b"<svg"), "bytes as received");
        bodies.push(body);
    }
    assert_eq!(bodies[0], bodies[1]);
    assert_eq!(mock_hits(&mock, path).await, 1);

    // The client's `gen=<n>` (added after Clear) is ignored: same stored file.
    let r = h.http.get(format!("{url}&gen=2")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["x-image-cache"], "hit");
    assert_eq!(r.bytes().await.unwrap(), bodies[0]);
    assert_eq!(mock_hits(&mock, path).await, 1);

    // HEAD answers the same headers without a body.
    let r = h.http.head(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()[header::CONTENT_TYPE], "image/svg+xml");
    assert_eq!(r.headers()["x-image-cache"], "hit");
    assert_eq!(
        r.headers()[header::CONTENT_LENGTH],
        bodies[0].len().to_string().as_str()
    );
    assert!(r.bytes().await.unwrap().is_empty());

    // Revalidation after the week of browser caching: 304.
    let last_modified =
        h.http.get(&url).send().await.unwrap().headers()[header::LAST_MODIFIED].clone();
    let r = h
        .http
        .get(&url)
        .header(header::IF_MODIFIED_SINCE, last_modified)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 304);
    assert_eq!(r.headers()["x-image-cache"], "hit");
    assert_sandboxed(&r);

    // images.stats sees the file; images.clear empties the cache, so the
    // next request is a miss again.
    let (status, stats) = rpc(&h, "images.stats", serde_json::Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(stats["files"], 1);
    assert_eq!(stats["bytes"], bodies[0].len() as u64);
    assert_eq!(stats["maxBytes"], 500u64 * 1024 * 1024);
    let (status, cleared) = rpc(&h, "images.clear", serde_json::json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(cleared["files"], 0);
    assert_eq!(cleared["bytes"], 0);
    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["x-image-cache"], "miss");
    assert_eq!(mock_hits(&mock, path).await, 2);
}

#[tokio::test]
async fn img_answers_400_404_415_and_502_with_json_errors() {
    let mock = iptv_fixtures::spawn_mock().await;
    let h = start_with(|o| o.allow_private_targets = true).await;
    let cases: Vec<(String, u16, &str)> = vec![
        (format!("{}/api/img", h.base), 400, "invalid"),
        (format!("{}/api/img?url=", h.base), 400, "invalid"),
        (h.img_url("not-a-url", None), 400, "invalid"),
        (h.img_url("/img/poster/relative.svg", None), 400, "invalid"),
        (
            h.img_url("ftp://127.0.0.1/poster.png", None),
            400,
            "invalid",
        ),
        (
            h.img_url("http://user:pw@127.0.0.1/poster.png", None),
            400,
            "invalid",
        ),
        // An expired panel's HTML login page instead of an image.
        (
            h.img_url(&mock.url("/fail/login.m3u"), None),
            415,
            "unsupported",
        ),
        (
            h.img_url(&mock.url("/fail/404.m3u"), None),
            404,
            "not_found",
        ),
        (
            h.img_url(&mock.url("/img/nope/x.svg"), None),
            404,
            "not_found",
        ),
        (
            h.img_url(&mock.url("/fail/status/500"), None),
            502,
            "network",
        ),
        // 20 MiB of octet-stream: over the 10 MB limit, the upstream's fault
        // (502) but mapped onto C2's `invalid`.
        (
            h.img_url(&mock.url("/files/video.bin"), None),
            502,
            "invalid",
        ),
    ];
    for (url, status, code) in &cases {
        let r = h.http.get(url).send().await.unwrap();
        assert_eq!(r.status().as_u16(), *status, "{url}");
        assert_sandboxed(&r);
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store", "{url}");
        assert!(r.headers().get("x-image-cache").is_none(), "{url}");
        let v: serde_json::Value = r.json().await.unwrap();
        assert_eq!(v["code"], *code, "{url}: {v}");
        assert!(v["message"].as_str().is_some_and(|m| !m.is_empty()));
    }
    // Failures are remembered: asking again does not refetch.
    let r = h
        .http
        .get(h.img_url(&mock.url("/fail/login.m3u"), None))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 415);
    assert_eq!(mock_hits(&mock, "/fail/login.m3u").await, 1);
    // Nothing was stored, and the route sits before the catch-all.
    let (_, stats) = rpc(&h, "images.stats", serde_json::Value::Null).await;
    assert_eq!(stats["files"], 0);
    let r = h
        .http
        .get(format!("{}/api/imgs", h.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
}

#[tokio::test]
async fn img_refuses_private_targets_unless_a_source_trusts_them() {
    let mock = iptv_fixtures::spawn_mock().await;
    let h = start().await;
    let path = "/img/logo/guarded.svg";
    let target = mock.url(path);

    let r = h.http.get(h.img_url(&target, None)).send().await.unwrap();
    assert_eq!(r.status(), 403);
    assert_sandboxed(&r);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["code"], "invalid");
    assert_eq!(mock_hits(&mock, path).await, 0);

    // The mock is this source's own server, so its host:port is trusted.
    h.add_source(
        "mock",
        "m3u",
        serde_json::json!({ "url": mock.url("/m3u/sample.m3u") }),
    )
    .await;
    for expected in ["miss", "hit"] {
        let r = h
            .http
            .get(h.img_url(&target, Some("mock")))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "{expected}");
        assert_eq!(r.headers()["x-image-cache"], expected);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "image/svg+xml");
    }
    // Without the source it stays refused, cached or not.
    let r = h.http.get(h.img_url(&target, None)).send().await.unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(mock_hits(&mock, path).await, 1);
}
