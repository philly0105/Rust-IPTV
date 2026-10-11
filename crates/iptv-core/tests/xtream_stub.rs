//! Shared harness for the `xtream_*` integration tests.
//!
//! [`server`] prefers `iptv_fixtures::spawn_mock()` (B11, SPEC C13) and falls
//! back to the embedded axum stub below when that mock does not serve Xtream
//! yet. The stub mirrors C13's shapes (user `demo` / pass `secret`, 3 live
//! categories / 40 channels 101..140 with archive on 101..105, 2 vod
//! categories / 30 movies 201..230, 2 series categories / 10 series 301..310
//! with 2 seasons x 3 episodes from 3001) and adds quirks real panels have:
//! numbers as strings, `category_ids` arrays, `backdrop_path` as a string,
//! `rating` "N/A", `info: []`. User `flaky` / `secret` answers 503 to the
//! first account request (retry test). User `slow` / `secret` answers
//! `get_vod_streams` after [`SLOW_DELAY`] (import-lock tests). Users
//! `nodetail404` / `nodetail500` (pass `secret`) answer `get_vod_info` and
//! `get_series_info` with that HTTP status (detail fallback tests). User
//! `tsonly` / `secret` reports `allowed_output_formats: ["TS", " rtmp "]`.
//!
//! Included by the other test files with `#[path = "xtream_stub.rs"] mod stub;`.
#![allow(dead_code)]

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use iptv_core::events::BroadcastSink;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

pub const USER: &str = "demo";
pub const PASS: &str = "secret";
/// How long user `slow` waits before answering `get_vod_streams`.
pub const SLOW_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// A running Xtream server for a test.
pub struct Server {
    /// Server URL to put in `XtreamSourceConfig.serverUrl` (`.../xtream`).
    pub server_url: String,
    /// True when this is the embedded stub (not B11's mock).
    pub is_stub: bool,
    _mock: Option<iptv_fixtures::MockHandle>,
    _stub: Option<tokio::sync::oneshot::Sender<()>>,
}

/// B11's mock when it serves Xtream, else the stub.
pub async fn server() -> Server {
    let mock = iptv_fixtures::spawn_mock().await;
    let url = format!(
        "{}/xtream/player_api.php?username={USER}&password={PASS}",
        mock.base
    );
    let ok = async {
        let v: Value = reqwest::get(&url).await.ok()?.json().await.ok()?;
        let auth = &v["user_info"]["auth"];
        Some(auth == 1 || auth == "1" || auth == true)
    }
    .await
    .unwrap_or(false);
    if ok {
        return Server {
            server_url: format!("{}/xtream", mock.base),
            is_stub: false,
            _mock: Some(mock),
            _stub: None,
        };
    }
    drop(mock);
    stub().await
}

/// Always the embedded stub.
pub async fn stub() -> Server {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let app = router();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Server {
        server_url: format!("http://127.0.0.1:{port}/xtream"),
        is_stub: true,
        _mock: None,
        _stub: Some(tx),
    }
}

/// Fresh app state in a temp dir plus an event receiver.
pub async fn state() -> (
    tempfile::TempDir,
    Arc<AppState>,
    tokio::sync::broadcast::Receiver<iptv_core::AppEvent>,
) {
    let dir = tempfile::tempdir().unwrap();
    let (sink, rx) = BroadcastSink::channel(8192);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    (dir, state, rx)
}

/// Inserts an xtream source row and returns its id.
pub async fn add_source(state: &Arc<AppState>, server_url: &str, user: &str, pass: &str) -> String {
    let id = format!("xt-{}", uuid::Uuid::new_v4().simple());
    let cfg = json!({"serverUrl": server_url, "username": user, "password": pass}).to_string();
    let id2 = id.clone();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', 'Mock Xtream', ?2)",
                rusqlite::params![id2, cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    id
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StubState {
    flaky_hits: AtomicU32,
}

fn router() -> Router {
    Router::new()
        .route("/xtream/player_api.php", get(player_api))
        .route("/xtream/xmltv.php", get(xmltv))
        .route("/xtream/live/{u}/{p}/{file}", get(stream))
        .route("/xtream/movie/{u}/{p}/{file}", get(stream))
        .route("/xtream/series/{u}/{p}/{file}", get(stream))
        .route("/xtream/timeshift/{u}/{p}/{d}/{s}/{file}", get(timeshift))
        .with_state(Arc::new(StubState::default()))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s)
}

async fn player_api(
    State(st): State<Arc<StubState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let user = q.get("username").map(String::as_str).unwrap_or("");
    let pass = q.get("password").map(String::as_str).unwrap_or("");
    let valid = matches!(
        user,
        USER | "flaky" | "slow" | "nodetail404" | "nodetail500" | "tsonly"
    ) && pass == PASS;
    if !valid {
        return Json(json!({"user_info": {"auth": 0}})).into_response();
    }
    let action = q.get("action").map(String::as_str).unwrap_or("");
    if user == "flaky" && action.is_empty() && st.flaky_hits.fetch_add(1, Ordering::SeqCst) == 0 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if matches!(action, "get_vod_info" | "get_series_info") {
        match user {
            "nodetail404" => return StatusCode::NOT_FOUND.into_response(),
            "nodetail500" => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => {}
        }
    }
    if user == "slow" && action == "get_vod_streams" {
        tokio::time::sleep(SLOW_DELAY).await;
    }
    let body = match action {
        "" => account(user),
        "get_live_categories" => json!([
            {"category_id": "1", "category_name": "News", "parent_id": 0},
            {"category_id": 2, "category_name": "Sports", "parent_id": 0},
            {"category_id": "3", "category_name": "Kids", "parent_id": 0}
        ]),
        "get_live_streams" => Value::Array(
            (101..=140)
                .map(|id: i64| {
                    let cat = ((id - 101) % 3) + 1;
                    json!({
                        "num": if id % 2 == 0 { json!(id - 100) } else { json!((id - 100).to_string()) },
                        "name": format!("Channel {id}"),
                        "stream_type": "live",
                        "stream_id": id,
                        "stream_icon": format!("http://img.mock/{id}.png"),
                        "epg_channel_id": if id == 101 { "bbc1.uk".to_string() } else { format!("ch{id}.mock") },
                        "added": "1700000000",
                        "category_id": cat.to_string(),
                        "category_ids": [cat],
                        "tv_archive": if id <= 105 { 1 } else { 0 },
                        "tv_archive_duration": if id <= 105 { "3" } else { "0" },
                        "is_adult": "0"
                    })
                })
                .collect(),
        ),
        "get_vod_categories" => json!([
            {"category_id": "10", "category_name": "Action"},
            {"category_id": "11", "category_name": "Drama"}
        ]),
        "get_vod_streams" => Value::Array(
            (201..=230)
                .map(|id: i64| {
                    json!({
                        "num": id - 200,
                        "name": format!("Movie {id} ({})", 1990 + (id - 200)),
                        "stream_type": "movie",
                        "stream_id": id.to_string(),
                        "stream_icon": format!("http://img.mock/m{id}.jpg"),
                        "rating": if id == 201 { json!("N/A") } else { json!(format!("{}.5", id % 9)) },
                        "rating_5based": 3.5,
                        "added": (1_700_000_000 + id * 3600).to_string(),
                        "category_id": if id % 2 == 0 { "10" } else { "11" },
                        "container_extension": "mp4"
                    })
                })
                .collect(),
        ),
        "get_series_categories" => json!([
            {"category_id": "20", "category_name": "Comedy"},
            {"category_id": "21", "category_name": "Crime"}
        ]),
        "get_series" => Value::Array(
            (301..=310)
                .map(|id: i64| {
                    json!({
                        "num": id - 300,
                        "name": format!("Series {id}"),
                        "series_id": id,
                        "cover": format!("http://img.mock/s{id}.jpg"),
                        "plot": "A plot.",
                        "genre": "Comedy, Crime",
                        "releaseDate": "2018-03-01",
                        "last_modified": "1700000000",
                        "rating": "7",
                        "backdrop_path": format!("http://img.mock/b{id}.jpg"),
                        "category_id": if id % 2 == 0 { "20" } else { "21" }
                    })
                })
                .collect(),
        ),
        "get_vod_info" => {
            let id: i64 = q.get("vod_id").and_then(|v| v.parse().ok()).unwrap_or(0);
            if !(201..=230).contains(&id) {
                json!({"info": [], "movie_data": []})
            } else {
                json!({
                    "info": {
                        "name": format!("Movie {id}"),
                        "plot": "A movie plot.",
                        "genre": "Action / Thriller",
                        "director": "Jane Doe",
                        "actors": "Actor One, Actor Two",
                        "duration_secs": 5400,
                        "duration": "01:30:00",
                        "rating": "7.5",
                        "releasedate": "2001-02-03",
                        "backdrop_path": [format!("http://img.mock/mb{id}.jpg")],
                        "youtube_trailer": "dQw4w9WgXcQ",
                        "tmdb_id": "550"
                    },
                    "movie_data": {"stream_id": id, "name": format!("Movie {id}"), "container_extension": "mp4", "category_id": "10", "added": "1700000000"}
                })
            }
        }
        "get_series_info" => {
            let id: i64 = q.get("series_id").and_then(|v| v.parse().ok()).unwrap_or(0);
            if !(301..=310).contains(&id) {
                json!({"seasons": [], "info": [], "episodes": []})
            } else {
                let base = 3001 + (id - 301) * 6;
                let mut episodes = serde_json::Map::new();
                for season in 1..=2i64 {
                    let eps: Vec<Value> = (1..=3i64)
                        .map(|e| {
                            json!({
                                "id": (base + (season - 1) * 3 + (e - 1)).to_string(),
                                "episode_num": e,
                                "title": format!("S{season}E{e}"),
                                "container_extension": "mp4",
                                "info": if e == 1 { json!([]) } else { json!({"duration_secs": 1500, "plot": "Ep plot"}) },
                                "season": season,
                                "added": "1700000000"
                            })
                        })
                        .collect();
                    episodes.insert(season.to_string(), Value::Array(eps));
                }
                json!({
                    "seasons": [{"season_number": 1, "name": "Season 1", "cover": "http://img.mock/s1.jpg"}],
                    "info": {"name": format!("Series {id}"), "plot": "Series plot", "cast": "A, B", "director": "D",
                             "genre": "Comedy", "rating": "N/A", "rating_5based": "4", "backdrop_path": "http://img.mock/sb.jpg",
                             "releaseDate": "2018-03-01", "category_id": "20"},
                    "episodes": episodes
                })
            }
        }
        "get_short_epg" => {
            let id = q.get("stream_id").cloned().unwrap_or_default();
            let limit: i64 = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(4);
            let start = now() - now() % 1800 - 1800;
            let listings: Vec<Value> = (0..limit.min(4))
                .map(|i| {
                    let s = start + i * 1800;
                    json!({
                        "id": format!("{id}-{i}"),
                        "epg_id": format!("ch{id}.mock"),
                        "title": b64(&format!("Programme {i}")),
                        "description": b64("About this programme"),
                        "start": "2000-01-01 00:00:00",
                        "end": "2000-01-01 00:30:00",
                        "start_timestamp": s.to_string(),
                        "stop_timestamp": (s + 1800).to_string()
                    })
                })
                .collect();
            json!({"epg_listings": listings})
        }
        _ => json!([]),
    };
    Json(body).into_response()
}

fn account(user: &str) -> Value {
    let formats = if user == "tsonly" {
        json!(["TS", " rtmp "])
    } else {
        json!(["m3u8", "ts"])
    };
    let ts = now();
    let local = chrono::DateTime::from_timestamp(ts + 3600, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    json!({
        "user_info": {
            "username": user, "password": PASS, "message": "", "auth": 1, "status": "Active",
            "exp_date": (ts + 30 * 86400).to_string(), "is_trial": "0", "active_cons": "0",
            "created_at": "1600000000", "max_connections": "2", "allowed_output_formats": formats
        },
        "server_info": {
            "url": "127.0.0.1", "port": "80", "https_port": "443", "server_protocol": "http",
            "timezone": "Europe/Paris", "timestamp_now": ts, "time_now": local
        }
    })
}

async fn xmltv(Query(q): Query<HashMap<String, String>>) -> Response {
    if q.get("username").map(String::as_str) != Some(USER) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    (
        [("content-type", "application/xml")],
        "<?xml version=\"1.0\"?><tv><channel id=\"bbc1.uk\"><display-name>BBC One</display-name></channel></tv>",
    )
        .into_response()
}

async fn stream(Path((u, p, file)): Path<(String, String, String)>) -> Response {
    if u != USER || p != PASS {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if file.ends_with(".m3u8") {
        (
            [("content-type", "application/vnd.apple.mpegurl")],
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/xtream/seg/0.ts\n",
        )
            .into_response()
    } else {
        ([("content-type", "video/mp2t")], vec![0x47u8; 188]).into_response()
    }
}

async fn timeshift(
    Path((u, p, _d, _s, _file)): Path<(String, String, String, String, String)>,
) -> Response {
    if u != USER || p != PASS {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ([("content-type", "video/mp2t")], vec![0x47u8; 188]).into_response()
}

#[test]
fn stub_compiles() {
    let _ = router();
}
