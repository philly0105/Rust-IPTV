//! Everything behind the `xtream.*` commands except `sync`: detail pages,
//! stream and catch-up URLs, short EPG, account info and connection test.

use super::client::XtreamClient;
use super::meta::{
    self, added_to_rfc3339, duration_to_seconds, parse_instant, parse_server_datetime,
    unix_to_rfc3339, year_from_date, ServerMeta,
};
use super::raw::{RawAccount, RawEpgListing, RawSeriesInfo, RawShortEpg, RawVodInfo};
use super::sync::{load_source, XtreamSourceRow};
use super::url::{catchup_stamp, clean_extension, episode_url, live_url, movie_url, timeshift_url};
use crate::catalog::{self, NamedRow};
use crate::error::{CoreError, CoreResult};
use crate::model::{
    ContentType, EpgProgram, Episode, ItemRef, Person, PlayerKind, PlayerSource, RequestHeaders,
    Season, SeriesDetail, SeriesItem, StreamFormat, VodDetail, VodItem, XtreamSourceConfig,
};
use crate::state::AppState;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

/// Most cast members returned on a detail page.
const MAX_CAST: usize = 30;
/// Default and maximum `limit` of `xtream.shortEpg`.
pub const SHORT_EPG_DEFAULT: i64 = 4;
pub const SHORT_EPG_MAX: i64 = 50;
/// Longest catch-up request (7 days, in minutes).
const MAX_CATCHUP_MINUTES: i64 = 7 * 24 * 60;

/// Base64 engine that accepts padded and unpadded input (panels vary).
const B64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// Source row, client and the catalog row of `r` (if synced).
struct Ctx {
    source: XtreamSourceRow,
    client: XtreamClient,
    item: Option<NamedRow>,
    meta: Option<ServerMeta>,
}

async fn ctx(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<Ctx> {
    let r2 = r.clone();
    let rt = meta::runtime(state);
    let (source, item, server_meta) = state
        .db_call(move |c| {
            let source = load_source(c, &r2.source_id)?;
            let item = catalog::get_named(c, &r2)?;
            let m = meta::load_meta(c, &rt, &r2.source_id)?;
            Ok((source, item, m))
        })
        .await?;
    let http = crate::http::trusted_client(state, &source.config.server_url);
    let client = XtreamClient::new(http, &source.config)?;
    Ok(Ctx {
        source,
        client,
        item,
        meta: server_meta,
    })
}

fn expect_type(r: &ItemRef, allowed: &[ContentType], what: &str) -> CoreResult<()> {
    if allowed.contains(&r.content_type) {
        Ok(())
    } else {
        Err(CoreError::invalid(format!(
            "{what} needs a {} item, got {}.",
            allowed
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(" or "),
            r.content_type
        )))
    }
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn http_urls(v: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| {
            (u.starts_with("http://") || u.starts_with("https://")) && seen.insert(u.clone())
        })
        .collect()
}

fn genres(g: Option<&str>) -> Option<Vec<String>> {
    let v: Vec<String> = g?
        .split([',', '/', '|'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    (!v.is_empty()).then_some(v)
}

/// Comma-separated names to people (deduplicated, capped).
pub fn cast_list(raw: Option<&str>) -> Vec<Person> {
    let mut seen = HashSet::new();
    raw.unwrap_or_default()
        .split([',', ';'])
        .map(str::trim)
        .filter(|n| !n.is_empty() && seen.insert(n.to_lowercase()))
        .take(MAX_CAST)
        .map(|name| Person {
            id: None,
            name: name.to_string(),
            role: None,
            profile_url: None,
        })
        .collect()
}

/// `youtube_trailer` is a video id or a full URL.
pub fn trailer_url(raw: Option<&str>) -> Option<String> {
    let t = raw?.trim();
    if t.is_empty() {
        None
    } else if t.starts_with("http://") || t.starts_with("https://") {
        Some(t.to_string())
    } else if t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(format!("https://www.youtube.com/watch?v={t}"))
    } else {
        None
    }
}

fn rating10(r: Option<f64>) -> Option<f64> {
    r.filter(|v| *v > 0.0)
        .map(|v| (v.min(10.0) * 10.0).round() / 10.0)
}

fn kind_for_ext(ext: &str) -> PlayerKind {
    match ext {
        "m3u8" => PlayerKind::Hls,
        "mpd" => PlayerKind::Dash,
        _ => PlayerKind::Direct,
    }
}

/// Saved resume point from `playback_positions` (C3), if any.
async fn resume_seconds(
    state: &Arc<AppState>,
    r: &ItemRef,
    episode_id: Option<&str>,
) -> Option<i64> {
    let r = r.clone();
    let ep = episode_id.unwrap_or_default().to_string();
    state
        .db_call(move |c| stored_resume(c, &r, &ep))
        .await
        .ok()
        .flatten()
}

/// The stored position to resume from, or `None` when there is none or the
/// row is finished: C13 keeps a finished episode as a watched row with the
/// position at the end, and resuming there would start at the credits.
fn stored_resume(c: &rusqlite::Connection, r: &ItemRef, ep: &str) -> CoreResult<Option<i64>> {
    let row = c
        .query_row(
            "SELECT position_seconds, duration_seconds, watched FROM playback_positions WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id = ?4",
            rusqlite::params![r.source_id, r.content_type.as_str(), r.item_id, ep],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(pos, duration, watched)| {
        (pos > 0 && !watched && !crate::userstate::is_complete(pos, duration)).then_some(pos)
    }))
}

// ---------------------------------------------------------------------------
// Detail pages
// ---------------------------------------------------------------------------

pub async fn vod_detail(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<VodDetail> {
    expect_type(r, &[ContentType::Movie], "xtream.vodDetail")?;
    let cx = ctx(state, r).await?;
    let raw: RawVodInfo = match cx
        .client
        .get(Some("get_vod_info"), &[("vod_id", r.item_id.clone())])
        .await
    {
        Ok(raw) => raw,
        Err(err @ CoreError::Auth(_)) => return Err(err),
        // The catalog row still has title, poster, plot and rating.
        Err(err) if cx.item.is_some() => {
            tracing::debug!(error = %err, "vod info unavailable; detail from the catalog row");
            let mut d = build_vod_detail(r, cx.item, RawVodInfo::default());
            d.provider_details_unavailable = true;
            d.provider_error = Some(error_text(&err));
            return Ok(d);
        }
        Err(err) => return Err(err),
    };
    if cx.item.is_none() && raw.info.is_none() && raw.movie_data.is_none() {
        return Err(CoreError::not_found(
            "This movie is no longer offered by the provider.",
        ));
    }
    Ok(build_vod_detail(r, cx.item, raw))
}

pub fn build_vod_detail(r: &ItemRef, item: Option<NamedRow>, raw: RawVodInfo) -> VodDetail {
    let info = raw.info.unwrap_or_default();
    let md = raw.movie_data.unwrap_or_default();
    let mut v = match item {
        Some(row) => row.into_vod(),
        None => {
            let title = non_empty(info.name.clone())
                .or(non_empty(md.name.clone()))
                .unwrap_or_else(|| format!("Movie {}", r.item_id));
            let (base, year) = catalog::title_base(&title);
            VodItem {
                item_ref: r.clone(),
                title,
                title_base: Some(base),
                year,
                poster_url: None,
                backdrop_url: None,
                rating: None,
                added: added_to_rfc3339(md.added.as_deref()),
                category_id: md.category_id.clone().unwrap_or_else(|| "0".into()),
                category_name: None,
                container_extension: None,
                duration_seconds: None,
                plot: None,
                genres: None,
                tmdb_id: None,
            }
        }
    };
    let backdrops = http_urls(info.backdrop_path.clone());
    v.plot = non_empty(info.plot.clone())
        .or(non_empty(info.description.clone()))
        .or(v.plot);
    v.genres = genres(info.genre.as_deref()).or(v.genres);
    v.duration_seconds = info
        .duration_secs
        .filter(|d| *d > 0)
        .or_else(|| duration_to_seconds(info.duration.as_deref()))
        .or(v.duration_seconds);
    v.poster_url = v
        .poster_url
        .or_else(|| http_urls(info.cover_big.clone().into_iter().collect()).pop())
        .or_else(|| http_urls(info.movie_image.clone().into_iter().collect()).pop());
    v.backdrop_url = v.backdrop_url.or_else(|| backdrops.first().cloned());
    v.rating = rating10(info.rating).or(v.rating);
    v.year = v.year.or_else(|| year_from_date(info.release()));
    v.tmdb_id = info.tmdb().or(v.tmdb_id);
    v.container_extension =
        clean_extension(md.container_extension.as_deref()).or(v.container_extension);
    let cast = cast_list(info.actors.as_deref().or(info.cast.as_deref()));
    VodDetail {
        item: v,
        cast,
        director: non_empty(info.director),
        trailer_url: trailer_url(info.youtube_trailer.as_deref()),
        backdrops,
        provider_details_unavailable: false,
        provider_error: None,
    }
}

/// User-facing text of a provider error (no `network:` prefix).
fn error_text(err: &CoreError) -> String {
    match err {
        CoreError::NotFound(m)
        | CoreError::Invalid(m)
        | CoreError::Network(m)
        | CoreError::Auth(m)
        | CoreError::Timeout(m)
        | CoreError::Conflict(m)
        | CoreError::Unsupported(m) => m.clone(),
        other => other.to_string(),
    }
}

async fn series_info(
    state: &Arc<AppState>,
    client: &XtreamClient,
    r: &ItemRef,
) -> CoreResult<Arc<RawSeriesInfo>> {
    let rt = meta::runtime(state);
    if let Some(hit) = meta::cached_series(&rt, &r.source_id, &r.item_id) {
        return Ok(hit);
    }
    let raw: RawSeriesInfo = client
        .get(Some("get_series_info"), &[("series_id", r.item_id.clone())])
        .await?;
    let raw = Arc::new(raw);
    meta::put_series(&rt, &r.source_id, &r.item_id, raw.clone());
    Ok(raw)
}

pub async fn series_detail(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<SeriesDetail> {
    expect_type(r, &[ContentType::Series], "xtream.seriesDetail")?;
    let cx = ctx(state, r).await?;
    // The detail page always shows fresh episodes.
    meta::invalidate_series(&meta::runtime(state), &r.source_id, &r.item_id);
    let raw = match series_info(state, &cx.client, r).await {
        Ok(raw) => raw,
        Err(err @ CoreError::Auth(_)) => return Err(err),
        // The catalog row still has title, poster, plot and rating.
        Err(err) if cx.item.is_some() => {
            tracing::debug!(error = %err, "series info unavailable; detail from the catalog row");
            let mut d = build_series_detail(r, cx.item, &RawSeriesInfo::default());
            d.provider_details_unavailable = true;
            d.provider_error = Some(error_text(&err));
            return Ok(d);
        }
        Err(err) => return Err(err),
    };
    if cx.item.is_none() && raw.info.is_none() && raw.episodes.is_empty() {
        return Err(CoreError::not_found(
            "This series is no longer offered by the provider.",
        ));
    }
    Ok(build_series_detail(r, cx.item, &raw))
}

pub fn build_seasons(r: &ItemRef, raw: &RawSeriesInfo) -> Vec<Season> {
    let mut seasons: BTreeMap<i64, Season> = BTreeMap::new();
    let mut seen = HashSet::new();
    for (key, eps) in &raw.episodes {
        for (idx, ep) in eps.iter().enumerate() {
            let Some(id) = ep.id.clone() else { continue };
            if !seen.insert(id.clone()) {
                continue;
            }
            let season_no = key.or(ep.season).unwrap_or(1).max(0);
            let number = ep.episode_num.unwrap_or(idx as i64 + 1);
            let info = ep.info.as_ref();
            let episode = Episode {
                title: non_empty(ep.title.clone()).unwrap_or_else(|| format!("Episode {number}")),
                plot: info.and_then(|i| non_empty(i.plot.clone())),
                duration_seconds: info.and_then(|i| {
                    i.duration_secs
                        .filter(|d| *d > 0)
                        .or_else(|| duration_to_seconds(i.duration.as_deref()))
                }),
                poster_url: info
                    .and_then(|i| http_urls(i.movie_image.clone().into_iter().collect()).pop()),
                container_extension: clean_extension(ep.container_extension.as_deref()),
                added: added_to_rfc3339(ep.added.as_deref())
                    .or_else(|| info.and_then(|i| added_to_rfc3339(i.releasedate.as_deref()))),
                id,
                series_ref: r.clone(),
                season: season_no,
                episode: number,
            };
            seasons
                .entry(season_no)
                .or_insert_with(|| Season {
                    number: season_no,
                    name: None,
                    poster_url: None,
                    episodes: Vec::new(),
                })
                .episodes
                .push(episode);
        }
    }
    for s in &raw.seasons.items {
        let Some(n) = s.season_number else { continue };
        if let Some(season) = seasons.get_mut(&n) {
            season.name = non_empty(s.name.clone());
            season.poster_url = http_urls(
                s.cover_big
                    .clone()
                    .into_iter()
                    .chain(s.cover.clone())
                    .collect(),
            )
            .into_iter()
            .next();
        }
    }
    let mut out: Vec<Season> = seasons.into_values().collect();
    for s in &mut out {
        s.episodes.sort_by_key(|e| e.episode);
    }
    out
}

pub fn build_series_detail(
    r: &ItemRef,
    item: Option<NamedRow>,
    raw: &RawSeriesInfo,
) -> SeriesDetail {
    let info = raw.info.as_ref();
    let mut s = match item {
        Some(row) => row.into_series(),
        None => {
            let title = info
                .and_then(|i| non_empty(i.name.clone()))
                .unwrap_or_else(|| format!("Series {}", r.item_id));
            let (base, year) = catalog::title_base(&title);
            SeriesItem {
                item_ref: r.clone(),
                title,
                title_base: Some(base),
                year,
                poster_url: None,
                backdrop_url: None,
                rating: None,
                added: None,
                category_id: info
                    .and_then(|i| i.category_id.clone())
                    .unwrap_or_else(|| "0".into()),
                category_name: None,
                plot: None,
                genres: None,
                tmdb_id: None,
            }
        }
    };
    let backdrops = info
        .map(|i| http_urls(i.backdrop_path.clone()))
        .unwrap_or_default();
    if let Some(i) = info {
        s.plot = non_empty(i.plot.clone()).or(s.plot);
        s.genres = genres(i.genre.as_deref()).or(s.genres);
        s.poster_url = s
            .poster_url
            .or_else(|| http_urls(i.cover.clone().into_iter().collect()).pop());
        s.rating = rating10(i.rating)
            .or_else(|| rating10(i.rating_5based.map(|v| v * 2.0)))
            .or(s.rating);
        s.year = s.year.or_else(|| year_from_date(i.release()));
        s.tmdb_id = i.tmdb().or(s.tmdb_id);
    }
    s.backdrop_url = s.backdrop_url.or_else(|| backdrops.first().cloned());
    SeriesDetail {
        seasons: build_seasons(r, raw),
        cast: cast_list(info.and_then(|i| i.cast.as_deref())),
        director: info.and_then(|i| non_empty(i.director.clone())),
        trailer_url: trailer_url(info.and_then(|i| i.youtube_trailer.as_deref())),
        backdrops,
        item: s,
        provider_details_unavailable: false,
        provider_error: None,
    }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/// Live extension: `settings.streamFormat` when the panel's
/// `allowed_output_formats` lists it or lists nothing (unknown); otherwise the
/// first allowed format in the order `m3u8` > `ts` > whatever the panel lists
/// first (`allowed` is lowercased by [`ServerMeta::from_account`]).
pub fn live_extension(pref: StreamFormat, allowed: &[String]) -> String {
    let want = pref.as_str();
    let has = |f: &str| allowed.iter().any(|a| a == f);
    if allowed.is_empty() || has(want) {
        return want.to_string();
    }
    ["m3u8", "ts"]
        .into_iter()
        .find(|f| has(f))
        .map(str::to_string)
        .or_else(|| allowed.iter().find_map(|f| clean_extension(Some(f))))
        .unwrap_or_else(|| want.to_string())
}

/// The source's own User-Agent, Referer and Origin (trimmed when saved,
/// `sources::validate_xtream`) for the player, downloads and recordings;
/// `None` when none is set, so the player keeps its defaults.
fn stream_headers(cfg: &XtreamSourceConfig) -> Option<RequestHeaders> {
    (!cfg.headers.is_empty()).then(|| cfg.headers.clone())
}

pub async fn stream_url(
    state: &Arc<AppState>,
    r: &ItemRef,
    episode_id: Option<&str>,
) -> CoreResult<PlayerSource> {
    let cx = ctx(state, r).await?;
    let headers = stream_headers(&cx.source.config);
    let (server, user, pass) = (&cx.client.server, &cx.client.username, cx.client.password());
    let row = cx.item.as_ref().map(|n| &n.row);
    let title = row.map(|r| r.title.clone());
    match r.content_type {
        ContentType::Live | ContentType::Radio => {
            let allowed = cx
                .meta
                .as_ref()
                .map(|m| m.allowed_output_formats.clone())
                .unwrap_or_default();
            let ext = live_extension(state.settings.read().stream_format, &allowed);
            Ok(PlayerSource {
                url: live_url(server, user, pass, &r.item_id, &ext),
                kind: kind_for_ext(&ext),
                headers,
                title: title.unwrap_or_else(|| format!("Channel {}", r.item_id)),
                subtitle: Some(cx.source.name.clone()),
                poster_url: row.and_then(|r| r.logo_url.clone()),
                item_ref: Some(r.clone()),
                episode_id: None,
                resume_seconds: None,
                is_live: true,
                is_radio: r.content_type == ContentType::Radio || row.is_some_and(|r| r.is_radio),
            })
        }
        ContentType::Movie => {
            if row.is_none() {
                let as_series = ItemRef {
                    content_type: ContentType::Series,
                    ..r.clone()
                };
                let series = state
                    .db_call(move |c| catalog::get_named(c, &as_series))
                    .await?;
                if let Some(s) = series {
                    return Err(CoreError::not_found(format!(
                        "\"{}\" is a series, not a movie. Open it from the series list.",
                        s.row.title
                    )));
                }
            }
            let mut ext = row.and_then(|r| clean_extension(r.container_extension.as_deref()));
            if ext.is_none() {
                match cx
                    .client
                    .get::<RawVodInfo>(Some("get_vod_info"), &[("vod_id", r.item_id.clone())])
                    .await
                {
                    Ok(info) => {
                        ext = info
                            .movie_data
                            .and_then(|m| clean_extension(m.container_extension.as_deref()))
                    }
                    Err(err @ CoreError::Auth(_)) => return Err(err),
                    Err(err) => tracing::debug!(error = %err, "vod info unavailable; assuming mp4"),
                }
            }
            let ext = ext.unwrap_or_else(|| "mp4".into());
            Ok(PlayerSource {
                url: movie_url(server, user, pass, &r.item_id, &ext),
                kind: kind_for_ext(&ext),
                headers,
                title: title.unwrap_or_else(|| format!("Movie {}", r.item_id)),
                subtitle: row.and_then(|r| r.year).map(|y| y.to_string()),
                poster_url: row.and_then(|r| r.poster_url.clone()),
                item_ref: Some(r.clone()),
                episode_id: None,
                resume_seconds: resume_seconds(state, r, None).await,
                is_live: false,
                is_radio: false,
            })
        }
        ContentType::Series => {
            let Some(ep_id) = episode_id.map(str::trim).filter(|e| !e.is_empty()) else {
                return Err(CoreError::invalid("Choose an episode to play."));
            };
            let find = |info: &RawSeriesInfo| {
                build_seasons(r, info)
                    .into_iter()
                    .flat_map(|s| s.episodes)
                    .find(|e| e.id == ep_id)
            };
            let mut loaded = series_info(state, &cx.client, r).await;
            if loaded.as_ref().is_ok_and(|info| find(info).is_none()) {
                // The cached list may predate the episode: refetch once.
                meta::invalidate_series(&meta::runtime(state), &r.source_id, &r.item_id);
                loaded = series_info(state, &cx.client, r).await;
            }
            let episode = match loaded {
                Ok(info) => match find(&info) {
                    Some(e) => Some(e),
                    None => {
                        return Err(CoreError::not_found(
                            "This episode is no longer offered by the provider.",
                        ))
                    }
                },
                Err(err @ CoreError::Auth(_)) => return Err(err),
                Err(err) => {
                    tracing::debug!(error = %err, "series info unavailable; assuming mp4");
                    None
                }
            };
            let ext = episode
                .as_ref()
                .and_then(|e| e.container_extension.clone())
                .unwrap_or_else(|| "mp4".into());
            let subtitle = episode
                .as_ref()
                .map(|e| format!("S{:02}E{:02} · {}", e.season, e.episode, e.title));
            Ok(PlayerSource {
                url: episode_url(server, user, pass, ep_id, &ext),
                kind: kind_for_ext(&ext),
                headers,
                title: title.unwrap_or_else(|| format!("Series {}", r.item_id)),
                subtitle,
                poster_url: episode
                    .as_ref()
                    .and_then(|e| e.poster_url.clone())
                    .or_else(|| row.and_then(|r| r.poster_url.clone())),
                item_ref: Some(r.clone()),
                episode_id: Some(ep_id.to_string()),
                resume_seconds: resume_seconds(state, r, Some(ep_id)).await,
                is_live: false,
                is_radio: false,
            })
        }
    }
}

/// Rejects a catch-up start older than the channel's archive window.
/// `archive_hours` comes from the catalog row; rows stored by older builds
/// may hold any provider value, so it is clamped before the time math.
fn check_catchup_window(
    start_at: chrono::DateTime<chrono::Utc>,
    now: chrono::DateTime<chrono::Utc>,
    archive_hours: Option<i64>,
) -> CoreResult<()> {
    let Some(hours) = archive_hours.filter(|h| *h > 0) else {
        return Err(CoreError::invalid("This channel has no catch-up."));
    };
    let hours = meta::clamp_archive_hours(hours);
    let oldest = now
        .checked_sub_signed(chrono::Duration::hours(hours))
        .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC);
    if start_at < oldest {
        let days = (hours + 23) / 24;
        let window = if days == 1 {
            "day".to_string()
        } else {
            format!("{days} days")
        };
        return Err(CoreError::invalid(format!(
            "That programme is older than this channel's catch-up window (the last {window})."
        )));
    }
    Ok(())
}

pub async fn catchup_url(
    state: &Arc<AppState>,
    r: &ItemRef,
    start: &str,
    duration_minutes: f64,
) -> CoreResult<PlayerSource> {
    expect_type(r, &[ContentType::Live], "xtream.catchupUrl")?;
    let start_at = parse_instant(start)
        .ok_or_else(|| CoreError::invalid("The catch-up start time is not a valid date."))?;
    if start_at > chrono::Utc::now() + chrono::Duration::seconds(60) {
        return Err(CoreError::invalid("That programme has not aired yet."));
    }
    if !duration_minutes.is_finite() || duration_minutes <= 0.0 {
        return Err(CoreError::invalid(
            "The catch-up duration must be positive.",
        ));
    }
    let duration = (duration_minutes.round() as i64).clamp(1, MAX_CATCHUP_MINUTES);
    let mut cx = ctx(state, r).await?;
    if let Some(n) = &cx.item {
        check_catchup_window(start_at, chrono::Utc::now(), n.row.archive_hours)?;
    }
    if cx.meta.is_none() {
        // First contact since install: learn the server clock, best effort.
        if let Ok(acc) = cx.client.account().await {
            let m = ServerMeta::from_account(&acc);
            let rt = meta::runtime(state);
            let sid = r.source_id.clone();
            let m2 = m.clone();
            let _ = state
                .db_call(move |c| meta::store_meta(c, &rt, &sid, &m2))
                .await;
            cx.meta = Some(m);
        }
    }
    let offset = cx.meta.as_ref().map_or(0, |m| m.offset_seconds);
    let stamp = catchup_stamp(start_at, offset);
    let row = cx.item.as_ref().map(|n| &n.row);
    Ok(PlayerSource {
        url: timeshift_url(
            &cx.client.server,
            &cx.client.username,
            cx.client.password(),
            duration,
            &stamp,
            &r.item_id,
        ),
        kind: PlayerKind::Direct,
        headers: stream_headers(&cx.source.config),
        title: row.map_or_else(|| format!("Channel {}", r.item_id), |r| r.title.clone()),
        subtitle: Some(start_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        poster_url: row.and_then(|r| r.logo_url.clone()),
        item_ref: Some(r.clone()),
        episode_id: None,
        resume_seconds: None,
        is_live: false,
        is_radio: false,
    })
}

// ---------------------------------------------------------------------------
// Short EPG
// ---------------------------------------------------------------------------

/// Decodes a base64 EPG field; returns the input when it is not base64 text.
///
/// Line breaks inside the value are ignored (some panels wrap long base64 at
/// 76 columns); spaces are not, so a plain title is never read as base64.
pub fn decode_b64_text(s: &str) -> String {
    let t = s.trim();
    let compact: String = t
        .chars()
        .filter(|c| !matches!(c, '\n' | '\r' | '\t'))
        .collect();
    match B64.decode(compact.as_bytes()) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text)
                if !text.trim().is_empty()
                    && !text
                        .chars()
                        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) =>
            {
                text.trim().to_string()
            }
            _ => t.to_string(),
        },
        Err(_) => t.to_string(),
    }
}

/// Maps listings to programs (UTC, sorted, at most `limit`). `offset_seconds`
/// converts the server-local `start`/`end` strings when timestamps are absent.
pub fn map_short_epg(
    listings: Vec<RawEpgListing>,
    fallback_channel: &str,
    offset_seconds: i64,
    limit: usize,
) -> Vec<EpgProgram> {
    let to_utc = |ts: Option<i64>, local: Option<&str>| -> Option<(i64, String)> {
        // A few panels send milliseconds; no programme airs in the year 5138.
        let ts = ts.map(|t| if t > 100_000_000_000 { t / 1000 } else { t });
        let secs = ts.filter(|t| *t > 0).or_else(|| {
            local
                .and_then(parse_server_datetime)
                .and_then(|d| d.and_utc().timestamp().checked_sub(offset_seconds))
        })?;
        Some((secs, unix_to_rfc3339(secs)?))
    };
    let mut out: Vec<(i64, EpgProgram)> = listings
        .into_iter()
        .filter_map(|l| {
            let (start_secs, start) = to_utc(l.start_timestamp, l.start.as_deref())?;
            let (end_secs, end) = to_utc(l.stop(), l.end.as_deref())?;
            // An empty or backwards slot would draw nothing and confuse now/next.
            if end_secs <= start_secs {
                return None;
            }
            let title = l
                .title
                .as_deref()
                .map(decode_b64_text)
                .filter(|t| !t.is_empty())?;
            Some((
                start_secs,
                EpgProgram {
                    channel_id: l
                        .epg_id
                        .or(l.channel_id)
                        .unwrap_or_else(|| fallback_channel.to_string()),
                    start,
                    end,
                    title,
                    description: l
                        .description
                        .as_deref()
                        .map(decode_b64_text)
                        .filter(|d| !d.is_empty()),
                    category: None,
                    icon: None,
                },
            ))
        })
        .collect();
    out.sort_by_key(|(s, _)| *s);
    out.dedup_by(|a, b| a.0 == b.0);
    out.into_iter().take(limit).map(|(_, p)| p).collect()
}

pub async fn short_epg(
    state: &Arc<AppState>,
    r: &ItemRef,
    limit: Option<i64>,
) -> CoreResult<Vec<EpgProgram>> {
    expect_type(
        r,
        &[ContentType::Live, ContentType::Radio],
        "xtream.shortEpg",
    )?;
    let limit = limit.unwrap_or(SHORT_EPG_DEFAULT).clamp(1, SHORT_EPG_MAX);
    let cx = ctx(state, r).await?;
    let raw: RawShortEpg = cx
        .client
        .get(
            Some("get_short_epg"),
            &[
                ("stream_id", r.item_id.clone()),
                ("limit", limit.to_string()),
            ],
        )
        .await?;
    let fallback = cx
        .item
        .as_ref()
        .and_then(|n| n.row.epg_channel_id.clone())
        .unwrap_or_else(|| r.item_id.clone());
    let offset = cx.meta.as_ref().map_or(0, |m| m.offset_seconds);
    Ok(map_short_epg(
        raw.epg_listings.items,
        &fallback,
        offset,
        limit as usize,
    ))
}

/// Most programmes kept from one `get_simple_data_table` answer (a panel
/// with a two-week archive lists a few thousand).
pub const DATA_TABLE_MAX: usize = 5000;

/// guide: the panel's full archive table for a live channel
/// (`get_simple_data_table`), decoded like the short EPG.
pub async fn simple_data_table(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<Vec<EpgProgram>> {
    expect_type(r, &[ContentType::Live], "catchup.programs")?;
    let cx = ctx(state, r).await?;
    let raw: RawShortEpg = cx
        .client
        .get(
            Some("get_simple_data_table"),
            &[("stream_id", r.item_id.clone())],
        )
        .await?;
    let fallback = cx
        .item
        .as_ref()
        .and_then(|n| n.row.epg_channel_id.clone())
        .unwrap_or_else(|| r.item_id.clone());
    let offset = cx.meta.as_ref().map_or(0, |m| m.offset_seconds);
    Ok(map_short_epg(
        raw.epg_listings.items,
        &fallback,
        offset,
        DATA_TABLE_MAX,
    ))
}

// ---------------------------------------------------------------------------
// Account and test
// ---------------------------------------------------------------------------

/// `xtream.accountInfo` result (TS `XtreamAccountInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XtreamAccountInfo {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_date: Option<String>,
    pub active_cons: i64,
    pub max_connections: i64,
    pub is_trial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// Lowercased `user_info.allowed_output_formats` (empty = not reported).
    pub allowed_output_formats: Vec<String>,
}

/// `xtream.test` result (TS `ConnectionTestResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

pub async fn account_info(state: &Arc<AppState>, source_id: &str) -> CoreResult<XtreamAccountInfo> {
    let sid = source_id.to_string();
    let source = state.db_call(move |c| load_source(c, &sid)).await?;
    let http = crate::http::trusted_client(state, &source.config.server_url);
    let client = XtreamClient::new(http, &source.config)?;
    let acc = client.account().await?;
    let m = ServerMeta::from_account(&acc);
    let rt = meta::runtime(state);
    let sid = source_id.to_string();
    state
        .db_call(move |c| meta::store_meta(c, &rt, &sid, &m))
        .await?;
    Ok(info_from_raw(acc))
}

/// `xtream.accountInfo` fields of a `player_api.php` account reply (also
/// used by the sync to refresh the cached account status).
pub fn info_from_raw(acc: RawAccount) -> XtreamAccountInfo {
    let allowed_output_formats = ServerMeta::from_account(&acc).allowed_output_formats;
    let u = acc.user_info.unwrap_or_default();
    let s = acc.server_info.unwrap_or_default();
    XtreamAccountInfo {
        status: non_empty(u.status).unwrap_or_else(|| "Active".into()),
        exp_date: u.exp_date.and_then(unix_to_rfc3339),
        active_cons: u.active_cons.unwrap_or(0).max(0),
        max_connections: u.max_connections.unwrap_or(0).max(0),
        is_trial: u.is_trial.unwrap_or(false),
        created_at: u.created_at.and_then(unix_to_rfc3339),
        server_time: server_time(s.timestamp_now, s.time_now, s.timezone.as_deref()),
        timezone: non_empty(s.timezone),
        allowed_output_formats,
    }
}

/// `serverTime` of `xtream.accountInfo`: RFC 3339 from `timestamp_now`, or
/// from the `time_now` wall clock when `timezone` names UTC or a fixed
/// offset. A named zone (`Europe/Berlin`) cannot be converted without a zone
/// database, so the wall clock is returned as sent, without an offset, and
/// the UI shows it verbatim next to the zone name.
fn server_time(
    timestamp_now: Option<i64>,
    time_now: Option<String>,
    timezone: Option<&str>,
) -> Option<String> {
    if let Some(t) = timestamp_now.and_then(unix_to_rfc3339) {
        return Some(t);
    }
    let wall = non_empty(time_now)?;
    let utc = parse_server_datetime(&wall).and_then(|naive| {
        let offset = timezone.and_then(fixed_offset_seconds)?;
        let at = naive
            .and_utc()
            .checked_sub_signed(chrono::Duration::seconds(offset))?;
        Some(at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    });
    Some(utc.unwrap_or(wall))
}

/// Seconds east of UTC for a zone written as UTC or a fixed offset: `UTC`,
/// `GMT`, `Etc/UTC`, `+02:00`, `-0530`, `UTC+2`, `GMT-03:30`, and `Etc/GMT-2`
/// (POSIX sign: east of UTC is negative). `None` for named zones.
fn fixed_offset_seconds(tz: &str) -> Option<i64> {
    let tz = tz.trim();
    let upper = tz.to_ascii_uppercase();
    let (rest, sign_flip) = if let Some(r) = upper.strip_prefix("ETC/GMT") {
        (r, -1)
    } else if let Some(r) = upper
        .strip_prefix("ETC/UTC")
        .or_else(|| upper.strip_prefix("ETC/UCT"))
    {
        (r, 1)
    } else if let Some(r) = upper
        .strip_prefix("UTC")
        .or_else(|| upper.strip_prefix("GMT"))
        .or_else(|| upper.strip_prefix("UCT"))
    {
        (r, 1)
    } else if upper == "Z" {
        ("", 1)
    } else if upper.starts_with('+') || upper.starts_with('-') {
        (upper.as_str(), 1)
    } else {
        return None;
    };
    if rest.is_empty() {
        return Some(0);
    }
    let (sign, digits) = match rest.as_bytes()[0] {
        b'+' => (1, &rest[1..]),
        b'-' => (-1, &rest[1..]),
        _ => return None,
    };
    let (h, m) = match digits.split_once(':') {
        Some((h, m)) => (h, m),
        // `is_ascii` keeps byte 2 on a char boundary ("1é1" is 4 bytes).
        None if digits.len() == 4 && digits.is_ascii() => digits.split_at(2),
        None => (digits, "0"),
    };
    if h.is_empty() || h.len() > 2 || m.len() > 2 {
        return None;
    }
    // ASCII digits only: `parse` would take "+5", and the length checks above
    // count bytes, so a multi-byte char must never reach `split_at`.
    if !h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let h: i64 = h.parse().ok()?;
    let m: i64 = m.parse().ok()?;
    if h > 14 || m >= 60 {
        return None;
    }
    Some(sign_flip * sign * (h * 3600 + m * 60))
}

/// Turns a failure into a message naming the next action.
pub fn test_message(err: &CoreError) -> String {
    match err {
        CoreError::Auth(m) | CoreError::Invalid(m) => m.clone(),
        CoreError::NotFound(_) => {
            "No Xtream API answered at this address (HTTP 404). Check the server URL and port."
                .into()
        }
        CoreError::Timeout(_) => {
            "The server did not answer in time. Check the URL and port, then try again.".into()
        }
        // Transport failures already name the host (http::transport_error),
        // and status errors (429 is Network) already say what to do.
        CoreError::Network(m) if m.starts_with("Could not reach ") || m.contains(": HTTP ") => {
            m.clone()
        }
        CoreError::Network(m) => format!(
            "Could not reach the server ({m}). Check the URL and your connection, then try again."
        ),
        // 5xx: the status message as is, without the "server: " kind prefix.
        CoreError::Server(m) => m.clone(),
        other => crate::sources::error_text(other),
    }
}

pub async fn test(
    state: &Arc<AppState>,
    cfg: &XtreamSourceConfig,
) -> CoreResult<ConnectionTestResult> {
    let fail = |err: CoreError| ConnectionTestResult {
        ok: false,
        message: Some(test_message(&err)),
        name: None,
    };
    let http = crate::http::trusted_client(state, &cfg.server_url);
    let client = match XtreamClient::new(http, cfg) {
        Ok(c) => c.with_attempts(1),
        Err(err) => return Ok(fail(err)),
    };
    match client.account().await {
        Ok(acc) => {
            let host = url::Url::parse(&client.server)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned));
            let u = acc.user_info.unwrap_or_default();
            let status = non_empty(u.status.clone());
            let expired = status
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case("expired"))
                || u.exp_date
                    .is_some_and(|e| e > 0 && e < chrono::Utc::now().timestamp());
            let message = if expired {
                Some("Signed in, but the account has expired. Renew it with your provider.".into())
            } else {
                status
                    .filter(|s| !s.eq_ignore_ascii_case("active"))
                    .map(|s| format!("Signed in. Account status: {s}."))
            };
            Ok(ConnectionTestResult {
                ok: true,
                message,
                name: host,
            })
        }
        Err(err) => Ok(fail(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(ct: ContentType, id: &str) -> ItemRef {
        ItemRef::new("s", ct, id)
    }

    /// Review R2-2: a finished episode (C13 keeps it as a watched row at
    /// position = duration) resumed at the end.
    #[test]
    fn finished_rows_do_not_resume() {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut c).unwrap();
        c.execute(
            "INSERT INTO sources (id, kind, name, config_json) VALUES ('s', 'xtream', 'S', '{}')",
            [],
        )
        .unwrap();
        let put = |ep: &str, pos: i64, dur: Option<i64>, watched: i64| {
            c.execute(
                "INSERT INTO playback_positions(source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, watched) VALUES ('s', 'series', 'show', ?1, ?2, ?3, ?4)",
                rusqlite::params![ep, pos, dur, watched],
            )
            .unwrap();
        };
        put("done", 1000, Some(1000), 1);
        put("watched-early", 300, Some(1000), 1);
        put("near-end", 960, Some(1000), 0);
        put("half", 500, Some(1000), 0);
        put("no-duration", 500, None, 0);
        put("zero", 0, Some(1000), 0);
        let show = r(ContentType::Series, "show");
        let get = |ep: &str| stored_resume(&c, &show, ep).unwrap();
        assert_eq!(get("done"), None);
        assert_eq!(get("watched-early"), None);
        assert_eq!(get("near-end"), None);
        assert_eq!(get("zero"), None);
        assert_eq!(get("missing"), None);
        assert_eq!(get("half"), Some(500));
        assert_eq!(get("no-duration"), Some(500));
    }

    #[test]
    fn base64_titles() {
        assert_eq!(decode_b64_text("TW9ybmluZyBOZXdz"), "Morning News");
        assert_eq!(decode_b64_text("TW9ybmluZyBOZXdz\n"), "Morning News");
        assert_eq!(decode_b64_text("Q2Fmw6k"), "Café"); // unpadded
        assert_eq!(decode_b64_text("Plain title!"), "Plain title!");
        // guide: wrapped base64, plain words, and garbage that decodes to binary.
        assert_eq!(decode_b64_text("TW9ybmlu\r\nZyBOZXdz"), "Morning News");
        assert_eq!(decode_b64_text("Morning News"), "Morning News");
        assert_eq!(decode_b64_text("AAEC"), "AAEC");
        assert_eq!(decode_b64_text("  "), "");
    }

    #[test]
    fn short_epg_drops_bad_slots_and_reads_milliseconds() {
        let listings: RawShortEpg = serde_json::from_value(json!({"epg_listings": [
            {"title": "QmFja3dhcmRz", "start_timestamp": 1700007200, "stop_timestamp": 1700003600},
            {"title": "RW1wdHk=", "start_timestamp": 1700003600, "stop_timestamp": 1700003600},
            {"title": "TWlsbGlz", "start_timestamp": 1700003600000_i64, "stop_timestamp": "1700007200000"},
            {"title": "Tm8gZW5k", "start_timestamp": 1700010000},
            {"title": "QmFkIGRhdGU=", "start": "not a date", "end": "2023-11-15 00:13:20"},
            "garbage",
            {"title": 42, "start_timestamp": -5, "stop_timestamp": 10}
        ]}))
        .unwrap();
        let p = map_short_epg(listings.epg_listings.items, "f", 0, 10);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Millis");
        assert_eq!(p[0].start, "2023-11-14T23:13:20Z");
        assert_eq!(p[0].end, "2023-11-15T00:13:20Z");
    }

    #[test]
    fn short_epg_offset_applies_to_local_strings_only() {
        let listings: RawShortEpg = serde_json::from_value(json!({"epg_listings": [
            {"title": "TG9jYWw=", "start": "2023-11-15 01:00:00", "end": "2023-11-15 02:00:00"},
            {"title": "U3RhbXA=", "start": "2023-11-15 05:00:00", "end": "2023-11-15 06:00:00",
             "start_timestamp": 1700024400, "stop_timestamp": 1700028000}
        ]}))
        .unwrap();
        // Server two hours east of UTC: 01:00 local is 23:00 UTC the day before.
        let p = map_short_epg(listings.epg_listings.items, "f", 7200, 10);
        assert_eq!(p[0].title, "Local");
        assert_eq!(p[0].start, "2023-11-14T23:00:00Z");
        // Timestamps win over the local strings and ignore the offset.
        assert_eq!(p[1].title, "Stamp");
        assert_eq!(p[1].start, "2023-11-15T05:00:00Z");
        // A limit cuts after sorting.
        let one: RawShortEpg = serde_json::from_value(json!({"epg_listings": [
            {"title": "Qg==", "start_timestamp": 1700010000, "stop_timestamp": 1700013600},
            {"title": "QQ==", "start_timestamp": 1700000000, "stop_timestamp": 1700003600}
        ]}))
        .unwrap();
        let p = map_short_epg(one.epg_listings.items, "f", 0, 1);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "A");
    }

    #[test]
    fn short_epg_mapping() {
        let listings: RawShortEpg = serde_json::from_value(json!({"epg_listings": [
            {"epg_id": "bbc1.uk", "title": "U2Vjb25k", "description": "", "start_timestamp": "1700003600", "stop_timestamp": "1700007200"},
            {"title": "Rmlyc3Q=", "description": "RGVzYw==", "start": "2023-11-14 23:13:20", "end": "2023-11-15 00:13:20"},
            {"title": "", "start_timestamp": 1, "stop_timestamp": 2}
        ]}))
        .unwrap();
        let p = map_short_epg(listings.epg_listings.items, "fallback", 3600, 10);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].title, "First");
        assert_eq!(p[0].start, "2023-11-14T22:13:20Z");
        assert_eq!(p[0].channel_id, "fallback");
        assert_eq!(p[0].description.as_deref(), Some("Desc"));
        assert_eq!(p[1].title, "Second");
        assert_eq!(p[1].channel_id, "bbc1.uk");
        assert!(p[1].description.is_none());
    }

    #[test]
    fn live_extension_respects_allowed_formats() {
        assert_eq!(live_extension(StreamFormat::M3u8, &[]), "m3u8");
        assert_eq!(live_extension(StreamFormat::M3u8, &["ts".into()]), "ts");
        assert_eq!(
            live_extension(StreamFormat::Ts, &["m3u8".into(), "ts".into()]),
            "ts"
        );
        assert_eq!(
            live_extension(StreamFormat::Ts, &["rtmp".into(), "m3u8".into()]),
            "m3u8"
        );
        assert_eq!(
            live_extension(StreamFormat::M3u8, &["rtmp".into(), "ts".into()]),
            "ts"
        );
        assert_eq!(live_extension(StreamFormat::M3u8, &["rtmp".into()]), "rtmp");
    }

    #[test]
    fn trailers_and_cast() {
        assert_eq!(
            trailer_url(Some("dQw4w9WgXcQ")).as_deref(),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        );
        assert_eq!(
            trailer_url(Some("https://youtu.be/x")).as_deref(),
            Some("https://youtu.be/x")
        );
        assert_eq!(trailer_url(Some("  ")), None);
        let c = cast_list(Some("A, B,  a , C"));
        assert_eq!(
            c.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["A", "B", "C"]
        );
    }

    #[test]
    fn vod_detail_without_catalog_row() {
        let raw: RawVodInfo = serde_json::from_value(json!({
            "info": {"name": "Film (2019)", "plot": "P", "genre": "Drama / Thriller", "backdrop_path": ["http://x/b.jpg", "junk"],
                     "duration": "01:40:00", "rating": "7.25", "actors": "X, Y", "director": "Z", "youtube_trailer": "abc"},
            "movie_data": {"stream_id": 201, "container_extension": "mkv", "category_id": "10", "added": "1700000000"}
        }))
        .unwrap();
        let d = build_vod_detail(&r(ContentType::Movie, "201"), None, raw);
        assert_eq!(d.item.title, "Film (2019)");
        assert_eq!(d.item.year, Some(2019));
        assert_eq!(d.item.duration_seconds, Some(6000));
        assert_eq!(d.item.rating, Some(7.3));
        assert_eq!(d.item.container_extension.as_deref(), Some("mkv"));
        assert_eq!(d.item.genres, Some(vec!["Drama".into(), "Thriller".into()]));
        assert_eq!(d.backdrops, vec!["http://x/b.jpg"]);
        assert_eq!(d.cast.len(), 2);
        assert_eq!(d.director.as_deref(), Some("Z"));
        assert!(d.trailer_url.unwrap().ends_with("v=abc"));
    }

    #[test]
    fn seasons_from_episode_map() {
        let raw: RawSeriesInfo = serde_json::from_value(json!({
            "seasons": [{"season_number": 2, "name": "Season Two", "cover_big": "http://x/s2.jpg"},
                        {"season_number": 9, "name": "Empty"}],
            "info": {"name": "Show"},
            "episodes": {
                "2": [{"id": "3005", "episode_num": 2, "title": "B", "container_extension": "mp4", "info": []},
                      {"id": "3004", "episode_num": 1, "title": "", "info": {"duration_secs": 1500}}],
                "1": [{"id": "3001", "episode_num": "1", "title": "Pilot", "info": {"plot": "p"}},
                      {"id": "3001", "episode_num": 1, "title": "dup"}]
            }
        }))
        .unwrap();
        let seasons = build_seasons(&r(ContentType::Series, "301"), &raw);
        assert_eq!(seasons.len(), 2);
        assert_eq!(seasons[0].number, 1);
        assert_eq!(seasons[0].episodes.len(), 1);
        assert_eq!(seasons[1].name.as_deref(), Some("Season Two"));
        assert_eq!(seasons[1].poster_url.as_deref(), Some("http://x/s2.jpg"));
        assert_eq!(seasons[1].episodes[0].id, "3004");
        assert_eq!(seasons[1].episodes[0].title, "Episode 1");
        assert_eq!(seasons[1].episodes[0].duration_seconds, Some(1500));
        assert_eq!(
            seasons[1].episodes[1].container_extension.as_deref(),
            Some("mp4")
        );
    }

    #[test]
    fn test_messages_name_next_action() {
        assert!(test_message(&CoreError::Network("refused".into())).contains("try again"));
        // Already host-naming transport messages are not wrapped twice.
        let named = "Could not reach 127.0.0.1. Check the address and that the server is online, then try again. (refused)";
        assert_eq!(test_message(&CoreError::Network(named.into())), named);
        assert!(test_message(&CoreError::NotFound("x".into())).contains("server URL"));
    }

    /// Review R3-1: 503 and 429 showed a "server: " kind prefix (or a
    /// "Could not reach" wrapper) in Test connection.
    #[test]
    fn test_messages_have_no_kind_prefix() {
        use reqwest::StatusCode as S;
        for status in [S::SERVICE_UNAVAILABLE, S::BAD_GATEWAY, S::TOO_MANY_REQUESTS] {
            let err = crate::http::status_error(status, "Xtream account");
            let m = test_message(&err);
            assert!(m.starts_with("Xtream account: HTTP "), "{status}: {m}");
            assert!(
                !m.contains("server:") && !m.contains("Could not reach"),
                "{m}"
            );
        }
    }

    /// R2 r3 F3: without `timestamp_now`, `time_now` is converted with a
    /// fixed-offset zone and passed through verbatim (no offset, so never
    /// read as UTC or as the viewer's local time) with a named zone.
    #[test]
    fn server_time_without_timestamp() {
        let wall = || Some("2026-10-11 18:00:00".to_string());
        assert_eq!(
            server_time(Some(1_700_000_000), wall(), Some("Europe/Berlin")).as_deref(),
            Some("2023-11-14T22:13:20Z")
        );
        assert_eq!(
            server_time(None, wall(), Some("Europe/Berlin")).as_deref(),
            Some("2026-10-11 18:00:00")
        );
        assert_eq!(
            server_time(None, wall(), None).as_deref(),
            Some("2026-10-11 18:00:00")
        );
        assert_eq!(
            server_time(None, wall(), Some("UTC")).as_deref(),
            Some("2026-10-11T18:00:00Z")
        );
        assert_eq!(
            server_time(None, wall(), Some("+02:00")).as_deref(),
            Some("2026-10-11T16:00:00Z")
        );
        assert_eq!(
            server_time(None, wall(), Some("GMT-5")).as_deref(),
            Some("2026-10-11T23:00:00Z")
        );
        assert_eq!(
            server_time(None, wall(), Some("UTC+05:30")).as_deref(),
            Some("2026-10-11T12:30:00Z")
        );
        // POSIX sign: Etc/GMT-2 is two hours east of UTC.
        assert_eq!(
            server_time(None, wall(), Some("Etc/GMT-2")).as_deref(),
            Some("2026-10-11T16:00:00Z")
        );
        assert_eq!(server_time(None, Some("  ".into()), Some("UTC")), None);
        assert_eq!(
            server_time(None, Some("soon".into()), Some("UTC")).as_deref(),
            Some("soon")
        );
        assert_eq!(fixed_offset_seconds("America/New_York"), None);
        assert_eq!(fixed_offset_seconds("+0530"), Some(19_800));
        assert_eq!(fixed_offset_seconds("UTC+99"), None);
    }

    /// B8-parsers: provider timezones with multi-byte characters used to
    /// panic in `split_at(2)`; signed parts used to parse.
    #[test]
    fn fixed_offset_rejects_non_ascii_and_signed_parts() {
        for tz in [
            "UTC+1é1",
            "+1é1",
            "GMT-é",
            "UTC+٠٥٣٠",
            "UTC++5",
            "UTC+-5",
            "UTC+05:+3",
            "+🙂",
        ] {
            assert_eq!(fixed_offset_seconds(tz), None, "{tz}");
        }
        assert_eq!(fixed_offset_seconds("GMT-03:30"), Some(-12_600));
        let wall = Some("2026-10-11 18:00:00".to_string());
        assert_eq!(
            server_time(None, wall, Some("UTC+1é1")).as_deref(),
            Some("2026-10-11 18:00:00")
        );
    }

    /// B8-parsers: a garbage `archive_hours` in a stored row used to panic in
    /// `chrono::Duration::hours`.
    #[test]
    fn catchup_window_survives_absurd_archive_hours() {
        let now = chrono::Utc::now();
        let recent = now - chrono::Duration::hours(2);
        let ancient = now - chrono::Duration::days(500);
        for hours in [i64::MAX, i64::MAX / 3600 + 1, 1 << 40] {
            assert!(check_catchup_window(recent, now, Some(hours)).is_ok());
            let err = check_catchup_window(ancient, now, Some(hours)).unwrap_err();
            assert!(err.to_string().contains("366 days"), "{err}");
        }
        assert!(check_catchup_window(recent, now, Some(0)).is_err());
        assert!(check_catchup_window(recent, now, None).is_err());
        assert!(check_catchup_window(recent, now, Some(24)).is_ok());
        let err =
            check_catchup_window(now - chrono::Duration::hours(30), now, Some(24)).unwrap_err();
        assert!(err.to_string().contains("the last day"), "{err}");
    }
}
