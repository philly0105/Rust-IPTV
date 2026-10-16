//! Loop 3 (core-serve, L3-perf-core-8): server mode compresses RPC replies
//! and the built UI for clients that accept it (brotli or gzip, 1 KiB and
//! up), serves precompressed assets as they are, and leaves small replies,
//! images and clients without `Accept-Encoding` alone.

use axum::http::header;
use axum::routing::get;
use axum::Router;
use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::rpc::build_router;
use iptv_core::AppState;
use iptv_server::{Server, ServerOptions};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::Arc;
use tokio::sync::broadcast;

const BIG_ASSET: &str = "/assets/index-Bk3a9_zQ.js";
const PRE_ASSET: &str = "/assets/vendor-C1x2y3z4.js";

struct Harness {
    base: String,
    /// No automatic decompression: the test sees the bytes on the wire.
    raw: reqwest::Client,
    _tmp: tempfile::TempDir,
}

fn big_js() -> String {
    (0..2000)
        .map(|i| format!("export const v{i} = \"value number {i}\";\n"))
        .collect()
}

async fn start() -> Harness {
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html><title>x</title>").unwrap();
    std::fs::write(dist.join(BIG_ASSET.trim_start_matches('/')), big_js()).unwrap();
    let pre = dist.join(PRE_ASSET.trim_start_matches('/'));
    std::fs::write(&pre, big_js()).unwrap();
    // A precompressed copy (what a build step would emit), marked so the
    // test can tell it from an on-the-fly result.
    std::fs::write(pre.with_extension("js.br"), b"PRECOMPRESSED-BROTLI").unwrap();

    let (tx, _) = broadcast::channel::<AppEvent>(64);
    let app = AppState::new(
        tmp.path().join("data"),
        Arc::new(BroadcastSink(tx.clone())),
        false,
    )
    .await
    .unwrap();
    let mut opts = ServerOptions::new(dist);
    opts.allow_private_targets = true;
    let server = Server::new(app, Arc::new(build_router()), tx, opts);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let router = iptv_server::router(server);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Harness {
        base: format!("http://{addr}"),
        raw: reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .build()
            .unwrap(),
        _tmp: tmp,
    }
}

/// `epg.nowNext` args for `n` refs without a guide: about 15 reply bytes each.
fn now_next_args(n: usize) -> Value {
    let refs: Vec<Value> = (0..n)
        .map(|i| json!({ "sourceId": "s", "contentType": "live", "itemId": i.to_string() }))
        .collect();
    json!({ "refs": refs })
}

impl Harness {
    async fn rpc(&self, cmd: &str, args: &Value, encoding: Option<&str>) -> reqwest::Response {
        let mut req = self
            .raw
            .post(format!("{}/api/rpc/{cmd}", self.base))
            .json(args);
        if let Some(e) = encoding {
            req = req.header(header::ACCEPT_ENCODING, e);
        }
        req.send().await.unwrap()
    }

    async fn get(&self, path: &str, encoding: &str) -> reqwest::Response {
        self.raw
            .get(format!("{}{path}", self.base))
            .header(header::ACCEPT_ENCODING, encoding)
            .send()
            .await
            .unwrap()
    }
}

fn encoding(res: &reqwest::Response) -> Option<String> {
    res.headers()
        .get(header::CONTENT_ENCODING)
        .map(|v| v.to_str().unwrap().to_owned())
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .unwrap();
    out
}

#[tokio::test]
async fn rpc_replies_are_compressed_for_clients_that_accept_it() {
    let h = start().await;
    let args = now_next_args(200);
    let plain = h.rpc("epg.nowNext", &args, None).await;
    assert_eq!(plain.status(), 200);
    assert_eq!(encoding(&plain), None, "no Accept-Encoding, no compression");
    let plain = plain.bytes().await.unwrap();
    assert!(plain.len() > 2000, "{}", plain.len());

    let br = h.rpc("epg.nowNext", &args, Some("gzip, deflate, br")).await;
    assert_eq!(br.status(), 200);
    assert_eq!(encoding(&br).as_deref(), Some("br"));
    let vary = br.headers().get(header::VARY).unwrap().to_str().unwrap();
    assert!(
        vary.to_ascii_lowercase().contains("accept-encoding"),
        "{vary}"
    );
    assert!(br.bytes().await.unwrap().len() * 5 < plain.len());

    let gz = h.rpc("epg.nowNext", &args, Some("gzip")).await;
    assert_eq!(encoding(&gz).as_deref(), Some("gzip"));
    let body = gunzip(&gz.bytes().await.unwrap());
    let a: Value = serde_json::from_slice(&body).unwrap();
    let b: Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(a, b, "the same reply, compressed");
}

#[tokio::test]
async fn small_rpc_replies_are_sent_as_they_are() {
    let h = start().await;
    let res = h
        .rpc("epg.nowNext", &now_next_args(1), Some("br, gzip"))
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(encoding(&res), None);
}

#[tokio::test]
async fn ui_assets_are_compressed_and_precompressed_copies_win() {
    let h = start().await;
    let res = h.get(BIG_ASSET, "gzip").await;
    assert_eq!(res.status(), 200);
    assert_eq!(encoding(&res).as_deref(), Some("gzip"));
    let cache = res.headers().get(header::CACHE_CONTROL).unwrap().clone();
    assert_eq!(cache, iptv_server::static_files::IMMUTABLE);
    assert_eq!(gunzip(&res.bytes().await.unwrap()), big_js().as_bytes());

    let res = h.get(PRE_ASSET, "br").await;
    assert_eq!(encoding(&res).as_deref(), Some("br"));
    assert_eq!(
        res.bytes().await.unwrap().as_ref(),
        b"PRECOMPRESSED-BROTLI",
        "the .br file, not compressed again"
    );

    // A Range request gets the plain bytes it asked for.
    let res = h
        .raw
        .get(format!("{}{BIG_ASSET}", h.base))
        .header(header::ACCEPT_ENCODING, "gzip")
        .header(header::RANGE, "bytes=0-9")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(encoding(&res), None);
    assert_eq!(
        res.bytes().await.unwrap().as_ref(),
        &big_js().as_bytes()[..10]
    );
}

#[tokio::test]
async fn images_are_never_compressed() {
    let h = start().await;
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg'>{}</svg>",
        "<rect width='1' height='1'/>".repeat(200)
    );
    let body = svg.clone();
    let app = Router::new().route(
        "/logo.svg",
        get(move || {
            let body = body.clone();
            async move { ([(header::CONTENT_TYPE, "image/svg+xml")], body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/logo.svg", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let mut url = url::Url::parse(&format!("{}/api/img", h.base)).unwrap();
    url.query_pairs_mut().append_pair("url", &upstream);
    let res = h
        .raw
        .get(url)
        .header(header::ACCEPT_ENCODING, "br, gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(encoding(&res), None);
    assert_eq!(res.bytes().await.unwrap().as_ref(), svg.as_bytes());
}

/// L3-serve-ui-3: a deep link (the SPA fallback) gets the build's
/// precompressed `index.html.br` when the client accepts br, like `/` does,
/// and the plain file when there is none or the client does not accept br.
#[tokio::test]
async fn deep_links_get_the_precompressed_index() {
    let h = start().await;
    let index = h._tmp.path().join("dist").join("index.html");
    let plain = std::fs::read(&index).unwrap();

    let res = h.get("/live/x", "gzip, deflate, br").await;
    assert_eq!(res.status(), 200);
    assert_eq!(encoding(&res), None, "no index.html.br: the plain file");
    assert_eq!(res.bytes().await.unwrap().as_ref(), plain.as_slice());

    std::fs::write(index.with_extension("html.br"), b"PRECOMPRESSED-INDEX").unwrap();
    let res = h.get("/live/x", "gzip, deflate, br").await;
    assert_eq!(res.status(), 200);
    assert_eq!(encoding(&res).as_deref(), Some("br"));
    let cache = res.headers().get(header::CACHE_CONTROL).unwrap().clone();
    assert_eq!(cache, iptv_server::static_files::NO_CACHE);
    let mime = res.headers().get(header::CONTENT_TYPE).unwrap().clone();
    assert!(mime.to_str().unwrap().starts_with("text/html"), "{mime:?}");
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"PRECOMPRESSED-INDEX");

    let res = h.get("/live/x", "identity").await;
    assert_eq!(res.status(), 200);
    assert_eq!(encoding(&res), None, "a client without br: the plain file");
    assert_eq!(res.bytes().await.unwrap().as_ref(), plain.as_slice());
}
