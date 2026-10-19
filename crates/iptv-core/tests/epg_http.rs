//! Remote EPG fetches against an in-test axum stub: source headers, ETag /
//! 304, gzip bodies without Content-Encoding, retry on 5xx, HTTP errors.
//! (iptv-mock's XMLTV routes are not required; the stub keeps this test
//! self-contained.)

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::epg;
use iptv_core::{AppEvent, AppState, BroadcastSink};
use parking_lot::Mutex;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

#[derive(Default)]
struct Hits {
    user_agents: Mutex<Vec<String>>,
    referers: Mutex<Vec<String>>,
    full: AtomicU32,
    not_modified: AtomicU32,
    flaky: AtomicU32,
}

fn feed() -> String {
    let now = chrono::Utc::now().timestamp();
    let base = now - now % 3600 - 3600;
    let ts = |t: i64| {
        chrono::DateTime::from_timestamp(t, 0)
            .unwrap()
            .format("%Y%m%d%H%M%S +0000")
            .to_string()
    };
    let mut xml =
        String::from("<tv><channel id=\"h.1\"><display-name>Http One</display-name></channel>");
    for i in 0..5 {
        xml.push_str(&format!(
            "<programme start=\"{}\" stop=\"{}\" channel=\"h.1\"><title>Remote {i}</title></programme>",
            ts(base + i * 3600),
            ts(base + (i + 1) * 3600)
        ));
    }
    xml.push_str("</tv>");
    xml
}

fn gz(data: &[u8]) -> Vec<u8> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data).unwrap();
    enc.finish().unwrap()
}

async fn epg_xml(State(h): State<Arc<Hits>>, headers: HeaderMap) -> Response {
    let get = |k: header::HeaderName| {
        headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    h.user_agents.lock().push(get(header::USER_AGENT));
    h.referers.lock().push(get(header::REFERER));
    if get(header::IF_NONE_MATCH) == "\"v1\"" {
        h.not_modified.fetch_add(1, Ordering::SeqCst);
        return StatusCode::NOT_MODIFIED.into_response();
    }
    h.full.fetch_add(1, Ordering::SeqCst);
    (
        [
            (header::ETAG, "\"v1\""),
            (header::CONTENT_TYPE, "application/xml"),
        ],
        feed(),
    )
        .into_response()
}

async fn epg_gz() -> Response {
    (
        [(header::CONTENT_TYPE, "application/octet-stream")],
        gz(feed().as_bytes()),
    )
        .into_response()
}

async fn flaky(State(h): State<Arc<Hits>>) -> Response {
    if h.flaky.fetch_add(1, Ordering::SeqCst) == 0 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    feed().into_response()
}

async fn spawn_stub() -> (String, Arc<Hits>, tokio::sync::oneshot::Sender<()>) {
    let hits = Arc::new(Hits::default());
    let app = Router::new()
        .route("/epg.xml", get(epg_xml))
        .route("/epg.gz", get(epg_gz))
        .route("/flaky.xml", get(flaky))
        .route("/missing.xml", get(|| async { StatusCode::NOT_FOUND }))
        .route("/denied.xml", get(|| async { StatusCode::FORBIDDEN }))
        .with_state(hits.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    (format!("http://127.0.0.1:{port}"), hits, tx)
}

async fn state_with_source(urls: &[String]) -> (tempfile::TempDir, Arc<AppState>) {
    let (tmp, state, _events) = state_with_events(urls).await;
    (tmp, state)
}

async fn state_with_events(
    urls: &[String],
) -> (
    tempfile::TempDir,
    Arc<AppState>,
    tokio::sync::broadcast::Receiver<AppEvent>,
) {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(1024);
    let state = AppState::new(tmp.path().join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    let links =
        serde_json::json!({"detectedUrls": urls, "manualUrls": [], "disabledUrls": []}).to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json, epg_json) VALUES ('s1', 'm3u', 'S', ?1, ?2)",
                rusqlite::params![
                    r#"{"origin":"url","url":"http://x/pl.m3u","headers":{"userAgent":"MyBox/1.0","referrer":"http://ref.example/"}}"#,
                    links
                ],
            )?;
            c.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id) VALUES ('s1','live','a','g','Http One','h.1')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    (tmp, state, events)
}

#[tokio::test]
async fn remote_fetch_uses_source_headers_and_etag() {
    let (base, hits, _stop) = spawn_stub().await;
    let url = format!("{base}/epg.xml");
    let (_tmp, state) = state_with_source(std::slice::from_ref(&url)).await;

    let stats = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert_eq!(stats.programs, 5);
    assert!(!stats.not_modified);
    assert_eq!(hits.user_agents.lock().as_slice(), ["MyBox/1.0"]);
    assert_eq!(hits.referers.lock().as_slice(), ["http://ref.example/"]);

    let list = epg::sources(&state).await.unwrap();
    assert_eq!(list[0].origin, iptv_core::model::EpgOrigin::Source);
    assert_eq!(list[0].source_id.as_deref(), Some("s1"));
    assert_eq!(list[0].program_count, 5);

    // Second fetch sends If-None-Match and keeps the data on 304.
    let stats = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(stats.not_modified);
    assert_eq!(stats.programs, 5);
    assert_eq!(hits.not_modified.load(Ordering::SeqCst), 1);
    assert_eq!(hits.full.load(Ordering::SeqCst), 1);
    let nn = epg::now_next(
        &state,
        vec![iptv_core::model::ItemRef::new(
            "s1",
            iptv_core::model::ContentType::Live,
            "a",
        )],
    )
    .await
    .unwrap();
    assert!(nn.values().next().unwrap().now.is_some());

    // Temp downloads are cleaned up.
    let leftovers = std::fs::read_dir(state.data_dir.join("tmp"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(leftovers, 0);
}

/// EP-2: a refresh starting, and one that ends on a 304, changed no guide
/// data: their `epg.changed` carries `reason: "status"` and the generation
/// (the cached channel directory) stays. A full download bumps it.
#[tokio::test]
async fn refresh_start_and_304_are_status_only_changes() {
    let (base, _hits, _stop) = spawn_stub().await;
    let url = format!("{base}/epg.xml");
    let (_tmp, state, mut events) = state_with_events(std::slice::from_ref(&url)).await;
    let changes = |events: &mut tokio::sync::broadcast::Receiver<AppEvent>| {
        let mut out = Vec::new();
        while let Ok(ev) = events.try_recv() {
            if ev.kind == "epg.changed" {
                out.push(ev.payload);
            }
        }
        out
    };
    let rt = epg::runtime(&state);

    let before = rt.generation();
    epg::refresh_now(state.clone(), &url).await.unwrap();
    let status = serde_json::json!({"reason": "status"});
    assert_eq!(changes(&mut events), [status.clone(), serde_json::json!({})]);
    assert_eq!(rt.generation(), before + 1);

    let stats = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(stats.not_modified);
    assert_eq!(changes(&mut events), [status.clone(), status]);
    assert_eq!(rt.generation(), before + 1, "a 304 keeps the directory");
}

#[tokio::test]
async fn gzip_body_retry_and_http_errors() {
    let (base, hits, _stop) = spawn_stub().await;
    let urls = vec![
        format!("{base}/epg.gz"),
        format!("{base}/flaky.xml"),
        format!("{base}/missing.xml"),
        format!("{base}/denied.xml"),
    ];
    let (_tmp, state) = state_with_source(&urls).await;

    let stats = epg::refresh_now(state.clone(), &urls[0]).await.unwrap();
    assert_eq!(stats.programs, 5, "gzip detected by magic bytes");

    let stats = epg::refresh_now(state.clone(), &urls[1]).await.unwrap();
    assert_eq!(stats.programs, 5, "503 retried");
    assert_eq!(hits.flaky.load(Ordering::SeqCst), 2);

    let err = epg::refresh_now(state.clone(), &urls[2]).await.unwrap_err();
    assert!(matches!(err, iptv_core::CoreError::NotFound(_)), "{err}");
    // B8: the message names the host and says what to do.
    let msg = err.to_string();
    assert!(
        msg.contains("127.0.0.1 answered the guide (EPG) download: HTTP 404")
            && msg.contains("Check the guide URL"),
        "{msg}"
    );
    let err = epg::refresh_now(state.clone(), &urls[3]).await.unwrap_err();
    assert!(matches!(err, iptv_core::CoreError::Auth(_)), "{err}");

    let list = epg::sources(&state).await.unwrap();
    let by_url = |u: &str| list.iter().find(|s| s.url == u).unwrap().clone();
    assert_eq!(
        by_url(&urls[2]).status,
        iptv_core::model::EpgFetchStatus::Error
    );
    let msg = by_url(&urls[3]).error.unwrap();
    assert!(msg.contains("refused"), "{msg}");
    assert_eq!(
        by_url(&urls[0]).status,
        iptv_core::model::EpgFetchStatus::Ok
    );
}
