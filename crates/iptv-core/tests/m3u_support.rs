//! Shared helpers for the B1 integration tests (`m3u_*`, `catalog_*`,
//! `sources_*`). Included with `#[path = "m3u_support.rs"] mod support;`.
//!
//! The iptv-fixtures generators were stubs when these tests were written, so
//! this file has its own playlist generator and a tiny axum HTTP stub.
#![allow(dead_code)]

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::events::BroadcastSink;
use iptv_core::model::{M3uOrigin, M3uSourceConfig, RequestHeaders, Source};
use iptv_core::rpc::RpcRouter;
use iptv_core::sources::{store, store::SourceConfig, AddSourceArgs, M3uAddInput};
use iptv_core::{AppEvent, AppState};
use parking_lot::Mutex;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

pub struct Env {
    pub dir: tempfile::TempDir,
    pub state: Arc<AppState>,
    pub events: Receiver<AppEvent>,
}

/// Fresh state in a temp dir with the m3u importer registered.
pub async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(100_000);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(state.clone()).await.unwrap();
    Env { dir, state, events }
}

/// Router with the B1 modules registered.
pub fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::sources::rpc::register(&mut r);
    iptv_core::catalog::rpc::register(&mut r);
    iptv_core::m3u::rpc::register(&mut r);
    r
}

/// Inserts a bare source row (no import) for catalog tests.
pub async fn bare_source(state: &AppState, id: &str) {
    let id = id.to_string();
    state
        .db_call(move |c| {
            let cfg = SourceConfig::M3u(M3uSourceConfig {
                origin: M3uOrigin::Text,
                url: None,
                file_path: None,
                headers: RequestHeaders::default(),
                catchup: None,
            });
            store::insert(c, &id, &id, false, &cfg, None)
        })
        .await
        .unwrap();
}

pub fn text_args(name: &str, text: &str) -> AddSourceArgs {
    AddSourceArgs {
        kind: iptv_core::model::SourceKind::M3u,
        name: name.into(),
        auto_refresh: None,
        m3u: Some(M3uAddInput {
            origin: Some(M3uOrigin::Text),
            text: Some(text.into()),
            ..Default::default()
        }),
        xtream: None,
        stalker: None,
    }
}

pub fn url_args(url: &str, auto_refresh: bool) -> AddSourceArgs {
    AddSourceArgs {
        kind: iptv_core::model::SourceKind::M3u,
        name: String::new(),
        auto_refresh: Some(auto_refresh),
        m3u: Some(M3uAddInput {
            origin: Some(M3uOrigin::Url),
            url: Some(url.into()),
            headers: Some(RequestHeaders {
                user_agent: Some("B1Test/1.0".into()),
                referrer: None,
                origin: None,
            }),
            ..Default::default()
        }),
        xtream: None,
        stalker: None,
    }
}

pub fn file_args(path: &std::path::Path) -> AddSourceArgs {
    AddSourceArgs {
        kind: iptv_core::model::SourceKind::M3u,
        name: String::new(),
        auto_refresh: None,
        m3u: Some(M3uAddInput {
            origin: Some(M3uOrigin::File),
            file_path: Some(path.to_string_lossy().into_owned()),
            ..Default::default()
        }),
        xtream: None,
        stalker: None,
    }
}

pub async fn add_text(state: &Arc<AppState>, name: &str, text: &str) -> Source {
    iptv_core::sources::add(state.clone(), text_args(name, text))
        .await
        .map_err(|e| e.error)
        .unwrap()
}

/// Generates an extended M3U with `n` live channels spread over `groups`
/// groups, plus a header with an EPG URL.
pub fn gen_m3u(n: usize, groups: usize) -> String {
    let mut s = String::with_capacity(n * 160);
    s.push_str("#EXTM3U x-tvg-url=\"http://epg.example/guide.xml\"\n");
    for i in 0..n {
        let g = i % groups.max(1);
        let _ = write!(
            s,
            "#EXTINF:-1 tvg-id=\"ch{i}.example\" tvg-name=\"Channel {i}\" tvg-logo=\"http://logo.example/{i}.png\" group-title=\"Group {g}\",Channel {i}\nhttp://stream.example/live/{i}.ts\n"
        );
    }
    s
}

/// Drains every event received so far.
pub fn drain(rx: &mut Receiver<AppEvent>) -> Vec<AppEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

// ---------------------------------------------------------------------------
// HTTP stub
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct StubState {
    pub body: Mutex<String>,
    pub fail: AtomicBool,
    pub hits: AtomicU32,
    pub last_user_agent: Mutex<Option<String>>,
}

pub struct Stub {
    pub base: String,
    pub state: Arc<StubState>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

impl Stub {
    pub fn url(&self) -> String {
        format!("{}/list.m3u", self.base)
    }
    pub fn set_body(&self, b: &str) {
        *self.state.body.lock() = b.to_string();
    }
    pub fn set_fail(&self, f: bool) {
        self.state.fail.store(f, Ordering::SeqCst);
    }
    pub fn hits(&self) -> u32 {
        self.state.hits.load(Ordering::SeqCst)
    }
}

async fn serve_list(State(st): State<Arc<StubState>>, headers: HeaderMap) -> Response {
    st.hits.fetch_add(1, Ordering::SeqCst);
    *st.last_user_agent.lock() = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if st.fail.load(Ordering::SeqCst) {
        return (StatusCode::NOT_FOUND, "gone").into_response();
    }
    let body = st.body.lock().clone();
    ([("content-type", "audio/x-mpegurl")], body).into_response()
}

/// Starts the stub on 127.0.0.1 (ephemeral port). Stops when dropped.
pub async fn stub(body: &str) -> Stub {
    let st = Arc::new(StubState::default());
    *st.body.lock() = body.to_string();
    let app = Router::new()
        .route("/list.m3u", get(serve_list))
        .with_state(st.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Stub {
        base: format!("http://{addr}"),
        state: st,
        _stop: tx,
    }
}

/// Panics unless `items_rank` (migration 0020) holds exactly one row per
/// `items` row with the columns the search ranks and filters by. A drifted
/// row would mis-rank or mis-filter search hits without an error.
pub fn assert_items_rank(c: &rusqlite::Connection) {
    let (items, rank, wrong): (i64, i64, i64) = c
        .query_row(
            "SELECT (SELECT count(*) FROM items), (SELECT count(*) FROM items_rank), \
             (SELECT count(*) FROM items i LEFT JOIN items_rank r ON r.id = i.rowid \
              WHERE r.id IS NULL OR r.source_id IS NOT i.source_id OR r.content_type IS NOT i.content_type \
              OR r.category_id IS NOT i.category_id OR r.non_english IS NOT i.non_english \
              OR r.title_len IS NOT length(i.title) OR r.position IS NOT i.position)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (rank, wrong),
        (items, 0),
        "items_rank: {rank} rows for {items} items, {wrong} missing or stale"
    );
}
