//! XA-12: two loop 2 core changes together. An Xtream refresh skips content
//! types whose fingerprint is unchanged (L2-perf-core-4), and English-only
//! reads a verdict stored at write time, with `english_pending` and a boot
//! backfill for catalogs written before migration 0018 (L2-perf-core-1).
//! A catalog in the pre-0018 state (verdicts unset, pending rows) that an
//! unchanged refresh leaves alone, or a refresh that rewrites one type only,
//! must still answer English-only exactly as `is_non_english` says.

use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use iptv_core::catalog::language::{backfill_pending, is_non_english};
use iptv_core::events::BroadcastSink;
use iptv_core::rpc::build_router;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone)]
struct Ctx {
    upstream: String,
    http: reqwest::Client,
    /// Renames one more live channel (a changed live list).
    more_live: Arc<AtomicBool>,
}

fn action(q: &str) -> &str {
    q.split('&')
        .find_map(|p| p.strip_prefix("action="))
        .unwrap_or("")
}

/// Gives the mock's English catalog a mix of languages.
fn localize(action: &str, v: &mut Value, more_live: bool) {
    let Some(list) = v.as_array_mut() else { return };
    for (i, row) in list.iter_mut().enumerate() {
        match action {
            "get_live_categories" if row["category_id"] == "3" => {
                row["category_name"] = json!("FR | Divertissement");
            }
            "get_live_streams" => {
                let name = row["name"].as_str().unwrap_or_default().to_string();
                let renamed = match i % 5 {
                    0 => format!("DE - {name}"),
                    1 => format!("EN - {name}"),
                    2 if more_live && i == 2 => format!("AR | {name}"),
                    _ => name,
                };
                row["name"] = json!(renamed);
            }
            "get_vod_streams" if i % 3 == 0 => {
                let name = row["name"].as_str().unwrap_or_default().to_string();
                row["name"] = json!(format!("Канал {name}"));
            }
            "get_series" if i % 4 == 0 => {
                let name = row["name"].as_str().unwrap_or_default().to_string();
                row["name"] = json!(format!("ES: {name}"));
            }
            _ => {}
        }
    }
}

async fn forward(
    State(ctx): State<Ctx>,
    uri: Uri,
    RawQuery(q): RawQuery,
    headers: HeaderMap,
) -> Response {
    let q = q.unwrap_or_default();
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
    if let Ok(mut v) = serde_json::from_slice::<Value>(&body) {
        localize(action(&q), &mut v, ctx.more_live.load(Ordering::SeqCst));
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
    router: iptv_core::rpc::RpcRouter,
    more_live: Arc<AtomicBool>,
}

async fn env() -> Env {
    let mock = iptv_fixtures::spawn_mock().await;
    let more_live = Arc::new(AtomicBool::new(false));
    let ctx = Ctx {
        upstream: mock.url(""),
        http: reqwest::Client::new(),
        more_live: more_live.clone(),
    };
    let app = axum::Router::new().fallback(forward).with_state(ctx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _) = BroadcastSink::channel(65_536);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    let cfg = json!({
        "serverUrl": format!("http://{addr}/xtream"),
        "username": "demo",
        "password": "secret",
    })
    .to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('x', 'xtream', 'Mock', ?1)",
                [cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    Env {
        _tmp: tmp,
        _mock: mock,
        state,
        router: build_router(),
        more_live,
    }
}

const TYPES: [(&str, &str); 3] = [
    ("live", "catalog.channels"),
    ("movie", "catalog.movies"),
    ("series", "catalog.series"),
];

impl Env {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd}: {e:?}"))
    }

    /// The item ids English-only should show, by the Rust rule.
    async fn expected(&self, ct: &'static str) -> BTreeSet<String> {
        self.state
            .db_call(move |c| {
                let mut stmt = c.prepare(
                    "SELECT i.item_id, i.title, c.name FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE i.source_id = 'x' AND i.content_type = ?1",
                )?;
                let rows = stmt
                    .query_map([ct], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows
                    .into_iter()
                    .filter(|(_, t, c)| !is_non_english(t, c.as_deref()))
                    .map(|(id, _, _)| id)
                    .collect())
            })
            .await
            .unwrap()
    }

    /// Every English-only read matches the rule: pages, totals and
    /// category counts of each type, and the global search.
    async fn check(&self, when: &str) {
        for (ct, cmd) in TYPES {
            let want = self.expected(ct).await;
            let page = self
                .call(cmd, json!({"sourceId": "x", "query": {"limit": 1000}}))
                .await;
            let got: BTreeSet<String> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i["ref"]["itemId"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(got, want, "{when}: {ct} page");
            assert_eq!(
                page["total"].as_i64().unwrap(),
                want.len() as i64,
                "{when}: {ct} total"
            );
            let cats = self
                .call(
                    "catalog.categories",
                    json!({"sourceId": "x", "contentType": ct}),
                )
                .await;
            let counted: i64 = cats
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["itemCount"].as_i64().unwrap())
                .sum();
            assert_eq!(counted, want.len() as i64, "{when}: {ct} category counts");
        }
    }

    async fn pending(&self) -> i64 {
        self.state
            .db_call(|c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM english_pending WHERE source_id = 'x'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap()
    }

    /// Puts the catalog in the state migration 0018 leaves a catalog written
    /// before it: every verdict 0 and every (source, type) pending.
    async fn as_before_0018(&self) {
        self.state
            .db_call(|c| {
                c.execute_batch(
                    "UPDATE items SET non_english = 0 WHERE source_id = 'x';
                     INSERT OR IGNORE INTO english_pending (source_id, content_type)
                       SELECT DISTINCT source_id, content_type FROM items WHERE source_id = 'x';",
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn english_only_stays_exact_across_unchanged_and_partial_refreshes() {
    let env = env().await;
    let first = iptv_core::sources::refresh(env.state.clone(), "x")
        .await
        .unwrap();
    assert!(first.channel_count > 0 && first.movie_count > 0 && first.series_count > 0);
    env.call("settings.update", json!({"patch": {"englishOnly": true}}))
        .await;
    // The mix must hide some rows of every type and show others.
    for (ct, _) in TYPES {
        let shown = env.expected(ct).await.len() as i64;
        let all: i64 = env
            .state
            .db_call(move |c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM items WHERE source_id = 'x' AND content_type = ?1",
                    [ct],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert!(shown > 0 && shown < all, "{ct}: {shown} of {all} shown");
    }
    env.check("after the import").await;

    // Pre-0018 state, then a refresh where nothing changed: no type is
    // rewritten, so the pending rows stay and readers use the per-row rule.
    env.as_before_0018().await;
    assert_eq!(env.pending().await, 4, "live, radio, movie and series");
    let unchanged = iptv_core::sources::refresh(env.state.clone(), "x")
        .await
        .unwrap();
    assert_eq!(unchanged.channel_count, first.channel_count);
    assert_eq!(
        env.pending().await,
        4,
        "an unchanged refresh rewrites nothing"
    );
    env.check("after an unchanged refresh of a pending catalog")
        .await;

    // Only live changes: live is rewritten with stored verdicts, the other
    // types stay pending.
    env.more_live.store(true, Ordering::SeqCst);
    iptv_core::sources::refresh(env.state.clone(), "x")
        .await
        .unwrap();
    let live_pending: i64 = env
        .state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM english_pending WHERE source_id = 'x' AND content_type = 'live'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(live_pending, 0);
    assert!(env.pending().await >= 2, "movies and series still pending");
    env.check("after a live-only refresh").await;

    // The boot backfill clears the rest; reads stay the same.
    let done = env
        .state
        .db_call(|c| Ok(backfill_pending(c)?))
        .await
        .unwrap();
    assert!(done >= 2, "{done}");
    assert_eq!(env.pending().await, 0);
    env.check("after the backfill").await;

    // And an unchanged refresh after the backfill still changes nothing.
    iptv_core::sources::refresh(env.state.clone(), "x")
        .await
        .unwrap();
    env.check("after a final unchanged refresh").await;
}
