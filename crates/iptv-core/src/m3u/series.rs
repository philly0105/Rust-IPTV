//! M3U series grouping. A playlist lists every episode as an entry of its
//! own; Xtream `get.php?type=m3u_plus` lists name them `Show S01 E02` and
//! point them at `/series/` URLs. The importer holds episodes back
//! ([`SeriesGrouper`]) and writes one series row per show and group when the
//! playlist ends, with the episodes in the row's `extra.episodes`
//! ([`StoredEpisode`]). `m3u.seriesDetail` and `m3u.streamUrl` read them
//! back. See docs/architecture/m3u.md ("Series").

use super::importer::{hash16, url_path_lower};
use super::parser::{url_extension, M3uEntry};
use crate::catalog::{self, ItemRow};
use crate::error::{CoreError, CoreResult};
use crate::model::{
    ContentType, Episode, ItemRef, PlayerKind, PlayerSource, RequestHeaders, Season, SeriesDetail,
};
use crate::state::AppState;
use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

/// `S01E02`, `S1 E2`, `s01.e02`, `S01-E02`, `S01 Ep 02`.
static SXE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|[^\p{L}\p{N}])(?P<m>[sS](?P<s>[0-9]{1,3})[ ._-]*[eE](?:[pP][ .]?)?(?P<e>[0-9]{1,4}))(?:[^0-9]|$)").unwrap()
});
/// `1x02`, `10x115` (two or three episode digits, so `4x4` stays a title).
static NXN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|[^\p{L}\p{N}])(?P<m>(?P<s>[0-9]{1,2})[xX](?P<e>[0-9]{2,3}))(?:[^\p{L}\p{N}]|$)").unwrap()
});
/// `Season 1 Episode 2`, `season 1, episode 2`.
static WORDS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:^|[^\p{L}\p{N}])(?P<m>season\s*(?P<s>[0-9]{1,3})[\s,.:-]{0,3}episode\s*(?P<e>[0-9]{1,4}))(?:[^0-9]|$)").unwrap()
});

/// An episode marker found in a title: byte range of the marker, season and
/// episode numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Marker {
    pub start: usize,
    pub end: usize,
    pub season: i64,
    pub episode: i64,
}

fn marker_of(c: &Captures<'_>) -> Option<Marker> {
    let m = c.name("m")?;
    Some(Marker {
        start: m.start(),
        end: m.end(),
        season: c.name("s")?.as_str().parse().ok()?,
        episode: c.name("e")?.as_str().parse().ok()?,
    })
}

/// The episode marker of `title` (`S01E02`, then `1x02`, then `Season 1
/// Episode 2`), if any.
pub fn marker(title: &str) -> Option<Marker> {
    [&SXE, &NXN, &WORDS]
        .into_iter()
        .find_map(|re| re.captures(title).and_then(|c| marker_of(&c)))
}

/// An entry recognised as an episode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    /// The show's title as the playlist writes it (`EN - Dark (2017)`).
    pub show: String,
    /// Season and episode from the title; `None` for a `/series/` URL whose
    /// title has no marker (numbered in playlist order).
    pub numbers: Option<(i64, i64)>,
    /// The title after the marker, or the whole entry name when nothing follows.
    pub title: String,
}

/// Separators a show title ends with before the marker (`Dark - S01E02`).
const SHOW_END: &[char] = &['-', '–', '—', ':', '|', '.', ',', '_', '(', '[', '#'];
/// Separators an episode title starts with after the marker (`S01E02 - Lies`).
const REST_START: &[char] = &['-', '–', '—', ':', '|', '.', ',', '_', ')', ']'];

/// The show title before a marker, without trailing separators.
fn clean_show(s: &str) -> String {
    s.trim_end_matches(|c: char| c.is_whitespace() || SHOW_END.contains(&c))
        .trim_start()
        .to_string()
}

/// The episode title after a marker, without leading separators.
fn clean_rest(s: &str) -> &str {
    s.trim_start_matches(|c: char| c.is_whitespace() || REST_START.contains(&c))
        .trim_end()
}

/// Whether `e` is a series episode: an Xtream `/series/` URL, or a title with
/// an episode marker. Only entries [`super::classify`] calls movies are asked,
/// so live channels and radio never become episodes.
pub fn detect(e: &M3uEntry) -> Option<Detected> {
    let found = marker(&e.name);
    if found.is_none() && !url_path_lower(&e.url).contains("/series/") {
        return None;
    }
    let name = e.name.trim();
    let Some(m) = found else {
        return Some(Detected {
            show: name.to_string(),
            numbers: None,
            title: name.to_string(),
        });
    };
    let rest = clean_rest(&e.name[m.end..]);
    let mut show = clean_show(&e.name[..m.start]);
    if show.is_empty() {
        // `S01E02 - Pilot`: the show is in tvg-name (before its own marker,
        // when it has one) or, failing that, the group. A tvg-name that only
        // repeats the episode title does not name the show.
        show = e
            .tvg_name
            .as_deref()
            .map(|t| clean_show(marker(t).map_or(t, |tm| &t[..tm.start])))
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case(rest))
            .or_else(|| {
                e.group
                    .as_deref()
                    .map(str::trim)
                    .filter(|g| !g.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| name.to_string());
    }
    Some(Detected {
        show,
        numbers: Some((m.season, m.episode)),
        title: if rest.is_empty() {
            name.to_string()
        } else {
            rest.to_string()
        },
    })
}

/// One episode in a series row's `extra.episodes`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEpisode {
    pub id: String,
    pub season: i64,
    pub episode: i64,
    pub title: String,
    pub url: String,
    /// Only when it differs from the series poster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_extension: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
    /// Per-entry headers (`#EXTVLCOPT`, `url|User-Agent=`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<RequestHeaders>,
}

/// State saved on an episode that an import before series grouping stored as
/// a movie row, and where it goes now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyEpisode {
    /// The movie id earlier imports gave the entry: the one it would have
    /// now, or, when its URL changed since, the one of the old row with its
    /// identity (see `RowBuilder::keep_legacy`).
    pub movie_id: String,
    pub series_id: String,
    pub episode_id: String,
    pub series_title: String,
    /// `S01E02 · Title`, as the player subtitles an episode.
    pub subtitle: String,
}

/// The player's subtitle of an episode (`S01E02 · Title`), as Xtream's.
pub fn episode_subtitle(season: i64, episode: i64, title: &str) -> String {
    format!("S{season:02}E{episode:02} · {title}")
}

struct Show {
    id: String,
    title: String,
    title_base: String,
    year: Option<i64>,
    category_id: String,
    poster_url: Option<String>,
    position: i64,
    /// Ids are set by [`SeriesGrouper::into_rows`] ([`episode_ids`]).
    episodes: Vec<StoredEpisode>,
    /// `(id seed, entry name)` of each episode, in episode order.
    id_seeds: Vec<(String, String)>,
    /// `(old movie id, index in episodes)` for entries with saved state.
    legacy: Vec<(String, usize)>,
    /// Episodes without numbers so far (they are numbered in playlist order).
    unnumbered: i64,
}

/// Collects the episodes of one import, one show per group and title.
#[derive(Default)]
pub struct SeriesGrouper {
    index: HashMap<String, usize>,
    shows: Vec<Show>,
}

/// Where [`SeriesGrouper::add`] put an episode, for [`SeriesGrouper::adopt`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpisodeAt {
    show: usize,
    episode: usize,
}

/// Grouping key of a show: its group plus the normalized base title, the
/// country tags of `show` and its year, so `EN - Dark (2017)` and
/// `Dark (2017)` in one group are one show, and `The Office [US]` and
/// `The Office [UK]` two (`[US]` keys like `(US)`, which `title_base` keeps).
fn show_key(category_id: &str, show: &str, base: &str, year: Option<i64>) -> String {
    let mut norm = base
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    for tag in catalog::country_tags(show) {
        norm.push_str(" (");
        norm.push_str(&tag.to_lowercase());
        norm.push(')');
    }
    format!("{category_id}\u{1}{norm}\u{1}{}", year.unwrap_or(0))
}

/// The ids of a show's episodes from their `(seed, entry name)`, in the same
/// order. Not the URL: a provider that rotates tokens keeps the ids, so
/// positions and downloads stay attached. The seed is the series id with
/// `S<n>E<n>` (or the entry name when there is no marker). An episode alone
/// with its seed has the seed's hash. Versions of one episode are told apart
/// by name, not by playlist order, so a playlist that reorders them keeps
/// each version's id: in name order the first has the seed's hash, the
/// others hash their name with it, and a repeated name adds `#2`, `#3` in
/// playlist order.
fn episode_ids(seeds: &[(String, String)]) -> Vec<String> {
    let mut order: Vec<&str> = Vec::new();
    let mut groups: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, (seed, _)) in seeds.iter().enumerate() {
        let members = groups.entry(seed.as_str()).or_default();
        if members.is_empty() {
            order.push(seed.as_str());
        }
        members.push(i);
    }
    let mut ids = vec![String::new(); seeds.len()];
    let mut used: HashSet<String> = HashSet::new();
    for seed in order {
        let mut members = groups.remove(seed).unwrap_or_default();
        members.sort_by_key(|i| &seeds[*i].1);
        let first = members.first().map(|i| seeds[*i].1.as_str());
        for i in members {
            let name = seeds[i].1.as_str();
            let own = if first == Some(name) {
                seed.to_string()
            } else {
                format!("{seed}\n{name}")
            };
            let mut id = hash16(&own);
            let mut n = 2u32;
            while used.contains(&id) {
                id = hash16(&format!("{own}\n#{n}"));
                n += 1;
            }
            used.insert(id.clone());
            ids[i] = id;
        }
    }
    ids
}

impl SeriesGrouper {
    /// Adds episode `e` of group `category_id`. `legacy_id` is the movie id of
    /// the entry when user state refers to it. Returns true when the entry
    /// started a new show, which then takes playlist position `position`, and
    /// where the episode went.
    pub fn add(
        &mut self,
        category_id: String,
        position: i64,
        found: Detected,
        e: M3uEntry,
        legacy_id: Option<String>,
    ) -> (bool, EpisodeAt) {
        let (base, year) = catalog::title_base(&found.show);
        let key = show_key(&category_id, &found.show, &base, year);
        let existing = self.index.get(&key).copied();
        let started = existing.is_none();
        let at = match existing {
            Some(i) => i,
            None => {
                self.shows.push(Show {
                    id: hash16(&format!("series\n{key}")),
                    title: found.show.clone(),
                    title_base: base,
                    year,
                    category_id,
                    poster_url: None,
                    position,
                    episodes: Vec::new(),
                    id_seeds: Vec::new(),
                    legacy: Vec::new(),
                    unnumbered: 0,
                });
                self.index.insert(key, self.shows.len() - 1);
                self.shows.len() - 1
            }
        };
        let show = &mut self.shows[at];
        let (season, episode) = match found.numbers {
            Some(n) => n,
            None => {
                show.unnumbered += 1;
                (1, show.unnumbered)
            }
        };
        let seed = match found.numbers {
            Some((s, n)) => format!("{}\nS{s}E{n}", show.id),
            None => format!("{}\n{}", show.id, e.name),
        };
        let added = EpisodeAt {
            show: at,
            episode: show.episodes.len(),
        };
        show.id_seeds.push((seed, e.name));
        if show.poster_url.is_none() {
            show.poster_url = e.tvg_logo.clone();
        }
        let poster_url = e
            .tvg_logo
            .filter(|p| show.poster_url.as_deref() != Some(p.as_str()));
        let headers = RequestHeaders {
            user_agent: e.user_agent,
            referrer: e.referrer,
            origin: e.origin,
        };
        if let Some(old) = legacy_id {
            show.legacy.push((old, added.episode));
        }
        show.episodes.push(StoredEpisode {
            id: String::new(),
            season,
            episode,
            title: found.title,
            container_extension: url_extension(&e.url),
            url: e.url,
            poster_url,
            duration_seconds: e
                .duration
                .filter(|d| d.is_finite() && *d >= 1.0)
                .map(|d| d.min(1e9) as i64),
            headers: (!headers.is_empty()).then_some(headers),
        });
        (started, added)
    }

    /// Gives the episode at `at` the state saved on old movie row `movie_id`
    /// (an episode matched to that row once the whole playlist is known).
    pub fn adopt(&mut self, at: EpisodeAt, movie_id: String) {
        if let Some(show) = self.shows.get_mut(at.show) {
            show.legacy.push((movie_id, at.episode));
        }
    }

    /// One series row per show, in first-seen order, and the movie ids whose
    /// state moves to an episode.
    pub fn into_rows(self, source_id: &str) -> (Vec<ItemRow>, Vec<LegacyEpisode>) {
        let mut rows = Vec::with_capacity(self.shows.len());
        let mut legacy = Vec::new();
        for mut show in self.shows {
            let ids = episode_ids(&show.id_seeds);
            for (ep, id) in show.episodes.iter_mut().zip(ids) {
                ep.id = id;
            }
            for (movie_id, i) in &show.legacy {
                let ep = &show.episodes[*i];
                legacy.push(LegacyEpisode {
                    movie_id: movie_id.clone(),
                    series_id: show.id.clone(),
                    episode_id: ep.id.clone(),
                    series_title: show.title.clone(),
                    subtitle: episode_subtitle(ep.season, ep.episode, &ep.title),
                });
            }
            let mut extra = serde_json::Map::new();
            extra.insert(
                "episodes".into(),
                serde_json::to_value(&show.episodes).unwrap_or_default(),
            );
            rows.push(ItemRow {
                source_id: source_id.to_string(),
                content_type: ContentType::Series,
                item_id: show.id,
                category_id: show.category_id,
                title: show.title,
                title_base: Some(show.title_base),
                year: show.year,
                poster_url: show.poster_url,
                extra: serde_json::Value::Object(extra),
                position: show.position,
                ..ItemRow::default()
            });
        }
        (rows, legacy)
    }
}

/// The episodes stored in a series row (empty for rows without them: Xtream
/// series, rows from older imports).
pub fn stored_episodes(extra: &serde_json::Value) -> Vec<StoredEpisode> {
    extra
        .get("episodes")
        .and_then(|v| Vec::<StoredEpisode>::deserialize(v).ok())
        .unwrap_or_default()
}

/// Seasons in number order, episodes in episode order (playlist order on a
/// tie), as `xtream::service::build_seasons` shapes them.
pub fn seasons(r: &ItemRef, episodes: &[StoredEpisode]) -> Vec<Season> {
    let mut by_season: BTreeMap<i64, Vec<Episode>> = BTreeMap::new();
    for ep in episodes {
        by_season.entry(ep.season).or_default().push(Episode {
            id: ep.id.clone(),
            series_ref: r.clone(),
            season: ep.season,
            episode: ep.episode,
            title: ep.title.clone(),
            plot: None,
            duration_seconds: ep.duration_seconds,
            poster_url: ep.poster_url.clone(),
            container_extension: ep.container_extension.clone(),
            added: None,
        });
    }
    by_season
        .into_iter()
        .map(|(number, mut eps)| {
            eps.sort_by_key(|e| e.episode);
            Season {
                number,
                name: None,
                poster_url: None,
                episodes: eps,
            }
        })
        .collect()
}

fn expect_series(r: &ItemRef, what: &str) -> CoreResult<()> {
    if r.content_type == ContentType::Series {
        Ok(())
    } else {
        Err(CoreError::invalid(format!(
            "{what} needs a series item, got {}.",
            r.content_type
        )))
    }
}

async fn series_row(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<catalog::NamedRow> {
    let key = r.clone();
    state
        .db_call(move |c| catalog::get_named(c, &key))
        .await?
        .ok_or_else(|| {
            CoreError::not_found(
                "This series is no longer in the playlist. Refresh the source and try again.",
            )
        })
}

/// `m3u.seriesDetail`: the catalog row with the seasons stored by the
/// importer. Playlists carry no cast, plot or trailer.
pub async fn series_detail(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<SeriesDetail> {
    expect_series(r, "m3u.seriesDetail")?;
    let named = series_row(state, r).await?;
    let episodes = stored_episodes(&named.row.extra);
    Ok(SeriesDetail {
        seasons: seasons(r, &episodes),
        item: named.into_series(),
        cast: Vec::new(),
        director: None,
        trailer_url: None,
        backdrops: Vec::new(),
        provider_details_unavailable: false,
        provider_error: None,
    })
}

/// Player kind of a playlist URL, by its extension.
fn kind_of(url: &str) -> PlayerKind {
    match url_extension(url).as_deref() {
        Some("m3u8" | "m3u") => PlayerKind::Hls,
        Some("mpd") => PlayerKind::Dash,
        _ => PlayerKind::Direct,
    }
}

/// The first non-blank value.
fn pick(a: Option<String>, b: Option<String>) -> Option<String> {
    a.filter(|v| !v.trim().is_empty())
        .or_else(|| b.filter(|v| !v.trim().is_empty()))
}

/// `m3u.streamUrl`: episode `episode_id` of series `r`, with the playlist's
/// headers and the entry's own over them, field by field (as the UI merges
/// them for channels).
pub async fn stream_url(
    state: &Arc<AppState>,
    r: &ItemRef,
    episode_id: Option<&str>,
) -> CoreResult<PlayerSource> {
    expect_series(r, "m3u.streamUrl")?;
    let Some(ep_id) = episode_id.map(str::trim).filter(|e| !e.is_empty()) else {
        return Err(CoreError::invalid("Choose an episode to play."));
    };
    let named = series_row(state, r).await?;
    let Some(ep) = stored_episodes(&named.row.extra)
        .into_iter()
        .find(|e| e.id == ep_id)
    else {
        return Err(CoreError::not_found(
            "This episode is no longer in the playlist. Refresh the source and try again.",
        ));
    };
    let base = crate::sources::get(state, &r.source_id)
        .await
        .ok()
        .and_then(|s| s.m3u)
        .map(|m| m.headers)
        .unwrap_or_default();
    let own = ep.headers.clone().unwrap_or_default();
    let headers = RequestHeaders {
        user_agent: pick(own.user_agent, base.user_agent),
        referrer: pick(own.referrer, base.referrer),
        origin: pick(own.origin, base.origin),
    };
    Ok(PlayerSource {
        kind: kind_of(&ep.url),
        headers: (!headers.is_empty()).then_some(headers),
        title: named.row.title.clone(),
        subtitle: Some(episode_subtitle(ep.season, ep.episode, &ep.title)),
        poster_url: ep.poster_url.or(named.row.poster_url),
        item_ref: Some(r.clone()),
        episode_id: Some(ep_id.to_string()),
        resume_seconds: None,
        is_live: false,
        is_radio: false,
        url: ep.url,
    })
}

/// Tables whose movie rows [`adopt_movie_state`] moves (`item_id` column).
const MOVIE_STATE_TABLES: [&str; 6] = [
    "playback_positions",
    "favorites",
    "recent",
    "watchlist",
    "downloads",
    "watch_log",
];

/// Movie ids of the source that user state refers to. Read inside the import
/// transaction, before the rows are written, so the grouper only remembers
/// the episodes that need [`adopt_movie_state`].
pub(crate) fn referenced_movie_ids(
    conn: &Connection,
    source_id: &str,
) -> CoreResult<HashSet<String>> {
    let mut out = HashSet::new();
    for table in MOVIE_STATE_TABLES {
        let mut stmt = conn.prepare(&format!(
            "SELECT DISTINCT item_id FROM {table} WHERE source_id = ?1 AND content_type = 'movie'"
        ))?;
        for id in stmt.query_map([source_id], |r| r.get::<_, String>(0))? {
            out.insert(id?);
        }
    }
    let mut stmt = conn.prepare(
        "SELECT DISTINCT target_id FROM parental_locks WHERE source_id = ?1 AND content_type = 'movie' AND kind = 'item'",
    )?;
    for id in stmt.query_map([source_id], |r| r.get::<_, String>(0))? {
        out.insert(id?);
    }
    Ok(out)
}

/// A snapshot rewritten for a series: its title, and `subtitle` (?6, or none
/// when NULL). Invalid or non-object snapshots stay as they are.
const SNAPSHOT_SQL: &str = "CASE WHEN json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'
     THEN CASE WHEN ?6 IS NULL
          THEN json_remove(json_set(snapshot_json, '$.contentType', 'series', '$.title', ?5), '$.subtitle')
          ELSE json_set(snapshot_json, '$.contentType', 'series', '$.title', ?5, '$.subtitle', ?6) END
     ELSE snapshot_json END";

/// Moves user state saved on episodes that earlier imports stored as movies
/// to the series and episode they belong to now, inside the import
/// transaction: positions and watched marks become episode rows, favorites,
/// recent, My List and parental item locks point at the series, downloads at
/// the episode, and watch stats add up under the series. Where the series
/// already has a row (two favorited episodes of one show), the series row
/// stays and the movie row goes, except downloads, which keep their file and
/// stay as they were. Returns the number of episodes moved.
pub(crate) fn adopt_movie_state(
    conn: &Connection,
    source_id: &str,
    legacy: &[LegacyEpisode],
) -> CoreResult<usize> {
    let no_subtitle: Option<String> = None;
    for l in legacy {
        let p = params![
            source_id,
            l.movie_id,
            l.series_id,
            l.episode_id,
            l.series_title,
            l.subtitle
        ];
        conn.prepare_cached(&format!(
            "UPDATE OR IGNORE playback_positions SET content_type = 'series', item_id = ?3, episode_id = ?4,
               snapshot_json = {SNAPSHOT_SQL}
             WHERE source_id = ?1 AND content_type = 'movie' AND item_id = ?2 AND episode_id = ''"
        ))?
        .execute(p)?;
        // Series-level rows: the episode subtitle (?6) is not theirs.
        let series_only = params![
            source_id,
            l.movie_id,
            l.series_id,
            l.episode_id,
            l.series_title,
            no_subtitle
        ];
        conn.prepare_cached(&format!(
            "UPDATE OR IGNORE favorites SET content_type = 'series', item_id = ?3,
               snapshot_json = {SNAPSHOT_SQL}
             WHERE source_id = ?1 AND content_type = 'movie' AND item_id = ?2"
        ))?
        .execute(series_only)?;
        // History keeps the show's newest view, whichever episode it was.
        conn.prepare_cached(&format!(
            "INSERT INTO recent (source_id, content_type, item_id, viewed_at, snapshot_json)
               SELECT source_id, 'series', ?3, viewed_at, {SNAPSHOT_SQL} FROM recent
               WHERE source_id = ?1 AND content_type = 'movie' AND item_id = ?2
             ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
               viewed_at = excluded.viewed_at, snapshot_json = excluded.snapshot_json
               WHERE COALESCE(julianday(excluded.viewed_at) > julianday(recent.viewed_at),
                              excluded.viewed_at > recent.viewed_at)"
        ))?
        .execute(series_only)?;
        conn.prepare_cached(
            "UPDATE OR IGNORE watchlist SET content_type = 'series', item_id = ?3, title = ?4, subtitle = NULL
             WHERE source_id = ?1 AND content_type = 'movie' AND item_id = ?2",
        )?
        .execute(params![source_id, l.movie_id, l.series_id, l.series_title])?;
        conn.prepare_cached(
            "UPDATE OR IGNORE downloads SET content_type = 'series', item_id = ?3, episode_id = ?4,
               title = ?5, subtitle = ?6
             WHERE source_id = ?1 AND content_type = 'movie' AND item_id = ?2 AND episode_id = ''",
        )?
        .execute(p)?;
        conn.prepare_cached(
            "INSERT INTO watch_log (day, source_id, content_type, item_id, title, poster_url, seconds, last_at)
               SELECT day, source_id, 'series', ?3, ?4, poster_url, seconds, last_at FROM watch_log
               WHERE source_id = ?1 AND content_type = 'movie' AND item_id = ?2
             ON CONFLICT(day, source_id, content_type, item_id)
               DO UPDATE SET seconds = seconds + excluded.seconds, last_at = max(last_at, excluded.last_at)",
        )?
        .execute(params![source_id, l.movie_id, l.series_id, l.series_title])?;
        conn.prepare_cached(
            "UPDATE OR IGNORE parental_locks SET content_type = 'series', target_id = ?3
             WHERE source_id = ?1 AND content_type = 'movie' AND kind = 'item' AND target_id = ?2",
        )?
        .execute(params![source_id, l.movie_id, l.series_id])?;
        // Rows the series already had: the movie copy is redundant now.
        for (table, col, filter) in [
            ("playback_positions", "item_id", ""),
            ("favorites", "item_id", ""),
            ("recent", "item_id", ""),
            ("watchlist", "item_id", ""),
            ("watch_log", "item_id", ""),
            ("parental_locks", "target_id", " AND kind = 'item'"),
        ] {
            conn.prepare_cached(&format!(
                "DELETE FROM {table} WHERE source_id = ?1 AND content_type = 'movie' AND {col} = ?2{filter}"
            ))?
            .execute(params![source_id, l.movie_id])?;
        }
    }
    // Episodes that arrive watched can complete their series: it gets the
    // mark `watched::sync_series_mark` sets after an episode write.
    let mut series_ids: Vec<&str> = legacy.iter().map(|l| l.series_id.as_str()).collect();
    series_ids.sort_unstable();
    series_ids.dedup();
    for series_id in series_ids {
        mark_if_complete(conn, source_id, series_id)?;
    }
    if !legacy.is_empty() {
        tracing::info!(
            source_id,
            moved = legacy.len(),
            "m3u episodes imported as movies before; their saved state moved to the series"
        );
    }
    Ok(legacy.len())
}

/// Sets the series-level watched mark of `series_id` when it is missing and
/// every episode the series row lists has a watched episode row.
fn mark_if_complete(conn: &Connection, source_id: &str, series_id: &str) -> CoreResult<()> {
    let r = ItemRef::new(source_id, ContentType::Series, series_id);
    let marked = crate::userstate::watched::watched_contains(conn, std::slice::from_ref(&r))?;
    if !marked.is_empty() {
        return Ok(());
    }
    let extra: Option<String> = conn
        .query_row(
            "SELECT extra_json FROM items WHERE source_id = ?1 AND content_type = 'series' AND item_id = ?2",
            params![source_id, series_id],
            |row| row.get(0),
        )
        .optional()?;
    let episodes = extra
        .and_then(|x| serde_json::from_str::<serde_json::Value>(&x).ok())
        .map(|x| stored_episodes(&x))
        .unwrap_or_default();
    if episodes.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare_cached(
        "SELECT episode_id FROM playback_positions
         WHERE source_id = ?1 AND content_type = 'series' AND item_id = ?2 AND episode_id <> '' AND watched = 1",
    )?;
    let watched = stmt
        .query_map([source_id, series_id], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    if episodes.iter().all(|e| watched.contains(&e.id)) {
        crate::userstate::set_watched(conn, &r, None, true)?;
    }
    Ok(())
}

/// Category ids of one source and content type that match `filter` (SQL).
fn category_ids(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    filter: &str,
) -> CoreResult<HashSet<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT category_id FROM categories WHERE source_id = ?1 AND content_type = ?2{filter}"
    ))?;
    let ct = content_type.as_str();
    let ids = stmt
        .query_map(params![source_id, ct], |r| r.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(ids)
}

/// Group settings that follow a group's episodes from Movies to Series. A
/// series category has the id of its group, like the movie category the
/// episodes sat in before grouping, but parental locks and hidden flags are
/// stored per content type. So the import that first writes a series
/// category gives it the hidden flag and the category lock of the movie
/// category with the same id. Later imports leave it alone: a series group
/// the user has unhidden or unlocked since stays that way.
pub(crate) struct GroupCarry {
    /// Movie categories hidden before the import.
    movie_hidden: HashSet<String>,
    /// Series categories that existed before the import.
    series_before: HashSet<String>,
}

impl GroupCarry {
    /// Read inside the import transaction, before the catalog writer deletes
    /// the categories.
    pub(crate) fn before(conn: &Connection, source_id: &str) -> CoreResult<Self> {
        Ok(Self {
            movie_hidden: category_ids(conn, source_id, ContentType::Movie, " AND hidden = 1")?,
            series_before: category_ids(conn, source_id, ContentType::Series, "")?,
        })
    }

    /// Copies the hidden flag and the parental category lock of each movie
    /// group to the series category of the same id when this import created
    /// it (`series`: the series categories just written). Returns how many
    /// series categories got either.
    pub(crate) fn carry_over(
        &self,
        conn: &Connection,
        source_id: &str,
        series: &[catalog::CategoryRow],
    ) -> CoreResult<usize> {
        let mut set_hidden = conn.prepare_cached(
            "UPDATE categories SET hidden = 1
             WHERE source_id = ?1 AND content_type = 'series' AND category_id = ?2",
        )?;
        let mut copy_lock = conn.prepare_cached(
            "INSERT OR IGNORE INTO parental_locks (source_id, content_type, kind, target_id, name, created_at)
             SELECT source_id, 'series', kind, target_id, name, created_at FROM parental_locks
             WHERE source_id = ?1 AND content_type = 'movie' AND kind = 'category' AND target_id = ?2",
        )?;
        let mut carried = 0;
        for c in series {
            if self.series_before.contains(&c.category_id) {
                continue;
            }
            let mut changed = copy_lock.execute(params![source_id, c.category_id])?;
            if self.movie_hidden.contains(&c.category_id) {
                changed += set_hidden.execute(params![source_id, c.category_id])?;
            }
            if changed > 0 {
                carried += 1;
            }
        }
        if carried > 0 {
            tracing::info!(
                source_id,
                carried,
                "m3u groups that became series kept their hidden flag or parental lock"
            );
        }
        Ok(carried)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::m3u::parse_str;

    fn entry(text: &str) -> M3uEntry {
        parse_str(&format!("#EXTM3U\n{text}\n")).0.remove(0)
    }

    #[test]
    fn finds_episode_markers() {
        let m = marker("Dark S01E02").unwrap();
        assert_eq!((m.season, m.episode), (1, 2));
        assert_eq!(&"Dark S01E02"[m.start..m.end], "S01E02");
        for (title, want) in [
            ("Dark S01 E02", (1, 2)),
            ("Dark s1.e2", (1, 2)),
            ("Dark S01 Ep 03", (1, 3)),
            ("Dark - S02-E10 - Title", (2, 10)),
            ("Dark 1x02", (1, 2)),
            ("Dark 10x115 Finale", (10, 115)),
            ("Dark Season 3 Episode 4", (3, 4)),
            ("The Show S00E01 Special", (0, 1)),
            ("Show S01E01E02", (1, 1)),
        ] {
            let m = marker(title).unwrap_or_else(|| panic!("{title}"));
            assert_eq!((m.season, m.episode), want, "{title}");
        }
        for title in [
            "Heat (1995)",
            "4x4 Off-road",
            "1920x1080 Demo",
            "Mission: Impossible",
            "SE7EN",
            "Bus 1x2",
            "Episodes S01",
            "PS5E02 review",
        ] {
            assert_eq!(marker(title), None, "{title}");
        }
    }

    #[test]
    fn detects_series_urls_and_marked_titles() {
        let e = entry(
            "#EXTINF:-1 group-title=\"EN | Drama\",EN - Dark (2017) S01 E02 - Lies\nhttp://h:8080/series/u/p/5002.mkv",
        );
        let d = detect(&e).unwrap();
        assert_eq!(d.show, "EN - Dark (2017)");
        assert_eq!(d.numbers, Some((1, 2)));
        assert_eq!(d.title, "Lies");
        // No marker, but an Xtream series URL: an episode numbered later.
        let e = entry("#EXTINF:-1,Dark Pilot\nhttp://h:8080/series/u/p/5001.mp4");
        let d = detect(&e).unwrap();
        assert_eq!((d.show.as_str(), d.numbers), ("Dark Pilot", None));
        // A marker on a file URL counts too; a plain movie does not.
        assert!(detect(&entry("#EXTINF:-1,Dark 1x03\nhttp://h/dark.103.mkv")).is_some());
        let heat = entry("#EXTINF:-1,Heat (1995)\nhttp://h:8080/movie/u/p/1.mkv");
        assert!(detect(&heat).is_none());
        // Nothing before the marker: tvg-name, then the group, names the show.
        let e = entry(
            "#EXTINF:-1 tvg-name=\"Dark S01E01\" group-title=\"G\",S01E01 Secrets\nhttp://h/series/u/p/1.mp4",
        );
        assert_eq!(detect(&e).unwrap().show, "Dark");
        let e = entry("#EXTINF:-1 group-title=\"Dark\",S01E01\nhttp://h/series/u/p/1.mp4");
        let d = detect(&e).unwrap();
        assert_eq!((d.show.as_str(), d.title.as_str()), ("Dark", "S01E01"));
    }

    /// A tvg-name without a marker names the show too, rather than the
    /// group; one that only repeats the episode title does not.
    #[test]
    fn plain_tvg_name_names_the_show() {
        let e = entry(
            "#EXTINF:-1 tvg-name=\"Dark (2017)\" group-title=\"Drama\",S01E01 - Secrets\nhttp://h/series/u/p/1.mp4",
        );
        assert_eq!(detect(&e).unwrap().show, "Dark (2017)");
        let e = entry(
            "#EXTINF:-1 tvg-name=\"Secrets\" group-title=\"Drama\",S01E01 - Secrets\nhttp://h/series/u/p/1.mp4",
        );
        assert_eq!(detect(&e).unwrap().show, "Drama");
        let e = entry(
            "#EXTINF:-1 tvg-name=\" \" group-title=\"Drama\",S01E01 - Secrets\nhttp://h/series/u/p/1.mp4",
        );
        assert_eq!(detect(&e).unwrap().show, "Drama");
    }

    fn group(text: &str) -> (Vec<ItemRow>, Vec<LegacyEpisode>) {
        let (entries, _, _) = parse_str(text);
        let mut g = SeriesGrouper::default();
        for (i, e) in entries.into_iter().enumerate() {
            let d = detect(&e).expect("episode");
            let cat = crate::m3u::group_id(e.group.as_deref().unwrap_or(""));
            let legacy = (i == 1).then(|| format!("movie{i}"));
            g.add(cat, i as i64, d, e, legacy);
        }
        g.into_rows("s")
    }

    #[test]
    fn groups_episodes_by_group_and_show() {
        let (rows, legacy) = group(
            "#EXTM3U\n\
             #EXTINF:-1 tvg-logo=\"http://i/dark.jpg\" group-title=\"Drama\",Dark (2017) S01E02\nhttp://h/series/u/p/2.mkv\n\
             #EXTINF:-1 tvg-logo=\"http://i/dark.jpg\" group-title=\"Drama\",EN - Dark (2017) S01E01\nhttp://h/series/u/p/1.mkv\n\
             #EXTINF:-1 tvg-logo=\"http://i/e3.jpg\" group-title=\"Drama\",Dark (2017) S02E01\nhttp://h/series/u/p/3.mkv\n\
             #EXTINF:-1 group-title=\"4K Drama\",Dark (2017) S01E01\nhttp://h/series/u/p/4.mkv\n\
             #EXTINF:-1 group-title=\"Drama\",Dark (2017) S01E02\nhttp://h/series/u/p/5.mkv\n",
        );
        assert_eq!(rows.len(), 2, "one show per group");
        let dark = &rows[0];
        assert_eq!(dark.content_type, ContentType::Series);
        assert_eq!(dark.title, "Dark (2017)");
        assert_eq!(dark.title_base.as_deref(), Some("Dark"));
        assert_eq!(dark.year, Some(2017));
        assert_eq!(dark.poster_url.as_deref(), Some("http://i/dark.jpg"));
        assert_eq!(dark.position, 0);
        assert_eq!(rows[1].position, 3);
        let eps = stored_episodes(&dark.extra);
        assert_eq!(eps.len(), 4);
        assert_eq!(eps[0].poster_url, None, "same as the series poster");
        assert_eq!(eps[2].poster_url.as_deref(), Some("http://i/e3.jpg"));
        assert_eq!(eps[0].container_extension.as_deref(), Some("mkv"));
        // A second S01E02 gets its own id.
        assert_ne!(eps[0].id, eps[3].id);
        let ids: HashSet<&str> = eps.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids.len(), 4);
        // Episode ids do not depend on the URL (token rotation keeps them).
        let (again, _) = group(
            "#EXTM3U\n#EXTINF:-1 group-title=\"Drama\",Dark (2017) S01E02\nhttp://h/series/u/NEW/2.mkv\n",
        );
        assert_eq!(again[0].item_id, dark.item_id);
        assert_eq!(stored_episodes(&again[0].extra)[0].id, eps[0].id);

        let r = ItemRef::new("s", ContentType::Series, dark.item_id.clone());
        let s = seasons(&r, &eps);
        assert_eq!(s.iter().map(|s| s.number).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(
            s[0].episodes.iter().map(|e| e.episode).collect::<Vec<_>>(),
            [1, 2, 2]
        );
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].movie_id, "movie1");
        assert_eq!(legacy[0].series_id, dark.item_id);
        assert_eq!(legacy[0].episode_id, eps[1].id);
        assert_eq!(legacy[0].subtitle, "S01E01 · EN - Dark (2017) S01E01");
    }

    #[test]
    fn unnumbered_series_urls_are_numbered_in_order() {
        let (rows, _) = group(
            "#EXTM3U\n\
             #EXTINF:-1 group-title=\"G\",Talk Show\nhttp://h/series/u/p/1.mp4\n\
             #EXTINF:-1 group-title=\"G\",Talk Show\nhttp://h/series/u/p/2.mp4\n",
        );
        assert_eq!(rows.len(), 1);
        let eps = stored_episodes(&rows[0].extra);
        assert_eq!(
            eps.iter()
                .map(|e| (e.season, e.episode))
                .collect::<Vec<_>>(),
            [(1, 1), (1, 2)]
        );
        assert_ne!(eps[0].id, eps[1].id);
    }

    /// Local versions of a show (`[US]`, `[UK]`) stay apart; `[US]` and
    /// `(US)` are one show, whatever language prefix or quality tag is added.
    #[test]
    fn country_tags_keep_local_versions_apart() {
        let (rows, _) = group(
            "#EXTM3U\n\
             #EXTINF:-1 group-title=\"Comedy\",The Office [US] S01E01\nhttp://h/series/u/p/1.mkv\n\
             #EXTINF:-1 group-title=\"Comedy\",The Office [UK] S01E01\nhttp://h/series/u/p/2.mkv\n\
             #EXTINF:-1 group-title=\"Comedy\",The Office (US) S01E02\nhttp://h/series/u/p/3.mkv\n\
             #EXTINF:-1 group-title=\"Comedy\",EN - The Office [US] [4K] S01E03\nhttp://h/series/u/p/4.mkv\n",
        );
        let titles: Vec<&str> = rows.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, ["The Office [US]", "The Office [UK]"]);
        assert_eq!(stored_episodes(&rows[0].extra).len(), 3);
        assert_eq!(stored_episodes(&rows[1].extra).len(), 1);
        assert_eq!(rows[0].title_base.as_deref(), Some("The Office"));
    }

    /// `(season, episode, title) -> id` of the one series of `text`.
    fn ids_of(text: &str) -> HashMap<(i64, i64, String), String> {
        let (rows, _) = group(text);
        assert_eq!(rows.len(), 1);
        stored_episodes(&rows[0].extra)
            .into_iter()
            .map(|e| ((e.season, e.episode, e.title), e.id))
            .collect()
    }

    /// Versions of one episode keep their ids when the playlist reorders
    /// them, and when a version other than the first by name leaves (the
    /// first keeps the id of the episode alone).
    #[test]
    fn episode_ids_do_not_follow_playlist_order() {
        let en = "#EXTINF:-1 group-title=\"D\",EN - Dark S01E02\nhttp://h/series/1.mkv\n";
        let de = "#EXTINF:-1 group-title=\"D\",DE - Dark S01E02\nhttp://h/series/2.mkv\n";
        let fr = "#EXTINF:-1 group-title=\"D\",FR - Dark S01E02\nhttp://h/series/3.mkv\n";
        let all = ids_of(&format!("#EXTM3U\n{en}{de}{fr}"));
        let unique: HashSet<&String> = all.values().collect();
        assert_eq!(unique.len(), 3);
        assert_eq!(ids_of(&format!("#EXTM3U\n{fr}{en}{de}")), all, "reordered");
        for rest in [format!("{en}{de}"), format!("{fr}{de}"), de.to_string()] {
            let left = ids_of(&format!("#EXTM3U\n{rest}"));
            assert_eq!(left.len(), rest.matches("#EXTINF").count());
            for (key, id) in &left {
                assert_eq!(all.get(key), Some(id), "{key:?}");
            }
        }
    }

    #[test]
    fn stored_episodes_round_trip_and_tolerate_junk() {
        let ep = StoredEpisode {
            id: "e".into(),
            season: 1,
            episode: 2,
            title: "T".into(),
            url: "http://h/1.mkv".into(),
            poster_url: None,
            container_extension: Some("mkv".into()),
            duration_seconds: None,
            headers: Some(RequestHeaders {
                user_agent: Some("UA".into()),
                referrer: None,
                origin: None,
            }),
        };
        let extra = serde_json::json!({ "episodes": [ep] });
        assert_eq!(stored_episodes(&extra), vec![ep]);
        assert!(stored_episodes(&serde_json::json!({})).is_empty());
        assert!(stored_episodes(&serde_json::json!({ "episodes": "x" })).is_empty());
        assert_eq!(kind_of("http://h/a.m3u8?t=1"), PlayerKind::Hls);
        assert_eq!(kind_of("http://h/a.mkv"), PlayerKind::Direct);
    }
}
