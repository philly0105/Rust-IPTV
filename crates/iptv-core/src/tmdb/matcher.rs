//! Title matching for TMDB search results, and cache lookup keys.
//!
//! Ported from the old app's `tmdb-matcher.ts`, plus the SPEC C4 fuzzy tier.
//! A result is accepted only with high confidence, because enrichment must
//! never attach the wrong movie's metadata:
//!
//! 1. Exact tier: normalized title equal (title or original title). With a
//!    wanted year, a result must be within ±1 year (TV also accepts shows
//!    that premiered earlier: portals report the current season's year);
//!    ties go to the most-voted. Without a year, the title must be
//!    unambiguous (exactly one exact match).
//! 2. Fuzzy tier (only when no result matches exactly, and only with a
//!    year): normalized Levenshtein similarity >= 0.85 and a year within ±1.
//! 3. Two-tier year fallback: a trailing year in the provider title is
//!    ambiguous ("The Matrix 1999" vs "Blade Runner 2049"). When the year
//!    was inferred from the title and tiers 1-2 fail, the year-kept form is
//!    compared and must be unambiguous.

use super::normalize::{
    extract_year, normalize_title, normalize_title_keys, release_tag_year, NormalizedTitleKeys,
};
use super::raw::SearchResult;
use crate::model::TmdbMediaType;
use once_cell::sync::Lazy;
use regex::Regex;

/// Minimum normalized Levenshtein similarity for the fuzzy tier (SPEC C4).
pub const FUZZY_THRESHOLD: f64 = 0.85;

/// Version suffix of every lookup key. Bump it when payload shapes or match
/// rules change, so stale (including negative) rows stop matching.
pub const KEY_VERSION: &str = "v1";

static LEADING_LANGUAGE_CODE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*[A-Z]{2,3}\s+").expect("valid regex"));
static LEADING_LANGUAGE_WORD: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)^\s*(?:multi|english|german|french|arabic|turkish|russian|spanish|italian|deutsch)\s+",
    )
    .expect("valid regex")
});

/// Drops a leading language token without a separator ("DE Batman",
/// "English The Godfather"); only used for fallback variants, since real
/// titles start like that too ("It Follows", "Us").
fn strip_leading_language_token(raw: &str) -> Option<String> {
    for re in [&*LEADING_LANGUAGE_CODE, &*LEADING_LANGUAGE_WORD] {
        if let Some(m) = re.find(raw) {
            let rest = &raw[m.end()..];
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

/// Ordered, deduplicated search candidates: original title, display title,
/// then both with a leading language-looking token dropped. The confidence
/// gate applies to every variant, so extras cost only extra searches.
pub fn build_search_title_variants(title: &str, original_title: Option<&str>) -> Vec<String> {
    let mut variants: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let n = normalize_title(raw);
        if !n.is_empty() && !variants.contains(&n) {
            variants.push(n);
        }
    };
    if let Some(o) = original_title {
        push(o);
    }
    push(title);
    for raw in [original_title.unwrap_or(""), title] {
        if raw.is_empty() {
            continue;
        }
        if let Some(stripped) = strip_leading_language_token(raw) {
            push(&stripped);
        }
    }
    variants
}

/// Search-resolution row key.
pub fn search_lookup_key(normalized_title: &str, year: Option<i64>, language: &str) -> String {
    let y = year.map(|y| y.to_string()).unwrap_or_default();
    format!("title:{normalized_title}|year:{y}|lang:{language}|{KEY_VERSION}")
}

/// Details row key (movie/tv payload in one language).
pub fn details_lookup_key(tmdb_id: i64, language: &str) -> String {
    format!("id:{tmdb_id}|lang:{language}|{KEY_VERSION}")
}

/// Season row key.
pub fn season_lookup_key(tmdb_id: i64, season: i64, language: &str) -> String {
    format!("id:{tmdb_id}|season:{season}|lang:{language}|{KEY_VERSION}")
}

/// Person row key.
pub fn person_lookup_key(person_id: i64, language: &str) -> String {
    format!("id:{person_id}|lang:{language}|{KEY_VERSION}")
}

/// Trending row key.
pub fn trending_lookup_key(language: &str) -> String {
    format!("all:week|lang:{language}|{KEY_VERSION}")
}

fn result_titles(r: &SearchResult, media: TmdbMediaType) -> [Option<&str>; 2] {
    match media {
        TmdbMediaType::Movie => [r.title.as_deref(), r.original_title.as_deref()],
        TmdbMediaType::Tv => [r.name.as_deref(), r.original_name.as_deref()],
    }
}

fn result_year(r: &SearchResult, media: TmdbMediaType) -> Option<i64> {
    let date = match media {
        TmdbMediaType::Movie => r.release_date.as_deref(),
        TmdbMediaType::Tv => r.first_air_date.as_deref(),
    };
    extract_year(date, None)
}

/// The search gate's year tolerance: ±1, and TV shows that premiered
/// before the provider's (season) year.
pub fn years_agree(provider_year: i64, tmdb_year: i64, media: TmdbMediaType) -> bool {
    (tmdb_year - provider_year).abs() <= 1
        || (media == TmdbMediaType::Tv && tmdb_year < provider_year)
}

fn popularity_order(a: &SearchResult, b: &SearchResult) -> std::cmp::Ordering {
    b.vote_count
        .unwrap_or(0)
        .cmp(&a.vote_count.unwrap_or(0))
        .then_with(|| {
            b.popularity
                .unwrap_or(0.0)
                .total_cmp(&a.popularity.unwrap_or(0.0))
        })
}

fn most_popular(mut v: Vec<&SearchResult>) -> Option<&SearchResult> {
    v.sort_by(|a, b| popularity_order(a, b));
    v.into_iter().next()
}

fn similarity(a: &str, b: &str) -> f64 {
    strsim::normalized_levenshtein(a, b)
}

/// Picks the search result that confidently matches `title` / `year`
/// (tiers 1 and 2 above). `None` when confidence is insufficient.
pub fn pick_confident_match<'a>(
    results: &'a [SearchResult],
    title: &str,
    year: Option<i64>,
    media: TmdbMediaType,
) -> Option<&'a SearchResult> {
    let wanted = normalize_title(title);
    if wanted.is_empty() || results.is_empty() {
        return None;
    }
    let exact: Vec<&SearchResult> = results
        .iter()
        .filter(|r| {
            result_titles(r, media)
                .iter()
                .flatten()
                .any(|t| normalize_title(t) == wanted)
        })
        .collect();

    if !exact.is_empty() {
        return match year {
            Some(y) => most_popular(
                exact
                    .into_iter()
                    .filter(|r| result_year(r, media).is_some_and(|ry| years_agree(y, ry, media)))
                    .collect(),
            ),
            None if exact.len() == 1 => exact.into_iter().next(),
            None => None,
        };
    }

    // Fuzzy tier: a year is mandatory so similarity alone never decides.
    let y = year?;
    let mut fuzzy: Vec<(&SearchResult, f64)> = results
        .iter()
        .filter(|r| result_year(r, media).is_some_and(|ry| (ry - y).abs() <= 1))
        .filter_map(|r| {
            let best = result_titles(r, media)
                .iter()
                .flatten()
                .map(|t| similarity(&normalize_title(t), &wanted))
                .fold(0.0_f64, f64::max);
            (best >= FUZZY_THRESHOLD).then_some((r, best))
        })
        .collect();
    fuzzy.sort_by(|(a, sa), (b, sb)| sb.total_cmp(sa).then_with(|| popularity_order(a, b)));
    fuzzy.into_iter().next().map(|(r, _)| r)
}

/// Full gate used by the resolver: tiers 1-2 on `variant` with `year`, then
/// tier 3 (year-kept form, unambiguous) when the year was only inferred
/// from a trailing title year.
pub fn match_results<'a>(
    results: &'a [SearchResult],
    variant: &str,
    keys: &NormalizedTitleKeys,
    year: Option<i64>,
    year_is_explicit: bool,
    media: TmdbMediaType,
) -> Option<&'a SearchResult> {
    if let Some(m) = pick_confident_match(results, variant, year, media) {
        return Some(m);
    }
    if year_is_explicit || keys.trailing_year.is_none() || keys.exact == keys.base {
        return None;
    }
    let exact: Vec<&SearchResult> = results
        .iter()
        .filter(|r| {
            result_titles(r, media)
                .iter()
                .flatten()
                .any(|t| normalize_title_keys(t).exact == keys.exact)
        })
        .collect();
    (exact.len() == 1).then(|| exact[0])
}

/// What a provider-supplied `tmdb_id`'s payload says about that id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderIdVerdict {
    /// Title or year agrees: use the details.
    Corroborated,
    /// Both years known and they disagree (stale id): let the search try.
    Contradicted,
    /// Title differs and no year to arbitrate: keep the details (TMDB
    /// titles come back in the request language).
    Inconclusive,
}

/// Assesses a provider id from the details' titles and year against the
/// provider's title and year.
pub fn assess_provider_id(
    details_titles: &[&str],
    details_year: Option<i64>,
    query_title: &str,
    query_year: Option<i64>,
    media: TmdbMediaType,
) -> ProviderIdVerdict {
    // Release-tag year only: "2001: A Space Odyssey" is not a 2001 film.
    let provider_year = query_year.or_else(|| release_tag_year(query_title));
    if let (Some(p), Some(d)) = (provider_year, details_year) {
        return if years_agree(p, d, media) {
            ProviderIdVerdict::Corroborated
        } else {
            ProviderIdVerdict::Contradicted
        };
    }
    if details_match_provider_title(details_titles, query_title) {
        ProviderIdVerdict::Corroborated
    } else {
        ProviderIdVerdict::Inconclusive
    }
}

/// Does a details payload plausibly describe the queried title? Never
/// reports a mismatch when there is nothing to compare against.
pub fn details_match_provider_title(details_titles: &[&str], query_title: &str) -> bool {
    let variants = build_search_title_variants(query_title, None);
    if variants.is_empty() {
        return true;
    }
    details_titles.iter().any(|t| {
        let n = normalize_title(t);
        !n.is_empty() && variants.contains(&n)
    })
}

/// Provider `tmdb_id` values arrive as numbers or garbage; keep positive ids.
pub fn parse_provider_tmdb_id(id: Option<i64>) -> Option<i64> {
    id.filter(|v| *v > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn movie(id: i64, title: &str, date: &str, votes: i64) -> SearchResult {
        SearchResult {
            id,
            title: Some(title.into()),
            release_date: Some(date.into()),
            vote_count: Some(votes),
            ..Default::default()
        }
    }

    fn tv(id: i64, name: &str, date: &str) -> SearchResult {
        SearchResult {
            id,
            name: Some(name.into()),
            first_air_date: Some(date.into()),
            vote_count: Some(100),
            ..Default::default()
        }
    }

    fn matrix() -> (SearchResult, SearchResult) {
        (
            movie(603, "The Matrix", "1999-03-31", 20000),
            movie(624860, "The Matrix Resurrections", "2021-12-16", 5000),
        )
    }

    const M: TmdbMediaType = TmdbMediaType::Movie;

    #[test]
    fn keys_are_stable() {
        assert_eq!(
            search_lookup_key("the matrix", Some(1999), "en-US"),
            "title:the matrix|year:1999|lang:en-US|v1"
        );
        assert_eq!(
            search_lookup_key("the matrix", None, "en-US"),
            "title:the matrix|year:|lang:en-US|v1"
        );
        assert_eq!(details_lookup_key(603, "de-DE"), "id:603|lang:de-DE|v1");
        assert_eq!(
            season_lookup_key(1, 2, "en-US"),
            "id:1|season:2|lang:en-US|v1"
        );
    }

    #[test]
    fn variants() {
        assert_eq!(
            build_search_title_variants("Пацаны", Some("The Boys")),
            vec!["the boys", "пацаны"]
        );
        assert_eq!(
            build_search_title_variants("DE Batman", None),
            vec!["de batman", "batman"]
        );
        assert_eq!(
            build_search_title_variants("English The Godfather", None),
            vec!["english the godfather", "the godfather"]
        );
        assert_eq!(
            build_search_title_variants("It Follows", None)[0],
            "it follows"
        );
        assert_eq!(
            build_search_title_variants("The Boys", Some("The Boys")),
            vec!["the boys"]
        );
        assert!(build_search_title_variants("", None).is_empty());
    }

    #[test]
    fn provider_ids() {
        assert_eq!(parse_provider_tmdb_id(Some(603)), Some(603));
        assert_eq!(parse_provider_tmdb_id(Some(0)), None);
        assert_eq!(parse_provider_tmdb_id(Some(-5)), None);
        assert_eq!(parse_provider_tmdb_id(None), None);
    }

    #[test]
    fn exact_title_with_matching_year() {
        let (m99, m21) = matrix();
        let rs = [m21, m99];
        assert_eq!(
            pick_confident_match(&rs, "The Matrix (1999)", Some(1999), M)
                .unwrap()
                .id,
            603
        );
    }

    #[test]
    fn year_tolerance() {
        let (m99, _) = matrix();
        let rs = [m99];
        assert_eq!(
            pick_confident_match(&rs, "The Matrix", Some(2000), M)
                .unwrap()
                .id,
            603
        );
        assert!(pick_confident_match(&rs, "The Matrix", Some(2005), M).is_none());
        assert!(pick_confident_match(&rs, "The Matrix", Some(2026), M).is_none());
    }

    #[test]
    fn rejects_partial_titles() {
        let (_, m21) = matrix();
        assert!(pick_confident_match(&[m21], "The Matrix", Some(2021), M).is_none());
    }

    #[test]
    fn without_year_title_must_be_unambiguous() {
        let (m99, _) = matrix();
        assert_eq!(
            pick_confident_match(std::slice::from_ref(&m99), "The Matrix", None, M)
                .unwrap()
                .id,
            603
        );
        let remake = movie(999, "The Matrix", "2030-01-01", 0);
        assert!(pick_confident_match(&[m99, remake], "The Matrix", None, M).is_none());
    }

    #[test]
    fn disambiguates_by_votes() {
        let (m99, _) = matrix();
        let obscure = movie(111, "The Matrix", "1998-05-01", 3);
        assert_eq!(
            pick_confident_match(&[obscure, m99], "The Matrix", Some(1999), M)
                .unwrap()
                .id,
            603
        );
    }

    #[test]
    fn matches_original_title() {
        let amelie = SearchResult {
            id: 194,
            title: Some("Amélie".into()),
            original_title: Some("Le Fabuleux Destin d’Amélie Poulain".into()),
            release_date: Some("2001-04-25".into()),
            ..Default::default()
        };
        assert_eq!(
            pick_confident_match(
                &[amelie],
                "Le fabuleux destin d’Amelie Poulain",
                Some(2001),
                M
            )
            .unwrap()
            .id,
            194
        );
    }

    #[test]
    fn tv_uses_name_fields_and_season_year() {
        let dark = tv(70523, "Dark", "2017-12-01");
        assert_eq!(
            pick_confident_match(&[dark], "Dark", Some(2017), TmdbMediaType::Tv)
                .unwrap()
                .id,
            70523
        );
        let boys = tv(76479, "The Boys", "2019-07-26");
        assert_eq!(
            pick_confident_match(&[boys], "The Boys s05", Some(2026), TmdbMediaType::Tv)
                .unwrap()
                .id,
            76479
        );
    }

    #[test]
    fn empty_inputs() {
        let (m99, _) = matrix();
        assert!(pick_confident_match(&[], "The Matrix", Some(1999), M).is_none());
        assert!(pick_confident_match(&[m99], "", None, M).is_none());
    }

    #[test]
    fn fuzzy_tier_requires_year_and_similarity() {
        // "Spiderman" vs "Spider-Man" normalize differently; similarity ~0.9.
        let spidey = movie(557, "Spider Man", "2002-05-01", 1000);
        assert_eq!(
            pick_confident_match(std::slice::from_ref(&spidey), "Spiderman", Some(2002), M)
                .unwrap()
                .id,
            557
        );
        assert!(
            pick_confident_match(std::slice::from_ref(&spidey), "Spiderman", None, M).is_none()
        );
        assert!(pick_confident_match(&[spidey], "Spiderman", Some(2010), M).is_none());
    }

    #[test]
    fn trailing_year_title_falls_back_to_exact_form() {
        let br82 = movie(78, "Blade Runner", "1982-06-25", 13000);
        let br49 = movie(335984, "Blade Runner 2049", "2017-10-04", 12000);
        let rs = [br82, br49];
        let keys = normalize_title_keys("Blade Runner 2049");
        // Year inferred from the title: tiers 1-2 fail, tier 3 finds 2049.
        let m = match_results(&rs, &keys.base, &keys, Some(2049), false, M).unwrap();
        assert_eq!(m.id, 335984);
        // An explicit provider year disables the inference fallback.
        assert!(match_results(&rs, &keys.base, &keys, Some(2049), true, M).is_none());
        // "The Matrix 1999" still resolves through tier 1.
        let (m99, _) = matrix();
        let k = normalize_title_keys("The Matrix 1999");
        assert_eq!(
            match_results(&[m99], &k.base, &k, Some(1999), false, M)
                .unwrap()
                .id,
            603
        );
    }

    #[test]
    fn provider_id_verdicts() {
        use ProviderIdVerdict::*;
        assert_eq!(
            assess_provider_id(
                &["Blade Runner"],
                Some(1982),
                "Blade Runner 2049",
                Some(2017),
                M
            ),
            Contradicted
        );
        assert_eq!(
            assess_provider_id(&["The Matrix"], Some(1999), "The Matrix", Some(2000), M),
            Corroborated
        );
        assert_eq!(
            assess_provider_id(&["Der Pate"], None, "The Godfather", None, M),
            Inconclusive
        );
        assert_eq!(
            assess_provider_id(&["The Matrix"], None, "EN - The Matrix 1080p", None, M),
            Corroborated
        );
        // TV: premiere before the provider's season year agrees.
        assert_eq!(
            assess_provider_id(
                &["The Boys"],
                Some(2019),
                "The Boys",
                Some(2026),
                TmdbMediaType::Tv
            ),
            Corroborated
        );
    }

    #[test]
    fn details_title_check() {
        assert!(details_match_provider_title(
            &["The Matrix"],
            "EN - The Matrix (1999) 1080p"
        ));
        assert!(details_match_provider_title(
            &["Die Hard", "Stirb langsam"],
            "Stirb langsam"
        ));
        assert!(details_match_provider_title(&["The Boys"], "The Boys s05"));
        assert!(!details_match_provider_title(
            &["The Matrix"],
            "Blade Runner"
        ));
        assert!(details_match_provider_title(&["The Matrix"], ""));
        assert!(!details_match_provider_title(&[], "The Matrix"));
    }
}
