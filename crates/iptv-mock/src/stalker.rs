//! Mock Stalker / Ministra portal under `/stalker` (SPEC C13).
//!
//! Endpoints (all GET or POST form, identical behaviour):
//! `/stalker/portal.php`, `/stalker/c/portal.php`, `/stalker/server/load.php`,
//! `/stalker/stalker_portal/server/load.php`. `/stalker/c/` serves a tiny STB
//! page, as real portals do.
//!
//! Auth model:
//! - The MAC comes from the `mac=` cookie (percent-decoded, case-insensitive)
//!   or a `mac` query parameter. Only [`MAC`] is registered.
//! - `handshake` answers any MAC with token `mock-token-<generation>`
//!   (generation starts at 1, so the token is [`TOKEN`]). Re-presenting the
//!   current token returns it unchanged.
//! - Every other action needs `Authorization: Bearer <current token>`;
//!   otherwise the portal answers HTTP 200 `text/html` `Authorization failed.`
//!   exactly like the real middleware.
//! - With a valid token but an unregistered MAC, `get_profile` answers
//!   `{"js":{"status":1,"msg":..,"block_msg":..}}` and every other action
//!   answers `Authorization failed.`.
//! - `POST /stalker/_control/expire` bumps the generation, invalidating the
//!   current token (for retry/re-handshake tests); `/stalker/_control/reset`
//!   restores generation 1.
//!
//! Content: 30 ITV channels (ids 1001..=1030 mirroring Xtream 101..=130,
//! 1001..=1005 with archive), 5 radio stations (2001..=2005), 30 VOD rows in
//! 2 categories (5001..=5030), 10 series in 2 categories (7001..=7010, each 2
//! seasons x 3 episodes). `get_ordered_list` pages by 14.
//!
//! VOD rows 5001..=5029 are films mirroring Xtream 201..=229. Row 5030 is a
//! VOD-as-series box set ([`catalog::VOD_SERIES`], `is_series: "1"`, category
//! "11"): it takes the last slot so the listing still totals 30 and the
//! first pages are unchanged. Its children come from `vod get_ordered_list`:
//! - `movie_id=5030` -> 2 season rows (`is_season: true`, ids `5030:1`,
//!   `5030:2`, `video_id` `5030`);
//! - `movie_id=5030&season_id=5030:<s>` (or `movie_id=5030:<s>`) -> episode
//!   rows (`is_episode: true`, ids `5030:<s>:<e>`, 3 in season 1 and 2 in
//!   season 2, `cmd` `/media/file_5030<s><e>.mpg`);
//! - `movie_id=5030:<s>:<e>` -> that episode's single file row.
//!
//! `create_link` maps `/media/file_5030<s><e>.mpg` to
//! `/xtream/series/demo/secret/5030<s><e>.mp4`.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::catalog::{self, Movie, Series};
use crate::images::{backdrop_url, poster_url};
use crate::{gen, Base, MockState, Params};

/// The only registered MAC address.
pub const MAC: &str = "00:1A:79:00:00:01";
/// Token issued by the first handshake.
pub const TOKEN: &str = "mock-token-1";
/// `get_ordered_list` page size.
pub const PAGE_SIZE: usize = 14;
/// Body of auth failures.
pub const AUTH_FAILED: &str = "Authorization failed.";

const ITV_FIRST: u32 = 1001;
const ITV_COUNT: u32 = 30;
const RADIO_FIRST: u32 = 2001;
const VOD_FIRST: u32 = 5001;
const VOD_COUNT: usize = 30;
const SERIES_FIRST: u32 = 7001;
/// Listing slot of the VOD-as-series box set (the last one).
const VOD_SERIES_SLOT: usize = VOD_COUNT - 1;
/// Stalker id of the VOD-as-series box set ([`catalog::VOD_SERIES`]).
pub const VOD_SERIES_ID: u32 = VOD_FIRST + VOD_SERIES_SLOT as u32;

const RADIO_NAMES: [&str; 5] = [
    "Classic FM",
    "Jazz FM",
    "Rock Radio",
    "Talk Radio 24",
    "Chill Lounge",
];

pub(crate) fn routes() -> Router<Arc<MockState>> {
    Router::new()
        .route("/stalker/portal.php", get(portal).post(portal))
        .route("/stalker/c/portal.php", get(portal).post(portal))
        .route("/stalker/server/load.php", get(portal).post(portal))
        .route(
            "/stalker/stalker_portal/server/load.php",
            get(portal).post(portal),
        )
        .route("/stalker/c", get(stb_page))
        .route("/stalker/c/", get(stb_page))
        .route("/stalker/c/index.html", get(stb_page))
        .route("/stalker/_control/expire", post(expire))
        .route("/stalker/_control/reset", post(reset))
}

/// Token for a generation.
pub fn token_for(generation: u32) -> String {
    format!("mock-token-{generation}")
}

fn p<'a>(params: &'a HashMap<String, String>, key: &str) -> &'a str {
    params.get(key).map(String::as_str).unwrap_or("")
}

/// MAC from the `mac=` cookie or the `mac` parameter.
pub fn extract_mac(headers: &HeaderMap, params: &HashMap<String, String>) -> String {
    let from_cookie = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| k.trim() == "mac")
        .map(|(_, v)| v.trim().to_string());
    let raw = from_cookie.unwrap_or_else(|| p(params, "mac").to_string());
    percent_encoding::percent_decode_str(&raw)
        .decode_utf8_lossy()
        .trim()
        .to_string()
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = v.trim().split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim().to_string())
}

fn auth_failed() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        AUTH_FAILED,
    )
        .into_response()
}

async fn portal(
    State(state): State<Arc<MockState>>,
    Base(base): Base,
    headers: HeaderMap,
    Params(params): Params,
) -> Response {
    let generation = state.stalker_generation.load(Ordering::SeqCst);
    let token = token_for(generation);
    let mac = extract_mac(&headers, &params);
    let action = p(&params, "action");
    let now = catalog::now();

    if action == "handshake" {
        return Json(handshake(&token, now)).into_response();
    }
    if bearer(&headers).as_deref() != Some(token.as_str()) {
        return auth_failed();
    }
    if !mac.eq_ignore_ascii_case(MAC) {
        if action == "get_profile" {
            return Json(json!({ "js": {
                "id": null,
                "status": 1,
                "msg": format!("MAC address {mac} is not registered"),
                "block_msg": "Your STB is not registered.<br/> Call the provider."
            }}))
            .into_response();
        }
        return auth_failed();
    }
    Json(respond(&params, &mac, &base, now)).into_response()
}

/// `stb.handshake` payload.
pub fn handshake(token: &str, now: i64) -> Value {
    json!({ "js": {
        "token": token,
        "random": "5a1e7c0b9d3f4e2a8c6b1d0e9f7a3c5b2e4d6f80",
        "not_valid": 0,
        "keep_alive": 180,
        "servertime": now,
        "servertimezone": "UTC",
        "version": "5.6.2",
        "revision": "1"
    }})
}

/// Payload for an authenticated request. Pure function of its inputs.
pub fn respond(params: &HashMap<String, String>, mac: &str, base: &str, now: i64) -> Value {
    let typ = p(params, "type");
    let action = p(params, "action");
    match (typ, action) {
        (_, "get_profile") => profile(mac, p(params, "stb_type")),
        (_, "do_auth") => json!({ "js": true }),
        (_, "get_localization") => {
            json!({ "js": { "lang": "en", "all": "All", "favorites": "Favorites" } })
        }
        (_, "log")
        | (_, "set_fav")
        | (_, "set_last_id")
        | (_, "set_played")
        | (_, "set_vclub_not_ended") => {
            json!({ "js": true })
        }
        (_, "get_preload_images") | (_, "get_fav_ids") | (_, "get_genres_by_category_alias") => {
            json!({ "js": [] })
        }
        ("watchdog", "get_events") | (_, "get_events") => {
            json!({ "js": { "data": { "msgs": 0, "additional_services_on": "1" } } })
        }
        ("account_info", "get_main_info") | (_, "get_main_info") => json!({ "js": {
            "mac": mac,
            "phone": "",
            "fname": "Mock User",
            "tariff_plan": "Mock Premium",
            "end_date": catalog::sql_time(catalog::EXPIRY)
        }}),
        ("itv", "get_genres") => genres(&catalog::LIVE_CATEGORIES),
        ("itv", "get_all_channels") => {
            let all: Vec<Value> = (0..ITV_COUNT).map(|i| itv_channel(base, i)).collect();
            let n = all.len();
            json!({ "js": { "total_items": n, "max_page_items": n, "selected_item": 0, "cur_page": 0, "data": all } })
        }
        ("itv", "get_ordered_list") => {
            let genre = first_non_empty(params, &["genre", "category"]);
            let items: Vec<Value> = (0..ITV_COUNT)
                .filter(|i| genre.is_none_or(|g| itv_source(*i).category == g))
                .map(|i| itv_channel(base, i))
                .collect();
            page(
                filter_search(items, p(params, "search")),
                page_param(params),
            )
        }
        ("itv", "get_short_epg") => {
            let size = p(params, "size")
                .parse::<usize>()
                .unwrap_or(10)
                .clamp(1, 50);
            short_epg(p(params, "ch_id"), now, size)
        }
        ("itv", "get_epg_info") => {
            let period = p(params, "period")
                .parse::<i64>()
                .unwrap_or(168)
                .clamp(1, 24 * 14);
            epg_info(now, period)
        }
        ("itv", "get_simple_data_table") | ("tv_archive", "get_simple_data_table") => {
            simple_data_table(
                p(params, "ch_id"),
                p(params, "date"),
                page_param(params),
                now,
            )
        }
        ("itv", "create_link")
        | ("tv_archive", "create_link")
        | ("vod", "create_link")
        | ("series", "create_link")
        | ("radio", "create_link") => create_link(typ, params, base, now),
        ("radio", "get_ordered_list") => {
            let items: Vec<Value> = (0..RADIO_NAMES.len())
                .map(|i| radio_station(base, i))
                .collect();
            page(
                filter_search(items, p(params, "search")),
                page_param(params),
            )
        }
        ("radio", "get_genres") => genres(&[("40", "Radio")]),
        ("vod", "get_categories") | ("vod", "get_genres") => genres(&catalog::VOD_CATEGORIES),
        ("series", "get_categories") | ("series", "get_genres") => {
            genres(&catalog::SERIES_CATEGORIES)
        }
        ("vod", "get_ordered_list") => {
            if !p(params, "movie_id").is_empty() {
                return vod_children(params, base);
            }
            let cat = first_non_empty(params, &["category", "genre"]);
            let items: Vec<Value> = (0..VOD_COUNT)
                .filter(|i| cat.is_none_or(|c| vod_category(*i) == c))
                .map(|i| {
                    if i == VOD_SERIES_SLOT {
                        vod_series_item(base, i)
                    } else {
                        vod_item(base, i, &catalog::MOVIES[i])
                    }
                })
                .collect();
            page(
                filter_search(items, p(params, "search")),
                page_param(params),
            )
        }
        ("series", "get_ordered_list") => series_list(params, base),
        (t, a) => json!({ "js": { "error": format!("Unknown action: {t}.{a}") } }),
    }
}

fn first_non_empty<'a>(params: &'a HashMap<String, String>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .map(|k| p(params, k))
        .find(|v| !v.is_empty())
        .filter(|v| *v != "*" && *v != "0")
}

fn page_param(params: &HashMap<String, String>) -> usize {
    p(params, "p").parse::<usize>().unwrap_or(1).max(1)
}

fn filter_search(items: Vec<Value>, search: &str) -> Vec<Value> {
    if search.is_empty() {
        return items;
    }
    let needle = search.to_lowercase();
    items
        .into_iter()
        .filter(|v| {
            v["name"]
                .as_str()
                .is_some_and(|n| n.to_lowercase().contains(&needle))
        })
        .collect()
}

/// Paged `{"js":{total_items,max_page_items,selected_item,cur_page,data}}`.
pub fn page(items: Vec<Value>, page: usize) -> Value {
    let total = items.len();
    let data: Vec<Value> = items
        .into_iter()
        .skip((page - 1) * PAGE_SIZE)
        .take(PAGE_SIZE)
        .collect();
    json!({ "js": {
        "total_items": total,
        "max_page_items": PAGE_SIZE,
        "selected_item": 0,
        "cur_page": page,
        "data": data
    }})
}

fn genres(list: &[(&str, &str)]) -> Value {
    let v: Vec<Value> = list
        .iter()
        .map(|(id, title)| {
            json!({
                "id": id,
                "title": title,
                "alias": title.to_lowercase().replace(" & ", "_").replace(' ', "_"),
                "censored": 0,
                "active_sub": true
            })
        })
        .collect();
    json!({ "js": v })
}

fn profile(mac: &str, stb_type: &str) -> Value {
    json!({ "js": {
        "id": "1",
        "name": "Mock STB",
        "sname": "",
        "login": "",
        "fname": "Mock User",
        "mac": mac,
        "status": 0,
        "blocked": "0",
        "stb_type": if stb_type.is_empty() { "MAG250" } else { stb_type },
        "hd": "1",
        "locale": "en_GB.utf8",
        "default_locale": "en_GB.utf8",
        "default_timezone": "UTC",
        "watchdog_timeout": 120,
        "timeslot": 15,
        "tariff_plan_id": "1",
        "tariff_expired_date": catalog::date(catalog::EXPIRY),
        "play_in_preview_by_ok": true,
        "allowed_stb_types": ["mag250", "mag254", "mag256", "mag322", "mag324", "mag420"]
    }})
}

// ---------------------------------------------------------------------------
// ITV
// ---------------------------------------------------------------------------

fn itv_source(i: u32) -> &'static catalog::Channel {
    &catalog::CHANNELS[i as usize]
}

fn itv_index(ch_id: &str) -> Option<u32> {
    let id: u32 = ch_id.trim().parse().ok()?;
    let i = id.checked_sub(ITV_FIRST)?;
    (i < ITV_COUNT).then_some(i)
}

fn itv_channel(base: &str, i: u32) -> Value {
    let c = itv_source(i);
    let id = ITV_FIRST + i;
    let archive = catalog::has_archive(c.id);
    let cmd = format!("ffmpeg http://localhost/ch/{id}_");
    json!({
        "id": id.to_string(),
        "name": c.name,
        "number": (i + 1).to_string(),
        "censored": 0,
        "cmd": cmd,
        "cost": "0",
        "count": "0",
        "status": 1,
        "hd": "1",
        "tv_genre_id": c.category,
        "base_ch": "1",
        "xmltv_id": c.epg_id,
        "service_id": "",
        "logo": gen::logo_url(base, c.epg_id),
        "enable_tv_archive": u8::from(archive),
        "tv_archive": u8::from(archive),
        "archive": u8::from(archive),
        "tv_archive_duration": if archive { catalog::ARCHIVE_DAYS * 24 } else { 0 },
        "allow_local_timeshift": "1",
        "use_http_tmp_link": "1",
        "use_load_balancing": "0",
        "wowza_tmp_link": "0",
        "nginx_secure_link": "0",
        "lock": 0,
        "fav": 0,
        "open": 1,
        "cmds": [{
            "id": id.to_string(),
            "ch_id": id.to_string(),
            "priority": "0",
            "url": cmd,
            "status": "1",
            "use_http_tmp_link": "1",
            "use_load_balancing": "0"
        }]
    })
}

fn radio_station(base: &str, i: usize) -> Value {
    let id = RADIO_FIRST + i as u32;
    let name = RADIO_NAMES[i];
    json!({
        "id": id.to_string(),
        "name": name,
        "number": (i + 1).to_string(),
        "cmd": format!("ffmpeg {}?station={id}", gen::radio_url(base)),
        "logo": gen::logo_url(base, &format!("radio-{id}")),
        "tv_genre_id": "40",
        "radio": true,
        "status": 1,
        "censored": 0,
        "count": "0",
        "use_http_tmp_link": "0",
        "use_load_balancing": "0",
        "fav": 0,
        "lock": 0
    })
}

/// Stalker program id: `(start / 60) * 1000 + channel offset`.
fn program_id(ch_index: u32, start: i64) -> i64 {
    (start / 60) * 1000 + ch_index as i64
}

fn program_json(ch_index: u32, p: &catalog::Programme, now: i64) -> Value {
    let ch_id = ITV_FIRST + ch_index;
    let archive = catalog::has_archive(itv_source(ch_index).id) && p.stop <= now;
    let id = program_id(ch_index, p.start);
    json!({
        "id": id.to_string(),
        "ch_id": ch_id.to_string(),
        "time": catalog::sql_time(p.start),
        "time_to": catalog::sql_time(p.stop),
        "duration": p.stop - p.start,
        "name": p.title,
        "descr": p.desc,
        "real_id": format!("{ch_id}_{}", p.start),
        "category": p.category,
        "director": "",
        "actor": "",
        "start_timestamp": p.start,
        "stop_timestamp": p.stop,
        "t_time": catalog::hhmm(p.start),
        "t_time_to": catalog::hhmm(p.stop),
        "mark_memo": 0,
        "mark_archive": u8::from(archive),
        "mark_rec": 0
    })
}

/// `itv.get_short_epg`: `{"js":[...]}` from the programme airing now.
pub fn short_epg(ch_id: &str, now: i64, size: usize) -> Value {
    let Some(i) = itv_index(ch_id) else {
        return json!({ "js": [] });
    };
    let list: Vec<Value> = catalog::programmes_from_now(itv_source(i).id, now, size)
        .iter()
        .map(|p| program_json(i, p, now))
        .collect();
    json!({ "js": list })
}

fn epg_info(now: i64, period_hours: i64) -> Value {
    let from = catalog::day_start(now);
    let to = now + period_hours * 3_600;
    let mut data = serde_json::Map::new();
    for i in 0..ITV_COUNT {
        let list: Vec<Value> = catalog::channel_schedule(itv_source(i).id, from, to)
            .iter()
            .map(|p| program_json(i, p, now))
            .collect();
        data.insert((ITV_FIRST + i).to_string(), Value::Array(list));
    }
    json!({ "js": { "data": data } })
}

fn simple_data_table(ch_id: &str, date: &str, page_no: usize, now: i64) -> Value {
    const PER_PAGE: usize = 10;
    let Some(i) = itv_index(ch_id) else {
        return json!({ "js": { "total_items": 0, "max_page_items": PER_PAGE, "selected_item": 0, "cur_page": 1, "data": [] } });
    };
    let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc().timestamp())
        .unwrap_or_else(|| catalog::day_start(now));
    let all = catalog::channel_schedule(itv_source(i).id, day, day + 86_400);
    let now_idx = all.iter().position(|p| p.start <= now && now < p.stop);
    // Real portals open on the page holding the current programme.
    let page_no = if date.is_empty() && page_no == 1 {
        now_idx.map(|n| n / PER_PAGE + 1).unwrap_or(1)
    } else {
        page_no
    };
    let data: Vec<Value> = all
        .iter()
        .skip((page_no - 1) * PER_PAGE)
        .take(PER_PAGE)
        .map(|p| program_json(i, p, now))
        .collect();
    let selected = now_idx
        .filter(|n| n / PER_PAGE + 1 == page_no)
        .map(|n| n % PER_PAGE + 1)
        .unwrap_or(0);
    json!({ "js": {
        "total_items": all.len(),
        "max_page_items": PER_PAGE,
        "selected_item": selected,
        "cur_page": page_no,
        "data": data
    }})
}

// ---------------------------------------------------------------------------
// VOD and series
// ---------------------------------------------------------------------------

fn vod_item(base: &str, i: usize, m: &Movie) -> Value {
    let id = VOD_FIRST + i as u32;
    let minutes = catalog::movie_duration_secs(i) / 60;
    json!({
        "id": id.to_string(),
        "owner": "",
        "name": m.name,
        "o_name": m.name,
        "old_name": "",
        "fname": "",
        "description": m.plot,
        "pic": "",
        "cost": 0,
        "time": minutes.to_string(),
        "file": "",
        "path": m.name.replace(' ', "_"),
        "protocol": "",
        "rtsp_url": "",
        "censored": 0,
        "series": [],
        "volume_correction": 0,
        "category_id": catalog::movie_category(m),
        "genre_id": "0",
        "director": m.director,
        "actors": m.actors,
        "year": m.year.to_string(),
        "added": catalog::sql_time(catalog::EPOCH - i as i64 * 3 * 86_400),
        "rating_imdb": format!("{:.1}", m.rating),
        "rating_kinopoisk": format!("{:.1}", m.rating),
        "rating_mpaa": "PG-13",
        "age": "12+",
        "high_quality": 1,
        "screenshot_uri": poster_url(base, m.slug),
        "genres_str": m.genre,
        "cmd": format!("/media/{id}.mpg"),
        "has_files": 1,
        "is_series": "0",
        "lock": 0,
        "fav": 0,
        "for_rent": 0
    })
}

/// Category of VOD listing slot `i`.
fn vod_category(i: usize) -> &'static str {
    if i == VOD_SERIES_SLOT {
        catalog::VOD_SERIES.category
    } else {
        catalog::movie_category(&catalog::MOVIES[i])
    }
}

/// The VOD-as-series row: a film-shaped row with `is_series: "1"` and no
/// embedded episode numbers, so clients fetch seasons via `movie_id`.
fn vod_series_item(base: &str, i: usize) -> Value {
    let s = &catalog::VOD_SERIES;
    let id = VOD_SERIES_ID;
    json!({
        "id": id.to_string(),
        "owner": "",
        "name": s.name,
        "o_name": s.name,
        "old_name": "",
        "fname": "",
        "description": s.plot,
        "pic": "",
        "cost": 0,
        "time": "0",
        "file": "",
        "path": s.name.replace(' ', "_"),
        "protocol": "",
        "rtsp_url": "",
        "censored": 0,
        "series": [],
        "volume_correction": 0,
        "category_id": s.category,
        "genre_id": "0",
        "director": s.director,
        "actors": s.cast,
        "year": s.year.to_string(),
        "added": catalog::sql_time(catalog::EPOCH - i as i64 * 3 * 86_400),
        "rating_imdb": format!("{:.1}", s.rating),
        "rating_kinopoisk": format!("{:.1}", s.rating),
        "rating_mpaa": "PG",
        "age": "7+",
        "high_quality": 1,
        "screenshot_uri": poster_url(base, s.slug),
        "genres_str": s.genre,
        "cmd": format!("/media/{id}.mpg"),
        "has_files": 0,
        "is_series": "1",
        "lock": 0,
        "fav": 0,
        "for_rent": 0
    })
}

/// File id (and `/media/file_<id>.mpg`) of a box-set episode: `5030<s><e>`.
fn vod_series_file_id(season: u32, episode: u32) -> u32 {
    VOD_SERIES_ID * 100 + season * 10 + episode
}

/// Inverse of [`vod_series_file_id`], validated against the catalog.
fn vod_series_file_parts(file_id: u64) -> Option<(u32, u32)> {
    if file_id / 100 != u64::from(VOD_SERIES_ID) {
        return None;
    }
    let (season, episode) = ((file_id % 100 / 10) as u32, (file_id % 10) as u32);
    vod_series_episode_title(season, episode).map(|_| (season, episode))
}

fn vod_series_episode_title(season: u32, episode: u32) -> Option<&'static str> {
    let titles = catalog::VOD_SERIES_EPISODES.get((season as usize).checked_sub(1)?)?;
    titles.get((episode as usize).checked_sub(1)?).copied()
}

fn vod_series_episode(base: &str, season: u32, episode: u32, title: &str) -> Value {
    let s = &catalog::VOD_SERIES;
    let id = VOD_SERIES_ID;
    let file_id = vod_series_file_id(season, episode);
    json!({
        "id": format!("{id}:{season}:{episode}"),
        "video_id": id.to_string(),
        "name": title,
        "o_name": title,
        "series_number": episode,
        "description": format!("{} Season {season}, episode {episode}.", s.plot),
        "screenshot_uri": backdrop_url(base, s.slug),
        "category_id": s.category,
        "cmd": format!("/media/file_{file_id}.mpg"),
        "time": (36 + season * 2 + episode).to_string(),
        "added": catalog::sql_time(catalog::EPOCH + i64::from(season * 10 + episode) * 86_400),
        "is_episode": true,
        "is_season": false,
        "is_series": "0",
        "has_files": 1
    })
}

/// `vod get_ordered_list` with `movie_id`: the children of the box set
/// (seasons, a season's episodes, or one episode's file). Films have no
/// children, so any other id answers an empty page.
fn vod_children(params: &HashMap<String, String>, base: &str) -> Value {
    let movie_id = p(params, "movie_id");
    let mut parts = movie_id.split(':').map(|v| v.trim().parse::<u32>().ok());
    if parts.next().flatten() != Some(VOD_SERIES_ID) {
        return page(Vec::new(), 1);
    }
    let id_season = parts.next().flatten();
    let id_episode = parts.next().flatten();
    let season = p(params, "season_id")
        .rsplit(':')
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|n| *n > 0)
        .or(id_season);
    let s = &catalog::VOD_SERIES;
    let seasons = catalog::VOD_SERIES_EPISODES.len() as u32;
    let rows: Vec<Value> = match (season, id_episode) {
        (None, _) => (1..=seasons)
            .map(|season| {
                let episodes = catalog::VOD_SERIES_EPISODES[season as usize - 1].len();
                json!({
                    "id": format!("{VOD_SERIES_ID}:{season}"),
                    "video_id": VOD_SERIES_ID.to_string(),
                    "name": format!("Season {season}"),
                    "o_name": format!("Season {season}"),
                    "season_number": season,
                    "description": format!("Season {season} of {} ({episodes} episodes).", s.name),
                    "screenshot_uri": poster_url(base, s.slug),
                    "category_id": s.category,
                    "year": (s.year + season - 1).to_string(),
                    "series": [],
                    "cmd": "",
                    "is_season": true,
                    "is_episode": false,
                    "is_series": "0",
                    "has_files": 0,
                    "added": catalog::sql_time(catalog::EPOCH)
                })
            })
            .collect(),
        (Some(season), None) => (season as usize)
            .checked_sub(1)
            .and_then(|i| catalog::VOD_SERIES_EPISODES.get(i))
            .map(|titles| {
                (1u32..)
                    .zip(titles.iter())
                    .map(|(e, title)| vod_series_episode(base, season, e, title))
                    .collect()
            })
            .unwrap_or_default(),
        (Some(season), Some(episode)) => match vod_series_episode_title(season, episode) {
            // One episode's file list, as portals answer for `has_files` rows.
            Some(_) => {
                let file_id = vod_series_file_id(season, episode);
                vec![json!({
                    "id": file_id.to_string(),
                    "name": format!("file_{file_id}.mp4"),
                    "cmd": format!("/media/file_{file_id}.mpg"),
                    "protocol": "",
                    "quality": "720p"
                })]
            }
            None => Vec::new(),
        },
    };
    page(rows, page_param(params))
}

fn series_item(base: &str, i: usize, s: &Series) -> Value {
    let id = SERIES_FIRST + i as u32;
    json!({
        "id": id.to_string(),
        "owner": "",
        "name": s.name,
        "o_name": s.name,
        "old_name": "",
        "description": s.plot,
        "time": "42",
        "path": s.name.replace(' ', "_"),
        "censored": 0,
        "series": [],
        "category_id": s.category,
        "director": s.director,
        "actors": s.cast,
        "year": s.year.to_string(),
        "added": catalog::sql_time(catalog::EPOCH - i as i64 * 5 * 86_400),
        "rating_imdb": format!("{:.1}", s.rating),
        "rating_kinopoisk": format!("{:.1}", s.rating),
        "age": "12+",
        "screenshot_uri": poster_url(base, s.slug),
        "genres_str": s.genre,
        "cmd": format!("/media/series/{id}.mpg"),
        "has_files": 0,
        "is_series": "1",
        "lock": 0,
        "fav": 0
    })
}

fn series_list(params: &HashMap<String, String>, base: &str) -> Value {
    let movie_id = p(params, "movie_id");
    if movie_id.is_empty() {
        let cat = first_non_empty(params, &["category", "genre"]);
        let items: Vec<Value> = catalog::SERIES
            .iter()
            .enumerate()
            .filter(|(_, s)| cat.is_none_or(|c| s.category == c))
            .map(|(i, s)| series_item(base, i, s))
            .collect();
        return page(
            filter_search(items, p(params, "search")),
            page_param(params),
        );
    }
    // `movie_id` may be "7001" or "7001:1".
    let sid: u32 = movie_id
        .split(':')
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let Some(idx) = sid
        .checked_sub(SERIES_FIRST)
        .filter(|i| (*i as usize) < catalog::SERIES.len())
    else {
        return page(Vec::new(), 1);
    };
    let s = &catalog::SERIES[idx as usize];
    let season_id = p(params, "season_id");
    let season_no: u32 = season_id
        .rsplit(':')
        .next()
        .and_then(|v| v.parse().ok())
        .or_else(|| movie_id.split(':').nth(1).and_then(|v| v.parse().ok()))
        .unwrap_or(0);
    let xtream_series = catalog::SERIES_FIRST_ID + idx;
    if season_no == 0 {
        let seasons: Vec<Value> = (1..=catalog::SEASONS)
            .map(|season| {
                json!({
                    "id": format!("{sid}:{season}"),
                    "name": format!("Season {season}"),
                    "o_name": format!("Season {season}"),
                    "description": format!("Season {season} of {}.", s.name),
                    "screenshot_uri": poster_url(base, s.slug),
                    "category_id": s.category,
                    "year": (s.year + season - 1).to_string(),
                    "series": (1..=catalog::EPISODES_PER_SEASON).collect::<Vec<_>>(),
                    "cmd": format!("/media/series/{sid}/{season}.mpg"),
                    "is_season": true,
                    "is_episode": false,
                    "is_series": "0",
                    "has_files": 0,
                    "added": catalog::sql_time(catalog::EPOCH)
                })
            })
            .collect();
        return page(seasons, page_param(params));
    }
    let episodes: Vec<Value> = (1..=catalog::EPISODES_PER_SEASON)
        .map(|ep| {
            json!({
                "id": format!("{sid}:{season_no}:{ep}"),
                "name": format!("Episode {ep}"),
                "o_name": catalog::episode_title(xtream_series, season_no.min(catalog::SEASONS), ep),
                "series_number": ep,
                "description": s.plot,
                "screenshot_uri": backdrop_url(base, s.slug),
                "cmd": format!("/media/series/{sid}/{season_no}/{ep}.mpg"),
                "is_episode": true,
                "is_season": false,
                "has_files": 1,
                "time": "42"
            })
        })
        .collect();
    page(episodes, page_param(params))
}

// ---------------------------------------------------------------------------
// create_link
// ---------------------------------------------------------------------------

fn digits(s: &str) -> Vec<u64> {
    s.split(|c: char| !c.is_ascii_digit())
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse().ok())
        .collect()
}

fn link(cmd: String, id: &str) -> Value {
    json!({ "js": {
        "id": id,
        "cmd": cmd,
        "streamer_id": 0,
        "link_id": 1,
        "load": 0,
        "error": ""
    }})
}

/// `create_link` for `itv`, `tv_archive`, `vod`, `series`, `radio`.
pub fn create_link(typ: &str, params: &HashMap<String, String>, base: &str, now: i64) -> Value {
    let cmd = p(params, "cmd");
    let nums = digits(cmd);
    match typ {
        "tv_archive" => {
            // cmd: "auto /media/<program id>.mpg"; id = (start/60)*1000 + ch offset.
            let pid = nums.last().copied().unwrap_or(0) as i64;
            let (start, ch) = if pid > 1000 {
                ((pid / 1000) * 60, (pid % 1000) as u32)
            } else {
                (now - 3_600, 0)
            };
            let ch = ch.min(ITV_COUNT - 1);
            let progs = catalog::channel_schedule(itv_source(ch).id, start, start + 1);
            let dur = progs
                .first()
                .map(|p| ((p.stop - p.start) / 60).max(1))
                .unwrap_or(60);
            let url = format!(
                "{base}/xtream/timeshift/demo/secret/{dur}/{}/{}.m3u8",
                catalog::timeshift_time(start),
                itv_source(ch).id
            );
            link(format!("ffmpeg {url}"), &pid.to_string())
        }
        "radio" => {
            let url = if cmd.contains("://") {
                cmd.trim_start_matches("ffmpeg ").to_string()
            } else {
                gen::radio_url(base)
            };
            link(format!("ffmpeg {url}"), "")
        }
        "vod" | "series" => {
            let series_no = p(params, "series").parse::<u32>().ok().filter(|n| *n > 0);
            if cmd.contains("/series/") {
                // /media/series/<sid>[/<season>[/<ep>]].mpg plus optional `series=<ep>`.
                let sid = nums.first().copied().unwrap_or(SERIES_FIRST as u64) as u32;
                let season = nums.get(1).copied().unwrap_or(1) as u32;
                let ep = nums
                    .get(2)
                    .copied()
                    .map(|n| n as u32)
                    .or(series_no)
                    .unwrap_or(1);
                let idx = sid
                    .saturating_sub(SERIES_FIRST)
                    .min(catalog::SERIES.len() as u32 - 1);
                let eid = catalog::episode_id(
                    catalog::SERIES_FIRST_ID + idx,
                    season.clamp(1, catalog::SEASONS),
                    ep.clamp(1, catalog::EPISODES_PER_SEASON),
                );
                link(
                    format!("ffmpeg {base}/xtream/series/demo/secret/{eid}.mp4"),
                    &eid.to_string(),
                )
            } else if let Some(file_id) = nums.first().and_then(|n| {
                // A box-set episode file, or the box-set row itself (its
                // first episode).
                vod_series_file_parts(*n)
                    .map(|(s, e)| vod_series_file_id(s, e))
                    .or_else(|| (*n == u64::from(VOD_SERIES_ID)).then(|| vod_series_file_id(1, 1)))
            }) {
                link(
                    format!("ffmpeg {base}/xtream/series/demo/secret/{file_id}.mp4"),
                    &file_id.to_string(),
                )
            } else {
                let id = nums.first().copied().unwrap_or(VOD_FIRST as u64) as u32;
                let i = id.saturating_sub(VOD_FIRST).min(VOD_COUNT as u32 - 1);
                let xid = catalog::VOD_FIRST_ID + i;
                link(
                    format!("ffmpeg {base}/xtream/movie/demo/secret/{xid}.mp4"),
                    &id.to_string(),
                )
            }
        }
        _ => {
            // itv: "ffmpeg http://localhost/ch/1001_" -> Xtream 101.
            let i = nums
                .iter()
                .find_map(|n| itv_index(&n.to_string()))
                .unwrap_or(0);
            let xid = itv_source(i).id;
            link(
                format!("ffmpeg {base}/xtream/live/demo/secret/{xid}.m3u8"),
                &(ITV_FIRST + i).to_string(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Control endpoints and STB page
// ---------------------------------------------------------------------------

async fn expire(State(state): State<Arc<MockState>>) -> Json<Value> {
    let generation = state.stalker_generation.fetch_add(1, Ordering::SeqCst) + 1;
    Json(json!({ "ok": true, "token": token_for(generation) }))
}

async fn reset(State(state): State<Arc<MockState>>) -> Json<Value> {
    state.stalker_generation.store(1, Ordering::SeqCst);
    Json(json!({ "ok": true, "token": TOKEN }))
}

async fn stb_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><html><head><title>Ministra mock</title></head><body>\
         <p>iptv-mock Stalker portal. API: <code>../portal.php</code>, <code>../server/load.php</code>.</p>\
         </body></html>",
    )
        .into_response()
}

/// Representative payloads written to `fixtures/stalker-*.json`.
pub fn sample_payloads(base: &str, now: i64) -> Vec<(&'static str, Value)> {
    let q = |pairs: &[(&str, &str)]| -> Value {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        respond(&m, MAC, base, now)
    };
    vec![
        ("stalker-handshake.json", handshake(TOKEN, now)),
        (
            "stalker-profile.json",
            q(&[("type", "stb"), ("action", "get_profile")]),
        ),
        (
            "stalker-itv-genres.json",
            q(&[("type", "itv"), ("action", "get_genres")]),
        ),
        (
            "stalker-itv-all-channels.json",
            q(&[("type", "itv"), ("action", "get_all_channels")]),
        ),
        (
            "stalker-radio-list.json",
            q(&[("type", "radio"), ("action", "get_ordered_list")]),
        ),
        (
            "stalker-vod-categories.json",
            q(&[("type", "vod"), ("action", "get_categories")]),
        ),
        (
            "stalker-vod-list-p1.json",
            q(&[
                ("type", "vod"),
                ("action", "get_ordered_list"),
                ("category", "*"),
                ("p", "1"),
            ]),
        ),
        (
            "stalker-series-categories.json",
            q(&[("type", "series"), ("action", "get_categories")]),
        ),
        (
            "stalker-series-list.json",
            q(&[
                ("type", "series"),
                ("action", "get_ordered_list"),
                ("category", "*"),
            ]),
        ),
        (
            "stalker-series-seasons.json",
            q(&[
                ("type", "series"),
                ("action", "get_ordered_list"),
                ("movie_id", "7001"),
            ]),
        ),
        (
            "stalker-series-episodes.json",
            q(&[
                ("type", "series"),
                ("action", "get_ordered_list"),
                ("movie_id", "7001"),
                ("season_id", "7001:1"),
            ]),
        ),
        (
            "stalker-vod-series-seasons.json",
            q(&[
                ("type", "vod"),
                ("action", "get_ordered_list"),
                ("movie_id", "5030"),
            ]),
        ),
        (
            "stalker-vod-series-episodes.json",
            q(&[
                ("type", "vod"),
                ("action", "get_ordered_list"),
                ("movie_id", "5030"),
                ("season_id", "5030:1"),
            ]),
        ),
        (
            "stalker-create-link-itv.json",
            q(&[
                ("type", "itv"),
                ("action", "create_link"),
                ("cmd", "ffmpeg http://localhost/ch/1001_"),
            ]),
        ),
        (
            "stalker-create-link-vod.json",
            q(&[
                ("type", "vod"),
                ("action", "create_link"),
                ("cmd", "/media/5001.mpg"),
            ]),
        ),
        (
            "stalker-short-epg.json",
            q(&[
                ("type", "itv"),
                ("action", "get_short_epg"),
                ("ch_id", "1001"),
                ("size", "4"),
            ]),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &[(&str, &str)]) -> Value {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        respond(&m, MAC, "http://127.0.0.1:9", catalog::EPOCH + 40_000)
    }

    #[test]
    fn all_channels_and_paging() {
        let all = q(&[("type", "itv"), ("action", "get_all_channels")]);
        assert_eq!(all["js"]["data"].as_array().unwrap().len(), 30);
        let p1 = q(&[
            ("type", "vod"),
            ("action", "get_ordered_list"),
            ("category", "*"),
            ("p", "1"),
        ]);
        assert_eq!(p1["js"]["total_items"], 30);
        assert_eq!(p1["js"]["max_page_items"], 14);
        assert_eq!(p1["js"]["data"].as_array().unwrap().len(), 14);
        let p3 = q(&[("type", "vod"), ("action", "get_ordered_list"), ("p", "3")]);
        assert_eq!(p3["js"]["data"].as_array().unwrap().len(), 2);
        let radio = q(&[("type", "radio"), ("action", "get_ordered_list")]);
        assert_eq!(radio["js"]["data"][0]["radio"], true);
    }

    #[test]
    fn create_link_maps_to_xtream_urls() {
        let l = q(&[
            ("type", "itv"),
            ("action", "create_link"),
            ("cmd", "ffmpeg http://localhost/ch/1001_"),
        ]);
        assert_eq!(
            l["js"]["cmd"],
            "ffmpeg http://127.0.0.1:9/xtream/live/demo/secret/101.m3u8"
        );
        let v = q(&[
            ("type", "vod"),
            ("action", "create_link"),
            ("cmd", "/media/5003.mpg"),
        ]);
        assert_eq!(
            v["js"]["cmd"],
            "ffmpeg http://127.0.0.1:9/xtream/movie/demo/secret/203.mp4"
        );
        let e = q(&[
            ("type", "vod"),
            ("action", "create_link"),
            ("cmd", "/media/series/7001/2.mpg"),
            ("series", "3"),
        ]);
        assert_eq!(
            e["js"]["cmd"],
            "ffmpeg http://127.0.0.1:9/xtream/series/demo/secret/3006.mp4"
        );
        let a = q(&[
            ("type", "tv_archive"),
            ("action", "create_link"),
            ("cmd", "auto /media/29453760000.mpg"),
        ]);
        assert!(a["js"]["cmd"]
            .as_str()
            .unwrap()
            .contains("/xtream/timeshift/demo/secret/"));
    }

    #[test]
    fn series_have_seasons_and_episodes() {
        let list = q(&[("type", "series"), ("action", "get_ordered_list")]);
        assert_eq!(list["js"]["total_items"], 10);
        assert_eq!(list["js"]["data"][0]["is_series"], "1");
        let seasons = q(&[
            ("type", "series"),
            ("action", "get_ordered_list"),
            ("movie_id", "7001"),
        ]);
        assert_eq!(seasons["js"]["data"].as_array().unwrap().len(), 2);
        assert_eq!(seasons["js"]["data"][0]["series"], json!([1, 2, 3]));
        let eps = q(&[
            ("type", "series"),
            ("action", "get_ordered_list"),
            ("movie_id", "7001"),
            ("season_id", "7001:2"),
        ]);
        assert_eq!(eps["js"]["data"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn vod_listing_has_one_series_row_in_the_last_slot() {
        let all: Vec<Value> = (1..=3)
            .flat_map(|n| {
                let page = q(&[
                    ("type", "vod"),
                    ("action", "get_ordered_list"),
                    ("category", "*"),
                    ("p", &n.to_string()),
                ]);
                assert_eq!(page["js"]["total_items"], 30);
                page["js"]["data"].as_array().unwrap().clone()
            })
            .collect();
        assert_eq!(all.len(), 30);
        let series: Vec<&Value> = all.iter().filter(|v| v["is_series"] == "1").collect();
        assert_eq!(series.len(), 1);
        let row = series[0];
        assert_eq!(row["id"], VOD_SERIES_ID.to_string());
        assert_eq!(row["id"], "5030");
        assert_eq!(row["name"], catalog::VOD_SERIES.name);
        assert_eq!(row["series"], json!([]));
        assert_eq!(row["category_id"], "11");
        assert!(row["screenshot_uri"]
            .as_str()
            .unwrap()
            .ends_with("/img/poster/the-lantern-keepers.svg"));
        // Films keep their ids and order; the box set is last.
        let ids: Vec<&str> = all.iter().map(|v| v["id"].as_str().unwrap()).collect();
        let want: Vec<String> = (5001..=5030).map(|i| i.to_string()).collect();
        assert_eq!(ids, want);
        assert_eq!(all[29]["is_series"], "1");

        // Category filter and search both reach it.
        let cat: Vec<Value> = (1..=2)
            .flat_map(|n| {
                q(&[
                    ("type", "vod"),
                    ("action", "get_ordered_list"),
                    ("category", "11"),
                    ("p", &n.to_string()),
                ])["js"]["data"]
                    .as_array()
                    .unwrap()
                    .clone()
            })
            .collect();
        assert!(cat.iter().any(|v| v["id"] == "5030"));
        let found = q(&[
            ("type", "vod"),
            ("action", "get_ordered_list"),
            ("search", "lantern"),
        ]);
        assert_eq!(found["js"]["total_items"], 1);
        assert_eq!(found["js"]["data"][0]["is_series"], "1");
    }

    #[test]
    fn vod_series_has_seasons_episodes_and_files() {
        let seasons = q(&[
            ("type", "vod"),
            ("action", "get_ordered_list"),
            ("movie_id", "5030"),
        ]);
        let rows = seasons["js"]["data"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "5030:1");
        assert_eq!(rows[0]["video_id"], "5030");
        assert_eq!(rows[1]["season_number"], 2);
        assert!(rows.iter().all(|r| r["is_season"] == true));

        let s1 = q(&[
            ("type", "vod"),
            ("action", "get_ordered_list"),
            ("movie_id", "5030"),
            ("season_id", "5030:1"),
        ]);
        let eps = s1["js"]["data"].as_array().unwrap();
        assert_eq!(eps.len(), 3);
        assert_eq!(eps[0]["id"], "5030:1:1");
        assert_eq!(eps[0]["name"], "The Lamp Room");
        assert_eq!(eps[2]["series_number"], 3);
        assert_eq!(eps[1]["cmd"], "/media/file_503012.mpg");
        assert!(eps.iter().all(|e| e["is_episode"] == true));

        // `movie_id=<id>:<season>` is an alias for `season_id`.
        let s2 = q(&[
            ("type", "vod"),
            ("action", "get_ordered_list"),
            ("movie_id", "5030:2"),
        ]);
        assert_eq!(s2["js"]["data"].as_array().unwrap().len(), 2);
        assert_eq!(s2["js"]["data"][1]["name"], "Last Light");

        let file = q(&[
            ("type", "vod"),
            ("action", "get_ordered_list"),
            ("movie_id", "5030:2:1"),
        ]);
        assert_eq!(file["js"]["data"][0]["id"], "503021");

        for missing in [
            &[("movie_id", "5030"), ("season_id", "5030:3")][..],
            &[("movie_id", "5030:1:9")][..],
            &[("movie_id", "5003")][..],
            &[("movie_id", "7001")][..],
        ] {
            let mut pairs = vec![("type", "vod"), ("action", "get_ordered_list")];
            pairs.extend_from_slice(missing);
            let r = q(&pairs);
            assert_eq!(r["js"]["total_items"], 0, "{missing:?}");
        }
    }

    #[test]
    fn vod_series_create_link() {
        let ep = q(&[
            ("type", "vod"),
            ("action", "create_link"),
            ("cmd", "/media/file_503012.mpg"),
        ]);
        assert_eq!(
            ep["js"]["cmd"],
            "ffmpeg http://127.0.0.1:9/xtream/series/demo/secret/503012.mp4"
        );
        let row = q(&[
            ("type", "vod"),
            ("action", "create_link"),
            ("cmd", "/media/5030.mpg"),
        ]);
        assert_eq!(
            row["js"]["cmd"],
            "ffmpeg http://127.0.0.1:9/xtream/series/demo/secret/503011.mp4"
        );
        // An out-of-range file id falls back to the film mapping.
        let bad = q(&[
            ("type", "vod"),
            ("action", "create_link"),
            ("cmd", "/media/file_503039.mpg"),
        ]);
        assert!(bad["js"]["cmd"]
            .as_str()
            .unwrap()
            .contains("/xtream/movie/demo/secret/"));
    }

    #[test]
    fn short_epg_is_an_array() {
        let e = q(&[
            ("type", "itv"),
            ("action", "get_short_epg"),
            ("ch_id", "1001"),
            ("size", "4"),
        ]);
        assert_eq!(e["js"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn mac_from_encoded_cookie() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            "stb_lang=en; mac=00%3A1A%3A79%3A00%3A00%3A01; timezone=UTC"
                .parse()
                .unwrap(),
        );
        assert_eq!(extract_mac(&h, &HashMap::new()), MAC);
    }
}
