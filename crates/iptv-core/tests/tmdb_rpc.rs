//! `tmdb.*` through the router against an in-test axum stub of TMDB v3:
//! disabled short-circuit, key placement, search + negative cache, TTL rows,
//! expiry refetch, coalescing, 429 Retry-After, mapping, testKey, clearCache.

use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use iptv_core::model::TmdbSettings;
use iptv_core::rpc::RpcRouter;
use iptv_core::tmdb::Tmdb;
use iptv_core::{AppState, NoopSink};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

// ---- stub -------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Hit {
    path: String,
    query: HashMap<String, String>,
    auth: Option<String>,
}

#[derive(Clone)]
struct Route {
    status: u16,
    body: Value,
    delay: Duration,
    /// Answer 429 (with `Retry-After: 1`) this many times first.
    rate_limit_first: usize,
}

impl Route {
    fn ok(body: Value) -> Self {
        Self {
            status: 200,
            body,
            delay: Duration::ZERO,
            rate_limit_first: 0,
        }
    }
    fn status(status: u16) -> Self {
        Self {
            status,
            body: json!({"status_message": "nope"}),
            delay: Duration::ZERO,
            rate_limit_first: 0,
        }
    }
}

#[derive(Default)]
struct Stub {
    hits: Mutex<Vec<Hit>>,
    routes: Mutex<HashMap<String, Route>>,
}

impl Stub {
    fn route(&self, path: &str, r: Route) {
        self.routes.lock().insert(path.to_string(), r);
    }
    fn hits(&self, path: &str) -> Vec<Hit> {
        self.hits
            .lock()
            .iter()
            .filter(|h| h.path == path)
            .cloned()
            .collect()
    }
    fn total(&self) -> usize {
        self.hits.lock().len()
    }
}

async fn handle(
    State(stub): State<Arc<Stub>>,
    uri: Uri,
    RawQuery(q): RawQuery,
    headers: HeaderMap,
) -> Response {
    let path = uri.path().to_string();
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(q.unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let n_before = stub.hits(&path).len();
    stub.hits.lock().push(Hit {
        path: path.clone(),
        query,
        auth,
    });
    let route = stub.routes.lock().get(&path).cloned();
    let Some(route) = route else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"status_code": 34})),
        )
            .into_response();
    };
    if n_before < route.rate_limit_first {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("retry-after", "1")],
            "slow down",
        )
            .into_response();
    }
    if !route.delay.is_zero() {
        tokio::time::sleep(route.delay).await;
    }
    (
        StatusCode::from_u16(route.status).unwrap(),
        axum::Json(route.body),
    )
        .into_response()
}

type Row = (String, String, Option<i64>, bool, i64);

struct Env {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    stub: Arc<Stub>,
    router: Arc<RpcRouter>,
    tmdb: Arc<Tmdb>,
}

impl Env {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e:?}"))
    }

    fn enable(&self, key: Option<&str>) {
        self.state.settings.write().tmdb = TmdbSettings {
            enabled: true,
            api_key: key.map(str::to_string),
            language: None,
        };
    }

    /// (media_type, lookup_key, tmdb_id, payload is null, expires - fetched in seconds)
    fn rows(&self) -> Vec<Row> {
        let conn = self.state.db.get().unwrap();
        let mut st = conn
            .prepare(
                "SELECT media_type, lookup_key, tmdb_id, payload_json IS NULL, fetched_at, expires_at \
                 FROM tmdb_cache ORDER BY lookup_key",
            )
            .unwrap();
        st.query_map([], |r| {
            let fetched: String = r.get(4)?;
            let expires: String = r.get(5)?;
            let f = chrono::DateTime::parse_from_rfc3339(&fetched).unwrap();
            let e = chrono::DateTime::parse_from_rfc3339(&expires).unwrap();
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                (e - f).num_seconds(),
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn row(&self, key_prefix: &str) -> Row {
        self.rows()
            .into_iter()
            .find(|r| r.1.starts_with(key_prefix))
            .unwrap_or_else(|| {
                panic!(
                    "no tmdb_cache row starting with {key_prefix}: {:?}",
                    self.rows()
                )
            })
    }

    /// Ages every row past its expiry and drops the memory layer.
    fn expire_all(&self) {
        let conn = self.state.db.get().unwrap();
        conn.execute(
            "UPDATE tmdb_cache SET expires_at = '2000-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
        self.tmdb.cache().clear_memory();
    }
}

async fn env() -> Env {
    let stub = Arc::new(Stub::default());
    let app = axum::Router::new()
        .fallback(handle)
        .with_state(stub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    let tmdb = Tmdb::install(
        &state,
        Tmdb::new(state.http.clone(), format!("http://{addr}/3")),
    );
    let mut r = RpcRouter::new();
    iptv_core::tmdb::rpc::register(&mut r);
    Env {
        _dir: dir,
        state,
        stub,
        router: Arc::new(r),
        tmdb,
    }
}

// ---- fixtures ---------------------------------------------------------------

fn matrix_details() -> Value {
    json!({
        "id": 603,
        "title": "The Matrix",
        "original_title": "The Matrix",
        "original_language": "en",
        "release_date": "1999-03-31",
        "overview": "A hacker learns the truth.",
        "runtime": 136,
        "vote_average": 8.234,
        "vote_count": 25000,
        "poster_path": "/poster.jpg",
        "backdrop_path": "/backdrop.jpg",
        "genres": [{"id": 28, "name": "Action"}, {"id": 878, "name": "Science Fiction"}],
        "credits": {
            "cast": [
                {"id": 6384, "name": "Keanu Reeves", "character": "Neo", "order": 0, "profile_path": "/keanu.jpg"},
                {"id": 2975, "name": "Laurence Fishburne", "character": "Morpheus", "order": 1, "profile_path": null}
            ],
            "crew": [
                {"id": 9339, "name": "Lana Wachowski", "job": "Director", "department": "Directing"},
                {"id": 1, "name": "Some Grip", "job": "Grip", "department": "Crew"}
            ]
        },
        "videos": {"results": [
            {"key": "teaser1", "site": "YouTube", "type": "Teaser", "official": true},
            {"key": "vKQi3bBA1y8", "site": "YouTube", "type": "Trailer", "official": true}
        ]},
        "similar": {"results": [
            {"id": 604, "title": "The Matrix Reloaded", "release_date": "2003-05-15", "vote_average": 7.0, "vote_count": 10000}
        ]},
        "external_ids": {"imdb_id": "tt0133093"}
    })
}

fn matrix_search() -> Value {
    json!({"page": 1, "results": [
        {"id": 999001, "title": "The Matrix Revisited", "release_date": "2001-01-01", "vote_count": 50},
        {"id": 603, "title": "The Matrix", "original_title": "The Matrix", "release_date": "1999-03-31", "vote_count": 25000, "popularity": 80.0}
    ]})
}

fn days(n: i64) -> i64 {
    n * 24 * 3600
}

// ---- tests ------------------------------------------------------------------

#[tokio::test]
async fn registers_every_tmdb_command() {
    let e = env().await;
    let names: Vec<&str> = e
        .router
        .names()
        .into_iter()
        .filter(|n| n.starts_with("tmdb."))
        .collect();
    let mut expected = iptv_core::tmdb::rpc::COMMANDS.to_vec();
    expected.sort_unstable();
    assert_eq!(names, expected);
    for n in [
        "tmdb.movie",
        "tmdb.tv",
        "tmdb.season",
        "tmdb.person",
        "tmdb.trending",
        "tmdb.similar",
        "tmdb.testKey",
        "tmdb.clearCache",
    ] {
        assert!(e.router.contains(n), "{n} not registered");
    }
}

#[tokio::test]
async fn disabled_short_circuits_without_network() {
    let e = env().await;
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    // Disabled by default, even with a key present.
    e.state.settings.write().tmdb.api_key = Some("abc123".into());
    assert_eq!(
        e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
            .await,
        Value::Null
    );
    assert_eq!(
        e.call("tmdb.tv", json!({"title": "Dark"})).await,
        Value::Null
    );
    assert_eq!(
        e.call("tmdb.season", json!({"tmdbId": 1, "season": 1}))
            .await,
        Value::Null
    );
    assert_eq!(
        e.call("tmdb.person", json!({"personId": 1})).await,
        Value::Null
    );
    assert_eq!(e.call("tmdb.trending", Value::Null).await, json!([]));
    assert_eq!(
        e.call("tmdb.similar", json!({"mediaType": "movie", "tmdbId": 603}))
            .await,
        json!([])
    );
    // Enabled but no key anywhere: still no network.
    e.enable(None);
    assert_eq!(
        e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
            .await,
        Value::Null
    );
    assert_eq!(e.call("tmdb.trending", Value::Null).await, json!([]));
    assert_eq!(e.stub.total(), 0);
    assert!(e.rows().is_empty());
}

#[tokio::test]
async fn key_from_data_dir_env_goes_in_query() {
    let e = env().await;
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    std::fs::write(
        e.state.data_dir.join(".env"),
        "# local\nOTHER=1\nTMDB_API_KEY=\"abc123\"\n",
    )
    .unwrap();
    e.enable(None);
    let m = e
        .call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
        .await;
    assert_eq!(m["tmdbId"], 603);
    let hits = e.stub.hits("/3/movie/603");
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0].query.get("api_key").map(String::as_str),
        Some("abc123")
    );
    assert_eq!(hits[0].auth, None);
    assert_eq!(
        hits[0].query.get("language").map(String::as_str),
        Some("en-US")
    );
    assert_eq!(
        hits[0].query.get("append_to_response").map(String::as_str),
        Some("credits,videos,similar,external_ids")
    );
}

#[tokio::test]
async fn v4_token_goes_in_bearer_header_and_language_follows_settings() {
    let e = env().await;
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    let token = "eyJhbGciOiJIUzI1NiJ9.test-token";
    e.enable(Some(token));
    e.state.settings.write().language = "de".into();
    e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
        .await;
    let hits = e.stub.hits("/3/movie/603");
    assert_eq!(
        hits[0].auth.as_deref(),
        Some(format!("Bearer {token}").as_str())
    );
    assert!(!hits[0].query.contains_key("api_key"));
    assert_eq!(
        hits[0].query.get("language").map(String::as_str),
        Some("de-DE")
    );
}

#[tokio::test]
async fn movie_by_search_maps_result_and_caches_for_seven_days() {
    let e = env().await;
    e.stub.route("/3/search/movie", Route::ok(matrix_search()));
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    e.enable(Some("abc123"));

    let m = e
        .call("tmdb.movie", json!({"title": "The Matrix (1999)"}))
        .await;
    assert_eq!(m["tmdbId"], 603);
    assert_eq!(m["mediaType"], "movie");
    assert_eq!(m["title"], "The Matrix");
    assert_eq!(m["year"], 1999);
    assert_eq!(m["rating"], 8.2);
    assert_eq!(m["runtime"], 136);
    assert_eq!(m["posterUrl"], "https://image.tmdb.org/t/p/w500/poster.jpg");
    assert_eq!(
        m["backdropUrl"],
        "https://image.tmdb.org/t/p/w1280/backdrop.jpg"
    );
    assert_eq!(m["genres"], json!(["Action", "Science Fiction"]));
    assert_eq!(m["director"], "Lana Wachowski");
    assert_eq!(m["trailerYoutubeKey"], "vKQi3bBA1y8");
    assert_eq!(m["imdbId"], "tt0133093");
    assert_eq!(m["cast"][0]["name"], "Keanu Reeves");
    assert_eq!(m["cast"][0]["role"], "Neo");
    assert_eq!(m["similar"][0]["tmdbId"], 604);
    assert!(
        m.get("_originalLanguage").is_none(),
        "hidden cache fields leak: {m}"
    );

    let search = e.stub.hits("/3/search/movie");
    assert_eq!(search.len(), 1);
    assert_eq!(
        search[0].query.get("query").map(String::as_str),
        Some("the matrix"),
        "normalized query, release tag dropped"
    );

    // Match row (id only, no payload) and details row: 7 days each.
    let (media, _, id, no_payload, ttl) = e.row("title:");
    assert_eq!(
        (media.as_str(), id, no_payload, ttl),
        ("movie", Some(603), true, days(7))
    );
    let (_, _, id, no_payload, ttl) = e.row("id:603");
    assert_eq!((id, no_payload, ttl), (Some(603), false, days(7)));

    // Cached: no new upstream hits, even after the memory layer is gone.
    e.tmdb.cache().clear_memory();
    let again = e
        .call("tmdb.movie", json!({"title": "The Matrix (1999)"}))
        .await;
    assert_eq!(again, m);
    assert_eq!(e.stub.total(), 2);

    // tmdb.similar reads the cached details.
    let sim = e
        .call("tmdb.similar", json!({"mediaType": "movie", "tmdbId": 603}))
        .await;
    assert_eq!(sim[0]["title"], "The Matrix Reloaded");
    assert_eq!(e.stub.total(), 2);
}

#[tokio::test]
async fn unconfident_search_is_negatively_cached_for_three_days() {
    let e = env().await;
    e.stub.route("/3/search/movie", Route::ok(matrix_search()));
    e.enable(Some("abc123"));

    // Exact title but a far-off year: rejected by the gate.
    assert_eq!(
        e.call("tmdb.movie", json!({"title": "The Matrix", "year": 1985}))
            .await,
        Value::Null
    );
    // Nothing close at all.
    assert_eq!(
        e.call("tmdb.movie", json!({"title": "Zzyzx Road Trip"}))
            .await,
        Value::Null
    );
    let searches = e.stub.hits("/3/search/movie").len();
    assert!(searches >= 2);
    let rows = e.rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    for r in rows {
        assert!(r.3 && r.2.is_none(), "expected negative row: {r:?}");
        assert_eq!(r.4, days(3), "negative TTL: {r:?}");
    }
    e.tmdb.cache().clear_memory();
    assert_eq!(
        e.call("tmdb.movie", json!({"title": "Zzyzx Road Trip"}))
            .await,
        Value::Null
    );
    assert_eq!(
        e.stub.hits("/3/search/movie").len(),
        searches,
        "negative cache was not used"
    );
    assert!(e.stub.hits("/3/movie/603").is_empty());
}

#[tokio::test]
async fn dead_provider_id_is_negatively_cached_and_falls_back_to_search() {
    let e = env().await;
    e.stub.route("/3/search/movie", Route::ok(matrix_search()));
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    e.enable(Some("abc123"));
    // /3/movie/424242 is unrouted: the stub answers 404.
    let m = e
        .call(
            "tmdb.movie",
            json!({"title": "The Matrix", "year": 1999, "tmdbId": 424242}),
        )
        .await;
    assert_eq!(m["tmdbId"], 603);
    let (_, _, id, no_payload, ttl) = e.row("id:424242");
    assert_eq!((id, no_payload, ttl), (None, true, days(3)));
}

#[tokio::test]
async fn contradicted_provider_id_without_search_match_returns_null() {
    let e = env().await;
    e.stub.route("/3/search/movie", Route::ok(matrix_search()));
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    e.enable(Some("abc123"));
    // Provider says 603 (The Matrix, 1999) for a 1985 film; the search has
    // no confident match, so the contradicted details must not be shown.
    let m = e
        .call(
            "tmdb.movie",
            json!({"title": "Zzyzx Road Trip", "year": 1985, "tmdbId": 603}),
        )
        .await;
    assert_eq!(m, Value::Null);
    assert!(
        !e.stub.hits("/3/search/movie").is_empty(),
        "search was tried"
    );
}

#[tokio::test]
async fn expired_rows_are_refetched() {
    let e = env().await;
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    e.enable(Some("abc123"));
    e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
        .await;
    e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
        .await;
    assert_eq!(e.stub.hits("/3/movie/603").len(), 1);
    e.expire_all();
    e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
        .await;
    assert_eq!(e.stub.hits("/3/movie/603").len(), 2);
}

#[tokio::test]
async fn concurrent_requests_coalesce_into_one_upstream_call() {
    let e = env().await;
    let mut r = Route::ok(matrix_details());
    r.delay = Duration::from_millis(200);
    e.stub.route("/3/movie/603", r);
    e.enable(Some("abc123"));
    let calls = (0..10).map(|_| {
        let router = e.router.clone();
        let state = e.state.clone();
        tokio::spawn(async move {
            router
                .dispatch(
                    state,
                    "tmdb.movie",
                    json!({"title": "The Matrix", "tmdbId": 603}),
                )
                .await
                .unwrap()
        })
    });
    for v in futures::future::join_all(calls).await {
        assert_eq!(v.unwrap()["tmdbId"], 603);
    }
    assert_eq!(e.stub.hits("/3/movie/603").len(), 1);
}

#[tokio::test]
async fn rate_limit_honours_retry_after_and_trending_caches_one_day() {
    let e = env().await;
    let mut r = Route::ok(json!({"results": [
        {"id": 603, "media_type": "movie", "title": "The Matrix", "release_date": "1999-03-31"},
        {"id": 31, "media_type": "person", "name": "Tom Hanks"},
        {"id": 1399, "media_type": "tv", "name": "Game of Thrones", "first_air_date": "2011-04-17"},
        {"id": 603, "media_type": "movie", "title": "The Matrix", "release_date": "1999-03-31"}
    ]}));
    r.rate_limit_first = 1;
    e.stub.route("/3/trending/all/week", r);
    e.enable(Some("abc123"));
    let started = Instant::now();
    let t = e.call("tmdb.trending", Value::Null).await;
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "Retry-After not honoured"
    );
    assert_eq!(e.stub.hits("/3/trending/all/week").len(), 2);
    let items = t.as_array().unwrap();
    assert_eq!(items.len(), 2, "persons dropped, duplicates removed: {t}");
    assert_eq!(items[0]["mediaType"], "movie");
    assert_eq!(items[1]["mediaType"], "tv");
    assert_eq!(items[1]["title"], "Game of Thrones");
    let (media, _, _, no_payload, ttl) = e.row("all:week");
    assert_eq!(
        (media.as_str(), no_payload, ttl),
        ("trending", false, days(1))
    );
}

#[tokio::test]
async fn tv_season_and_person_map() {
    let e = env().await;
    e.stub.route(
        "/3/tv/1399",
        Route::ok(json!({
            "id": 1399, "name": "Game of Thrones", "original_name": "Game of Thrones", "original_language": "en",
            "first_air_date": "2011-04-17", "overview": "Seven kingdoms.", "status": "Ended",
            "genres": [{"name": "Drama"}],
            "created_by": [{"id": 9813, "name": "David Benioff"}],
            "seasons": [{"season_number": 1, "name": "Season 1", "episode_count": 10, "air_date": "2011-04-17", "poster_path": "/s1.jpg"}],
            "aggregate_credits": {"cast": [{"id": 22970, "name": "Peter Dinklage", "order": 0, "roles": [{"character": "Tyrion Lannister", "episode_count": 67}]}]},
            "credits": {"cast": [], "crew": []},
            "videos": {"results": [{"key": "got-trailer", "site": "YouTube", "type": "Trailer", "official": true}]},
            "similar": {"results": []}
        })),
    );
    e.stub.route(
        "/3/tv/1399/season/1",
        Route::ok(json!({
            "season_number": 1, "name": "Season 1", "overview": "Winter is coming.",
            "episodes": [{"episode_number": 1, "name": "Winter Is Coming", "overview": "Pilot.", "still_path": "/e1.jpg", "air_date": "2011-04-17", "runtime": 62}]
        })),
    );
    e.stub.route(
        "/3/person/22970",
        Route::ok(json!({
            "id": 22970, "name": "Peter Dinklage", "biography": "Actor.", "birthday": "1969-06-11",
            "place_of_birth": "Morristown, New Jersey, USA", "profile_path": "/pd.jpg",
            "combined_credits": {
                "cast": [
                    {"id": 10000, "media_type": "movie", "title": "Elf", "release_date": "2003-10-09", "character": "Miles"},
                    {"id": 1399, "media_type": "tv", "name": "Game of Thrones", "first_air_date": "2011-04-17", "character": "Tyrion"}
                ],
                "crew": []
            }
        })),
    );
    e.enable(Some("abc123"));

    let tv = e
        .call(
            "tmdb.tv",
            json!({"title": "Game of Thrones", "tmdbId": 1399}),
        )
        .await;
    assert_eq!(tv["mediaType"], "tv");
    assert_eq!(tv["year"], 2011);
    assert_eq!(tv["creators"], json!(["David Benioff"]));
    assert_eq!(tv["status"], "Ended");
    assert_eq!(tv["seasons"][0]["episodeCount"], 10);
    assert_eq!(tv["cast"][0]["role"], "Tyrion Lannister");
    assert_eq!(tv["trailerYoutubeKey"], "got-trailer");
    let append = e.stub.hits("/3/tv/1399")[0]
        .query
        .get("append_to_response")
        .cloned();
    assert_eq!(
        append.as_deref(),
        Some("credits,aggregate_credits,videos,similar")
    );

    let s = e
        .call("tmdb.season", json!({"tmdbId": 1399, "season": 1}))
        .await;
    assert_eq!(s["number"], 1);
    assert_eq!(s["name"], "Season 1");
    assert_eq!(s["episodes"][0]["name"], "Winter Is Coming");
    assert_eq!(
        s["episodes"][0]["stillUrl"],
        "https://image.tmdb.org/t/p/w300/e1.jpg"
    );
    assert_eq!(s["episodes"][0]["runtime"], 62);

    let p = e.call("tmdb.person", json!({"personId": 22970})).await;
    assert_eq!(p["id"], 22970);
    assert_eq!(p["placeOfBirth"], "Morristown, New Jersey, USA");
    assert_eq!(p["profileUrl"], "https://image.tmdb.org/t/p/w185/pd.jpg");
    let known: Vec<&str> = p["knownFor"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["title"].as_str().unwrap())
        .collect();
    assert_eq!(known, ["Game of Thrones", "Elf"], "newest first");
    let combined = e.stub.hits("/3/person/22970")[0]
        .query
        .get("append_to_response")
        .cloned();
    assert_eq!(combined.as_deref(), Some("combined_credits"));

    // Missing season: null, negatively cached.
    assert_eq!(
        e.call("tmdb.season", json!({"tmdbId": 1399, "season": 9}))
            .await,
        Value::Null
    );
    assert_eq!(
        e.call("tmdb.season", json!({"tmdbId": 1399, "season": 9}))
            .await,
        Value::Null
    );
    assert_eq!(e.stub.hits("/3/tv/1399/season/9").len(), 1);
}

#[tokio::test]
async fn invalid_ids_are_rejected_without_network() {
    let e = env().await;
    e.enable(Some("abc123"));
    let err = e
        .router
        .dispatch(e.state.clone(), "tmdb.person", json!({"personId": 0}))
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid);
    assert_eq!(e.stub.total(), 0);
}

#[tokio::test]
async fn test_key_works_while_disabled() {
    let e = env().await;
    e.stub
        .route("/3/configuration", Route::ok(json!({"images": {}})));
    let ok = e.call("tmdb.testKey", json!({"apiKey": "good"})).await;
    assert_eq!(ok, json!({"ok": true}));
    let hit = &e.stub.hits("/3/configuration")[0];
    assert_eq!(hit.query.get("api_key").map(String::as_str), Some("good"));

    e.stub.route("/3/configuration", Route::status(401));
    let bad = e.call("tmdb.testKey", json!({"apiKey": "wrongkey"})).await;
    assert_eq!(bad["ok"], false);
    let msg = bad["message"].as_str().unwrap();
    assert!(msg.contains("rejected"), "{msg}");
    assert!(!msg.contains("wrongkey"), "key echoed in message: {msg}");

    let before = e.stub.total();
    let none = e.call("tmdb.testKey", json!({"apiKey": "  "})).await;
    assert_eq!(none["ok"], false);
    assert_eq!(
        e.stub.total(),
        before,
        "blank key with no fallback must not hit the network"
    );
}

#[tokio::test]
async fn clear_cache_empties_rows_and_memory() {
    let e = env().await;
    e.stub.route("/3/movie/603", Route::ok(matrix_details()));
    e.enable(Some("abc123"));
    e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
        .await;
    assert!(!e.rows().is_empty());
    assert_eq!(e.call("tmdb.clearCache", Value::Null).await, Value::Null);
    assert!(e.rows().is_empty());
    assert_eq!(e.tmdb.cache().memory_len(), 0);
    e.call("tmdb.movie", json!({"title": "The Matrix", "tmdbId": 603}))
        .await;
    assert_eq!(e.stub.hits("/3/movie/603").len(), 2);
}

#[tokio::test]
async fn network_errors_never_echo_the_key() {
    let e = env().await;
    // Point at a port nobody listens on.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let tmdb = Tmdb::install(
        &e.state,
        Tmdb::new(e.state.http.clone(), format!("http://{closed}/3")),
    );
    let r = tmdb.test_key(&e.state, "secretkey123").await;
    assert!(!r.ok);
    let msg = r.message.unwrap();
    assert!(!msg.contains("secretkey123"), "key leaked: {msg}");

    e.enable(Some("secretkey123"));
    let err = e
        .router
        .dispatch(e.state.clone(), "tmdb.trending", Value::Null)
        .await
        .unwrap_err();
    assert!(
        !format!("{err:?}").contains("secretkey123"),
        "key leaked: {err:?}"
    );
}

/// B9 review round 1: server mode shows the key masked; testing the masked
/// value tests the stored key, not the mask.
#[tokio::test]
async fn test_key_with_the_masked_value_uses_the_stored_key() {
    let e = env().await;
    e.stub
        .route("/3/configuration", Route::ok(json!({"images": {}})));
    e.enable(Some("storedkey1234567"));
    let masked = format!("{}4567", iptv_core::settings::SECRET_MASK);
    let ok = e.call("tmdb.testKey", json!({ "apiKey": masked })).await;
    assert_eq!(ok, json!({"ok": true}));
    let hit = &e.stub.hits("/3/configuration")[0];
    assert_eq!(
        hit.query.get("api_key").map(String::as_str),
        Some("storedkey1234567")
    );
}
