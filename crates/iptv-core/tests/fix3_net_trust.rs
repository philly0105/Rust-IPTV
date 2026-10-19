//! Fix wave 3 (R5-r3 F1-F3, R1-r3 F4): server-mode trust is per request.
//! A source's own `host:port` is trusted only for that source's fetches; it
//! does not leak to other requests, does not survive `xtream.test`, and a
//! redirect from one source into another source's private host is refused.
//! Backup EPG URLs are restored one by one, and a guide listed by several
//! sources is trusted when any of them owns its host:port.
//!
//! Upstreams listen on 127.0.0.1 and 127.0.0.2; `localhost` stands in for a
//! host name that resolves to a private address.

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use iptv_core::backup::{self, ImportMode};
use iptv_core::events::BroadcastSink;
use iptv_core::http::{self, ServerMode};
use iptv_core::model::{Download, DownloadStatus, EpgFetchStatus, XtreamSourceConfig};
use iptv_core::rpc::RpcRouter;
use iptv_core::{epg, settings, sources, AppState};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

struct Env {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(10_000);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    ServerMode::install(&state, false).expect("server mode installed");
    iptv_core::m3u::init(state.clone()).await.unwrap();
    Env { _dir: dir, state }
}

/// An upstream: `base` is how it is addressed, `paths` what it served.
struct Upstream {
    base: String,
    paths: Arc<Mutex<Vec<String>>>,
}

impl Upstream {
    fn hit(&self, path: &str) -> bool {
        self.paths.lock().iter().any(|p| p == path)
    }
}

const GUIDE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<tv><channel id="a"><display-name>A</display-name></channel>
<programme start="20261011000000 +0000" stop="20261011010000 +0000" channel="a"><title>Show</title></programme></tv>"#;

async fn handler(
    State((paths, base)): State<(Arc<Mutex<Vec<String>>>, String)>,
    req: Request,
) -> Response {
    let path = req.uri().path().to_string();
    paths.lock().push(path.clone());
    let query = req.uri().query().unwrap_or_default().to_string();
    match path.as_str() {
        "/list.m3u" => "#EXTM3U\n#EXTINF:-1 tvg-id=\"a\",A\nhttp://example.com/a.ts\n".into_response(),
        "/tvg.m3u" => format!(
            "#EXTM3U url-tvg=\"{base}/guide.xml\"\n#EXTINF:-1 tvg-id=\"a\",A\nhttp://example.com/a.ts\n"
        )
        .into_response(),
        "/guide.xml" => ([(header::CONTENT_TYPE, "application/xml")], GUIDE).into_response(),
        "/redir" => {
            let to = url::form_urlencoded::parse(query.as_bytes())
                .find(|(k, _)| k == "to")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
        }
        p if p.starts_with("/secret") => format!("SECRET-BODY {p}").into_response(),
        _ => (StatusCode::NOT_FOUND, "nope").into_response(),
    }
}

/// Listens on `ip` and addresses itself as `http://<name>:<port>`.
async fn upstream_on(ip: &str, name: Option<&str>) -> Option<Upstream> {
    let listener = tokio::net::TcpListener::bind((ip, 0)).await.ok()?;
    let port = listener.local_addr().unwrap().port();
    let base = format!("http://{}:{port}", name.unwrap_or(ip));
    let paths = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .fallback(handler)
        .with_state((paths.clone(), base.clone()));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Some(Upstream { base, paths })
}

async fn add_m3u(state: &Arc<AppState>, name: &str, m3u: Value) -> Result<String, String> {
    sources::add(
        state.clone(),
        serde_json::from_value(json!({ "kind": "m3u", "name": name, "m3u": m3u })).unwrap(),
    )
    .await
    .map(|s| s.id)
    .map_err(|e| format!("{e:?}"))
}

async fn get_ok(client: reqwest::Client, url: &str) -> Result<String, String> {
    let resp = http::send(client.get(url))
        .await
        .map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}

/// R5-r3 F1: trusting a source's private host name does not open it to
/// requests from no source, an unknown source, or the guard check.
#[tokio::test]
async fn fix3_net_trust_does_not_leak_across_sources() {
    let e = env().await;
    let st = &e.state;
    let up = upstream_on("127.0.0.1", Some("localhost")).await.unwrap();
    let secret = format!("{}/secret-after", up.base);

    assert!(http::check_fetch(st, &secret, None).await.is_err());
    assert!(get_ok(http::client_for(st), &secret).await.is_err());

    // The source on localhost:<port> imports (its own host is trusted)...
    let id = add_m3u(st, "nas", json!({ "url": format!("{}/list.m3u", up.base) }))
        .await
        .expect("own private host is trusted for its source");
    let own = http::source_authority(st, &id).await.unwrap();
    assert_eq!(
        get_ok(http::guarded_client(st, own.as_ref()), &secret)
            .await
            .unwrap(),
        "SECRET-BODY /secret-after"
    );
    assert_eq!(
        get_ok(http::source_client(st, &id).await, &secret)
            .await
            .unwrap(),
        "SECRET-BODY /secret-after"
    );

    // ...and nothing else gains that trust.
    let err = http::check_fetch(st, &secret, None).await.unwrap_err();
    assert!(err.to_string().contains("--allow-private-targets"), "{err}");
    let err = get_ok(http::client_for(st), &secret).await.unwrap_err();
    assert!(err.contains("--allow-private-targets"), "{err}");
    let err = get_ok(http::source_client(st, "nope").await, &secret)
        .await
        .unwrap_err();
    assert!(err.contains("--allow-private-targets"), "{err}");
    let unknown = http::source_authority(st, "nope").await.unwrap();
    assert!(http::check_fetch(st, &secret, unknown.as_ref())
        .await
        .is_err());

    // Removing the source leaves nothing behind either.
    sources::remove(st, &id).await.unwrap();
    assert!(get_ok(http::client_for(st), &secret).await.is_err());
    assert!(get_ok(http::source_client(st, &id).await, &secret)
        .await
        .is_err());
}

/// R5-r3 F1: `xtream.test` trusts the tested server for its own calls only.
#[tokio::test]
async fn fix3_net_trust_does_not_survive_xtream_test() {
    let e = env().await;
    let st = &e.state;
    let up = upstream_on("127.0.0.1", Some("localhost")).await.unwrap();
    let cfg = XtreamSourceConfig {
        server_url: up.base.clone(),
        username: "u".into(),
        password: "p".into(),
        headers: Default::default(),
    };
    let _ = iptv_core::xtream::service::test(st, &cfg).await;
    assert!(
        up.hit("/player_api.php"),
        "xtream.test reached its own server: {:?}",
        up.paths.lock()
    );
    let secret = format!("{}/secret-after-xtest", up.base);
    assert!(http::check_fetch(st, &secret, None).await.is_err());
    let err = get_ok(http::client_for(st), &secret).await.unwrap_err();
    assert!(err.contains("--allow-private-targets"), "{err}");
    assert!(!up.hit("/secret-after-xtest"));
}

async fn wait_terminal(router: &RpcRouter, state: &Arc<AppState>, id: i64) -> Download {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let v = router
                .dispatch(state.clone(), "downloads.list", Value::Null)
                .await
                .unwrap();
            let list: Vec<Download> = serde_json::from_value(v).unwrap();
            if let Some(d) = list.into_iter().find(|d| d.id == id) {
                if matches!(
                    d.status,
                    DownloadStatus::Completed | DownloadStatus::Failed | DownloadStatus::Canceled
                ) {
                    return d;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("download reached a terminal state")
}

async fn start_download(router: &RpcRouter, state: &Arc<AppState>, source: &str, url: &str) -> i64 {
    let v = router
        .dispatch(
            state.clone(),
            "downloads.start",
            json!({
                "ref": { "sourceId": source, "contentType": "movie", "itemId": "1" },
                "title": "Probe",
                "url": url,
            }),
        )
        .await
        .unwrap_or_else(|e| panic!("downloads.start failed: {e}"));
    v["id"].as_i64().unwrap()
}

/// R5-r3 F2: source B's server redirecting into source A's private
/// host:port is refused for downloads and playlist imports.
#[tokio::test]
async fn fix3_net_cross_source_redirect_refused() {
    let e = env().await;
    let st = &e.state;
    let a = upstream_on("127.0.0.1", None).await.unwrap();
    let Some(b) = upstream_on("127.0.0.2", None).await else {
        eprintln!("skipped: cannot listen on 127.0.0.2");
        return;
    };
    iptv_core::downloads::init(st.clone()).await.unwrap();
    let mut router = RpcRouter::new();
    iptv_core::downloads::rpc::register(&mut router);

    let id_a = add_m3u(st, "A", json!({ "url": format!("{}/list.m3u", a.base) }))
        .await
        .unwrap();
    let id_b = add_m3u(st, "B", json!({ "url": format!("{}/list.m3u", b.base) }))
        .await
        .unwrap();

    // A download on B that redirects into A fails without touching A.
    let cross = format!("{}/redir?to={}/secret-cross", b.base, a.base);
    let d = wait_terminal(
        &router,
        st,
        start_download(&router, st, &id_b, &cross).await,
    )
    .await;
    assert_eq!(d.status, DownloadStatus::Failed, "{d:?}");
    assert!(!a.hit("/secret-cross"), "redirect followed into A");

    // A's own download still works.
    let own = format!("{}/secret-own", a.base);
    let d = wait_terminal(&router, st, start_download(&router, st, &id_a, &own).await).await;
    assert_eq!(d.status, DownloadStatus::Completed, "{d:?}");

    // A playlist on B's server that redirects into A is refused.
    let err = add_m3u(
        st,
        "C",
        json!({ "url": format!("{}/redir?to={}/secret-list.m3u", b.base, a.base) }),
    )
    .await
    .unwrap_err();
    assert!(err.contains("Refusing"), "{err}");
    assert!(!a.hit("/secret-list.m3u"));
}

/// R5-r3 F3: a local path among backup EPG URLs is dropped on its own.
#[tokio::test]
async fn fix3_net_backup_epg_urls_partial_restore() {
    let e = env().await;
    let st = &e.state;
    let local = "C:/Users/me/guide.xml";
    let manifest = json!({
        "kind": "iptvnator-playlist-backup", "version": 1, "playlists": [],
        "settings": { "epgUrls": [
            "https://epg.example.com/guide.xml",
            "https://epg2.example.com/g.xml.gz",
            local,
            "file:///C:/guide.xml"
        ] }
    });
    let report = backup::import(st, &manifest.to_string(), ImportMode::Merge)
        .await
        .unwrap();
    assert_eq!(
        st.settings_snapshot().epg_urls,
        vec![
            "https://epg.example.com/guide.xml".to_string(),
            "https://epg2.example.com/g.xml.gz".to_string()
        ]
    );
    let epg_warnings: Vec<&String> = report
        .warnings
        .iter()
        .filter(|w| w.contains("EPG URL"))
        .collect();
    assert_eq!(epg_warnings.len(), 2, "{report:?}");
    assert!(epg_warnings[0].contains(local), "{epg_warnings:?}");
    assert!(
        epg_warnings[1].contains("file:///C:/guide.xml"),
        "{epg_warnings:?}"
    );
}

async fn guide_status(state: &AppState, url: &str) -> Option<(EpgFetchStatus, Option<String>)> {
    epg::sources(state)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.url == url)
        .map(|s| (s.status, s.error))
}

/// R1-r3 F4: a guide listed first by a pasted playlist (no host) and then by
/// a URL source on the guide's host:port is trusted, even when it is also in
/// Settings > EPG.
#[tokio::test]
async fn fix3_net_second_owner_epg_url_trusted() {
    let e = env().await;
    let st = &e.state;
    let up = upstream_on("127.0.0.1", None).await.unwrap();
    let guide = format!("{}/guide.xml", up.base);

    settings::update(st, json!({ "epgUrls": [guide] }))
        .await
        .unwrap();
    let text = format!(
        "#EXTM3U url-tvg=\"{guide}\"\n#EXTINF:-1 tvg-id=\"a\",A\nhttp://example.com/a.ts\n"
    );
    add_m3u(st, "Paste", json!({ "origin": "text", "text": text }))
        .await
        .unwrap();
    // Only hostless owners so far: refused.
    let err = epg::ingest::refresh_now(st.clone(), &guide)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("--allow-private-targets"), "{err}");

    add_m3u(st, "Url", json!({ "url": format!("{}/tvg.m3u", up.base) }))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match epg::ingest::refresh_now(st.clone(), &guide).await {
                Ok(stats) => return stats,
                Err(err) if err.to_string().contains("--allow-private-targets") => {
                    panic!("guide still refused: {err}")
                }
                // A background refresh of the same guide may be running.
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    })
    .await
    .expect("guide refreshed");
    let (status, error) = guide_status(st, &guide).await.unwrap();
    assert_eq!(status, EpgFetchStatus::Ok, "{error:?}");
    assert!(up.hit("/guide.xml"));
}
