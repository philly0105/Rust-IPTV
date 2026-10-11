//! Raw TMDB payloads -> SPEC C4 result types, plus the original-language
//! fallback. Ported from the old app's `tmdb-merge.ts`, `tmdb-credits.ts`,
//! `tmdb-person.ts`, and `tmdb-language-fallback.ts`.

use super::config::{backdrop_url, poster_url, profile_url, still_url};
use super::normalize::extract_year;
use super::raw;
use crate::model::{
    Person, TmdbBrief, TmdbEpisode, TmdbMediaType, TmdbMovie, TmdbPerson, TmdbSeason, TmdbTv,
    TmdbTvSeasonSummary,
};
use std::collections::HashSet;

/// Cast members shown on a detail page.
pub const MAX_CAST: usize = 20;
/// Slots held back for newest-season arrivals in a series cast, so a long
/// run's whole-cast list cannot push them off the end.
pub const RESERVED_NEW_SEASON_SLOTS: usize = 3;
/// Crew members kept (key jobs only).
pub const MAX_CREW: usize = 12;
/// Similar titles kept.
pub const MAX_SIMILAR: usize = 20;
/// Trending entries kept.
pub const MAX_TRENDING: usize = 40;
/// Filmography entries on a person page.
pub const MAX_KNOWN_FOR: usize = 80;

/// Crew jobs worth showing, in display priority.
const KEY_CREW_JOBS: &[&str] = &[
    "Director",
    "Screenplay",
    "Writer",
    "Novel",
    "Story",
    "Producer",
    "Original Music Composer",
    "Director of Photography",
];

fn text(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn has_text(v: &Option<String>) -> bool {
    text(v).is_some()
}

/// `vote_average` rounded to one decimal; `None` without votes.
pub fn rating(average: Option<f64>, count: Option<i64>) -> Option<f64> {
    match (average, count) {
        (Some(a), Some(c)) if a > 0.0 && c > 0 => Some((a * 10.0).round() / 10.0),
        _ => None,
    }
}

/// Media type of a mixed list entry (`trending/all`, `combined_credits`).
fn media_of(s: Option<&str>) -> Option<TmdbMediaType> {
    match s {
        Some("movie") => Some(TmdbMediaType::Movie),
        Some("tv") => Some(TmdbMediaType::Tv),
        _ => None,
    }
}

/// Card entry from a search/similar/trending result; `None` for unusable rows.
pub fn brief_from_result(r: &raw::SearchResult, media: TmdbMediaType) -> Option<TmdbBrief> {
    let title = text(&r.title).or_else(|| text(&r.name))?;
    if r.id <= 0 {
        return None;
    }
    Some(TmdbBrief {
        tmdb_id: r.id,
        media_type: media,
        title,
        year: extract_year(
            r.release_date.as_deref().or(r.first_air_date.as_deref()),
            None,
        ),
        poster_url: poster_url(r.poster_path.as_deref()),
        backdrop_url: backdrop_url(r.backdrop_path.as_deref()),
        rating: rating(r.vote_average, r.vote_count),
        overview: text(&r.overview),
    })
}

/// Trending list: movies and TV only (people dropped), deduplicated.
pub fn trending_from_page(page: &raw::ResultPage) -> Vec<TmdbBrief> {
    let mut seen = HashSet::new();
    page.results
        .iter()
        .filter_map(|r| brief_from_result(r, media_of(r.media_type.as_deref())?))
        .filter(|b| seen.insert((b.media_type, b.tmdb_id)))
        .take(MAX_TRENDING)
        .collect()
}

fn youtube_videos(d: &raw::Details) -> impl Iterator<Item = &raw::Video> {
    d.videos
        .iter()
        .flat_map(|v| v.results.iter())
        .filter(|v| v.site.as_deref() == Some("YouTube") && has_text(&v.key))
}

/// Best YouTube key: official trailer > any trailer > teaser.
pub fn pick_trailer_key(d: &raw::Details) -> Option<String> {
    let is = |v: &&raw::Video, kind: &str| v.kind.as_deref() == Some(kind);
    youtube_videos(d)
        .find(|v| is(v, "Trailer") && v.official == Some(true))
        .or_else(|| youtube_videos(d).find(|v| is(v, "Trailer")))
        .or_else(|| youtube_videos(d).find(|v| is(v, "Teaser")))
        .and_then(|v| text(&v.key))
}

fn has_youtube_trailer(d: &raw::Details) -> bool {
    youtube_videos(d).any(|v| matches!(v.kind.as_deref(), Some("Trailer" | "Teaser")))
}

fn cast_person(m: &raw::CastMember) -> Option<Person> {
    Some(Person {
        id: m.id.filter(|id| *id > 0),
        name: text(&m.name)?,
        role: text(&m.character),
        profile_url: profile_url(m.profile_path.as_deref()),
    })
}

fn by_billing(members: &mut [raw::CastMember]) {
    members.sort_by_key(|m| m.order.unwrap_or(i64::MAX));
}

/// Movie cast in billing order, capped.
pub fn movie_cast(credits: Option<&raw::Credits>) -> Vec<Person> {
    let mut cast: Vec<raw::CastMember> = credits.map(|c| c.cast.clone()).unwrap_or_default();
    by_billing(&mut cast);
    cast.iter().filter_map(cast_person).take(MAX_CAST).collect()
}

/// The role an aggregate member is known for: the named role with the most
/// episodes (a one-episode cameo must not beat a ten-season lead).
fn pick_aggregate_role(m: &raw::AggregateCastMember) -> Option<String> {
    m.roles
        .iter()
        .filter(|r| has_text(&r.character))
        .fold(None::<&raw::AggregateRole>, |best, r| match best {
            Some(b) if r.episode_count.unwrap_or(0) <= b.episode_count.unwrap_or(0) => Some(b),
            _ => Some(r),
        })
        .and_then(|r| text(&r.character))
}

/// Series cast: `aggregate_credits` (whole run) plus newest-season
/// arrivals from `credits` that the aggregate lacks, with reserved slots
/// for the arrivals. Falls back to `credits` when no aggregate exists.
pub fn tv_cast(d: &raw::Details) -> Vec<Person> {
    let mut aggregate: Vec<raw::AggregateCastMember> = d
        .aggregate_credits
        .as_ref()
        .map(|a| {
            a.cast
                .iter()
                .filter(|m| has_text(&m.name))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    aggregate.sort_by_key(|m| m.order.unwrap_or(i64::MAX));
    if aggregate.is_empty() {
        return movie_cast(d.credits.as_ref());
    }
    let aggregate: Vec<raw::CastMember> = aggregate
        .iter()
        .map(|m| raw::CastMember {
            id: m.id,
            name: m.name.clone(),
            character: pick_aggregate_role(m),
            order: m.order,
            profile_path: m.profile_path.clone(),
        })
        .collect();
    let known: HashSet<i64> = aggregate.iter().filter_map(|m| m.id).collect();
    let mut arrivals: Vec<raw::CastMember> = d
        .credits
        .as_ref()
        .map(|c| {
            c.cast
                .iter()
                .filter(|m| has_text(&m.name) && m.id.is_none_or(|id| !known.contains(&id)))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    by_billing(&mut arrivals);
    let reserved = arrivals.len().min(RESERVED_NEW_SEASON_SLOTS);
    let from_aggregate = aggregate.len().min(MAX_CAST.saturating_sub(reserved));
    let room = MAX_CAST - from_aggregate;
    aggregate[..from_aggregate]
        .iter()
        .chain(arrivals.iter().take(room))
        .filter_map(cast_person)
        .collect()
}

/// Key crew (directors first), deduplicated by person + job.
pub fn key_crew(credits: Option<&raw::Credits>) -> Vec<Person> {
    let Some(c) = credits else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for job in KEY_CREW_JOBS {
        for m in c.crew.iter().filter(|m| m.job.as_deref() == Some(*job)) {
            let Some(name) = text(&m.name) else { continue };
            let dedup = (m.id.unwrap_or(0), name.clone(), *job);
            if !seen.insert(dedup) {
                continue;
            }
            out.push(Person {
                id: m.id.filter(|id| *id > 0),
                name,
                role: Some((*job).to_string()),
                profile_url: profile_url(m.profile_path.as_deref()),
            });
        }
    }
    out.truncate(MAX_CREW);
    out
}

fn directors(credits: Option<&raw::Credits>) -> Option<String> {
    let mut seen = HashSet::new();
    let names: Vec<String> = credits
        .map(|c| {
            c.crew
                .iter()
                .filter(|m| m.job.as_deref() == Some("Director"))
                .filter_map(|m| text(&m.name))
                .filter(|n| seen.insert(n.clone()))
                .collect()
        })
        .unwrap_or_default();
    (!names.is_empty()).then(|| names.join(", "))
}

fn genres(d: &raw::Details) -> Vec<String> {
    d.genres.iter().filter_map(|g| text(&g.name)).collect()
}

fn similar(d: &raw::Details, media: TmdbMediaType) -> Vec<TmdbBrief> {
    let page = d
        .similar
        .as_ref()
        .filter(|p| !p.results.is_empty())
        .or(d.recommendations.as_ref());
    page.map(|p| {
        p.results
            .iter()
            .filter(|r| r.id != d.id)
            .filter_map(|r| brief_from_result(r, media))
            .take(MAX_SIMILAR)
            .collect()
    })
    .unwrap_or_default()
}

fn brief_of_details(d: &raw::Details, media: TmdbMediaType) -> TmdbBrief {
    let (title, date) = match media {
        TmdbMediaType::Movie => (
            text(&d.title).or_else(|| text(&d.original_title)),
            d.release_date.as_deref(),
        ),
        TmdbMediaType::Tv => (
            text(&d.name).or_else(|| text(&d.original_name)),
            d.first_air_date.as_deref(),
        ),
    };
    TmdbBrief {
        tmdb_id: d.id,
        media_type: media,
        title: title.unwrap_or_default(),
        year: extract_year(date, None),
        poster_url: poster_url(d.poster_path.as_deref()),
        backdrop_url: backdrop_url(d.backdrop_path.as_deref()),
        rating: rating(d.vote_average, d.vote_count),
        overview: text(&d.overview),
    }
}

pub fn movie_from_raw(d: &raw::Details) -> TmdbMovie {
    TmdbMovie {
        brief: brief_of_details(d, TmdbMediaType::Movie),
        runtime: d.runtime.filter(|r| *r > 0),
        genres: genres(d),
        cast: movie_cast(d.credits.as_ref()),
        crew: key_crew(d.credits.as_ref()),
        director: directors(d.credits.as_ref()),
        trailer_youtube_key: pick_trailer_key(d),
        similar: similar(d, TmdbMediaType::Movie),
        imdb_id: d
            .external_ids
            .as_ref()
            .and_then(|e| text(&e.imdb_id))
            .or_else(|| text(&d.imdb_id)),
    }
}

pub fn tv_from_raw(d: &raw::Details) -> TmdbTv {
    let mut crew: Vec<Person> = d
        .created_by
        .iter()
        .filter_map(|c| {
            Some(Person {
                id: c.id.filter(|id| *id > 0),
                name: text(&c.name)?,
                role: Some("Creator".to_string()),
                profile_url: profile_url(c.profile_path.as_deref()),
            })
        })
        .collect();
    crew.extend(key_crew(d.credits.as_ref()));
    crew.truncate(MAX_CREW);
    TmdbTv {
        brief: brief_of_details(d, TmdbMediaType::Tv),
        genres: genres(d),
        cast: tv_cast(d),
        crew,
        creators: d.created_by.iter().filter_map(|c| text(&c.name)).collect(),
        seasons: d
            .seasons
            .iter()
            .filter_map(|s| {
                let number = s.season_number?;
                Some(TmdbTvSeasonSummary {
                    number,
                    name: text(&s.name).unwrap_or_else(|| format!("Season {number}")),
                    episode_count: s.episode_count.unwrap_or(0),
                    poster_url: poster_url(s.poster_path.as_deref()),
                    air_date: text(&s.air_date),
                })
            })
            .collect(),
        trailer_youtube_key: pick_trailer_key(d),
        similar: similar(d, TmdbMediaType::Tv),
        status: text(&d.status),
    }
}

pub fn season_from_raw(s: &raw::Season, number: i64) -> TmdbSeason {
    let number = s.season_number.unwrap_or(number);
    TmdbSeason {
        number,
        name: text(&s.name).unwrap_or_else(|| format!("Season {number}")),
        overview: text(&s.overview),
        episodes: s
            .episodes
            .iter()
            .map(|e| TmdbEpisode {
                number: e.episode_number,
                name: text(&e.name).unwrap_or_else(|| format!("Episode {}", e.episode_number)),
                overview: text(&e.overview),
                still_url: still_url(e.still_path.as_deref()),
                air_date: text(&e.air_date),
                runtime: e.runtime.filter(|r| *r > 0),
            })
            .collect(),
    }
}

/// Person page: profile plus a merged filmography (acting credits win the
/// dedup; directing/creating-only credits are included), newest first,
/// undated last, capped.
pub fn person_from_raw(p: &raw::Person) -> TmdbPerson {
    let mut seen = HashSet::new();
    let mut known_for: Vec<TmdbBrief> = Vec::new();
    if let Some(cc) = &p.combined_credits {
        let crew = cc
            .crew
            .iter()
            .filter(|c| matches!(c.job.as_deref(), Some("Director" | "Creator")));
        for c in cc.cast.iter().chain(crew) {
            let Some(media) = media_of(c.media_type.as_deref()) else {
                continue;
            };
            let Some(title) = text(&c.title).or_else(|| text(&c.name)) else {
                continue;
            };
            if c.id <= 0 || !seen.insert((media, c.id)) {
                continue;
            }
            known_for.push(TmdbBrief {
                tmdb_id: c.id,
                media_type: media,
                title,
                year: extract_year(
                    c.release_date.as_deref().or(c.first_air_date.as_deref()),
                    None,
                ),
                poster_url: poster_url(c.poster_path.as_deref()),
                backdrop_url: backdrop_url(c.backdrop_path.as_deref()),
                rating: rating(c.vote_average, c.vote_count),
                overview: text(&c.overview),
            });
        }
    }
    known_for.sort_by_key(|b| std::cmp::Reverse(b.year.unwrap_or(-1)));
    known_for.truncate(MAX_KNOWN_FOR);
    TmdbPerson {
        id: p.id,
        name: text(&p.name).unwrap_or_default(),
        biography: text(&p.biography),
        profile_url: profile_url(p.profile_path.as_deref()),
        birthday: text(&p.birthday),
        place_of_birth: text(&p.place_of_birth),
        known_for,
    }
}

// ---------------------------------------------------------------------------
// Original-language fallback. TMDB filters text AND videos by `language`: a
// Russian-only title has an empty overview and no trailer in en-US. When the
// app-language payload lacks either, refetch once in `original_language` and
// fill only the missing fields.
// ---------------------------------------------------------------------------

/// Language to retry details with, or `None` when nothing is missing or the
/// request language already is the original language.
pub fn details_fallback_language(d: &raw::Details, current: &str) -> Option<String> {
    let original = text(&d.original_language)?;
    if has_text(&d.overview) && has_youtube_trailer(d) {
        return None;
    }
    if current.to_lowercase().starts_with(&original.to_lowercase()) {
        None
    } else {
        Some(original)
    }
}

/// Fills a missing overview and/or trailer from the fallback payload.
pub fn fill_details_from_fallback(primary: &mut raw::Details, fallback: raw::Details) {
    if !has_text(&primary.overview) && has_text(&fallback.overview) {
        primary.overview = fallback.overview.clone();
    }
    if !has_youtube_trailer(primary) && has_youtube_trailer(&fallback) {
        primary.videos = fallback.videos;
    }
}

/// True when a season has no usable text: all episode names empty, or no
/// overview anywhere.
pub fn season_needs_text_fallback(s: &raw::Season) -> bool {
    if !s.episodes.is_empty() && !s.episodes.iter().any(|e| has_text(&e.name)) {
        return true;
    }
    if has_text(&s.overview) {
        return false;
    }
    !s.episodes.iter().any(|e| has_text(&e.overview))
}

/// Fills empty season overview and episode names/overviews from the fallback.
pub fn fill_season_from_fallback(primary: &mut raw::Season, fallback: raw::Season) {
    if !has_text(&primary.overview) {
        primary.overview = fallback.overview.clone();
    }
    for e in &mut primary.episodes {
        if let Some(src) = fallback
            .episodes
            .iter()
            .find(|f| f.episode_number == e.episode_number)
        {
            if !has_text(&e.name) {
                e.name = src.name.clone();
            }
            if !has_text(&e.overview) {
                e.overview = src.overview.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn details(v: serde_json::Value) -> raw::Details {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn movie_mapping() {
        let d = details(json!({
            "id": 603, "title": "The Matrix", "original_title": "The Matrix",
            "release_date": "1999-03-31", "overview": "Neo.", "runtime": 136,
            "vote_average": 8.234, "vote_count": 20000,
            "poster_path": "/p.jpg", "backdrop_path": "/b.jpg",
            "genres": [{"id": 28, "name": "Action"}, {"id": 878, "name": "Science Fiction"}],
            "external_ids": {"imdb_id": "tt0133093"},
            "credits": {
                "cast": [
                    {"id": 2, "name": "Carrie-Anne Moss", "character": "Trinity", "order": 2},
                    {"id": 1, "name": "Keanu Reeves", "character": "Neo", "order": 0, "profile_path": "/k.jpg"},
                    {"id": 3, "name": "", "order": 1}
                ],
                "crew": [
                    {"id": 9, "name": "Lana Wachowski", "job": "Director"},
                    {"id": 9, "name": "Lana Wachowski", "job": "Director"},
                    {"id": 9, "name": "Lana Wachowski", "job": "Writer"},
                    {"id": 10, "name": "Lilly Wachowski", "job": "Director"},
                    {"id": 11, "name": "Grip Person", "job": "Grip"}
                ]
            },
            "videos": {"results": [
                {"key": "teaser", "site": "YouTube", "type": "Teaser"},
                {"key": "unofficial", "site": "YouTube", "type": "Trailer", "official": false},
                {"key": "vimeo", "site": "Vimeo", "type": "Trailer", "official": true},
                {"key": "official", "site": "YouTube", "type": "Trailer", "official": true}
            ]},
            "similar": {"results": [
                {"id": 604, "title": "The Matrix Reloaded", "release_date": "2003-05-15"},
                {"id": 0, "title": "bad"},
                {"id": 605, "title": ""}
            ]}
        }));
        let m = movie_from_raw(&d);
        assert_eq!(m.brief.tmdb_id, 603);
        assert_eq!(m.brief.title, "The Matrix");
        assert_eq!(m.brief.year, Some(1999));
        assert_eq!(m.brief.rating, Some(8.2));
        assert_eq!(
            m.brief.poster_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w500/p.jpg")
        );
        assert_eq!(
            m.brief.backdrop_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w1280/b.jpg")
        );
        assert_eq!(m.runtime, Some(136));
        assert_eq!(m.genres, vec!["Action", "Science Fiction"]);
        assert_eq!(m.cast.len(), 2);
        assert_eq!(m.cast[0].name, "Keanu Reeves");
        assert_eq!(m.cast[0].role.as_deref(), Some("Neo"));
        assert_eq!(
            m.cast[0].profile_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w185/k.jpg")
        );
        assert_eq!(
            m.director.as_deref(),
            Some("Lana Wachowski, Lilly Wachowski")
        );
        assert_eq!(
            m.crew.len(),
            3,
            "two directors and one writer, grip dropped"
        );
        assert_eq!(m.trailer_youtube_key.as_deref(), Some("official"));
        assert_eq!(m.imdb_id.as_deref(), Some("tt0133093"));
        assert_eq!(m.similar.len(), 1);
        assert_eq!(m.similar[0].media_type, TmdbMediaType::Movie);

        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["tmdbId"], 603);
        assert_eq!(v["mediaType"], "movie");
        assert_eq!(v["trailerYoutubeKey"], "official");
        assert!(v.get("brief").is_none(), "brief is flattened");
    }

    #[test]
    fn trailer_preference() {
        let teaser_only = details(json!({"id": 1, "videos": {"results": [
            {"key": "t", "site": "YouTube", "type": "Teaser"},
            {"key": "c", "site": "YouTube", "type": "Clip"}
        ]}}));
        assert_eq!(pick_trailer_key(&teaser_only).as_deref(), Some("t"));
        let none = details(
            json!({"id": 1, "videos": {"results": [{"key": "c", "site": "YouTube", "type": "Clip"}]}}),
        );
        assert_eq!(pick_trailer_key(&none), None);
    }

    #[test]
    fn rating_needs_votes() {
        assert_eq!(rating(Some(7.25), Some(3)), Some(7.3));
        assert_eq!(rating(Some(7.0), Some(0)), None);
        assert_eq!(rating(Some(0.0), Some(10)), None);
        assert_eq!(rating(None, None), None);
    }

    #[test]
    fn tv_cast_unions_aggregate_and_new_season() {
        let mut agg = Vec::new();
        for i in 0..30 {
            agg.push(json!({"id": i + 1, "name": format!("Regular {i}"), "order": i,
                "roles": [{"character": "Cameo", "episode_count": 1}, {"character": format!("Lead {i}"), "episode_count": 40}, {"character": "", "episode_count": 99}]}));
        }
        let d = details(json!({
            "id": 1, "name": "Show", "first_air_date": "2010-01-01",
            "aggregate_credits": {"cast": agg},
            "credits": {"cast": [
                {"id": 1, "name": "Regular 0", "character": "Lead 0", "order": 0},
                {"id": 500, "name": "Newcomer B", "character": "B", "order": 2},
                {"id": 501, "name": "Newcomer A", "character": "A", "order": 1}
            ]},
            "created_by": [{"id": 77, "name": "Creator One"}],
            "seasons": [{"season_number": 0, "name": "Specials", "episode_count": 2},
                        {"season_number": 1, "name": "Season 1", "episode_count": 10, "air_date": "2010-01-01"}],
            "status": "Ended"
        }));
        let tv = tv_from_raw(&d);
        assert_eq!(tv.cast.len(), MAX_CAST);
        assert_eq!(
            tv.cast[0].role.as_deref(),
            Some("Lead 0"),
            "role by episode count, unnamed skipped"
        );
        let names: Vec<_> = tv.cast.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names[MAX_CAST - 2], "Newcomer A");
        assert_eq!(names[MAX_CAST - 1], "Newcomer B");
        assert_eq!(tv.creators, vec!["Creator One"]);
        assert_eq!(tv.crew[0].role.as_deref(), Some("Creator"));
        assert_eq!(tv.seasons.len(), 2);
        assert_eq!(tv.seasons[1].air_date.as_deref(), Some("2010-01-01"));
        assert_eq!(tv.status.as_deref(), Some("Ended"));
        assert_eq!(tv.brief.media_type, TmdbMediaType::Tv);
    }

    #[test]
    fn tv_cast_without_aggregate_uses_credits() {
        let d = details(
            json!({"id": 1, "credits": {"cast": [{"id": 1, "name": "A", "order": 1}, {"id": 2, "name": "B", "order": 0}]}}),
        );
        let names: Vec<_> = tv_cast(&d).into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["B", "A"]);
    }

    #[test]
    fn person_filmography() {
        let p: raw::Person = serde_json::from_value(json!({
            "id": 6384, "name": "Keanu Reeves", "biography": "Bio", "birthday": "1964-09-02",
            "place_of_birth": "Beirut", "profile_path": "/k.jpg",
            "combined_credits": {
                "cast": [
                    {"id": 603, "media_type": "movie", "title": "The Matrix", "release_date": "1999-03-31", "character": "Neo"},
                    {"id": 1, "media_type": "tv", "name": "Old Show", "first_air_date": "1985-01-01"},
                    {"id": 2, "media_type": "movie", "title": "Undated"},
                    {"id": 3, "media_type": "person", "title": "Nope"}
                ],
                "crew": [
                    {"id": 603, "media_type": "movie", "title": "The Matrix", "job": "Director", "release_date": "1999-03-31"},
                    {"id": 4, "media_type": "movie", "title": "Man of Tai Chi", "job": "Director", "release_date": "2013-07-05"},
                    {"id": 5, "media_type": "movie", "title": "Produced", "job": "Producer", "release_date": "2020-01-01"}
                ]
            }
        }))
        .unwrap();
        let person = person_from_raw(&p);
        assert_eq!(person.name, "Keanu Reeves");
        assert_eq!(person.place_of_birth.as_deref(), Some("Beirut"));
        let titles: Vec<_> = person.known_for.iter().map(|b| b.title.as_str()).collect();
        assert_eq!(
            titles,
            vec!["Man of Tai Chi", "The Matrix", "Old Show", "Undated"]
        );
        assert_eq!(person.known_for[2].media_type, TmdbMediaType::Tv);
    }

    #[test]
    fn trending_filters_people_and_duplicates() {
        let page: raw::ResultPage = serde_json::from_value(json!({"results": [
            {"id": 1, "media_type": "movie", "title": "M", "popularity": 5.0},
            {"id": 2, "media_type": "tv", "name": "T"},
            {"id": 3, "media_type": "person", "name": "P"},
            {"id": 1, "media_type": "movie", "title": "M"}
        ]}))
        .unwrap();
        let t = trending_from_page(&page);
        assert_eq!(t.len(), 2);
        assert_eq!(t[1].media_type, TmdbMediaType::Tv);
    }

    #[test]
    fn details_language_fallback() {
        let ru = details(json!({"id": 1, "original_language": "ru", "overview": ""}));
        assert_eq!(
            details_fallback_language(&ru, "en-US").as_deref(),
            Some("ru")
        );
        assert_eq!(details_fallback_language(&ru, "ru-RU"), None);
        let complete = details(json!({"id": 1, "original_language": "ru", "overview": "x",
            "videos": {"results": [{"key": "k", "site": "YouTube", "type": "Trailer"}]}}));
        assert_eq!(details_fallback_language(&complete, "en-US"), None);
        let no_trailer = details(json!({"id": 1, "original_language": "ru", "overview": "x"}));
        assert_eq!(
            details_fallback_language(&no_trailer, "en-US").as_deref(),
            Some("ru")
        );
        assert_eq!(
            details_fallback_language(&details(json!({"id": 1})), "en-US"),
            None
        );

        let mut primary = details(json!({"id": 1, "overview": "kept"}));
        let fallback = details(json!({"id": 1, "overview": "other",
            "videos": {"results": [{"key": "k", "site": "YouTube", "type": "Trailer"}]}}));
        fill_details_from_fallback(&mut primary, fallback);
        assert_eq!(primary.overview.as_deref(), Some("kept"));
        assert_eq!(pick_trailer_key(&primary).as_deref(), Some("k"));
    }

    #[test]
    fn season_language_fallback() {
        let s: raw::Season = serde_json::from_value(json!({"season_number": 1, "overview": "",
            "episodes": [{"episode_number": 1, "name": "", "overview": ""}, {"episode_number": 2, "name": "", "overview": "kept"}]}))
        .unwrap();
        assert!(season_needs_text_fallback(&s));
        let fb: raw::Season = serde_json::from_value(json!({"overview": "S",
            "episodes": [{"episode_number": 1, "name": "Pilot", "overview": "O1"}, {"episode_number": 2, "name": "Two", "overview": "O2"}]}))
        .unwrap();
        let mut s2 = s.clone();
        fill_season_from_fallback(&mut s2, fb);
        assert_eq!(s2.overview.as_deref(), Some("S"));
        assert_eq!(s2.episodes[0].name.as_deref(), Some("Pilot"));
        assert_eq!(s2.episodes[1].overview.as_deref(), Some("kept"));
        let mapped = season_from_raw(&s2, 1);
        assert_eq!(mapped.episodes[0].name, "Pilot");
        assert_eq!(mapped.number, 1);

        let ok: raw::Season = serde_json::from_value(json!({"overview": "",
            "episodes": [{"episode_number": 1, "name": "A", "overview": "x"}]}))
        .unwrap();
        assert!(!season_needs_text_fallback(&ok));
    }
}
