//! Live-paged movies and series, details, season plans and search.
//!
//! Portal pages hold `max_page_items` rows (14 by default); `offset/limit`
//! from the UI is mapped onto the covering portal pages, fetched at most four
//! at a time.

use super::mapping;
use super::protocol::{self as p, absolutize, into_list, n, s};
use super::session::{Req, StalkerClient};
use super::{CachedItem, Runtime};
use crate::error::{CoreError, CoreResult};
use crate::model::{
    ContentType, Episode, ItemRef, Page, PageQuery, Season, SeriesDetail, SortKey, VodDetail,
};
use crate::state::AppState;
use futures::stream::{self, StreamExt, TryStreamExt};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::sync::Arc;

/// Largest `limit` honoured per call (≈15 portal pages).
pub const MAX_LIMIT: i64 = 200;
/// Concurrent portal page fetches.
const PAGE_CONCURRENCY: usize = 4;
/// Safety cap when walking episode pages.
const MAX_EPISODE_PAGES: i64 = 30;

/// Portal list kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Vod,
    Series,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Vod => "vod",
            Kind::Series => "series",
        }
    }
}

/// One raw row plus the category it was listed under.
#[derive(Debug, Clone)]
pub struct Listed {
    pub raw: Value,
    pub category_id: String,
}

fn page_size_key(source_id: &str, kind: Kind) -> String {
    format!("{source_id}|{}", kind.as_str())
}

fn list_req(kind: Kind, category: &str, sort: &str, search: Option<&str>, page: i64) -> Req {
    let mut req = Req::new(kind.as_str(), "get_ordered_list").p("category", category);
    if kind == Kind::Vod {
        req = req.p("genre", "0");
    }
    req.p("sortby", sort)
        .opt("search", search.filter(|s| !s.trim().is_empty()))
        .p("p", page)
}

/// Fetches the rows covering `offset..offset+limit` of a portal listing.
pub async fn list_page(
    state: &Arc<AppState>,
    client: &StalkerClient,
    source_id: &str,
    kind: Kind,
    category: Option<&str>,
    query: &PageQuery,
) -> CoreResult<Page<Listed>> {
    let offset = query.offset.max(0);
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let category = category
        .filter(|c| !c.trim().is_empty())
        .unwrap_or("*")
        .to_string();
    let sort = match query.sort {
        Some(SortKey::Name) => "name",
        _ => "added",
    };
    let search = query.search.as_deref();
    let runtime = Runtime::get(state);
    let key = page_size_key(source_id, kind);
    let mut ps = runtime
        .page_sizes
        .get(&key)
        .map(|v| *v)
        .unwrap_or(p::DEFAULT_PAGE_SIZE)
        .max(1);

    let first = offset / ps + 1;
    let first_js = client
        .call(list_req(kind, &category, sort, search, first))
        .await?;
    let total = n(&first_js, "total_items");
    let reported = n(&first_js, "max_page_items").filter(|x| *x > 0);
    let mut first_rows = into_list(first_js);

    let mut pages: Vec<(i64, Vec<Value>)> = Vec::new();
    if let Some(real) = reported.filter(|r| *r != ps) {
        // The cached page size was wrong: remember the real one and restart.
        ps = real;
        runtime.page_sizes.insert(key, ps);
        let first_real = offset / ps + 1;
        if first_real != first {
            first_rows = into_list(
                client
                    .call(list_req(kind, &category, sort, search, first_real))
                    .await?,
            );
        }
        pages.push((first_real, first_rows));
    } else {
        if reported.is_none() && first_rows.len() as i64 > ps {
            // No page size reported and the page is bigger than assumed.
            ps = first_rows.len() as i64;
            runtime.page_sizes.insert(key, ps);
        }
        pages.push((offset / ps + 1, first_rows));
    }
    let first_page = pages[0].0;
    let total = total.unwrap_or_else(|| (first_page - 1) * ps + pages[0].1.len() as i64);
    let last_needed = last_needed_page(offset, limit, ps, total);

    if last_needed > first_page {
        let rest: Vec<(i64, Vec<Value>)> = stream::iter((first_page + 1)..=last_needed)
            .map(|page| {
                let req = list_req(kind, &category, sort, search, page);
                async move { Ok::<_, CoreError>((page, into_list(client.call(req).await?))) }
            })
            .buffered(PAGE_CONCURRENCY)
            .try_collect()
            .await?;
        pages.extend(rest);
    }

    let skip = (offset - (first_page - 1) * ps).max(0) as usize;
    let items: Vec<Listed> = pages
        .into_iter()
        .flat_map(|(_, rows)| rows)
        .skip(skip)
        .take(limit as usize)
        .map(|raw| {
            let category_id = s(&raw, "category_id").unwrap_or_else(|| category.clone());
            Listed { raw, category_id }
        })
        .collect();
    Ok(Page {
        items,
        total,
        offset,
        limit,
    })
}

/// Last 1-based portal page `list_page` must read for `[offset, offset +
/// limit)` with `ps` items per page and `total` items. Saturating (D9):
/// `total_items` comes from the portal and the offset from the UI.
fn last_needed_page(offset: i64, limit: i64, ps: i64, total: i64) -> i64 {
    let ps = ps.max(1);
    let wanted = (offset.saturating_add(limit.saturating_sub(1)) / ps + 1).max(1);
    let available = total.saturating_sub(1).max(0) / ps + 1;
    wanted.min(available)
}

/// Category names of a source/content type, from the catalog.
pub async fn category_names(
    state: &AppState,
    source_id: &str,
    ct: ContentType,
) -> std::collections::HashMap<String, String> {
    let sid = source_id.to_string();
    state
        .db_call(move |conn| {
            let mut stmt = conn.prepare_cached("SELECT category_id, name FROM categories WHERE source_id = ?1 AND content_type = ?2")?;
            let rows = stmt.query_map(rusqlite::params![sid, ct.as_str()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            Ok(rows.filter_map(Result::ok).collect())
        })
        .await
        .unwrap_or_default()
}

/// Remembers listed rows for details/playback, in memory and in
/// `stalker_items` (so they survive resyncs and restarts).
pub async fn remember_rows(
    state: &AppState,
    source_id: &str,
    kind: Kind,
    rows: &[Listed],
    names: &std::collections::HashMap<String, String>,
) {
    let runtime = Runtime::get(state);
    let mut persisted: Vec<(ItemRef, CachedItem)> = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(id) = mapping::vod_id(&row.raw) else {
            continue;
        };
        let ct = if kind == Kind::Series || mapping::is_vod_series(&row.raw) {
            ContentType::Series
        } else {
            ContentType::Movie
        };
        let mut raw = row.raw.clone();
        if kind == Kind::Series {
            // Mark the origin so detail lookups use the series API.
            raw["__kind"] = Value::from("series");
        }
        let r = ItemRef::new(source_id, ct, id);
        // `*` is the all-categories listing of a row that names none.
        let category_id = (!row.category_id.is_empty() && row.category_id != "*")
            .then(|| row.category_id.clone());
        let item = CachedItem {
            raw,
            category_name: names.get(&row.category_id).cloned(),
            category_id,
        };
        runtime.remember(&r, item.clone());
        persisted.push((r, item));
    }
    super::persist_items(state, persisted).await;
}

/// Finds a VOD/series row: memory, then `stalker_items`, then a portal
/// search by the title remembered in favorites/recent/positions.
pub async fn lookup(
    state: &Arc<AppState>,
    client: &StalkerClient,
    r: &ItemRef,
) -> CoreResult<CachedItem> {
    if let Some(hit) = super::cached_item(state, r).await {
        return Ok(hit);
    }
    let runtime = Runtime::get(state);
    let title = snapshot_title(state, r).await;
    if let Some(title) = title {
        let query = PageQuery {
            offset: 0,
            limit: 56,
            search: Some(title),
            ..Default::default()
        };
        let kinds: &[Kind] = if r.content_type == ContentType::Series {
            &[Kind::Series, Kind::Vod]
        } else {
            &[Kind::Vod]
        };
        for kind in kinds {
            match list_page(state, client, &r.source_id, *kind, None, &query).await {
                Ok(page) => {
                    remember_rows(state, &r.source_id, *kind, &page.items, &Default::default())
                        .await;
                    if let Some(hit) = runtime.items.get(&r.key()) {
                        return Ok(hit);
                    }
                }
                Err(err @ CoreError::Auth(_)) => return Err(err),
                Err(_) => continue,
            }
        }
    }
    Err(CoreError::not_found(
        "This title is no longer listed by the portal. Open it again from the movies or series list.",
    ))
}

async fn snapshot_title(state: &AppState, r: &ItemRef) -> Option<String> {
    let (sid, ct, id) = (
        r.source_id.clone(),
        r.content_type.as_str().to_string(),
        r.item_id.clone(),
    );
    let json: Option<String> = state
        .db_call(move |conn| {
            for sql in [
                "SELECT snapshot_json FROM favorites WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                "SELECT snapshot_json FROM recent WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                "SELECT snapshot_json FROM playback_positions WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND snapshot_json IS NOT NULL LIMIT 1",
            ] {
                let hit: Option<Option<String>> = conn.query_row(sql, rusqlite::params![sid, ct, id], |row| row.get(0)).optional()?;
                if let Some(Some(j)) = hit {
                    return Ok(Some(j));
                }
            }
            Ok(None)
        })
        .await
        .ok()
        .flatten();
    let v: Value = serde_json::from_str(&json?).ok()?;
    s(&v, "title")
}

/// `stalker.vodDetail`.
pub async fn vod_detail(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<VodDetail> {
    let client = StalkerClient::for_source(state, &r.source_id).await?;
    let endpoint = client.endpoint().await?;
    let cached = lookup(state, &client, r).await?;
    let mut item = mapping::vod_item(
        &r.source_id,
        &endpoint,
        &cached.raw,
        "*",
        cached.category_name.clone(),
    )
    .ok_or_else(|| CoreError::not_found("the portal row has no id"))?;
    item.item_ref = r.clone();
    Ok(VodDetail {
        cast: mapping::cast(&cached.raw),
        director: s(&cached.raw, "director"),
        trailer_url: None,
        backdrops: Vec::new(),
        provider_details_unavailable: false,
        provider_error: None,
        item,
    })
}

// ---------------------------------------------------------------------------
// Season plans
// ---------------------------------------------------------------------------

/// How an episode is played.
#[derive(Debug, Clone, PartialEq)]
pub struct EpisodePlan {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub plot: Option<String>,
    pub duration_seconds: Option<i64>,
    pub poster_url: Option<String>,
    pub added: Option<String>,
    /// `cmd` for `create_link`.
    pub cmd: String,
    /// `series=<n>` for regular series episodes; `None` for VOD episodes.
    pub series: Option<i64>,
    /// Raw episode row (VOD-as-series), for `has_files` resolution.
    pub raw: Value,
}

/// One season with its playable episodes.
#[derive(Debug, Clone, PartialEq)]
pub struct SeasonPlan {
    pub id: String,
    pub number: i64,
    pub name: Option<String>,
    pub poster_url: Option<String>,
    pub episodes: Vec<EpisodePlan>,
}

fn season_number_from_name(name: &str) -> Option<i64> {
    let lower = name.to_lowercase();
    let idx = lower
        .find("season")
        .map(|i| i + 6)
        .or_else(|| lower.find("сезон").map(|i| i + "сезон".len()));
    // Slice `lower`, not `name`: lowercasing can change byte lengths
    // ('İ' is 2 bytes, "i̇" is 3), so `lower`'s indexes are not `name`'s.
    let tail = match idx {
        Some(i) => &lower[i..],
        None => lower.as_str(),
    };
    let digits: String = tail
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok().filter(|n| *n > 0 && *n < 1000)
}

fn series_numbers(v: &Value) -> Vec<i64> {
    match v.get("series") {
        Some(Value::Array(a)) => a.iter().filter_map(p::int_of).collect(),
        _ => Vec::new(),
    }
}

fn regular_season(
    endpoint: &str,
    v: &Value,
    index: usize,
    fallback_id: &str,
) -> Option<SeasonPlan> {
    let id = s(v, "id").unwrap_or_else(|| fallback_id.to_string());
    let cmd = s(v, "cmd")?;
    let name = s(v, "name");
    let number = n(v, "season_number")
        .filter(|x| *x > 0)
        .or_else(|| name.as_deref().and_then(season_number_from_name))
        .unwrap_or(index as i64 + 1);
    let poster = ["screenshot_uri", "cover", "logo"]
        .iter()
        .find_map(|k| absolutize(endpoint, v.get(*k).and_then(Value::as_str)));
    let episodes = series_numbers(v)
        .into_iter()
        .map(|e| EpisodePlan {
            id: format!("s|{id}|{e}"),
            number: e,
            title: format!("Episode {e}"),
            plot: None,
            duration_seconds: None,
            poster_url: None,
            added: None,
            cmd: cmd.clone(),
            series: Some(e),
            raw: Value::Null,
        })
        .collect();
    Some(SeasonPlan {
        id,
        number,
        name,
        poster_url: poster,
        episodes,
    })
}

async fn vod_pages(client: &StalkerClient, base: Req) -> CoreResult<Vec<Value>> {
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let js = client.call(base.clone().p("p", page)).await?;
        let total = n(&js, "total_items");
        let rows = into_list(js);
        if rows.is_empty() {
            break;
        }
        out.extend(rows);
        if total.is_none_or(|t| out.len() as i64 >= t) || page >= MAX_EPISODE_PAGES {
            break;
        }
        page += 1;
    }
    Ok(out)
}

async fn vod_series_plan(
    client: &StalkerClient,
    endpoint: &str,
    id: &str,
    raw: Option<&Value>,
) -> CoreResult<Vec<SeasonPlan>> {
    let seasons = vod_pages(
        client,
        Req::new("vod", "get_ordered_list").p("movie_id", id),
    )
    .await?;
    let seasons: Vec<Value> = {
        let flagged: Vec<Value> = seasons
            .iter()
            .filter(|v| p::flag_enabled(v.get("is_season")))
            .cloned()
            .collect();
        if flagged.is_empty() {
            seasons
        } else {
            flagged
        }
    };
    let fallback_poster = raw.and_then(|r| {
        ["screenshot_uri", "cover"]
            .iter()
            .find_map(|k| absolutize(endpoint, r.get(*k).and_then(Value::as_str)))
    });
    let plans: Vec<SeasonPlan> = stream::iter(seasons.into_iter().enumerate())
        .map(|(index, season)| {
            let fallback_poster = fallback_poster.clone();
            async move {
                let season_id = s(&season, "id").unwrap_or_default();
                let video_id = s(&season, "video_id").unwrap_or_else(|| id.to_string());
                let rows = vod_pages(
                    client,
                    Req::new("vod", "get_ordered_list")
                        .p("movie_id", &video_id)
                        .p("season_id", &season_id),
                )
                .await?;
                let rows: Vec<Value> = {
                    let flagged: Vec<Value> = rows
                        .iter()
                        .filter(|v| p::flag_enabled(v.get("is_episode")))
                        .cloned()
                        .collect();
                    if flagged.is_empty() {
                        rows
                    } else {
                        flagged
                    }
                };
                let mut episodes: Vec<EpisodePlan> = rows
                    .into_iter()
                    .enumerate()
                    .filter_map(|(i, e)| {
                        let eid = s(&e, "id")?;
                        let cmd = s(&e, "cmd")?;
                        let number = n(&e, "series_number")
                            .filter(|x| *x > 0)
                            .unwrap_or(i as i64 + 1);
                        Some(EpisodePlan {
                            id: format!("v|{season_id}|{eid}"),
                            number,
                            title: s(&e, "name").unwrap_or_else(|| format!("Episode {number}")),
                            plot: s(&e, "description"),
                            duration_seconds: n(&e, "time")
                                .and_then(p::minutes_to_seconds)
                                .or_else(|| n(&e, "duration").filter(|d| *d > 0)),
                            poster_url: ["cover", "screenshot_uri"].iter().find_map(|k| {
                                absolutize(endpoint, e.get(*k).and_then(Value::as_str))
                            }),
                            added: e.get("added").and_then(p::date_to_rfc3339),
                            cmd,
                            series: None,
                            raw: e,
                        })
                    })
                    .collect();
                episodes.sort_by_key(|e| e.number);
                let name = s(&season, "name");
                let number = n(&season, "season_number")
                    .filter(|x| *x > 0)
                    .or_else(|| name.as_deref().and_then(season_number_from_name))
                    .unwrap_or(index as i64 + 1);
                Ok::<_, CoreError>(SeasonPlan {
                    id: season_id,
                    number,
                    name,
                    poster_url: ["screenshot_uri", "cover"]
                        .iter()
                        .find_map(|k| absolutize(endpoint, season.get(*k).and_then(Value::as_str)))
                        .or(fallback_poster),
                    episodes,
                })
            }
        })
        .buffered(PAGE_CONCURRENCY)
        .try_collect()
        .await?;
    Ok(plans)
}

/// Builds (or returns the cached) season plan of a series reference.
pub async fn season_plan(
    state: &Arc<AppState>,
    client: &StalkerClient,
    r: &ItemRef,
) -> CoreResult<Arc<Vec<SeasonPlan>>> {
    let runtime = Runtime::get(state);
    if let Some(plan) = runtime.plans.get(&r.key()) {
        return Ok(plan);
    }
    let endpoint = client.endpoint().await?;
    let raw = super::cached_item(state, r).await.map(|c| c.raw);
    let id = r.item_id.as_str();

    let mut plans: Vec<SeasonPlan> = if raw.as_ref().is_some_and(|v| !series_numbers(v).is_empty())
    {
        // The row itself is a single season with its episode numbers.
        raw.as_ref()
            .and_then(|v| regular_season(&endpoint, v, 0, id))
            .into_iter()
            .collect()
    } else if raw
        .as_ref()
        .is_some_and(|v| mapping::is_vod_series(v) && v.get("__kind").is_none())
    {
        vod_series_plan(client, &endpoint, id, raw.as_ref()).await?
    } else {
        let rows = into_list(
            client
                .call(
                    Req::new("series", "get_ordered_list")
                        .p("movie_id", id)
                        .p("p", 1),
                )
                .await?,
        );
        let regular: Vec<SeasonPlan> = rows
            .iter()
            .enumerate()
            .filter_map(|(i, v)| regular_season(&endpoint, v, i, id))
            .collect();
        if regular.is_empty() && raw.is_none() {
            // Unknown origin: maybe a VOD-as-series row.
            vod_series_plan(client, &endpoint, id, None)
                .await
                .unwrap_or_default()
        } else {
            regular
        }
    };
    plans.sort_by_key(|s| s.number);
    let plans = Arc::new(plans);
    runtime.remember_plan(r, plans.clone());
    Ok(plans)
}

/// Finds an episode in a plan by id.
pub fn find_episode<'a>(
    plans: &'a [SeasonPlan],
    episode_id: &str,
) -> Option<(&'a SeasonPlan, &'a EpisodePlan)> {
    plans.iter().find_map(|s| {
        s.episodes
            .iter()
            .find(|e| e.id == episode_id)
            .map(|e| (s, e))
    })
}

/// `stalker.seriesDetail`.
pub async fn series_detail(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<SeriesDetail> {
    let client = StalkerClient::for_source(state, &r.source_id).await?;
    let endpoint = client.endpoint().await?;
    let cached = lookup(state, &client, r).await?;
    let mut item = mapping::series_item(
        &r.source_id,
        &endpoint,
        &cached.raw,
        "*",
        cached.category_name.clone(),
    )
    .ok_or_else(|| CoreError::not_found("the portal row has no id"))?;
    item.item_ref = r.clone();
    let plans = season_plan(state, &client, r).await?;
    let seasons = plans
        .iter()
        .map(|sp| Season {
            number: sp.number,
            name: sp.name.clone(),
            poster_url: sp.poster_url.clone(),
            episodes: sp
                .episodes
                .iter()
                .map(|e| Episode {
                    id: e.id.clone(),
                    series_ref: r.clone(),
                    season: sp.number,
                    episode: e.number,
                    title: e.title.clone(),
                    plot: e.plot.clone(),
                    duration_seconds: e.duration_seconds,
                    poster_url: e.poster_url.clone(),
                    container_extension: None,
                    added: e.added.clone(),
                })
                .collect(),
        })
        .collect();
    Ok(SeriesDetail {
        cast: mapping::cast(&cached.raw),
        director: s(&cached.raw, "director"),
        trailer_url: None,
        backdrops: Vec::new(),
        provider_details_unavailable: false,
        provider_error: None,
        seasons,
        item,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn season_numbers() {
        assert_eq!(season_number_from_name("Season 3"), Some(3));
        assert_eq!(season_number_from_name("Сезон 2"), Some(2));
        assert_eq!(season_number_from_name("S04"), Some(4));
        assert_eq!(season_number_from_name("Specials"), None);
    }

    /// B8-parsers: indexes found in `to_lowercase()` were used to slice the
    /// original name; 'İ' lowercases to 3 bytes from 2, so this panicked.
    #[test]
    fn season_numbers_survive_length_changing_lowercase() {
        assert_eq!(season_number_from_name("İİİİ Season 5"), Some(5));
        assert_eq!(season_number_from_name("İ Сезон 7"), Some(7));
        assert_eq!(season_number_from_name("ΣİSeasonİ"), None);
        for name in ["İSEASON", "ẞİİİİİİİİİİİİ season", "Ⱥ season 2", "İ"] {
            let _ = season_number_from_name(name);
        }
    }

    #[test]
    fn regular_season_plan() {
        let v = json!({"id": "12:2", "name": "Season 2", "cmd": "/media/12.mpg", "series": [1, "2", 3]});
        let plan = regular_season("http://h/portal.php", &v, 0, "12").unwrap();
        assert_eq!(plan.number, 2);
        assert_eq!(plan.episodes.len(), 3);
        assert_eq!(plan.episodes[1].id, "s|12:2|2");
        assert_eq!(plan.episodes[1].series, Some(2));
        assert!(regular_season(
            "http://h/portal.php",
            &json!({"id": 1, "series": [1]}),
            0,
            "x"
        )
        .is_none());
        let plans = vec![plan];
        assert!(find_episode(&plans, "s|12:2|3").is_some());
        assert!(find_episode(&plans, "s|12:2|9").is_none());
    }

    /// D9: `total - 1` and `offset + limit - 1` overflowed on a hostile
    /// `total_items` or an offset near i64::MAX.
    #[test]
    fn paging_math_saturates() {
        // Normal: items 20..40 of 100 at 14 per page are on pages 2..=3.
        assert_eq!(last_needed_page(20, 20, 14, 100), 3);
        // Capped by the total.
        assert_eq!(last_needed_page(0, 500, 14, 30), 3);
        // Hostile totals and offsets: no overflow, sane answers.
        assert_eq!(last_needed_page(0, 20, 14, i64::MIN), 1);
        assert_eq!(last_needed_page(0, 20, 14, i64::MAX), 2);
        assert_eq!(last_needed_page(i64::MAX, 20, 14, 100), 8);
        assert_eq!(
            last_needed_page(i64::MAX, i64::MAX, 14, i64::MAX),
            i64::MAX / 14 + 1
        );
        assert_eq!(last_needed_page(0, i64::MIN, 0, 10), 1);
    }
}
