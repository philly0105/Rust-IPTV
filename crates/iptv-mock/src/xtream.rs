//! Mock Xtream Codes panel under `/xtream` (SPEC C13).
//!
//! Credentials: `demo` / `secret`. Server URL for clients: `{base}/xtream`.
//!
//! - `player_api.php` (GET query or POST form): bare call and
//!   `get_account_info` return `user_info` + `server_info`; actions
//!   `get_live_categories`, `get_live_streams`, `get_vod_categories`,
//!   `get_vod_streams`, `get_vod_info`, `get_series_categories`,
//!   `get_series`, `get_series_info`, `get_short_epg`,
//!   `get_simple_data_table`. Wrong credentials: `{"user_info":{"auth":0}}`.
//! - `xmltv.php`: XMLTV for the 40 channels, yesterday through tomorrow.
//! - `get.php`: M3U of the live channels (`type=m3u_plus`).
//! - Streams: `live/{u}/{p}/{id}.m3u8|.ts`, `seg/{n}.ts`,
//!   `movie/{u}/{p}/{id}.mp4|.webm|.mkv`, `series/{u}/{p}/{id}.mp4`,
//!   `timeshift/{u}/{p}/{dur}/{start}/{id}.ts|.m3u8`, `timeshift.php`.
//!   Any numeric id plays, so generated playlists are playable too.
//!
//! Account modes (same password `secret`, same catalog as `demo`), picked by
//! the username, for subscription warnings and connection limits:
//! - `expiring`: trial, expires 3 days after `now`, 1 of 2 connections used.
//! - `expired`: status `Expired`, expired 2 days before `now`.
//! - `full`: 2 of 2 connections in use; stream, movie, episode and archive
//!   requests answer `403 Max connections reached`.
//!
//! The payload builders are pure functions of `(params, base, now)`, so the
//! `fixtures/xtream-*.json` samples are reproducible.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::Path;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::catalog::{self, Channel};
use crate::images::{backdrop_url, poster_url};
use crate::media::{self, serve_static, split_id_ext};
use crate::{gen, Base, MockState, Params};

/// Accepted username.
pub const USERNAME: &str = "demo";
/// Accepted password.
pub const PASSWORD: &str = "secret";

pub(crate) fn routes() -> Router<Arc<MockState>> {
    Router::new()
        .route("/xtream/player_api.php", get(player_api).post(player_api))
        .route("/xtream/xmltv.php", get(xmltv))
        .route("/xtream/get.php", get(get_php))
        .route("/xtream/live/{user}/{pass}/{file}", get(live))
        .route("/xtream/seg/{file}", get(segment))
        .route("/xtream/movie/{user}/{pass}/{file}", get(vod_file))
        .route("/xtream/series/{user}/{pass}/{file}", get(vod_file))
        .route(
            "/xtream/timeshift/{user}/{pass}/{dur}/{start}/{file}",
            get(timeshift),
        )
        .route("/xtream/timeshift.php", get(timeshift_php))
}

/// Username of the expiring trial account (see the module docs).
pub const USER_EXPIRING: &str = "expiring";
/// Username of the expired account.
pub const USER_EXPIRED: &str = "expired";
/// Username of the account whose connections are all in use.
pub const USER_FULL: &str = "full";

/// Subscription state of a mock account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountMode {
    Normal,
    Expiring,
    Expired,
    Full,
}

/// The account mode of `user`, or `None` for an unknown user.
pub fn account_mode(user: &str) -> Option<AccountMode> {
    match user {
        USERNAME => Some(AccountMode::Normal),
        USER_EXPIRING => Some(AccountMode::Expiring),
        USER_EXPIRED => Some(AccountMode::Expired),
        USER_FULL => Some(AccountMode::Full),
        _ => None,
    }
}

fn authed(user: &str, pass: &str) -> bool {
    account_mode(user).is_some() && pass == PASSWORD
}

/// Streams of a `full` account are refused the way panels do it.
fn connection_limited(user: &str) -> Option<Response> {
    (account_mode(user) == Some(AccountMode::Full))
        .then(|| (StatusCode::FORBIDDEN, "Max connections reached").into_response())
}

fn p<'a>(params: &'a HashMap<String, String>, key: &str) -> &'a str {
    params.get(key).map(String::as_str).unwrap_or("")
}

fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

fn host_port(base: &str) -> (String, String) {
    let rest = base.split("://").nth(1).unwrap_or(base);
    let rest = rest.split('/').next().unwrap_or(rest);
    match rest.rsplit_once(':') {
        Some((h, port)) => (h.to_string(), port.to_string()),
        None => (rest.to_string(), "80".to_string()),
    }
}

// ---------------------------------------------------------------------------
// player_api payloads
// ---------------------------------------------------------------------------

/// Builds the `player_api.php` response for `params`.
pub fn api(params: &HashMap<String, String>, base: &str, now: i64) -> (StatusCode, Value) {
    if !authed(p(params, "username"), p(params, "password")) {
        return (StatusCode::OK, json!({ "user_info": { "auth": 0 } }));
    }
    let category = params
        .get("category_id")
        .map(String::as_str)
        .filter(|c| !c.is_empty() && *c != "*");
    match p(params, "action") {
        "" | "get_account_info" | "get_user_info" => (
            StatusCode::OK,
            account_for(p(params, "username"), base, now),
        ),
        "get_live_categories" => (StatusCode::OK, categories(&catalog::LIVE_CATEGORIES)),
        "get_vod_categories" => (StatusCode::OK, categories(&catalog::VOD_CATEGORIES)),
        "get_series_categories" => (StatusCode::OK, categories(&catalog::SERIES_CATEGORIES)),
        "get_live_streams" => (StatusCode::OK, live_streams(base, category)),
        "get_vod_streams" => (StatusCode::OK, vod_streams(base, category)),
        "get_series" => (StatusCode::OK, series_list(base, category)),
        "get_vod_info" => {
            let id = p(params, "vod_id").parse::<u32>().unwrap_or(0);
            (StatusCode::OK, vod_info(base, id))
        }
        "get_series_info" => {
            let id = p(params, "series_id").parse::<u32>().unwrap_or(0);
            (StatusCode::OK, series_info(base, id))
        }
        "get_short_epg" => {
            let id = p(params, "stream_id").parse::<u32>().unwrap_or(0);
            let limit = p(params, "limit")
                .parse::<usize>()
                .unwrap_or(4)
                .clamp(1, 50);
            (StatusCode::OK, short_epg(id, now, limit))
        }
        "get_simple_data_table" | "get_simple_date_table" => {
            let id = p(params, "stream_id").parse::<u32>().unwrap_or(0);
            (StatusCode::OK, simple_data_table(id, now))
        }
        other => (
            StatusCode::BAD_REQUEST,
            json!({ "error": format!("Unknown action: {other}") }),
        ),
    }
}

/// Bare `player_api.php` response.
pub fn account(base: &str, now: i64) -> Value {
    account_for(USERNAME, base, now)
}

/// Bare `player_api.php` response for `user` (an [`account_mode`] name).
pub fn account_for(user: &str, base: &str, now: i64) -> Value {
    let (host, port) = host_port(base);
    let mode = account_mode(user).unwrap_or(AccountMode::Normal);
    let (status, exp, trial, active) = match mode {
        AccountMode::Normal => ("Active", catalog::EXPIRY, "0", "0"),
        AccountMode::Expiring => ("Active", now + 3 * 86_400, "1", "1"),
        AccountMode::Expired => ("Expired", now - 2 * 86_400, "0", "0"),
        AccountMode::Full => ("Active", catalog::EXPIRY, "0", "2"),
    };
    let user = if mode == AccountMode::Normal {
        USERNAME
    } else {
        user
    };
    json!({
        "user_info": {
            "username": user,
            "password": PASSWORD,
            "message": "Welcome to the iptv-mock Xtream panel",
            "auth": 1,
            "status": status,
            "exp_date": exp.to_string(),
            "is_trial": trial,
            "active_cons": active,
            "created_at": (catalog::EPOCH - 365 * 86_400).to_string(),
            "max_connections": "2",
            "allowed_output_formats": ["m3u8", "ts"]
        },
        "server_info": {
            "url": host,
            "port": port,
            "https_port": "",
            "server_protocol": "http",
            "rtmp_port": "",
            "timezone": "UTC",
            "timestamp_now": now,
            "time_now": catalog::sql_time(now),
            "process": true
        }
    })
}

fn categories(list: &[(&str, &str)]) -> Value {
    Value::Array(
        list.iter()
            .map(|(id, name)| json!({ "category_id": id, "category_name": name, "parent_id": 0 }))
            .collect(),
    )
}

fn live_stream(base: &str, num: usize, c: &Channel) -> Value {
    let archive = catalog::has_archive(c.id);
    json!({
        "num": num,
        "name": c.name,
        "stream_type": if c.radio { "radio_streams" } else { "live" },
        "stream_id": c.id,
        "stream_icon": gen::logo_url(base, c.epg_id),
        "epg_channel_id": c.epg_id,
        "added": (catalog::EPOCH - (c.id as i64 - 100) * 3_600).to_string(),
        "is_adult": 0,
        "category_id": c.category,
        "category_ids": [c.category.parse::<u32>().unwrap_or(0)],
        "custom_sid": "",
        "tv_archive": u8::from(archive),
        "direct_source": "",
        "tv_archive_duration": if archive { catalog::ARCHIVE_DAYS } else { 0 },
        "thumbnail": ""
    })
}

/// `get_live_streams`, optionally filtered by category.
pub fn live_streams(base: &str, category: Option<&str>) -> Value {
    Value::Array(
        catalog::CHANNELS
            .iter()
            .enumerate()
            .filter(|(_, c)| category.is_none_or(|cat| c.category == cat))
            .map(|(i, c)| live_stream(base, i + 1, c))
            .collect(),
    )
}

fn vod_id(index: usize) -> u32 {
    catalog::VOD_FIRST_ID + index as u32
}

fn rating5(r: f64) -> f64 {
    (r * 5.0).round() / 10.0
}

/// `get_vod_streams`, optionally filtered by category. `added` decreases
/// with id, so 201 is the most recently added film.
pub fn vod_streams(base: &str, category: Option<&str>) -> Value {
    Value::Array(
        catalog::MOVIES
            .iter()
            .take(catalog::VOD_COUNT as usize)
            .enumerate()
            .filter(|(_, m)| category.is_none_or(|cat| catalog::movie_category(m) == cat))
            .map(|(i, m)| {
                let cat = catalog::movie_category(m);
                json!({
                    "num": i + 1,
                    "name": format!("{} ({})", m.name, m.year),
                    "title": m.name,
                    "year": m.year.to_string(),
                    "stream_type": "movie",
                    "stream_id": vod_id(i),
                    "stream_icon": poster_url(base, m.slug),
                    "rating": format!("{:.1}", m.rating),
                    "rating_5based": rating5(m.rating),
                    "added": (catalog::EPOCH - i as i64 * 3 * 86_400).to_string(),
                    "is_adult": 0,
                    "category_id": cat,
                    "category_ids": [cat.parse::<u32>().unwrap_or(0)],
                    "container_extension": "mp4",
                    "custom_sid": "",
                    "direct_source": ""
                })
            })
            .collect(),
    )
}

/// `get_vod_info`. Unknown ids answer `{"info":[],"movie_data":[]}` like
/// real panels.
pub fn vod_info(base: &str, id: u32) -> Value {
    let Some(m) = catalog::movie(id) else {
        return json!({ "info": [], "movie_data": [] });
    };
    let idx = (id - catalog::VOD_FIRST_ID) as usize;
    let secs = catalog::movie_duration_secs(idx);
    let cat = catalog::movie_category(m);
    json!({
        "info": {
            "kinopoisk_url": "",
            "tmdb_id": (900_000 + id).to_string(),
            "name": m.name,
            "o_name": m.name,
            "cover_big": poster_url(base, m.slug),
            "movie_image": poster_url(base, m.slug),
            "releasedate": format!("{}-0{}-1{}", m.year, idx % 9 + 1, idx % 10),
            "release_date": format!("{}-0{}-1{}", m.year, idx % 9 + 1, idx % 10),
            "episode_run_time": (secs / 60).to_string(),
            "youtube_trailer": "",
            "director": m.director,
            "actors": m.actors,
            "cast": m.actors,
            "description": format!("{} {}", m.tagline, m.plot),
            "plot": m.plot,
            "age": "12",
            "mpaa_rating": "PG-13",
            "rating_count_kinopoisk": 0,
            "country": "United Kingdom",
            "genre": m.genre,
            "backdrop_path": [backdrop_url(base, m.slug)],
            "duration_secs": secs,
            "duration": catalog::hms(secs),
            "video": { "codec_name": "h264", "width": 320, "height": 180 },
            "audio": { "codec_name": "aac", "channels": 1 },
            "bitrate": 64,
            "rating": format!("{:.1}", m.rating),
            "rating_imdb": format!("{:.1}", m.rating),
            "status": "Released",
            "runtime": (secs / 60).to_string()
        },
        "movie_data": {
            "stream_id": id,
            "name": format!("{} ({})", m.name, m.year),
            "title": m.name,
            "year": m.year.to_string(),
            "added": (catalog::EPOCH - idx as i64 * 3 * 86_400).to_string(),
            "category_id": cat,
            "category_ids": [cat.parse::<u32>().unwrap_or(0)],
            "container_extension": "mp4",
            "custom_sid": "",
            "direct_source": ""
        }
    })
}

/// `get_series`, optionally filtered by category.
pub fn series_list(base: &str, category: Option<&str>) -> Value {
    Value::Array(
        catalog::SERIES
            .iter()
            .enumerate()
            .filter(|(_, s)| category.is_none_or(|cat| s.category == cat))
            .map(|(i, s)| {
                let id = catalog::SERIES_FIRST_ID + i as u32;
                json!({
                    "num": i + 1,
                    "name": s.name,
                    "title": s.name,
                    "year": s.year.to_string(),
                    "stream_type": "series",
                    "series_id": id,
                    "cover": poster_url(base, s.slug),
                    "plot": s.plot,
                    "cast": s.cast,
                    "director": s.director,
                    "genre": s.genre,
                    "releaseDate": format!("{}-03-01", s.year),
                    "release_date": format!("{}-03-01", s.year),
                    "last_modified": (catalog::EPOCH - i as i64 * 5 * 86_400).to_string(),
                    "rating": format!("{:.1}", s.rating),
                    "rating_5based": rating5(s.rating),
                    "backdrop_path": [backdrop_url(base, s.slug)],
                    "youtube_trailer": "",
                    "episode_run_time": "42",
                    "category_id": s.category,
                    "category_ids": [s.category.parse::<u32>().unwrap_or(0)]
                })
            })
            .collect(),
    )
}

/// `get_series_info`: seasons, info, and episodes keyed by season number
/// (`"1"`, `"2"`). Episode ids start at 3001. Unknown ids answer with empty
/// collections.
pub fn series_info(base: &str, id: u32) -> Value {
    let Some(s) = catalog::series(id) else {
        return json!({ "seasons": [], "info": [], "episodes": [] });
    };
    let mut seasons = Vec::new();
    let mut episodes = serde_json::Map::new();
    for season in 1..=catalog::SEASONS {
        seasons.push(json!({
            "air_date": format!("{}-0{}-01", s.year + season - 1, season + 1),
            "episode_count": catalog::EPISODES_PER_SEASON,
            "id": id * 100 + season,
            "name": format!("Season {season}"),
            "overview": format!("Season {season} of {}.", s.name),
            "season_number": season,
            "vote_average": s.rating,
            "cover": poster_url(base, s.slug),
            "cover_big": poster_url(base, s.slug)
        }));
        let list: Vec<Value> = (1..=catalog::EPISODES_PER_SEASON)
            .map(|ep| {
                let eid = catalog::episode_id(id, season, ep);
                let secs = 2_400 + (catalog::mix(eid as u64) % 900) as u32;
                json!({
                    "id": eid.to_string(),
                    "episode_num": ep,
                    "title": format!("{} - S{season:02}E{ep:02} - {}", s.name, catalog::episode_title(id, season, ep)),
                    "container_extension": "mp4",
                    "info": {
                        "tmdb_id": 800_000 + eid,
                        "releasedate": format!("{}-0{}-{:02}", s.year + season - 1, season + 1, ep * 7),
                        "plot": format!("{} Episode {ep} of season {season}.", s.plot),
                        "duration_secs": secs,
                        "duration": catalog::hms(secs),
                        "movie_image": backdrop_url(base, s.slug),
                        "bitrate": 64,
                        "rating": s.rating,
                        "season": season.to_string(),
                        "name": catalog::episode_title(id, season, ep)
                    },
                    "custom_sid": "",
                    "added": (catalog::EPOCH - (eid as i64 % 60) * 86_400).to_string(),
                    "season": season,
                    "direct_source": ""
                })
            })
            .collect();
        episodes.insert(season.to_string(), Value::Array(list));
    }
    json!({
        "seasons": seasons,
        "info": {
            "name": s.name,
            "title": s.name,
            "year": s.year.to_string(),
            "cover": poster_url(base, s.slug),
            "plot": s.plot,
            "cast": s.cast,
            "director": s.director,
            "genre": s.genre,
            "releaseDate": format!("{}-03-01", s.year),
            "release_date": format!("{}-03-01", s.year),
            "last_modified": catalog::EPOCH.to_string(),
            "rating": format!("{:.1}", s.rating),
            "rating_5based": rating5(s.rating),
            "backdrop_path": [backdrop_url(base, s.slug)],
            "youtube_trailer": "",
            "episode_run_time": "42",
            "category_id": s.category,
            "category_ids": [s.category.parse::<u32>().unwrap_or(0)]
        },
        "episodes": episodes
    })
}

fn epg_listing(id: u32, p: &catalog::Programme, now: i64, with_flags: bool) -> Value {
    let c = catalog::channel(id);
    let epg_id = c.map(|c| c.epg_id).unwrap_or("");
    let idx = catalog::channel_index(id);
    let mut v = json!({
        "id": p.id(idx).to_string(),
        "epg_id": epg_id,
        "title": b64(&p.title),
        "lang": "en",
        "start": catalog::sql_time(p.start),
        "end": catalog::sql_time(p.stop),
        "description": b64(&p.desc),
        "channel_id": epg_id,
        "start_timestamp": p.start.to_string(),
        "stop_timestamp": p.stop.to_string(),
        "stream_id": id.to_string()
    });
    if with_flags {
        v["now_playing"] = json!(u8::from(p.start <= now && now < p.stop));
        v["has_archive"] = json!(u8::from(catalog::has_archive(id) && p.stop <= now));
    }
    v
}

/// `get_short_epg`: the programme airing now and the following ones
/// (`limit`, default 4). Titles and descriptions are base64, as on real
/// panels.
pub fn short_epg(id: u32, now: i64, limit: usize) -> Value {
    if catalog::channel(id).is_none() {
        return json!({ "epg_listings": [] });
    }
    let list: Vec<Value> = catalog::programmes_from_now(id, now, limit)
        .iter()
        .map(|p| epg_listing(id, p, now, false))
        .collect();
    json!({ "epg_listings": list })
}

/// `get_simple_data_table`: the full 3-day window (yesterday..tomorrow) with
/// `now_playing` and `has_archive` flags.
pub fn simple_data_table(id: u32, now: i64) -> Value {
    if catalog::channel(id).is_none() {
        return json!({ "epg_listings": [] });
    }
    let from = catalog::day_start(now) - 86_400;
    let list: Vec<Value> = catalog::channel_schedule(id, from, from + 3 * 86_400)
        .iter()
        .map(|p| epg_listing(id, p, now, true))
        .collect();
    json!({ "epg_listings": list })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn player_api(Base(base): Base, Params(params): Params) -> Response {
    let (status, body) = api(&params, &base, catalog::now());
    (status, Json(body)).into_response()
}

async fn xmltv(Base(base): Base, Params(params): Params) -> Response {
    if !authed(p(&params, "username"), p(&params, "password")) {
        return (StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    }
    (
        [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
        gen::xtream_xmltv(&base, catalog::now()),
    )
        .into_response()
}

async fn get_php(Base(base): Base, Params(params): Params) -> Response {
    let (user, pass) = (p(&params, "username"), p(&params, "password"));
    if !authed(user, pass) {
        return (StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    }
    let ext = if p(&params, "output") == "ts" {
        "ts"
    } else {
        "m3u8"
    };
    let mut out =
        format!("#EXTM3U url-tvg=\"{base}/xtream/xmltv.php?username={user}&password={pass}\"\n");
    for c in &catalog::CHANNELS {
        let cat = catalog::LIVE_CATEGORIES
            .iter()
            .find(|(id, _)| *id == c.category)
            .map(|(_, n)| *n)
            .unwrap_or("");
        out.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"{}\" tvg-name=\"{}\" tvg-logo=\"{}\" group-title=\"{}\",{}\n{base}/xtream/live/{user}/{pass}/{}.{ext}\n",
            c.epg_id,
            c.name,
            gen::logo_url(&base, c.epg_id),
            cat,
            c.name,
            c.id
        ));
    }
    (
        [(header::CONTENT_TYPE, "audio/x-mpegurl; charset=utf-8")],
        out,
    )
        .into_response()
}

fn forbidden() -> Response {
    (StatusCode::UNAUTHORIZED, "invalid credentials").into_response()
}

async fn live(
    Base(base): Base,
    headers: HeaderMap,
    Path((user, pass, file)): Path<(String, String, String)>,
) -> Response {
    if !authed(&user, &pass) {
        return forbidden();
    }
    if let Some(r) = connection_limited(&user) {
        return r;
    }
    match split_id_ext(&file) {
        Some((_, "m3u8")) => media::m3u8_response(media::live_playlist(&base, catalog::now())),
        Some((_, "ts")) | Some((_, "")) => media::serve_owned(
            &headers,
            media::live_loop_ts(),
            "video/mp2t",
            "\"live-loop\"".to_string(),
        ),
        _ => (StatusCode::NOT_FOUND, "unknown stream").into_response(),
    }
}

async fn segment(headers: HeaderMap, Path(file): Path<String>) -> Response {
    match split_id_ext(&file) {
        Some((n, "ts")) => media::serve_owned(
            &headers,
            media::live_segment(n),
            "video/mp2t",
            format!("\"seg-{n}\""),
        ),
        _ => (StatusCode::NOT_FOUND, "unknown segment").into_response(),
    }
}

async fn vod_file(
    Base(base): Base,
    headers: HeaderMap,
    Path((user, pass, file)): Path<(String, String, String)>,
) -> Response {
    if !authed(&user, &pass) {
        return forbidden();
    }
    if let Some(r) = connection_limited(&user) {
        return r;
    }
    match split_id_ext(&file) {
        Some((_, "webm")) => serve_static(
            &headers,
            media::SAMPLE_WEBM,
            "video/webm",
            "\"sample-webm\"",
        ),
        Some((_, ext @ ("mp4" | "mkv" | "avi" | "m4v" | ""))) => {
            let ct = if ext == "mkv" {
                "video/x-matroska"
            } else {
                "video/mp4"
            };
            serve_static(&headers, media::SAMPLE_MP4, ct, "\"sample-mp4\"")
        }
        Some((_, "m3u8")) => media::m3u8_response(media::vod_playlist(&base, 30)),
        _ => (StatusCode::NOT_FOUND, "unknown file").into_response(),
    }
}

async fn timeshift(
    Base(base): Base,
    headers: HeaderMap,
    Path((user, pass, dur, _start, file)): Path<(String, String, String, String, String)>,
) -> Response {
    if !authed(&user, &pass) {
        return forbidden();
    }
    if let Some(r) = connection_limited(&user) {
        return r;
    }
    timeshift_body(&base, &headers, &file, &dur)
}

async fn timeshift_php(Base(base): Base, headers: HeaderMap, Params(params): Params) -> Response {
    if !authed(p(&params, "username"), p(&params, "password")) {
        return forbidden();
    }
    if let Some(r) = connection_limited(p(&params, "username")) {
        return r;
    }
    let file = format!("{}.ts", p(&params, "stream"));
    timeshift_body(&base, &headers, &file, p(&params, "duration"))
}

fn timeshift_body(base: &str, headers: &HeaderMap, file: &str, dur: &str) -> Response {
    let minutes = dur.parse::<u32>().unwrap_or(60).clamp(1, 600);
    match split_id_ext(file) {
        Some((_, "m3u8")) => {
            media::m3u8_response(media::vod_playlist(base, (minutes * 30).min(1_800)))
        }
        Some((_, "ts")) | Some((_, "")) => media::serve_owned(
            headers,
            media::live_loop_ts(),
            "video/mp2t",
            "\"live-loop\"".to_string(),
        ),
        _ => (StatusCode::NOT_FOUND, "unknown archive").into_response(),
    }
}

/// Representative payloads written to `fixtures/xtream-*.json`.
pub fn sample_payloads(base: &str, now: i64) -> Vec<(&'static str, Value)> {
    let q = |pairs: &[(&str, &str)]| -> Value {
        let mut m: HashMap<String, String> = [("username", USERNAME), ("password", PASSWORD)]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        m.extend(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        api(&m, base, now).1
    };
    vec![
        ("xtream-account.json", q(&[])),
        (
            "xtream-live-categories.json",
            q(&[("action", "get_live_categories")]),
        ),
        (
            "xtream-live-streams.json",
            q(&[("action", "get_live_streams")]),
        ),
        (
            "xtream-vod-categories.json",
            q(&[("action", "get_vod_categories")]),
        ),
        (
            "xtream-vod-streams.json",
            q(&[("action", "get_vod_streams")]),
        ),
        (
            "xtream-vod-info.json",
            q(&[("action", "get_vod_info"), ("vod_id", "201")]),
        ),
        (
            "xtream-series-categories.json",
            q(&[("action", "get_series_categories")]),
        ),
        ("xtream-series.json", q(&[("action", "get_series")])),
        (
            "xtream-series-info.json",
            q(&[("action", "get_series_info"), ("series_id", "301")]),
        ),
        (
            "xtream-short-epg.json",
            q(&[("action", "get_short_epg"), ("stream_id", "101")]),
        ),
        (
            "xtream-auth-failed.json",
            json!({ "user_info": { "auth": 0 } }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        let mut m: HashMap<String, String> = HashMap::new();
        m.insert("username".into(), USERNAME.into());
        m.insert("password".into(), PASSWORD.into());
        for (k, v) in pairs {
            m.insert(k.to_string(), v.to_string());
        }
        m
    }

    #[test]
    fn counts_match_spec() {
        let now = catalog::EPOCH + 43_200;
        let base = "http://h:1";
        assert_eq!(
            api(&params(&[("action", "get_live_categories")]), base, now)
                .1
                .as_array()
                .unwrap()
                .len(),
            3
        );
        let live = api(&params(&[("action", "get_live_streams")]), base, now).1;
        let live = live.as_array().unwrap();
        assert_eq!(live.len(), 40);
        assert_eq!(live[0]["stream_id"], 101);
        assert_eq!(live[0]["epg_channel_id"], "bbc1.uk");
        assert_eq!(live.iter().filter(|c| c["tv_archive"] == 1).count(), 5);
        let vod = api(&params(&[("action", "get_vod_streams")]), base, now).1;
        assert_eq!(vod.as_array().unwrap().len(), 30);
        assert_eq!(
            api(&params(&[("action", "get_vod_categories")]), base, now)
                .1
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            api(&params(&[("action", "get_series")]), base, now)
                .1
                .as_array()
                .unwrap()
                .len(),
            10
        );
        let by_cat = api(
            &params(&[("action", "get_live_streams"), ("category_id", "2")]),
            base,
            now,
        )
        .1;
        assert!(by_cat
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["category_id"] == "2"));
    }

    #[test]
    fn account_modes_report_expiry_and_connections() {
        let now = catalog::EPOCH + 1_000;
        let acc = |user: &str| {
            let mut m = params(&[]);
            m.insert("username".into(), user.into());
            api(&m, "http://h:1", now).1["user_info"].clone()
        };
        let demo = acc(USERNAME);
        assert_eq!(demo["status"], "Active");
        assert_eq!(demo["active_cons"], "0");
        let e = acc(USER_EXPIRING);
        assert_eq!(e["exp_date"], (now + 3 * 86_400).to_string());
        assert_eq!(e["is_trial"], "1");
        let x = acc(USER_EXPIRED);
        assert_eq!(x["status"], "Expired");
        assert_eq!(x["exp_date"], (now - 2 * 86_400).to_string());
        let f = acc(USER_FULL);
        assert_eq!(
            (f["active_cons"].clone(), f["max_connections"].clone()),
            ("2".into(), "2".into())
        );
        assert_eq!(acc("nobody")["auth"], 0);
        assert!(connection_limited(USER_FULL).is_some());
        assert!(connection_limited(USERNAME).is_none());
    }

    #[test]
    fn series_info_keys_episodes_by_season() {
        let v = series_info("http://h", 301);
        assert_eq!(v["seasons"].as_array().unwrap().len(), 2);
        assert_eq!(v["episodes"]["1"].as_array().unwrap().len(), 3);
        assert_eq!(v["episodes"]["1"][0]["id"], "3001");
        assert_eq!(v["episodes"]["2"][2]["id"], "3006");
        assert_eq!(
            series_info("http://h", 310)["episodes"]["2"][2]["id"],
            "3060"
        );
    }

    #[test]
    fn short_epg_is_base64_and_starts_now() {
        let now = catalog::EPOCH + 50_000;
        let v = short_epg(101, now, 4);
        let list = v["epg_listings"].as_array().unwrap();
        assert_eq!(list.len(), 4);
        let start: i64 = list[0]["start_timestamp"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let stop: i64 = list[0]["stop_timestamp"].as_str().unwrap().parse().unwrap();
        assert!(start <= now && now < stop);
        let title = base64::engine::general_purpose::STANDARD
            .decode(list[0]["title"].as_str().unwrap())
            .unwrap();
        assert!(!String::from_utf8(title).unwrap().is_empty());
    }

    #[test]
    fn bad_credentials() {
        let mut m = params(&[]);
        m.insert("password".into(), "nope".into());
        assert_eq!(
            api(&m, "http://h", 0).1,
            json!({ "user_info": { "auth": 0 } })
        );
    }
}
