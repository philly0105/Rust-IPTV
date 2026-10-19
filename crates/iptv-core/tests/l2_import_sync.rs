//! Loop 2 import fixes for Xtream and Stalker refreshes, against the mock
//! portal behind a proxy that can fail or alter single calls:
//!
//! - L2-perf-core-4: an unchanged Xtream refresh writes nothing and reports
//!   `unchanged`; a changed kind is rewritten alone.
//! - L1-core-15: Xtream categories that fail keep the previous rows (and say
//!   so in `lastError`); on a first import the items land under
//!   "Uncategorized" with a warning, and the next good refresh fixes them.
//! - L1-core-14: a Stalker radio or VOD answer that fails for now keeps
//!   that section's previous rows and sets `lastError`.
//! - L2-sources-home-7: the Xtream saving phase carries no raw content type.
//! - ST-2: an unchanged Xtream refresh does not wait for the save slot.

use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use iptv_core::events::BroadcastSink;
use iptv_core::{AppEvent, AppState};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

const MAC: &str = "00:1A:79:00:00:01";

/// What the proxy does to the calls whose query holds every fragment.
#[derive(Default)]
struct Rules {
    /// Answer with this status and body instead of the portal's.
    fail: Vec<(Vec<&'static str>, u16, &'static str)>,
    /// Drop the last element of the portal's JSON array answer.
    trim: Vec<Vec<&'static str>>,
}

type Shared = Arc<Mutex<Rules>>;

fn matches(q: &str, frags: &[&str]) -> bool {
    frags.iter().all(|f| q.split('&').any(|p| p == *f))
}

#[derive(Clone)]
struct Ctx {
    upstream: String,
    rules: Shared,
    http: reqwest::Client,
}

async fn forward(
    State(ctx): State<Ctx>,
    uri: Uri,
    RawQuery(q): RawQuery,
    headers: HeaderMap,
) -> Response {
    let q = q.unwrap_or_default();
    let (fail, trim) = {
        let rules = ctx.rules.lock();
        let fail = rules
            .fail
            .iter()
            .find(|(f, _, _)| matches(&q, f))
            .map(|(_, s, b)| (*s, *b));
        (fail, rules.trim.iter().any(|f| matches(&q, f)))
    };
    if let Some((status, body)) = fail {
        return (StatusCode::from_u16(status).unwrap(), body).into_response();
    }
    let mut req = ctx
        .http
        .get(format!("{}{}?{}", ctx.upstream, uri.path(), q));
    for (k, v) in headers.iter() {
        if k != axum::http::header::HOST {
            req = req.header(k.as_str(), v.as_bytes());
        }
    }
    let Ok(resp) = req.send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap();
    let mut body = resp.bytes().await.unwrap_or_default().to_vec();
    if trim {
        let mut v: Value = serde_json::from_slice(&body).unwrap();
        v.as_array_mut().expect("a JSON array to trim").pop();
        body = serde_json::to_vec(&v).unwrap();
    }
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

struct Env {
    _tmp: tempfile::TempDir,
    _mock: iptv_fixtures::MockHandle,
    state: Arc<AppState>,
    events: Receiver<AppEvent>,
    rules: Shared,
    proxy: String,
}

async fn env() -> Env {
    let mock = iptv_fixtures::spawn_mock().await;
    let rules: Shared = Arc::default();
    let ctx = Ctx {
        upstream: mock.url(""),
        rules: rules.clone(),
        http: reqwest::Client::new(),
    };
    let app = axum::Router::new().fallback(forward).with_state(ctx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(65_536);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    iptv_core::stalker::init(state.clone()).await.unwrap();
    Env {
        _tmp: tmp,
        _mock: mock,
        state,
        events,
        rules,
        proxy: format!("http://{addr}"),
    }
}

impl Env {
    async fn add(&self, id: &'static str, kind: &'static str, cfg: Value) {
        let cfg = cfg.to_string();
        self.state
            .db_call(move |c| {
                c.execute(
                    "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, ?2, 'Mock', ?3)",
                    rusqlite::params![id, kind, cfg],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn add_xtream(&self, id: &'static str) {
        let cfg = json!({
            "serverUrl": format!("{}/xtream", self.proxy),
            "username": "demo",
            "password": "secret",
        });
        self.add(id, "xtream", cfg).await;
    }

    async fn add_stalker(&self, id: &'static str) {
        let cfg = json!({
            "portalUrl": format!("{}/stalker/portal.php", self.proxy),
            "macAddress": MAC,
            "isFullPortal": true,
        });
        self.add(id, "stalker", cfg).await;
    }

    /// Refreshes through `sources::run_import` and returns the source plus
    /// the `import.progress` events of that run.
    async fn refresh(&mut self, id: &str) -> (iptv_core::model::Source, Vec<Value>) {
        while self.events.try_recv().is_ok() {}
        let source = iptv_core::sources::refresh(self.state.clone(), id)
            .await
            .unwrap_or_else(|e| panic!("refresh failed: {e}"));
        let mut progress = Vec::new();
        while let Ok(ev) = self.events.try_recv() {
            if ev.kind == "import.progress" && ev.payload["sourceId"] == id {
                progress.push(ev.payload);
            }
        }
        (source, progress)
    }

    async fn int(&self, sql: &'static str, id: &'static str) -> i64 {
        self.state
            .db_call(move |c| Ok(c.query_row(sql, [id], |r| r.get(0))?))
            .await
            .unwrap()
    }

    async fn rows(&self, id: &'static str, ct: &'static str) -> i64 {
        let sql: &'static str = match ct {
            "live" => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'live'",
            "radio" => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'radio'",
            "movie" => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'movie'",
            _ => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'series'",
        };
        self.int(sql, id).await
    }

    async fn categories(&self, id: &'static str, ct: &'static str) -> Vec<String> {
        self.state
            .db_call(move |c| {
                let mut st = c.prepare(
                    "SELECT name FROM categories WHERE source_id = ?1 AND content_type = ?2 ORDER BY position",
                )?;
                let names = st
                    .query_map([id, ct], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(names)
            })
            .await
            .unwrap()
    }

    /// Renames every row of one content type. A rewrite of that type brings
    /// the portal's titles back; an untouched type keeps the mark.
    async fn mark(&self, id: &'static str, ct: &'static str) {
        self.state
            .db_call(move |c| {
                c.execute(
                    "UPDATE items SET title = 'MARK' WHERE source_id = ?1 AND content_type = ?2",
                    [id, ct],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn marked(&self, id: &'static str, ct: &'static str) -> i64 {
        let sql: &'static str = match ct {
            "live" => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'live' AND title = 'MARK'",
            "radio" => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'radio' AND title = 'MARK'",
            "movie" => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'movie' AND title = 'MARK'",
            _ => "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'series' AND title = 'MARK'",
        };
        self.int(sql, id).await
    }
}

fn done_message(progress: &[Value]) -> Option<String> {
    let done = progress
        .iter()
        .rev()
        .find(|p| p["phase"] == "done")
        .expect("a done event");
    done["message"].as_str().map(str::to_string)
}

const XT: &str = "xt1";
const STK: &str = "stk1";

// ---------------------------------------------------------------------------
// L2-perf-core-4 + L2-sources-home-7
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unchanged_xtream_refresh_writes_nothing_and_says_unchanged() {
    let mut e = env().await;
    e.add_xtream(XT).await;
    let (first, progress) = e.refresh(XT).await;
    assert_eq!(first.last_error, None);
    assert_eq!(done_message(&progress), None, "a first import is a change");
    let (live, movies, series) = (
        e.rows(XT, "live").await,
        e.rows(XT, "movie").await,
        e.rows(XT, "series").await,
    );
    assert!(live > 0 && movies > 0 && series > 0);
    // L2-sources-home-7: no raw content type under the saving bar.
    for p in progress.iter().filter(|p| p["phase"] == "saving") {
        let msg = p["message"].as_str();
        assert!(
            !matches!(msg, Some("live" | "radio" | "movie" | "series")),
            "raw content type in a saving event: {p}"
        );
    }

    for ct in ["live", "movie", "series"] {
        e.mark(XT, ct).await;
    }
    let (second, progress) = e.refresh(XT).await;
    assert_eq!(second.last_error, None);
    assert_eq!(done_message(&progress).as_deref(), Some("unchanged"));
    assert_eq!(e.marked(XT, "live").await, live, "live rows were rewritten");
    assert_eq!(e.marked(XT, "movie").await, movies, "movies were rewritten");
    assert_eq!(
        e.marked(XT, "series").await,
        series,
        "series were rewritten"
    );
    assert!(
        progress
            .iter()
            .all(|p| p["phase"] != "saving" || p["done"] == 0),
        "an unchanged refresh saves no rows: {progress:?}"
    );
}

/// ST-2: a kind whose answer matches the last write is not decoded, so an
/// unchanged refresh never waits for the save slot another import holds.
#[tokio::test]
async fn unchanged_xtream_refresh_does_not_wait_for_the_save_slot() {
    let mut e = env().await;
    e.add_xtream(XT).await;
    e.refresh(XT).await;
    let slot = iptv_core::sources::save_slot(&e.state).await.unwrap();
    let refresh = tokio::time::timeout(std::time::Duration::from_secs(10), e.refresh(XT));
    let (_, progress) = refresh.await.expect("waited for the save slot");
    assert_eq!(done_message(&progress).as_deref(), Some("unchanged"));
    drop(slot);
}

#[tokio::test]
async fn only_the_changed_xtream_kind_is_rewritten() {
    let mut e = env().await;
    e.add_xtream(XT).await;
    e.refresh(XT).await;
    let movies = e.rows(XT, "movie").await;
    for ct in ["live", "movie", "series"] {
        e.mark(XT, ct).await;
    }
    e.rules.lock().trim.push(vec!["action=get_vod_streams"]);

    let (source, progress) = e.refresh(XT).await;
    assert_eq!(source.last_error, None);
    assert_eq!(
        done_message(&progress),
        None,
        "a changed refresh is not unchanged"
    );
    assert_eq!(e.rows(XT, "movie").await, movies - 1, "movies rewritten");
    assert_eq!(e.marked(XT, "movie").await, 0, "movies rewritten");
    assert_eq!(
        e.marked(XT, "live").await,
        e.rows(XT, "live").await,
        "live kept as it was"
    );
    assert_eq!(
        e.marked(XT, "series").await,
        e.rows(XT, "series").await,
        "series kept as they were"
    );
    assert_eq!(source.movie_count, movies - 1);

    // The new answer is the stored one now: the next refresh is unchanged.
    let (_, progress) = e.refresh(XT).await;
    assert_eq!(done_message(&progress).as_deref(), Some("unchanged"));
}

#[tokio::test]
async fn a_removed_catalog_is_written_again_even_when_the_panel_did_not_change() {
    let mut e = env().await;
    e.add_xtream(XT).await;
    e.refresh(XT).await;
    let movies = e.rows(XT, "movie").await;
    e.state
        .db_call(|c| {
            c.execute(
                "DELETE FROM items WHERE source_id = 'xt1' AND content_type = 'movie'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let (_, progress) = e.refresh(XT).await;
    assert_eq!(done_message(&progress), None);
    assert_eq!(e.rows(XT, "movie").await, movies);
}

// ---------------------------------------------------------------------------
// L1-core-15
// ---------------------------------------------------------------------------

/// What an expired panel sends instead of JSON.
const LOGIN_PAGE: &str = "<html><body>Please log in</body></html>";

#[tokio::test]
async fn failed_xtream_categories_keep_the_previous_rows_and_set_last_error() {
    let mut e = env().await;
    e.add_xtream(XT).await;
    e.refresh(XT).await;
    let movies = e.rows(XT, "movie").await;
    let cats = e.categories(XT, "movie").await;
    assert!(!cats.iter().any(|c| c == "Uncategorized"), "{cats:?}");

    e.rules
        .lock()
        .fail
        .push((vec!["action=get_vod_categories"], 200, LOGIN_PAGE));
    // A changed movie list too: without the categories it must still not
    // be written (it would land under Uncategorized).
    e.rules.lock().trim.push(vec!["action=get_vod_streams"]);
    let (source, _) = e.refresh(XT).await;
    assert_eq!(e.rows(XT, "movie").await, movies, "previous movies kept");
    assert_eq!(
        e.categories(XT, "movie").await,
        cats,
        "previous categories kept"
    );
    let err = source.last_error.expect("lastError says what is stale");
    assert!(err.contains("movie categories"), "{err}");
    assert!(source.last_error_code.is_some());

    // The panel recovers: the warning goes away with the next refresh.
    e.rules.lock().fail.clear();
    let (source, _) = e.refresh(XT).await;
    assert_eq!(source.last_error, None);
    assert_eq!(e.rows(XT, "movie").await, movies - 1);
    assert_eq!(e.categories(XT, "movie").await, cats);
}

#[tokio::test]
async fn first_xtream_import_without_categories_is_uncategorized_then_fixed() {
    let mut e = env().await;
    e.add_xtream(XT).await;
    e.rules
        .lock()
        .fail
        .push((vec!["action=get_vod_categories"], 200, LOGIN_PAGE));
    let (source, _) = e.refresh(XT).await;
    let movies = e.rows(XT, "movie").await;
    assert!(movies > 0, "movies imported without their categories");
    let cats = e.categories(XT, "movie").await;
    assert!(
        !cats.is_empty() && cats.iter().all(|c| c == "Uncategorized"),
        "{cats:?}"
    );
    let err = source.last_error.expect("lastError says why");
    assert!(err.contains("Uncategorized"), "{err}");
    assert!(
        !e.categories(XT, "live")
            .await
            .iter()
            .any(|c| c == "Uncategorized"),
        "other kinds keep their categories"
    );

    // Same movie list, categories back: the movies are written again (no
    // fingerprint was stored for them) under their real categories.
    e.rules.lock().fail.clear();
    let (source, progress) = e.refresh(XT).await;
    assert_eq!(source.last_error, None);
    assert_eq!(done_message(&progress), None);
    let cats = e.categories(XT, "movie").await;
    assert!(!cats.iter().any(|c| c == "Uncategorized"), "{cats:?}");
    assert_eq!(e.rows(XT, "movie").await, movies);
}

// ---------------------------------------------------------------------------
// L1-core-14
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stalker_radio_and_vod_failures_keep_their_previous_rows() {
    let mut e = env().await;
    e.add_stalker(STK).await;
    let (first, _) = e.refresh(STK).await;
    assert_eq!(first.last_error, None);
    let radio = e.rows(STK, "radio").await;
    let vod_cats = e.categories(STK, "movie").await;
    let series_cats = e.categories(STK, "series").await;
    assert!(radio > 0, "the mock serves radio");
    assert!(!vod_cats.is_empty() && !series_cats.is_empty());

    {
        let mut rules = e.rules.lock();
        rules.fail.push((
            vec!["type=radio", "action=get_ordered_list"],
            502,
            "upstream down",
        ));
        rules
            .fail
            .push((vec!["type=vod", "action=get_categories"], 503, "busy"));
    }
    let (source, _) = e.refresh(STK).await;
    assert_eq!(e.rows(STK, "radio").await, radio, "radio kept");
    assert_eq!(
        e.categories(STK, "movie").await,
        vod_cats,
        "VOD categories kept"
    );
    assert_eq!(
        e.categories(STK, "series").await,
        series_cats,
        "series categories rewritten as before"
    );
    let err = source.last_error.expect("lastError says what is stale");
    assert!(err.contains("radio stations"), "{err}");
    assert_eq!(
        source.radio_count, first.radio_count,
        "kept radio still counts"
    );

    e.rules.lock().fail.clear();
    let (source, _) = e.refresh(STK).await;
    assert_eq!(source.last_error, None);
    assert_eq!(e.rows(STK, "radio").await, radio);
}

#[tokio::test]
async fn stalker_portal_without_radio_still_gets_an_empty_section() {
    let mut e = env().await;
    e.add_stalker(STK).await;
    e.refresh(STK).await;
    assert!(e.rows(STK, "radio").await > 0);
    // A 404 means the portal does not serve radio: the section empties as
    // before, and nothing is flagged.
    e.rules.lock().fail.push((
        vec!["type=radio", "action=get_ordered_list"],
        404,
        "not found",
    ));
    let (source, _) = e.refresh(STK).await;
    assert_eq!(e.rows(STK, "radio").await, 0);
    assert_eq!(source.last_error, None);
}
