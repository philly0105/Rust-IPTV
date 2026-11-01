//! Remote EPG fetches against an in-test axum stub: source headers, ETag /
//! 304, Last-Modified, gzip bodies without Content-Encoding, retry on 5xx,
//! HTTP errors, and refreshes that keep an unchanged body (a server without
//! validators, a local file). (iptv-mock's XMLTV routes are not required;
//! the stub keeps this test self-contained.)

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
    /// Body of the routes without an ETag.
    plain_body: Mutex<String>,
    plain: AtomicU32,
    if_modified_since: Mutex<Vec<String>>,
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

/// The same body every time, with no validator.
async fn plain(State(h): State<Arc<Hits>>) -> Response {
    h.plain.fetch_add(1, Ordering::SeqCst);
    let body = h.plain_body.lock().clone();
    ([(header::CONTENT_TYPE, "application/xml")], body).into_response()
}

const DATED: &str = "Wed, 21 Oct 2026 07:28:00 GMT";

/// A server that sends only Last-Modified.
async fn dated(State(h): State<Arc<Hits>>, headers: HeaderMap) -> Response {
    let since = headers
        .get(header::IF_MODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    h.if_modified_since.lock().push(since.clone());
    if since == DATED {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let body = h.plain_body.lock().clone();
    ([(header::LAST_MODIFIED, DATED)], body).into_response()
}

async fn flaky(State(h): State<Arc<Hits>>) -> Response {
    if h.flaky.fetch_add(1, Ordering::SeqCst) == 0 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    feed().into_response()
}

async fn spawn_stub() -> (String, Arc<Hits>, tokio::sync::oneshot::Sender<()>) {
    let hits = Arc::new(Hits::default());
    *hits.plain_body.lock() = feed();
    let app = Router::new()
        .route("/epg.xml", get(epg_xml))
        .route("/plain.xml", get(plain))
        .route("/dated.xml", get(dated))
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
    assert_eq!(
        changes(&mut events),
        [status.clone(), serde_json::json!({})]
    );
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

fn epg_changes(events: &mut tokio::sync::broadcast::Receiver<AppEvent>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Ok(ev) = events.try_recv() {
        if ev.kind == "epg.changed" {
            out.push(ev.payload);
        }
    }
    out
}

/// The last programme rowid and the programme count.
async fn programme_rows(state: &AppState) -> (i64, i64) {
    state
        .db_call(|c| {
            Ok(
                c.query_row("SELECT max(rowid), count(*) FROM epg_programs", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?,
            )
        })
        .await
        .unwrap()
}

/// A failed refresh changed no guide data: its `epg.changed` is
/// status-only, like the one at its start, and the generation stays.
#[tokio::test]
async fn a_failed_refresh_is_a_status_only_change() {
    let (base, _hits, _stop) = spawn_stub().await;
    let url = format!("{base}/missing.xml");
    let (_tmp, state, mut events) = state_with_events(std::slice::from_ref(&url)).await;
    let rt = epg::runtime(&state);
    let before = rt.generation();
    assert!(epg::refresh_now(state.clone(), &url).await.is_err());
    let status = serde_json::json!({"reason": "status"});
    assert_eq!(epg_changes(&mut events), [status.clone(), status]);
    assert_eq!(rt.generation(), before);
}

/// A server that sends no validator: a refresh that gets the body the
/// stored guide came from keeps that guide (no parse, no swap, a
/// status-only change). A changed body is read again, and so is the same
/// body a day after it was read, so the stored window moves on.
#[tokio::test]
async fn an_unchanged_body_without_validators_keeps_the_stored_guide() {
    let (base, hits, _stop) = spawn_stub().await;
    let url = format!("{base}/plain.xml");
    let (_tmp, state, mut events) = state_with_events(std::slice::from_ref(&url)).await;
    let rt = epg::runtime(&state);
    let status = serde_json::json!({"reason": "status"});

    let first = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(!first.not_modified);
    assert_eq!(first.programs, 5);
    let rows = programme_rows(&state).await;
    let generation = rt.generation();
    epg_changes(&mut events);

    let second = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(second.not_modified);
    assert_eq!((second.channels, second.programs), (1, 5));
    assert_eq!(hits.plain.load(Ordering::SeqCst), 2, "downloaded again");
    assert_eq!(programme_rows(&state).await, rows, "nothing rewritten");
    assert_eq!(rt.generation(), generation);
    assert_eq!(epg_changes(&mut events), [status.clone(), status.clone()]);
    let list = epg::sources(&state).await.unwrap();
    assert_eq!(list[0].status, iptv_core::model::EpgFetchStatus::Ok);
    assert_eq!(list[0].program_count, 5);

    // A changed body is read again.
    hits.plain_body.lock().push('\n');
    let third = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(!third.not_modified);
    assert_eq!(rt.generation(), generation + 1);

    // The same body a day after it was read is read again.
    let key = format!("epg_validators:{url}");
    state
        .db_call(move |c| {
            let value: String =
                c.query_row("SELECT value FROM app_state WHERE key = ?1", [&key], |r| {
                    r.get(0)
                })?;
            let mut v: serde_json::Value = serde_json::from_str(&value).unwrap();
            let day_ago = chrono::Utc::now().timestamp() - 24 * 3600 - 60;
            v["ingestedAt"] = day_ago.into();
            c.execute(
                "UPDATE app_state SET value = ?2 WHERE key = ?1",
                rusqlite::params![key, v.to_string()],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let fourth = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(!fourth.not_modified);
    let fifth = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(fifth.not_modified, "read today: kept again");

    // Clearing the guide forgets the body: the next refresh reads it.
    state
        .db_call(|c| epg::store::clear_all(c).map(drop))
        .await
        .unwrap();
    let sixth = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(!sixth.not_modified);
    assert_eq!(sixth.programs, 5);
}

/// A server that sends only Last-Modified gets it back as
/// If-Modified-Since, and its 304 keeps the guide.
#[tokio::test]
async fn last_modified_is_sent_back() {
    let (base, hits, _stop) = spawn_stub().await;
    let url = format!("{base}/dated.xml");
    let (_tmp, state, mut events) = state_with_events(std::slice::from_ref(&url)).await;
    let rt = epg::runtime(&state);
    let first = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(!first.not_modified);
    let generation = rt.generation();
    epg_changes(&mut events);
    let second = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(second.not_modified);
    assert_eq!(second.programs, 5);
    assert_eq!(hits.if_modified_since.lock().as_slice(), ["", DATED]);
    assert_eq!(rt.generation(), generation);
    let status = serde_json::json!({"reason": "status"});
    assert_eq!(epg_changes(&mut events), [status.clone(), status]);
}

/// A local guide file with the same size and modification time is not read
/// again, and the stored guide keeps its unreadable-feed warning; a new
/// modification time reads it again.
#[tokio::test]
async fn an_unchanged_local_file_is_not_read_again() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("guide.xml");
    // Two readable programmes and three in an unknown zone: a thin guide
    // with a warning.
    let now = chrono::Utc::now();
    let ts = |h: i64, zone: &str| {
        format!(
            "{} {zone}",
            (now + chrono::Duration::hours(h)).format("%Y%m%d%H%M%S")
        )
    };
    let mut xml =
        String::from("<tv><channel id=\"h.1\"><display-name>Http One</display-name></channel>");
    for (h, zone) in [
        (0, "+0000"),
        (1, "+0000"),
        (2, "XYZ"),
        (3, "XYZ"),
        (4, "XYZ"),
    ] {
        xml.push_str(&format!(
            "<programme channel=\"h.1\" start=\"{}\" stop=\"{}\"><title>T{h}</title></programme>",
            ts(h, zone),
            ts(h + 1, zone)
        ));
    }
    xml.push_str("</tv>");
    std::fs::write(&path, xml).unwrap();
    let url = path.to_string_lossy().into_owned();
    let (_data, state) = state_with_source(std::slice::from_ref(&url)).await;

    let first = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert_eq!(first.programs, 2);
    let warning = first.warning.clone().expect("unreadable warning");
    assert!(warning.starts_with("epg_unreadable:"), "{warning}");
    let rows = programme_rows(&state).await;

    let second = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(second.not_modified);
    assert_eq!(second.warning.as_deref(), Some(warning.as_str()));
    assert_eq!(programme_rows(&state).await, rows);
    let list = epg::sources(&state).await.unwrap();
    assert_eq!(list[0].status, iptv_core::model::EpgFetchStatus::Ok);
    assert_eq!(list[0].error.as_deref(), Some(warning.as_str()));

    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
        .unwrap();
    let third = epg::refresh_now(state.clone(), &url).await.unwrap();
    assert!(!third.not_modified);
    assert_eq!(third.programs, 2);
}
