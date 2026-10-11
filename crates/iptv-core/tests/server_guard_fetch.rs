//! Server-mode SSRF guard on core fetches (R5-r2 F1-F4, R1-r2 F2): Xtream
//! and Stalker use the guarded client, redirects to another port of a
//! trusted host name are refused, no client sends Referer, local EPG paths
//! are refused, a source's own guide is trusted, and backup import does not
//! reveal whether a path exists.

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use iptv_core::backup::{self, ImportMode};
use iptv_core::error::CoreError;
use iptv_core::events::BroadcastSink;
use iptv_core::http::{self, Authority, ServerMode};
use iptv_core::model::{EpgFetchStatus, RequestHeaders, StalkerSourceConfig, XtreamSourceConfig};
use iptv_core::{epg, settings, sources, AppEvent, AppState};
use parking_lot::Mutex;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

struct Env {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    events: Receiver<AppEvent>,
}

async fn env(server_mode: bool) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(10_000);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(state.clone()).await.unwrap();
    if server_mode {
        ServerMode::install(&state, false).expect("server mode installed");
    }
    Env {
        _dir: dir,
        state,
        events,
    }
}

/// Requests seen by the stub: `(host header, path, referer)`.
#[derive(Default)]
struct Seen {
    hits: Mutex<Vec<(String, String, Option<String>)>>,
    /// Location of `/other-port`.
    other_port: Mutex<String>,
}

impl Seen {
    fn paths(&self) -> Vec<String> {
        self.hits.lock().iter().map(|h| h.1.clone()).collect()
    }
}

/// `/echo` answers with the Referer it got (or `none`), `/to-echo`
/// redirects there, `/other-port` redirects to `Seen::other_port`, `/hit*`
/// answers 200; anything else (Xtream / Stalker API calls) redirects to
/// `http://localhost:<port>/hit...`, an authority nobody trusted.
async fn stub(State((seen, port)): State<(Arc<Seen>, u16)>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let referer = req
        .headers()
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    seen.hits.lock().push((host, path.clone(), referer.clone()));
    let redirect = |to: String| (StatusCode::FOUND, [(header::LOCATION, to)]).into_response();
    match path.as_str() {
        "/echo" => referer.unwrap_or_else(|| "none".into()).into_response(),
        "/to-echo" => redirect("/echo".into()),
        "/other-port" => redirect(seen.other_port.lock().clone()),
        p if p.starts_with("/hit") => "hit".into_response(),
        p => redirect(format!("http://localhost:{port}/hit{p}")),
    }
}

async fn spawn_stub() -> (String, Arc<Seen>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Seen::default());
    let app = Router::new()
        .fallback(stub)
        .with_state((seen.clone(), port));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://127.0.0.1:{port}"), seen)
}

fn closed_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.local_addr().unwrap().port()
}

#[tokio::test]
async fn server_guard_xtream_redirect_to_untrusted_authority_is_refused() {
    let e = env(true).await;
    let (base, seen) = spawn_stub().await;
    let cfg = XtreamSourceConfig {
        server_url: base.clone(),
        username: "u".into(),
        password: "p".into(),
    };
    let res = iptv_core::xtream::service::test(&e.state, &cfg)
        .await
        .unwrap();
    assert!(!res.ok, "{res:?}");
    let paths = seen.paths();
    assert!(
        paths.iter().any(|p| p.contains("player_api.php")),
        "{paths:?}"
    );
    assert!(
        !paths.iter().any(|p| p.starts_with("/hit")),
        "redirect was followed: {paths:?}"
    );
}

#[tokio::test]
async fn server_guard_stalker_redirect_to_untrusted_authority_is_refused() {
    let e = env(true).await;
    let (base, seen) = spawn_stub().await;
    let cfg: StalkerSourceConfig = serde_json::from_value(json!({
        "portalUrl": format!("{base}/c/"),
        "macAddress": "00:1A:79:00:00:01",
    }))
    .unwrap();
    let res = iptv_core::stalker::playback::test(&e.state, cfg).await;
    assert!(!res.ok, "{res:?}");
    let paths = seen.paths();
    assert!(!paths.is_empty());
    assert!(
        !paths.iter().any(|p| p.starts_with("/hit")),
        "redirect was followed: {paths:?}"
    );
}

/// The source's own host:port is trusted, so a loopback panel still works.
#[tokio::test]
async fn server_guard_xtream_and_stalker_reach_their_own_loopback_host() {
    let mock = iptv_fixtures::spawn_mock().await;
    let e = env(true).await;
    let cfg = XtreamSourceConfig {
        server_url: mock.xtream_url(),
        username: "demo".into(),
        password: "secret".into(),
    };
    let res = iptv_core::xtream::service::test(&e.state, &cfg)
        .await
        .unwrap();
    assert!(res.ok, "{res:?}");
    let cfg: StalkerSourceConfig = serde_json::from_value(json!({
        "portalUrl": mock.stalker_portal_url(),
        "macAddress": "00:1A:79:00:00:01",
    }))
    .unwrap();
    let res = iptv_core::stalker::playback::test(&e.state, cfg).await;
    assert!(res.ok, "{res:?}");
}

#[tokio::test]
async fn server_guard_no_client_sends_referer_on_redirect() {
    let (base, _seen) = spawn_stub().await;
    let plain = http::client(None)
        .get(format!("{base}/to-echo"))
        .send()
        .await
        .unwrap();
    assert_eq!(plain.text().await.unwrap(), "none");

    let e = env(true).await;
    let own = Authority::parse_lenient(&base).unwrap();
    http::check_fetch(&e.state, &format!("{base}/to-echo"), Some(&own))
        .await
        .unwrap();
    let guarded = http::client_for(&e.state)
        .get(format!("{base}/to-echo"))
        .send()
        .await
        .unwrap();
    assert_eq!(guarded.text().await.unwrap(), "none");
}

/// A redirect to another port of a host name that is trusted on one port
/// (the resolver trusts names, not ports) is refused when the name resolves
/// to a private address. Uses the machine's own name, which resolves to its
/// LAN / loopback addresses; skipped when it does not resolve privately.
#[tokio::test]
async fn server_guard_redirect_to_other_port_of_trusted_name_is_refused() {
    let Some(name) = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|n| n.trim().to_ascii_lowercase())
        .filter(|n| !n.is_empty() && n != "localhost")
    else {
        eprintln!("skipped: no machine name in the environment");
        return;
    };
    let private = tokio::net::lookup_host((name.as_str(), 80))
        .await
        .map(|a| a.into_iter().any(|a| !http::is_public_ip(a.ip())))
        .unwrap_or(false);
    if !private {
        eprintln!("skipped: {name} does not resolve to a private address");
        return;
    }

    let e = env(true).await;
    let (base, seen) = spawn_stub().await;
    // A source on `name:1` makes the name trusted (on port 1 only).
    let named = Authority {
        host: name.clone(),
        port: 1,
    };
    http::check_fetch(&e.state, &format!("http://{name}:1/"), Some(&named))
        .await
        .unwrap();
    *seen.other_port.lock() = format!("http://{name}:{}/x", closed_port());

    let url = format!("{base}/other-port");
    let own = Authority::parse_lenient(&base).unwrap();
    http::check_fetch(&e.state, &url, Some(&own)).await.unwrap();
    let err = http::send(http::client_for(&e.state).get(&url))
        .await
        .unwrap_err();
    match err {
        CoreError::Invalid(m) => assert!(m.contains("only the source's own port"), "{m}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn server_guard_local_epg_paths_are_refused() {
    let e = env(true).await;
    let st = &e.state;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("secret.xml");
    std::fs::write(&file, "<tv><channel id=\"s\"/></tv>").unwrap();
    let path = file.display().to_string();
    let file_url = url::Url::from_file_path(&file).unwrap().to_string();

    // fetch refuses an existing file and a missing one alike.
    for u in [path.clone(), file_url.clone(), "Z:/missing/x.xml".into()] {
        let err = epg::fetch::fetch(st, &u, &RequestHeaders::default(), None, &|_| {})
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Unsupported(m) if m == epg::fetch::SERVER_EPG_FILE_MESSAGE),
            "{u}: {err:?}"
        );
    }

    // settings.update refuses new local URLs up front; http stays fine.
    for u in [&path, &file_url] {
        let err = settings::update(st, json!({ "epgUrls": [u] }))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Unsupported(_)), "{err:?}");
    }
    settings::update(st, json!({ "epgUrls": ["http://guide.example/x.xml"] }))
        .await
        .unwrap();

    // A playlist whose url-tvg names a server file: the guide row shows the
    // refusal (without an error-kind prefix) and nothing is read.
    let text = format!(
        "#EXTM3U url-tvg=\"{}\"\n#EXTINF:-1 tvg-id=\"a\",A\nhttp://example.com/a.ts\n",
        file_url
    );
    let src = sources::add(
        st.clone(),
        serde_json::from_value(json!({
            "kind": "m3u", "name": "T", "m3u": { "origin": "text", "text": text }
        }))
        .unwrap(),
    )
    .await
    .unwrap_or_else(|e| panic!("add failed: {e:?}"));
    let row = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let rows = epg::sources(st).await.unwrap();
            if let Some(r) = rows
                .into_iter()
                .find(|s| s.url == file_url && s.status == EpgFetchStatus::Error)
            {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("guide row reached error");
    assert_eq!(
        row.error.as_deref(),
        Some(epg::fetch::SERVER_EPG_FILE_MESSAGE)
    );
    assert_eq!(row.channel_count, 0);

    // Source EPG links are refused up front.
    let err = sources::update(
        st,
        &src.id,
        serde_json::from_value(json!({ "epg": { "manualUrls": [path] } })).unwrap(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CoreError::Unsupported(_)), "{err:?}");

    // Backup epgUrls go through settings.update and are refused.
    let manifest = json!({
        "kind": "iptvnator-playlist-backup", "version": 1, "playlists": [],
        "settings": { "epgUrls": [path] }
    });
    let report = backup::import(st, &manifest.to_string(), ImportMode::Merge)
        .await
        .unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("EPG URLs could not be restored")),
        "{report:?}"
    );
    assert!(!st.settings_snapshot().epg_urls.contains(&path));
}

/// Desktop: a missing local guide has a single, correct next step.
#[tokio::test]
async fn server_guard_desktop_missing_epg_file_message_is_not_doubled() {
    let e = env(false).await;
    let missing = "Z:/does/not/exist.xml";
    settings::update(&e.state, json!({ "epgUrls": [missing] }))
        .await
        .unwrap();
    let _ = epg::ingest::refresh_now(e.state.clone(), missing).await;
    let row = epg::sources(&e.state)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.url == missing)
        .unwrap();
    assert_eq!(
        row.error.as_deref(),
        Some("EPG file not found: Z:/does/not/exist.xml. Check the URL in Settings > EPG.")
    );
}

/// A guard refusal does not get the "points to an XMLTV file" hint.
#[tokio::test]
async fn server_guard_epg_refusal_has_no_xmltv_hint() {
    let e = env(true).await;
    let url = format!("http://127.0.0.1:{}/guide.xml", closed_port());
    settings::update(&e.state, json!({ "epgUrls": [url] }))
        .await
        .unwrap();
    let _ = epg::ingest::refresh_now(e.state.clone(), &url).await;
    let row = epg::sources(&e.state)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.url == url)
        .unwrap();
    let msg = row.error.unwrap();
    assert!(msg.contains("--allow-private-targets"), "{msg}");
    assert!(!msg.contains("XMLTV"), "{msg}");
    assert!(!msg.contains(".."), "{msg}");
}

/// R1-r2 F2: a guide detected from a source on the source's own host:port
/// is trusted like the playlist.
#[tokio::test]
async fn server_guard_source_guide_on_own_host_loads() {
    let mock = iptv_fixtures::spawn_mock().await;
    let mut e = env(true).await;
    let guide = mock.url("/xmltv/sample.xml");
    let src = sources::add(
        e.state.clone(),
        serde_json::from_value(json!({
            "kind": "m3u", "name": "Sample", "m3u": { "url": mock.url("/m3u/sample.m3u") }
        }))
        .unwrap(),
    )
    .await
    .unwrap_or_else(|e| panic!("add failed: {e:?}"));
    assert_eq!(src.epg.detected_urls, vec![guide.clone()]);
    let phase = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let ev = e.events.recv().await.unwrap();
            if ev.kind == "epg.progress" && ev.payload["url"] == guide.as_str() {
                let p = ev.payload["phase"].as_str().unwrap_or_default().to_string();
                if p == "done" || p == "error" {
                    return (p, ev.payload.clone());
                }
            }
        }
    })
    .await
    .expect("guide refresh finished");
    assert_eq!(phase.0, "done", "{}", phase.1);
    let row = epg::sources(&e.state)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.url == guide)
        .unwrap();
    assert_eq!(row.status, EpgFetchStatus::Ok, "{:?}", row.error);
}

/// R5-r2 F4: the import report is the same whether the path exists or not.
#[tokio::test]
async fn server_guard_backup_file_entry_does_not_probe_paths() {
    let existing = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let mut warnings = Vec::new();
    for (i, hint) in [existing, "Z:/nonexistent-zz.m3u"].into_iter().enumerate() {
        let e = env(true).await;
        let manifest = json!({
            "kind": "iptvnator-playlist-backup", "version": 1,
            "playlists": [{
                "portalType": "m3u", "exportedId": format!("p{i}"), "title": "P0",
                "source": {
                    "kind": "file",
                    "rawM3u": "#EXTM3U\n#EXTINF:-1,A\nhttp://example.com/a.ts\n",
                    "filePathHint": hint
                }
            }]
        });
        let report = backup::import(&e.state, &manifest.to_string(), ImportMode::Merge)
            .await
            .unwrap();
        assert_eq!(report.imported, 1, "{report:?}");
        warnings.push(report.warnings);
    }
    assert_eq!(warnings[0], warnings[1]);
    assert!(
        warnings[0]
            .iter()
            .any(|w| w.contains("the playlist file path was ignored")),
        "{warnings:?}"
    );
}
