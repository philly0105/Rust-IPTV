//! `/player_api.php`: the account, `get_vod_info` and `get_series_info`, in
//! the shapes Xtream panels send (numbers as strings, episodes keyed by
//! season), so the app's own parsers read them.

use super::{Ctx, Shared};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;

pub(super) async fn player_api(
    State(l): Ctx,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    l.note_request();
    let s = &l.shared;
    let body = match q.get("action").map(String::as_str) {
        None | Some("") => {
            s.count("account");
            account(s)
        }
        Some("get_vod_info") => {
            s.count("vodInfo");
            vod_info(s, q.get("vod_id").map(String::as_str))
        }
        Some("get_series_info") => {
            s.count("seriesInfo");
            series_info(s, q.get("series_id").map(String::as_str))
        }
        // Lists and anything else: empty, as a panel with nothing to offer.
        Some(_) => json!([]),
    };
    axum::Json(body).into_response()
}

fn account(s: &Shared) -> Value {
    let max = s.reported.load(Ordering::SeqCst);
    json!({
        "user_info": {
            "username": "panel",
            "auth": 1,
            "status": "Active",
            "max_connections": max.to_string(),
            "active_cons": "0",
        },
        "server_info": {"url": "127.0.0.1", "timezone": "UTC"},
    })
}

/// `movie_data.container_extension` is `mp4` for every file the panel
/// serves; a file it does not serve gets the empty answer panels give.
fn vod_info(s: &Shared, vod_id: Option<&str>) -> Value {
    let id = vod_id.and_then(|v| v.trim().parse::<u32>().ok());
    match id.filter(|id| s.files.lock().contains_key(id)) {
        Some(id) => json!({
            "info": {"name": format!("Movie {id}")},
            "movie_data": {
                "stream_id": id.to_string(),
                "name": format!("Movie {id}"),
                "container_extension": "mp4",
            },
        }),
        None => json!({"info": [], "movie_data": []}),
    }
}

/// Seasons and episodes from [`super::Panel::series`]; episode ids are file
/// ids. An unknown series gets the empty answer panels give.
fn series_info(s: &Shared, series_id: Option<&str>) -> Value {
    let id = series_id.and_then(|v| v.trim().parse::<u32>().ok());
    let Some((id, episodes)) = id.and_then(|id| Some((id, s.series.lock().get(&id)?.clone())))
    else {
        return json!({"seasons": [], "info": [], "episodes": []});
    };
    let mut by_season: std::collections::BTreeMap<i64, Vec<Value>> = Default::default();
    for (season, number, file) in episodes {
        by_season.entry(season).or_default().push(json!({
            "id": file.to_string(),
            "episode_num": number.to_string(),
            "title": format!("Episode {number}"),
            "container_extension": "mp4",
            "season": season.to_string(),
            "info": {"duration_secs": 2700},
        }));
    }
    let seasons: Vec<Value> = by_season
        .keys()
        .map(|n| json!({"season_number": n, "name": format!("Season {n}")}))
        .collect();
    let episodes: serde_json::Map<String, Value> = by_season
        .into_iter()
        .map(|(n, eps)| (n.to_string(), Value::Array(eps)))
        .collect();
    json!({
        "seasons": seasons,
        "info": {"name": format!("Series {id}")},
        "episodes": episodes,
    })
}
