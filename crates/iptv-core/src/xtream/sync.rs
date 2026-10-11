//! Catalog sync: account check, then live (+radio), movies, series one content
//! type at a time through `catalog::replace_catalog`, then the XMLTV link.
//!
//! Memory: each type's body is fetched as bytes, decoded into a
//! `Vec<RawItem>` on the blocking pool, the bytes dropped, and the Vec fed to
//! the writer as an iterator; nothing from the previous type is alive when the
//! next one is fetched.
//!
//! Failure policy: `Auth`, `Network` and `Timeout` (after retries) abort the
//! whole sync (the catalog of types not yet synced stays as it was). A type the
//! panel does not serve (`NotFound`, unreadable JSON) is skipped with a warning
//! and keeps its previous rows; the sync fails only if every requested type
//! failed.

use super::client::XtreamClient;
use super::meta::{self, added_to_rfc3339, year_from_date, ServerMeta};
use super::raw::{LenientVec, RawCategory, RawLive, RawSeries, RawVod};
use super::url::{clean_extension, is_xmltv_url_for, xmltv_url};
use crate::catalog::{self, CategoryRow, ItemRow};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, EpgLinks, ImportSummary, XtreamSourceConfig};
use crate::sources::progress;
use crate::state::AppState;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::Arc;

/// Progress is emitted at least this often while saving.
const PROGRESS_EVERY: u64 = 2000;

/// Which content types to sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncPlan {
    pub live: bool,
    pub movies: bool,
    pub series: bool,
}

impl SyncPlan {
    pub const ALL: Self = Self {
        live: true,
        movies: true,
        series: true,
    };

    /// From an rpc `contentTypes` filter (`None` or empty = everything;
    /// `radio` means live, since radio streams come from the live list).
    pub fn from_types(types: Option<&[ContentType]>) -> Self {
        match types {
            None | Some([]) => Self::ALL,
            Some(t) => Self {
                live: t.contains(&ContentType::Live) || t.contains(&ContentType::Radio),
                movies: t.contains(&ContentType::Movie),
                series: t.contains(&ContentType::Series),
            },
        }
    }
}

/// An xtream row of the `sources` table.
#[derive(Debug, Clone)]
pub struct XtreamSourceRow {
    pub id: String,
    pub name: String,
    pub config: XtreamSourceConfig,
    pub epg: EpgLinks,
}

/// Loads an xtream source; `NotFound` when missing, `Invalid` for other kinds.
pub fn load_source(conn: &Connection, id: &str) -> CoreResult<XtreamSourceRow> {
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT kind, name, config_json, epg_json FROM sources WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((kind, name, config_json, epg_json)) = row else {
        return Err(CoreError::not_found(format!(
            "Source {id} no longer exists."
        )));
    };
    if kind != "xtream" {
        return Err(CoreError::invalid(format!(
            "Source \"{name}\" is not an Xtream source."
        )));
    }
    let config: XtreamSourceConfig = serde_json::from_str(&config_json).map_err(|_| {
        CoreError::invalid(format!(
            "The Xtream settings of \"{name}\" are incomplete. Edit the source and save it again."
        ))
    })?;
    let epg = serde_json::from_str(&epg_json).unwrap_or_default();
    Ok(XtreamSourceRow {
        id: id.to_string(),
        name,
        config,
        epg,
    })
}

/// Runs a sync for one source, emitting `fetching` / `parsing` / `saving`
/// progress. It does not emit `done` / `error` or touch `last_refresh_at` /
/// `last_error`: `sources::run_import` (or `xtream.sync` for a subset) owns
/// the outcome.
pub async fn sync_source(
    state: Arc<AppState>,
    source_id: &str,
    cfg: &XtreamSourceConfig,
    plan: SyncPlan,
) -> CoreResult<ImportSummary> {
    let client = XtreamClient::new(state.http.clone(), cfg)?;
    tracing::info!(source_id, server = %client.server, user = %client.username, ?plan, "xtream sync start");
    progress(&state, source_id, "fetching", 0, None, Some("account"));
    let account = client.account().await?;
    let server_meta = ServerMeta::from_account(&account);
    let rt = meta::runtime(&state);
    {
        let rt = rt.clone();
        let sid = source_id.to_string();
        state
            .db_call(move |c| meta::store_meta(c, &rt, &sid, &server_meta))
            .await?;
    }

    let mut summary = ImportSummary::default();
    let mut first_err: Option<CoreError> = None;
    let mut attempted = 0;

    let steps: [(bool, Kind); 3] = [
        (plan.live, Kind::Live),
        (plan.movies, Kind::Movies),
        (plan.series, Kind::Series),
    ];
    for (enabled, kind) in steps {
        if !enabled {
            continue;
        }
        attempted += 1;
        match sync_kind(&state, &client, source_id, kind).await {
            Ok(n) => match kind {
                Kind::Live => summary.channels = n as i64,
                Kind::Movies => summary.movies = n as i64,
                Kind::Series => summary.series = n as i64,
            },
            Err(err)
                if matches!(
                    err,
                    CoreError::Auth(_) | CoreError::Network(_) | CoreError::Timeout(_)
                ) =>
            {
                return Err(err);
            }
            Err(err) => {
                tracing::warn!(source_id, kind = kind.label(), error = %err, "xtream content type skipped");
                progress(
                    &state,
                    source_id,
                    "parsing",
                    0,
                    None,
                    Some(&format!("{} skipped: {err}", kind.label())),
                );
                first_err.get_or_insert(err);
            }
        }
    }
    if attempted > 0 && summary == ImportSummary::default() {
        if let Some(err) = first_err {
            // Every requested type failed.
            return Err(err);
        }
    }

    // XMLTV link + caches.
    let xmltv = xmltv_url(&client.server, &client.username, client.password());
    let server = client.server.clone();
    let sid = source_id.to_string();
    state
        .db_call(move |c| add_detected_epg(c, &sid, &server, &xmltv))
        .await?;
    meta::invalidate_source(&rt, source_id);

    tracing::info!(
        source_id,
        channels = summary.channels,
        movies = summary.movies,
        series = summary.series,
        "xtream sync done"
    );
    Ok(summary)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Live,
    Movies,
    Series,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Live => "live",
            Kind::Movies => "movies",
            Kind::Series => "series",
        }
    }
    fn actions(self) -> (&'static str, &'static str) {
        match self {
            Kind::Live => ("get_live_categories", "get_live_streams"),
            Kind::Movies => ("get_vod_categories", "get_vod_streams"),
            Kind::Series => ("get_series_categories", "get_series"),
        }
    }
}

/// Fetches, parses and stores one content type. Returns the number of items
/// written (live includes radio).
async fn sync_kind(
    state: &Arc<AppState>,
    client: &XtreamClient,
    source_id: &str,
    kind: Kind,
) -> CoreResult<u64> {
    let (cat_action, list_action) = kind.actions();
    progress(state, source_id, "fetching", 0, None, Some(kind.label()));
    let (cats, list) = tokio::join!(
        client.get::<LenientVec<RawCategory>>(Some(cat_action), &[]),
        client.get_bytes(list_action),
    );
    let categories = match cats {
        Ok(c) => map_categories(c),
        // Categories are cosmetic; items still land under "Uncategorized".
        Err(err @ (CoreError::Auth(_) | CoreError::Network(_) | CoreError::Timeout(_))) => {
            return Err(err)
        }
        Err(err) => {
            tracing::warn!(source_id, action = cat_action, error = %err, "xtream categories unavailable");
            Vec::new()
        }
    };
    let bytes = list?;

    let state2 = state.clone();
    let sid = source_id.to_string();
    state
        .db_call(move |conn| {
            progress(&state2, &sid, "parsing", 0, None, Some(kind.label()));
            match kind {
                Kind::Live => {
                    let parsed: LenientVec<RawLive> =
                        super::client::decode(&bytes, "live streams")?;
                    drop(bytes);
                    log_skipped(&sid, kind, parsed.skipped);
                    let rows: Vec<ItemRow> = parsed
                        .items
                        .into_iter()
                        .enumerate()
                        .filter_map(|(i, r)| live_row(&sid, i as i64, r))
                        .collect();
                    let (radio, live): (Vec<ItemRow>, Vec<ItemRow>) =
                        rows.into_iter().partition(|r| r.is_radio);
                    let (live_cats, radio_cats) = split_categories(&categories, &live, &radio);
                    let total = (live.len() + radio.len()) as u64;
                    let mut done = 0u64;
                    let n_live = write(
                        conn,
                        &state2,
                        &sid,
                        ContentType::Live,
                        &live_cats,
                        live,
                        total,
                        &mut done,
                    )?;
                    let n_radio = write(
                        conn,
                        &state2,
                        &sid,
                        ContentType::Radio,
                        &radio_cats,
                        radio,
                        total,
                        &mut done,
                    )?;
                    Ok(n_live + n_radio)
                }
                Kind::Movies => {
                    let parsed: LenientVec<RawVod> = super::client::decode(&bytes, "movies")?;
                    drop(bytes);
                    log_skipped(&sid, kind, parsed.skipped);
                    let total = parsed.items.len() as u64;
                    let rows = parsed
                        .items
                        .into_iter()
                        .enumerate()
                        .filter_map(|(i, r)| vod_row(&sid, i as i64, r));
                    let mut done = 0;
                    write(
                        conn,
                        &state2,
                        &sid,
                        ContentType::Movie,
                        &categories,
                        rows,
                        total,
                        &mut done,
                    )
                }
                Kind::Series => {
                    let parsed: LenientVec<RawSeries> = super::client::decode(&bytes, "series")?;
                    drop(bytes);
                    log_skipped(&sid, kind, parsed.skipped);
                    let total = parsed.items.len() as u64;
                    let rows = parsed
                        .items
                        .into_iter()
                        .enumerate()
                        .filter_map(|(i, r)| series_row(&sid, i as i64, r));
                    let mut done = 0;
                    write(
                        conn,
                        &state2,
                        &sid,
                        ContentType::Series,
                        &categories,
                        rows,
                        total,
                        &mut done,
                    )
                }
            }
        })
        .await
}

fn log_skipped(source_id: &str, kind: Kind, skipped: usize) {
    if skipped > 0 {
        tracing::warn!(
            source_id,
            kind = kind.label(),
            skipped,
            "xtream entries could not be read and were skipped"
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn write(
    conn: &mut Connection,
    state: &AppState,
    source_id: &str,
    ct: ContentType,
    categories: &[CategoryRow],
    rows: impl IntoIterator<Item = ItemRow>,
    total: u64,
    done: &mut u64,
) -> CoreResult<u64> {
    let label = ct.as_str();
    let n = {
        let mut iter = rows.into_iter().inspect(|_| {
            *done += 1;
            if *done % PROGRESS_EVERY == 0 {
                progress(state, source_id, "saving", *done, Some(total), Some(label));
            }
        });
        catalog::replace_catalog(conn, source_id, ct, categories, &mut iter)?
    };
    progress(state, source_id, "saving", *done, Some(total), Some(label));
    Ok(n)
}

/// Adds the account's XMLTV URL to `epg.detectedUrls`, replacing stale
/// `xmltv.php` links of the same server (credentials changed).
pub fn add_detected_epg(
    conn: &Connection,
    source_id: &str,
    server: &str,
    xmltv: &str,
) -> CoreResult<()> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT epg_json FROM sources WHERE id = ?1",
            [source_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(()) };
    let mut links: EpgLinks = serde_json::from_str(&raw).unwrap_or_default();
    let before = links.detected_urls.clone();
    links
        .detected_urls
        .retain(|u| u == xmltv || !is_xmltv_url_for(u, server));
    if !links.detected_urls.iter().any(|u| u == xmltv) {
        links.detected_urls.push(xmltv.to_string());
    }
    if links.detected_urls != before {
        conn.execute(
            "UPDATE sources SET epg_json = ?1 WHERE id = ?2",
            rusqlite::params![serde_json::to_string(&links)?, source_id],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

/// Category id an item belongs to: `category_id`, else the first of `category_ids`.
fn item_category(category_id: Option<String>, category_ids: &[String]) -> String {
    category_id
        .or_else(|| category_ids.first().cloned())
        .unwrap_or_else(|| "0".to_string())
}

pub fn map_categories(raw: LenientVec<RawCategory>) -> Vec<CategoryRow> {
    let mut seen = HashSet::new();
    raw.items
        .into_iter()
        .filter_map(|c| {
            let id = c.category_id?;
            if !seen.insert(id.clone()) {
                return None;
            }
            let name = c.category_name.unwrap_or_else(|| format!("Category {id}"));
            Some((id, name))
        })
        .enumerate()
        .map(|(i, (category_id, name))| CategoryRow {
            category_id,
            name,
            position: i as i64,
        })
        .collect()
}

/// Live categories: declared ones not used only by radio. Radio categories:
/// declared ones used by radio items.
fn split_categories(
    all: &[CategoryRow],
    live: &[ItemRow],
    radio: &[ItemRow],
) -> (Vec<CategoryRow>, Vec<CategoryRow>) {
    if radio.is_empty() {
        return (all.to_vec(), Vec::new());
    }
    let live_ids: HashSet<&str> = live.iter().map(|r| r.category_id.as_str()).collect();
    let radio_ids: HashSet<&str> = radio.iter().map(|r| r.category_id.as_str()).collect();
    let live_cats = all
        .iter()
        .filter(|c| {
            live_ids.contains(c.category_id.as_str()) || !radio_ids.contains(c.category_id.as_str())
        })
        .cloned()
        .collect();
    let radio_cats = all
        .iter()
        .filter(|c| radio_ids.contains(c.category_id.as_str()))
        .cloned()
        .collect();
    (live_cats, radio_cats)
}

fn put(extra: &mut Map<String, Value>, key: &str, v: Option<impl Into<Value>>) {
    if let Some(v) = v {
        extra.insert(key.to_string(), v.into());
    }
}

fn clean_url(u: Option<String>) -> Option<String> {
    u.filter(|s| s.starts_with("http://") || s.starts_with("https://"))
}

/// Rating on a 0..10 scale: `rating`, else `rating_5based * 2`.
fn rating(r: Option<f64>, r5: Option<f64>) -> Option<f64> {
    r.filter(|v| *v > 0.0)
        .or_else(|| r5.filter(|v| *v > 0.0).map(|v| v * 2.0))
        .map(|v| (v.min(10.0) * 10.0).round() / 10.0)
}

fn split_genres(g: Option<&str>) -> Option<Value> {
    let v: Vec<Value> = g?
        .split([',', '/', '|'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
        .collect();
    (!v.is_empty()).then_some(Value::Array(v))
}

pub fn live_row(source_id: &str, position: i64, r: RawLive) -> Option<ItemRow> {
    let id = r.stream_id?;
    let is_radio = r.stream_type.as_deref().is_some_and(|t| {
        t.eq_ignore_ascii_case("radio_streams") || t.eq_ignore_ascii_case("radio")
    });
    let archive = r.tv_archive == Some(true);
    let days = r.tv_archive_duration.filter(|d| *d > 0);
    let mut extra = Map::new();
    put(&mut extra, "tvArchive", r.tv_archive.map(i64::from));
    put(&mut extra, "tvArchiveDuration", days);
    put(&mut extra, "isAdult", r.is_adult);
    put(&mut extra, "customSid", r.custom_sid);
    put(&mut extra, "streamType", r.stream_type);
    if r.category_ids.len() > 1 {
        extra.insert("categoryIds".into(), r.category_ids.clone().into());
    }
    let title = r.name.unwrap_or_else(|| format!("Channel {id}"));
    Some(ItemRow {
        source_id: source_id.to_string(),
        content_type: if is_radio {
            ContentType::Radio
        } else {
            ContentType::Live
        },
        category_id: item_category(r.category_id, &r.category_ids),
        title,
        number: r.num.filter(|n| *n > 0),
        logo_url: clean_url(r.stream_icon),
        added: added_to_rfc3339(r.added.as_deref()),
        epg_channel_id: r.epg_channel_id,
        is_radio,
        // Xtream reports archive depth in days; enabled archives with an
        // unknown depth get one day so the UI offers catch-up.
        archive_hours: archive.then(|| days.unwrap_or(1) * 24),
        extra: Value::Object(extra),
        position,
        item_id: id,
        ..ItemRow::default()
    })
}

pub fn vod_row(source_id: &str, position: i64, r: RawVod) -> Option<ItemRow> {
    let tmdb_id = r.tmdb_id();
    let id = r.stream_id?;
    let title = r.name.or(r.title).unwrap_or_else(|| format!("Movie {id}"));
    let mut extra = Map::new();
    put(&mut extra, "tmdbId", tmdb_id);
    put(&mut extra, "plot", r.plot);
    put(&mut extra, "genres", split_genres(r.genre.as_deref()));
    put(&mut extra, "isAdult", r.is_adult);
    if r.category_ids.len() > 1 {
        extra.insert("categoryIds".into(), r.category_ids.clone().into());
    }
    let poster = clean_url(r.stream_icon).or(clean_url(r.cover));
    Some(ItemRow {
        source_id: source_id.to_string(),
        content_type: ContentType::Movie,
        category_id: item_category(r.category_id, &r.category_ids),
        title,
        number: r.num.filter(|n| *n > 0),
        poster_url: poster,
        rating: rating(r.rating, r.rating_5based),
        added: added_to_rfc3339(r.added.as_deref()),
        year: r.year.filter(|y| (1900..=2100).contains(y)),
        container_extension: clean_extension(r.container_extension.as_deref()),
        extra: Value::Object(extra),
        position,
        item_id: id,
        ..ItemRow::default()
    })
}

pub fn series_row(source_id: &str, position: i64, r: RawSeries) -> Option<ItemRow> {
    let tmdb_id = r.tmdb_id();
    let release = r.release().map(str::to_owned);
    let id = r.series_id?;
    let title = r.name.or(r.title).unwrap_or_else(|| format!("Series {id}"));
    let mut extra = Map::new();
    put(&mut extra, "tmdbId", tmdb_id);
    put(&mut extra, "plot", r.plot);
    put(&mut extra, "genres", split_genres(r.genre.as_deref()));
    put(&mut extra, "isAdult", r.is_adult);
    if r.category_ids.len() > 1 {
        extra.insert("categoryIds".into(), r.category_ids.clone().into());
    }
    let year = r
        .year
        .filter(|y| (1900..=2100).contains(y))
        .or_else(|| year_from_date(release.as_deref()));
    Some(ItemRow {
        source_id: source_id.to_string(),
        content_type: ContentType::Series,
        category_id: item_category(r.category_id, &r.category_ids),
        title,
        number: r.num.filter(|n| *n > 0),
        poster_url: clean_url(r.cover),
        backdrop_url: r.backdrop_path.into_iter().find(|u| u.starts_with("http")),
        rating: rating(r.rating, r.rating_5based),
        added: added_to_rfc3339(r.last_modified.as_deref()),
        year,
        extra: Value::Object(extra),
        position,
        item_id: id,
        ..ItemRow::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn plan_from_types() {
        assert_eq!(SyncPlan::from_types(None), SyncPlan::ALL);
        assert_eq!(SyncPlan::from_types(Some(&[])), SyncPlan::ALL);
        let p = SyncPlan::from_types(Some(&[ContentType::Radio]));
        assert!(p.live && !p.movies && !p.series);
    }

    #[test]
    fn maps_live_rows() {
        let r: RawLive = parse(json!({
            "num": "7", "name": "BBC One", "stream_id": 101, "stream_icon": "http://x/l.png",
            "epg_channel_id": "bbc1.uk", "category_ids": [3, 4], "tv_archive": 1,
            "tv_archive_duration": "3", "added": "1700000000", "is_adult": 0
        }));
        let row = live_row("s", 0, r).unwrap();
        assert_eq!(row.item_id, "101");
        assert_eq!(row.category_id, "3");
        assert_eq!(row.number, Some(7));
        assert_eq!(row.archive_hours, Some(72));
        assert_eq!(row.added.as_deref(), Some("2023-11-14T22:13:20Z"));
        assert_eq!(row.extra["isAdult"], false);
        assert!(
            row.url.is_none(),
            "credentials must not be stored in items.url"
        );

        let radio: RawLive =
            parse(json!({"stream_id": "9", "stream_type": "radio_streams", "tv_archive": 1}));
        let row = live_row("s", 1, radio).unwrap();
        assert!(row.is_radio);
        assert_eq!(row.content_type, ContentType::Radio);
        assert_eq!(row.archive_hours, Some(24));
        assert_eq!(row.title, "Channel 9");
        assert_eq!(row.category_id, "0");

        assert!(live_row("s", 0, parse(json!({"name": "no id"}))).is_none());
    }

    #[test]
    fn maps_vod_and_series_rows() {
        let v: RawVod = parse(json!({
            "name": "Film (2019)", "stream_id": "201", "stream_icon": "http://x/p.jpg",
            "rating": "N/A", "rating_5based": "3.5", "category_id": 10, "container_extension": "MKV",
            "tmdb": "550", "added": "1700000000"
        }));
        let row = vod_row("s", 0, v).unwrap();
        assert_eq!(row.rating, Some(7.0));
        assert_eq!(row.container_extension.as_deref(), Some("mkv"));
        assert_eq!(row.extra["tmdbId"], 550);
        assert_eq!(row.category_id, "10");

        let s: RawSeries = parse(json!({
            "name": "Show", "series_id": 301, "cover": "http://x/c.jpg",
            "backdrop_path": "http://x/b.jpg", "releaseDate": "2018-03-01", "rating": "8.25",
            "genre": "Drama, Crime", "last_modified": "1700000000", "category_ids": ["5"]
        }));
        let row = series_row("s", 0, s).unwrap();
        assert_eq!(row.year, Some(2018));
        assert_eq!(row.backdrop_url.as_deref(), Some("http://x/b.jpg"));
        assert_eq!(row.rating, Some(8.3));
        assert_eq!(row.extra["genres"], json!(["Drama", "Crime"]));
        assert_eq!(row.category_id, "5");
    }

    #[test]
    fn categories_dedupe_and_split() {
        let cats = map_categories(parse(json!([
            {"category_id": "1", "category_name": "News"},
            {"category_id": 1, "category_name": "Dup"},
            {"category_id": "2", "category_name": "Radio"},
            {"category_name": "no id"}
        ])));
        assert_eq!(cats.len(), 2);
        assert_eq!(cats[1].position, 1);
        let live = vec![ItemRow {
            category_id: "1".into(),
            ..ItemRow::default()
        }];
        let radio = vec![ItemRow {
            category_id: "2".into(),
            is_radio: true,
            ..ItemRow::default()
        }];
        let (l, r) = split_categories(&cats, &live, &radio);
        assert_eq!(l.len(), 1);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name, "Radio");
    }
}
