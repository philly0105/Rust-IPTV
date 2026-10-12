//! Portal JSON -> catalog rows and model types.

use super::protocol::{
    self as p, absolutize, date_to_rfc3339, f, flag_enabled, n, s, split_list, year_of,
};
use crate::catalog::{title_base, CategoryRow, ItemRow};
use crate::model::{ContentType, EpgProgram, ItemRef, Person, SeriesItem, VodItem};
use serde_json::{json, Value};

/// Category rows from a `get_genres` / `get_categories` answer. The `*`
/// ("All") pseudo-category is skipped; titles are trimmed; duplicates dropped.
pub fn categories(list: &[Value]) -> Vec<CategoryRow> {
    let mut out: Vec<CategoryRow> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for v in list {
        let Some(id) = s(v, "id") else { continue };
        if id == "*" || !seen.insert(id.clone()) {
            continue;
        }
        let name = s(v, "title")
            .or_else(|| s(v, "name"))
            .unwrap_or_else(|| id.clone());
        out.push(CategoryRow {
            category_id: id,
            name,
            position: out.len() as i64,
        });
    }
    out
}

/// Catch-up window of a channel in hours, when the portal enables archive.
fn archive_hours(v: &Value) -> Option<i64> {
    if !(flag_enabled(v.get("tv_archive")) || flag_enabled(v.get("enable_tv_archive"))) {
        return None;
    }
    // `tv_archive_duration` is in hours on Ministra; default to a day.
    // Clamped: a garbage duration must not overflow the catch-up time math.
    Some(p::clamp_archive_hours(
        n(v, "tv_archive_duration").filter(|h| *h > 0).unwrap_or(24),
    ))
}

/// A live channel (or radio station) row.
pub fn channel_row(
    source_id: &str,
    endpoint: &str,
    v: &Value,
    content_type: ContentType,
    category_id: String,
    position: i64,
) -> Option<ItemRow> {
    let id = s(v, "id")?;
    let title = s(v, "name").unwrap_or_else(|| format!("Channel {id}"));
    let mut extra = serde_json::Map::new();
    if let Some(cmd) = s(v, "cmd") {
        extra.insert("cmd".into(), json!(cmd));
    }
    for (key, json_key) in [
        ("use_http_tmp_link", "useHttpTmpLink"),
        ("use_load_balancing", "useLoadBalancing"),
    ] {
        if let Some(flag) = v.get(key).filter(|f| !f.is_null()) {
            extra.insert(json_key.into(), json!(flag_enabled(Some(flag))));
        }
    }
    if flag_enabled(v.get("censored")) {
        extra.insert("censored".into(), json!(true));
    }
    let is_radio = content_type == ContentType::Radio;
    Some(ItemRow {
        source_id: source_id.to_string(),
        content_type,
        item_id: id,
        category_id,
        title_base: None,
        number: n(v, "number").filter(|x| *x > 0),
        logo_url: absolutize(endpoint, v.get("logo").and_then(Value::as_str)),
        epg_channel_id: s(v, "xmltv_id"),
        is_radio,
        archive_hours: if is_radio { None } else { archive_hours(v) },
        extra: Value::Object(extra),
        position,
        title,
        ..Default::default()
    })
}

/// Rebuilds the portal-ish raw value of a stored channel (for playback).
pub fn channel_raw(extra: &Value) -> Value {
    let mut raw = json!({});
    if let Some(cmd) = extra.get("cmd") {
        raw["cmd"] = cmd.clone();
    }
    if let Some(v) = extra.get("useHttpTmpLink") {
        raw["use_http_tmp_link"] = v.clone();
    }
    if let Some(v) = extra.get("useLoadBalancing") {
        raw["use_load_balancing"] = v.clone();
    }
    raw
}

/// True when a VOD row is really a series (`is_series` 1/"1"/true).
pub fn is_vod_series(v: &Value) -> bool {
    flag_enabled(v.get("is_series"))
}

fn poster(endpoint: &str, v: &Value) -> Option<String> {
    ["screenshot_uri", "cover_big", "cover", "pic", "logo"]
        .iter()
        .find_map(|k| absolutize(endpoint, v.get(*k).and_then(Value::as_str)))
}

fn rating(v: &Value) -> Option<f64> {
    f(v, "rating_imdb")
        .or_else(|| f(v, "rating_kinopoisk"))
        .or_else(|| f(v, "rating"))
        .filter(|r| *r <= 10.0)
}

fn year(v: &Value) -> Option<i64> {
    v.get("year")
        .and_then(year_of)
        .or_else(|| v.get("releasedate").and_then(year_of))
}

fn title(v: &Value) -> String {
    s(v, "name")
        .or_else(|| s(v, "o_name"))
        .or_else(|| s(v, "title"))
        .unwrap_or_else(|| "Untitled".into())
}

fn genres(v: &Value) -> Option<Vec<String>> {
    let g = s(v, "genres_str")
        .or_else(|| s(v, "genre"))
        .map(|g| split_list(&g))
        .unwrap_or_default();
    (!g.is_empty()).then_some(g)
}

/// The id of a VOD row (`id`, then `video_id`, `movie_id`).
pub fn vod_id(v: &Value) -> Option<String> {
    s(v, "id")
        .or_else(|| s(v, "video_id"))
        .or_else(|| s(v, "movie_id"))
}

/// A VOD row as a [`VodItem`]. `ref.contentType` is `series` for
/// VOD-as-series rows so the UI opens the series view.
pub fn vod_item(
    source_id: &str,
    endpoint: &str,
    v: &Value,
    fallback_category: &str,
    category_name: Option<String>,
) -> Option<VodItem> {
    let id = vod_id(v)?;
    let t = title(v);
    let content_type = if is_vod_series(v) {
        ContentType::Series
    } else {
        ContentType::Movie
    };
    Some(VodItem {
        item_ref: ItemRef::new(source_id, content_type, id),
        title_base: Some(title_base(&t).0).filter(|b| !b.is_empty()),
        year: year(v),
        poster_url: poster(endpoint, v),
        backdrop_url: None,
        rating: rating(v),
        added: v.get("added").and_then(date_to_rfc3339),
        category_id: s(v, "category_id").unwrap_or_else(|| fallback_category.to_string()),
        category_name,
        container_extension: None,
        duration_seconds: n(v, "time").and_then(p::minutes_to_seconds),
        plot: s(v, "description"),
        genres: genres(v),
        tmdb_id: n(v, "tmdb_id").or_else(|| n(v, "tmdb")).filter(|x| *x > 0),
        title: t,
    })
}

/// A series (or VOD-as-series) row as a [`SeriesItem`].
pub fn series_item(
    source_id: &str,
    endpoint: &str,
    v: &Value,
    fallback_category: &str,
    category_name: Option<String>,
) -> Option<SeriesItem> {
    let item = vod_item(source_id, endpoint, v, fallback_category, category_name)?;
    Some(SeriesItem {
        item_ref: ItemRef {
            content_type: ContentType::Series,
            ..item.item_ref
        },
        title: item.title,
        title_base: item.title_base,
        year: item.year,
        poster_url: item.poster_url,
        backdrop_url: item.backdrop_url,
        rating: item.rating,
        added: item.added,
        category_id: item.category_id,
        category_name: item.category_name,
        plot: item.plot,
        genres: item.genres,
        tmdb_id: item.tmdb_id,
    })
}

/// Cast from the `actors` field.
pub fn cast(v: &Value) -> Vec<Person> {
    s(v, "actors")
        .map(|a| split_list(&a))
        .unwrap_or_default()
        .into_iter()
        .take(40)
        .map(|name| Person {
            id: None,
            name,
            role: None,
            profile_url: None,
        })
        .collect()
}

/// One EPG entry (short EPG / epg_info / simple data table).
pub fn epg_program(channel_id: &str, v: &Value) -> Option<EpgProgram> {
    let start = v
        .get("start_timestamp")
        .and_then(date_to_rfc3339)
        .or_else(|| v.get("time").and_then(date_to_rfc3339))
        .or_else(|| v.get("start").and_then(date_to_rfc3339))?;
    let end = v
        .get("stop_timestamp")
        .and_then(date_to_rfc3339)
        .or_else(|| v.get("time_to").and_then(date_to_rfc3339))
        .or_else(|| v.get("stop").and_then(date_to_rfc3339))
        .or_else(|| v.get("end").and_then(date_to_rfc3339))
        .or_else(|| {
            let start_ts = chrono::DateTime::parse_from_rfc3339(&start)
                .ok()?
                .timestamp();
            let secs = n(v, "duration").filter(|d| *d > 0)?;
            date_to_rfc3339(&json!(start_ts.checked_add(secs)?))
        })
        // A stop before the start (swapped or garbage fields) would give the
        // UI a negative-length programme; collapse it to the start instead.
        // Both strings come from `date_to_rfc3339` (4-digit years, `Z`), so
        // they order lexically.
        .filter(|end| *end >= start)
        .unwrap_or_else(|| start.clone());
    Some(EpgProgram {
        channel_id: channel_id.to_string(),
        start,
        end,
        title: s(v, "name")
            .or_else(|| s(v, "title"))
            .unwrap_or_else(|| "Untitled".into()),
        description: s(v, "descr")
            .or_else(|| s(v, "description"))
            .map(|d| p::strip_markup(&d))
            .filter(|d| !d.is_empty()),
        category: s(v, "category"),
        icon: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EP: &str = "http://h/stalker_portal/server/load.php";

    #[test]
    fn maps_categories_skipping_all() {
        let rows = categories(&[
            json!({"id": "*", "title": "All"}),
            json!({"id": 3, "title": " News "}),
            json!({"id": "3", "title": "dup"}),
            json!({"id": "4"}),
        ]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "News");
        assert_eq!(rows[1].name, "4");
        assert_eq!(rows[1].position, 1);
    }

    #[test]
    fn maps_channels() {
        let v = json!({"id": "7", "name": "One", "number": "3", "logo": "/stalker_portal/misc/logos/7.png", "cmd": "ffmpeg http://x/7", "tv_archive": 1, "tv_archive_duration": "48", "xmltv_id": "one.uk", "use_http_tmp_link": "0"});
        let row = channel_row("s", EP, &v, ContentType::Live, "2".into(), 0).unwrap();
        assert_eq!(row.number, Some(3));
        assert_eq!(
            row.logo_url.as_deref(),
            Some("http://h/stalker_portal/misc/logos/7.png")
        );
        assert_eq!(row.archive_hours, Some(48));
        assert_eq!(row.epg_channel_id.as_deref(), Some("one.uk"));
        assert_eq!(row.extra["cmd"], "ffmpeg http://x/7");
        assert_eq!(row.extra["useHttpTmpLink"], false);
        assert_eq!(channel_raw(&row.extra)["use_http_tmp_link"], false);
        let radio = channel_row(
            "s",
            EP,
            &json!({"id": 1, "name": "R", "tv_archive": 1}),
            ContentType::Radio,
            "radio".into(),
            1,
        )
        .unwrap();
        assert!(radio.is_radio);
        assert_eq!(radio.archive_hours, None);
        assert!(channel_row(
            "s",
            EP,
            &json!({"name": "no id"}),
            ContentType::Live,
            "x".into(),
            0
        )
        .is_none());
    }

    #[test]
    fn maps_vod() {
        let v = json!({"id": "9", "name": "Heat (1995)", "screenshot_uri": "/stalker_portal/screenshots/9.jpg", "rating_imdb": "8.3", "year": "1995-12-15", "time": "170", "added": "2021-03-04 12:13:14", "genres_str": "Action, Crime", "actors": "Al Pacino, Robert De Niro", "category_id": "5", "description": "Plot."});
        let item = vod_item("s", EP, &v, "*", Some("Movies".into())).unwrap();
        assert_eq!(item.item_ref.content_type, ContentType::Movie);
        assert_eq!(
            item.poster_url.as_deref(),
            Some("http://h/stalker_portal/screenshots/9.jpg")
        );
        assert_eq!(item.rating, Some(8.3));
        assert_eq!(item.year, Some(1995));
        assert_eq!(item.duration_seconds, Some(10200));
        assert_eq!(item.added.as_deref(), Some("2021-03-04T12:13:14Z"));
        assert_eq!(item.genres.as_ref().unwrap().len(), 2);
        assert_eq!(item.category_id, "5");
        assert_eq!(cast(&v).len(), 2);
        let series = json!({"id": 2, "name": "Show", "is_series": "1"});
        assert_eq!(
            vod_item("s", EP, &series, "*", None)
                .unwrap()
                .item_ref
                .content_type,
            ContentType::Series
        );
        assert_eq!(
            series_item("s", EP, &series, "*", None)
                .unwrap()
                .category_id,
            "*"
        );
    }

    #[test]
    fn maps_epg() {
        let e = json!({"id": "1", "name": "News", "descr": "<b>Daily</b> news", "start_timestamp": 1_600_000_000, "stop_timestamp": "1600003600", "category": "News"});
        let prog = epg_program("one.uk", &e).unwrap();
        assert_eq!(prog.start, "2020-09-13T12:26:40Z");
        assert_eq!(prog.end, "2020-09-13T13:26:40Z");
        assert_eq!(prog.description.as_deref(), Some("Daily news"));
        let by_time = epg_program(
            "x",
            &json!({"name": "A", "time": "2021-01-01 10:00:00", "duration": 1800}),
        )
        .unwrap();
        assert_eq!(by_time.end, "2021-01-01T10:30:00Z");
        assert!(epg_program("x", &json!({"name": "no time"})).is_none());
    }

    /// B8-parsers: provider numbers that overflowed (debug panic) or were
    /// stored unbounded.
    #[test]
    fn overflowing_portal_numbers() {
        let ch = json!({"id": 1, "tv_archive": 1, "tv_archive_duration": i64::MAX});
        let row = channel_row("s", EP, &ch, ContentType::Live, "c".into(), 0).unwrap();
        assert_eq!(row.archive_hours, Some(366 * 24));
        let v = json!({"id": "9", "name": "X", "time": i64::MAX});
        assert_eq!(
            vod_item("s", EP, &v, "*", None).unwrap().duration_seconds,
            None
        );
        let v = json!({"id": "9", "name": "X", "time": "-5"});
        assert_eq!(
            vod_item("s", EP, &v, "*", None).unwrap().duration_seconds,
            None
        );
        let e = json!({"name": "A", "start_timestamp": 1_600_000_000, "duration": i64::MAX});
        let prog = epg_program("x", &e).unwrap();
        assert_eq!(prog.end, prog.start);
    }

    /// B8-parsers: a stop before the start used to come out unchanged,
    /// giving the UI a negative-length programme.
    #[test]
    fn epg_stop_before_start_collapses() {
        let e = json!({"name": "A", "start_timestamp": 1_700_000_000, "stop_timestamp": 1000});
        let prog = epg_program("x", &e).unwrap();
        assert_eq!(prog.start, "2023-11-14T22:13:20Z");
        assert_eq!(prog.end, prog.start);
        let ok =
            json!({"name": "A", "start_timestamp": 1_700_000_000, "stop_timestamp": 1_700_003_600});
        assert_eq!(epg_program("x", &ok).unwrap().end, "2023-11-14T23:13:20Z");
    }

    /// Review R1-8: the duplicate check scanned every kept category, so a
    /// hostile genre list was quadratic.
    #[test]
    fn category_dedupe_is_linear() {
        let mut list: Vec<Value> = (0..60_000)
            .map(|i| json!({"id": format!("g{i}"), "title": format!("G {i}")}))
            .collect();
        list.push(json!({"id": "g7", "title": "dup"}));
        list.push(json!({"id": "*", "title": "All"}));
        let started = std::time::Instant::now();
        let cats = categories(&list);
        let took = started.elapsed();
        assert_eq!(cats.len(), 60_000);
        assert_eq!(cats[7].name, "G 7", "first wins");
        assert_eq!(cats[59_999].position, 59_999);
        assert!(took < std::time::Duration::from_secs(1), "took {took:?}");
    }
}
