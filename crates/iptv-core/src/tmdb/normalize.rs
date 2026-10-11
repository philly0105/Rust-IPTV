//! Provider-title normalization for TMDB matching.
//!
//! A port of the old app's `title-normalization.util.ts`. Provider titles are
//! noisy (`"4K-DE - The Pitt (2025) (US)"`, `"Fallout_eng"`,
//! `"The Boys s05"`); these functions reduce every observed variant of a
//! title to one comparable key. The JS original leans on regex lookaheads,
//! which the `regex` crate lacks; each one is rewritten as a capture plus a
//! check in code, with the same accept/reject behavior (the ported tests
//! below pin it).

use once_cell::sync::Lazy;
use regex::Regex;

const QUALITY_TAGS: &[&str] = &[
    "4k", "uhd", "fhd", "hd", "sd", "hdr", "hevc", "h264", "h265", "x264", "x265", "480p", "720p",
    "1080p", "2160p", "multi", "multisub", "vostfr", "vf", "dubbed",
];

/// Trailing language/subtitle tags (vocabulary-gated so real endings like
/// "Rocky II", "Made in USA", "NCIS: LA" survive).
const TRAILING_TAG_VOCABULARY: &[&str] = &[
    "AF", "AL", "ALB", "AR", "BY", "DE", "DUB", "EN", "ENG", "ES", "ESP", "EXYU", "FR", "FRA",
    "GE", "GR", "HU", "IN", "IR", "IS", "IT", "ITA", "KA", "KU", "LAT", "ML", "MSUB", "MULTI",
    "NL", "PL", "PT", "RO", "RU", "SC", "SE", "SUB", "SUBS", "SW", "TA", "TL", "TR", "TUR",
];

/// Vocabulary tags that are also English hyphenated-word endings
/// ("drive-in", "plug-in"); only accepted after a strong separator.
const WEAK_JOIN_EXCLUSIONS: &[&str] = &["IN"];

/// Season words in the languages providers use.
pub const SEASON_WORD_ALTERNATIVES: &str = "season|сезон|staffel|temporada|saison";

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: Lazy<Regex> = Lazy::new(|| Regex::new($pat).expect("valid regex"));
    };
}

// "|DE| ARD", "|MULTI| Fallout". The token must contain a letter (checked in code).
re!(WRAPPED_TAG_PREFIX, r"^\s*\|([A-Z0-9+]{2,5})\|\s*");
// Bracketed groups; inner classes exclude the opening delimiter so runaway
// input backtracks linearly.
re!(BRACKET_GROUPS, r"\[[^\]\[]*\]|\([^()]*\)|\{[^{}]*\}");
// Leading "EN - ", "DE| ", "FR: ", "4K-DE - ", "EXYU| ". Segment rules are
// enforced in `strip_language_prefix`.
re!(
    LANGUAGE_PREFIX,
    r"^([A-Z0-9+]{2,5}(?:-[A-Z0-9+]{2,6}){0,2})\s*([-|:])\s+"
);
re!(DOUBLE_DASH_SUFFIX, r"[-–]{2}[A-Za-z]{2,5}\s*$");
re!(UNDERSCORE_SUFFIX, r"_([A-Za-z]{2,5})\s*$");
re!(JOINED_DASH_SUFFIX, r"-([A-Za-z]{2,5})\s*$");
re!(TRAILING_TAG_SUFFIX, r"\s([A-Z]{2,5})\s*$");
re!(HAS_LOWERCASE, r"\p{Ll}");
re!(NON_ALNUM, r"[^\p{L}\p{N}]+");
// JS `\b` is ASCII-only; keep that so "Фильм2019" still yields 2019.
re!(YEAR_PATTERN, r"(?-u:\b)(19[0-9]{2}|20[0-9]{2})(?-u:\b)");
re!(TRAILING_YEAR_PATTERN, r"(?:^|\s)(19[0-9]{2}|20[0-9]{2})$");
re!(
    BRACKETED_YEAR_PATTERN,
    r"[(\[{]\s*(19[0-9]{2}|20[0-9]{2})\s*[)\]}]"
);
static SEASON_SUFFIX_PATTERN: Lazy<Regex> = Lazy::new(|| {
    let w = SEASON_WORD_ALTERNATIVES;
    Regex::new(&format!(
        r"(?i)(?:^|\s)(?:s[0-9]{{1,2}}|(?:{w})\s*[0-9]{{1,2}}|[0-9]{{1,2}}\s*(?:st|nd|rd|th|й|и|я|ой|ои)?\s+(?:{w}))$"
    ))
    .expect("valid regex")
});

fn has_ascii_upper(s: &str) -> bool {
    s.bytes().any(|b| b.is_ascii_uppercase())
}

fn strip_wrapped_tag(s: &str) -> &str {
    match WRAPPED_TAG_PREFIX.captures(s) {
        Some(c) if has_ascii_upper(&c[1]) => &s[c.get(0).map_or(0, |m| m.end())..],
        _ => s,
    }
}

/// Removes one leading channel/language prefix. Rules (from the JS):
/// every segment contains a letter; dash separators allow a compound tag or
/// a single 2-3 char segment; pipes allow a compound or 2-5 chars; colons
/// allow only a single 2-3 char segment.
fn strip_language_prefix(s: &str) -> &str {
    let Some(c) = LANGUAGE_PREFIX.captures(s) else {
        return s;
    };
    let tag = &c[1];
    let sep = &c[2];
    let parts: Vec<&str> = tag.split('-').collect();
    if !parts.iter().all(|p| has_ascii_upper(p)) {
        return s;
    }
    let ok = if parts.len() > 1 {
        sep != ":"
    } else {
        let n = tag.len();
        match sep {
            "|" => (2..=5).contains(&n),
            _ => (2..=3).contains(&n),
        }
    };
    if ok {
        &s[c.get(0).map_or(0, |m| m.end())..]
    } else {
        s
    }
}

fn in_vocab(token: &str) -> bool {
    TRAILING_TAG_VOCABULARY.contains(&token)
}

fn is_case_uniform(token: &str) -> bool {
    token == token.to_lowercase() || token == token.to_uppercase()
}

fn is_joined_tag(token: &str) -> bool {
    let upper = token.to_uppercase();
    in_vocab(&upper) && !WEAK_JOIN_EXCLUSIONS.contains(&upper.as_str()) && is_case_uniform(token)
}

fn strip_trailing_tag_once(value: &str) -> String {
    let result = value.trim_end();
    let has_lowercase = HAS_LOWERCASE.is_match(result);

    if DOUBLE_DASH_SUFFIX.is_match(result) {
        return DOUBLE_DASH_SUFFIX
            .replace(result, "")
            .trim_end()
            .to_string();
    }
    if let Some(c) = UNDERSCORE_SUFFIX.captures(result) {
        if result.find('_') == result.rfind('_') && is_joined_tag(&c[1]) {
            return UNDERSCORE_SUFFIX.replace(result, "").trim_end().to_string();
        }
    }
    if let Some(c) = JOINED_DASH_SUFFIX.captures(result) {
        if has_lowercase && is_joined_tag(&c[1]) {
            return JOINED_DASH_SUFFIX
                .replace(result, "")
                .trim_end()
                .to_string();
        }
    }
    if let Some(c) = TRAILING_TAG_SUFFIX.captures(result) {
        if has_lowercase && in_vocab(&c[1]) {
            return TRAILING_TAG_SUFFIX
                .replace(result, "")
                .trim_end()
                .to_string();
        }
    }
    result.to_string()
}

/// Strips appended language/subtitle tags, repeating so compound tags
/// ("FR-EN") shed one token per pass.
fn strip_trailing_tags(value: &str) -> String {
    let mut result = value.to_string();
    for _ in 0..3 {
        let next = strip_trailing_tag_once(&result);
        if next == result {
            break;
        }
        result = next;
    }
    result
}

/// Precomposed characters and their NFD base letter. Rust's std has no
/// Unicode normalization; this covers Latin-1, Latin Extended-A/B letters
/// with canonical decompositions, Greek tonos/dialytika, and the Cyrillic
/// letters whose decomposition the JS NFD pass relied on (й -> и, ё -> е).
/// Letters without a canonical decomposition (ø, æ, ß, ł, đ) are kept, as
/// they are by NFD.
const FOLD: &[(&str, char)] = &[
    ("ÀÁÂÃÄÅĀĂĄǍǞǠǺȀȂȦ", 'A'),
    ("àáâãäåāăąǎǟǡǻȁȃȧ", 'a'),
    ("ÇĆĈĊČ", 'C'),
    ("çćĉċč", 'c'),
    ("ĎḌ", 'D'),
    ("ďḍ", 'd'),
    ("ÈÉÊËĒĔĖĘĚȄȆȨẸẺẼ", 'E'),
    ("èéêëēĕėęěȅȇȩẹẻẽ", 'e'),
    ("ĜĞĠĢǦǴ", 'G'),
    ("ĝğġģǧǵ", 'g'),
    ("ĤȞḤ", 'H'),
    ("ĥȟḥ", 'h'),
    ("ÌÍÎÏĨĪĬĮİǏȈȊỊỈ", 'I'),
    ("ìíîïĩīĭįǐȉȋịỉ", 'i'),
    ("Ĵ", 'J'),
    ("ĵǰ", 'j'),
    ("ĶǨ", 'K'),
    ("ķǩ", 'k'),
    ("ĹĻĽ", 'L'),
    ("ĺļľ", 'l'),
    ("ÑŃŅŇǸ", 'N'),
    ("ñńņňǹ", 'n'),
    ("ÒÓÔÕÖŌŎŐƠǑǪǬȌȎȮȰỌỎ", 'O'),
    ("òóôõöōŏőơǒǫǭȍȏȯȱọỏ", 'o'),
    ("ŔŖŘȐȒ", 'R'),
    ("ŕŗřȑȓ", 'r'),
    ("ŚŜŞŠȘ", 'S'),
    ("śŝşšș", 's'),
    ("ŢŤȚ", 'T'),
    ("ţťț", 't'),
    ("ÙÚÛÜŨŪŬŮŰŲƯǓǕǗǙǛȔȖỤỦ", 'U'),
    ("ùúûüũūŭůűųưǔǖǘǚǜȕȗụủ", 'u'),
    ("Ŵ", 'W'),
    ("ŵ", 'w'),
    ("ÝŶŸȲỲỸ", 'Y'),
    ("ýÿŷȳỳỹ", 'y'),
    ("ŹŻŽ", 'Z'),
    ("źżž", 'z'),
    ("Ά", 'Α'),
    ("ά", 'α'),
    ("Έ", 'Ε'),
    ("έ", 'ε'),
    ("Ή", 'Η'),
    ("ή", 'η'),
    ("ΊΪ", 'Ι'),
    ("ίϊΐ", 'ι'),
    ("Ό", 'Ο'),
    ("ό", 'ο'),
    ("ΎΫ", 'Υ'),
    ("ύϋΰ", 'υ'),
    ("Ώ", 'Ω'),
    ("ώ", 'ω'),
    ("Й", 'И'),
    ("й", 'и'),
    ("ЁЀ", 'Е'),
    ("ёѐ", 'е'),
    ("Ї", 'І'),
    ("ї", 'і'),
    ("Ў", 'У'),
    ("ў", 'у'),
    ("Ѓ", 'Г'),
    ("ѓ", 'г'),
    ("Ќ", 'К'),
    ("ќ", 'к'),
];

fn fold_char(c: char) -> Option<char> {
    if c.is_ascii() {
        return Some(c);
    }
    // Combining diacritical marks (what NFD leaves behind) are dropped.
    if ('\u{0300}'..='\u{036F}').contains(&c) {
        return None;
    }
    for (set, base) in FOLD {
        if set.contains(c) {
            return Some(*base);
        }
    }
    Some(c)
}

/// Strips diacritics the way `normalize('NFD').replace(/[\u0300-\u036F]/g, '')` does.
pub fn strip_diacritics(s: &str) -> String {
    s.chars().filter_map(fold_char).collect()
}

/// A provider title normalized on two tiers. Trailing years are ambiguous:
/// usually a release tag ("The Matrix 1999"), sometimes part of the title
/// ("Blade Runner 2049"), so matching tries both.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NormalizedTitleKeys {
    /// Fully normalized, trailing year kept ("blade runner 2049").
    pub exact: String,
    /// Trailing year stripped ("blade runner"); equals `exact` if none.
    pub base: String,
    /// The trailing year removed in `base`.
    pub trailing_year: Option<i64>,
}

fn strip_season(value: &str) -> String {
    let stripped = SEASON_SUFFIX_PATTERN.replace(value, "");
    let stripped = stripped.trim();
    if stripped.is_empty() {
        value.to_string()
    } else {
        stripped.to_string()
    }
}

pub fn normalize_title_keys(raw: &str) -> NormalizedTitleKeys {
    if raw.is_empty() {
        return NormalizedTitleKeys::default();
    }
    let s = strip_wrapped_tag(raw);
    let s = BRACKET_GROUPS.replace_all(s, " ");
    let s = strip_language_prefix(&s);
    let s = strip_trailing_tags(s);
    let s = strip_diacritics(&s).to_lowercase();
    // Fold final sigma into the medial form (what Unicode case folding does).
    let s = s.replace('ς', "σ");
    let s = NON_ALNUM.replace_all(&s, " ");
    let cleaned = s
        .split(' ')
        .filter(|t| !t.is_empty() && !QUALITY_TAGS.contains(t))
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = cleaned.trim();

    let exact = strip_season(cleaned);
    let year = TRAILING_YEAR_PATTERN
        .captures(cleaned)
        .and_then(|c| c[1].parse::<i64>().ok());
    let without_year = TRAILING_YEAR_PATTERN.replace(cleaned, "");
    let without_year = without_year
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    match year {
        Some(y) if !without_year.is_empty() => NormalizedTitleKeys {
            exact,
            base: strip_season(&without_year),
            trailing_year: Some(y),
        },
        _ => NormalizedTitleKeys {
            base: exact.clone(),
            exact,
            trailing_year: None,
        },
    }
}

/// Base-tier key (trailing year stripped). Empty for empty input.
pub fn normalize_title(raw: &str) -> String {
    normalize_title_keys(raw).base
}

/// True when two years do not contradict each other (unknown never blocks; ±1 tolerance).
pub fn title_years_compatible(a: Option<i64>, b: Option<i64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= 1,
        _ => true,
    }
}

/// Release year from a date string, else from any year in a raw title.
pub fn extract_year(release_date: Option<&str>, raw_title: Option<&str>) -> Option<i64> {
    let find = |s: Option<&str>| {
        YEAR_PATTERN
            .captures(s?)
            .and_then(|c| c[1].parse::<i64>().ok())
    };
    find(release_date).or_else(|| find(raw_title))
}

/// The year a provider title states as a release TAG (bracketed or
/// trailing), never one that belongs to the name ("2001: A Space Odyssey").
pub fn release_tag_year(raw_title: &str) -> Option<i64> {
    if raw_title.is_empty() {
        return None;
    }
    if let Some(c) = BRACKETED_YEAR_PATTERN.captures(raw_title) {
        return c[1].parse().ok();
    }
    normalize_title_keys(raw_title).trailing_year
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(exact: &str, base: &str, year: Option<i64>) -> NormalizedTitleKeys {
        NormalizedTitleKeys {
            exact: exact.into(),
            base: base.into(),
            trailing_year: year,
        }
    }

    #[test]
    fn keeps_trailing_year_in_exact_and_strips_in_base() {
        assert_eq!(
            normalize_title_keys("Blade Runner 2049"),
            keys("blade runner 2049", "blade runner", Some(2049))
        );
        assert_eq!(
            normalize_title_keys("Blade Runner"),
            keys("blade runner", "blade runner", None)
        );
        assert_eq!(
            normalize_title_keys("The Matrix 1999 [4K] (Remastered)"),
            keys("the matrix 1999", "the matrix", Some(1999))
        );
        assert_eq!(normalize_title_keys("2012"), keys("2012", "2012", None));
    }

    #[test]
    fn keeps_leading_and_mid_title_years() {
        assert_eq!(
            normalize_title("2001: A Space Odyssey"),
            "2001 a space odyssey"
        );
    }

    #[test]
    fn only_strips_uppercase_language_prefixes() {
        assert_eq!(normalize_title("EN - The Boys s05"), "the boys");
        assert_eq!(normalize_title("It: Chapter Two"), "it chapter two");
    }

    #[test]
    fn strips_season_suffixes() {
        assert_eq!(normalize_title_keys("The Boys s05").exact, "the boys");
        assert_eq!(normalize_title_keys("Пацаны сезон 2").base, "пацаны");
        assert_eq!(
            normalize_title("The Mandalorian 2 Season"),
            "the mandalorian"
        );
        assert_eq!(
            normalize_title("The Mandalorian 2nd Season"),
            "the mandalorian"
        );
        assert_eq!(normalize_title("Мандалорец 2 сезон"), "мандалорец");
        assert_eq!(normalize_title("Пацаны 2-й сезон"), "пацаны");
        assert_eq!(normalize_title("Best of 2 Seasons"), "best of 2 seasons");
        assert_eq!(normalize_title("The Boys S01"), "the boys");
        assert_eq!(normalize_title("Breaking Bad Season 2"), "breaking bad");
        assert_eq!(normalize_title("Пацаны сезон 3"), "пацаны");
        assert_eq!(normalize_title("Dark Staffel 2"), "dark");
        assert_eq!(
            normalize_title("Season of the Witch"),
            "season of the witch"
        );
    }

    #[test]
    fn folds_greek_sigma() {
        assert_eq!(normalize_title("ΑΣ"), normalize_title("Ας"));
        assert_eq!(normalize_title("ασ"), normalize_title("ας"));
        assert_eq!(normalize_title("ΑΣ"), normalize_title("ασ"));
        assert_eq!(normalize_title("Ο Άρχοντας"), normalize_title("ο αρχοντασ"));
        assert_ne!(normalize_title("ΑΣ"), normalize_title("ΑΝ"));
        assert_ne!(normalize_title("ΟΣ"), normalize_title("ΑΣ"));
    }

    #[test]
    fn basic_normalization() {
        assert_eq!(
            normalize_title("The Matrix: Reloaded!"),
            "the matrix reloaded"
        );
        assert_eq!(
            normalize_title("The Matrix (1999) [4K] MULTI"),
            "the matrix"
        );
        assert_eq!(normalize_title("EN - The Matrix"), "the matrix");
        assert_eq!(normalize_title("DE| Der Untergang"), "der untergang");
        assert_eq!(normalize_title("Amélie"), "amelie");
        assert_eq!(normalize_title("The Matrix 1999"), "the matrix");
        assert_eq!(normalize_title(""), "");
    }

    #[test]
    fn strips_wrapped_and_compound_tags() {
        assert_eq!(normalize_title("|DE| ARD"), "ard");
        assert_eq!(normalize_title("|MULTI| Fallout - 4K"), "fallout");
        assert_eq!(normalize_title("|EXYU| The Pitt"), "the pitt");
        assert_eq!(normalize_title("EXYU| Fallout"), "fallout");
        assert_eq!(normalize_title("MULTI| Breaking Bad"), "breaking bad");
        assert_eq!(normalize_title("4K-DE - The Pitt (2025) (US)"), "the pitt");
        assert_eq!(normalize_title("AR-SUBS - Fallout (2024) (US)"), "fallout");
        assert_eq!(
            normalize_title("4K-OSN+ - The Last of Us (2023)"),
            "the last of us"
        );
        assert_eq!(
            normalize_title("1917 - Behind the Lines"),
            "1917 behind the lines"
        );
        assert_eq!(normalize_title("DUNE - Part Two"), "dune part two");
        assert_eq!(normalize_title("ALIEN - Covenant"), "alien covenant");
    }

    #[test]
    fn suffix_tags() {
        assert_eq!(normalize_title("Fallout_eng"), "fallout");
        assert_eq!(normalize_title("Breaking Bad (US)_msub"), "breaking bad");
        assert_eq!(normalize_title("The Pitt (2025)_sub"), "the pitt");
        assert_eq!(normalize_title("The Last of Us--esp"), "the last of us");
        assert_eq!(normalize_title("The_Last_of_Us"), "the last of us");
        assert_eq!(normalize_title("Mr_Robot"), "mr robot");
        assert_eq!(normalize_title("Cowboy_Bebop"), "cowboy bebop");
        assert_eq!(normalize_title("Mrs_Davis"), "mrs davis");
        assert_eq!(normalize_title("Breaking Bad-eng"), "breaking bad");
        assert_eq!(normalize_title("The Last of Us-DE"), "the last of us");
        assert_eq!(normalize_title("The Pitt (2025)-it"), "the pitt");
        assert_eq!(normalize_title("Spider-Man"), "spider man");
        assert_eq!(normalize_title("Kick-It"), "kick it");
        assert_eq!(normalize_title("drive-in"), "drive in");
        assert_eq!(normalize_title("Plug-in"), "plug in");
        assert_eq!(normalize_title("The Pitt (2025) DE"), "the pitt");
        assert_eq!(normalize_title("Breaking Bad ES"), "breaking bad");
        assert_eq!(normalize_title("EN| Breaking Bad SUB"), "breaking bad");
        assert_eq!(
            normalize_title("The Last of Us (2023) AF"),
            "the last of us"
        );
    }

    #[test]
    fn keeps_real_endings() {
        assert_eq!(normalize_title("Rocky II"), "rocky ii");
        assert_eq!(normalize_title("Made in USA"), "made in usa");
        assert_eq!(normalize_title("NCIS: LA"), "ncis la");
        assert_eq!(normalize_title("Making It"), "making it");
        assert_eq!(normalize_title("THE LAST OF US"), "the last of us");
        assert_eq!(
            normalize_title("Breaking Bad: A Química do Mal"),
            "breaking bad a quimica do mal"
        );
    }

    #[test]
    fn provider_corpora_collapse_to_one_key() {
        let corpora: &[(&str, &[&str])] = &[
            (
                "the pitt",
                &[
                    "The Pitt (2025)_sub",
                    "The Pitt (2025)-it",
                    "The Pitt (2025)",
                    "The Pitt (Hindi)",
                    "The Pitt (2025) 4K",
                    "The Pitt (2025) DE",
                    "The Pitt (2025) ES",
                    "The Pitt (2025) FR",
                    "The Pitt (2025)_eng",
                    "The Pitt [MULTI-SUB]",
                    "The Pitt (2025) (4K DV)",
                    "GR - The Pitt",
                    "4K-DE - The Pitt (2025) (US)",
                    "4K-TR - The Pitt (2025) (US)",
                    "AR-SUBS - The Pitt (2025) (US)",
                    "DE - The Pitt (2025) (US)",
                    "ALB| The Pitt",
                    "EXYU| The Pitt",
                    "|ALB| The Pitt",
                    "|DE| The Pitt",
                ],
            ),
            (
                "fallout",
                &[
                    "Fallout",
                    "DE - Fallout (2024)",
                    "Fallout (2024) - 4K",
                    "Fallout (2024) FR-EN",
                    "Fallout (2024) Multi",
                    "Fallout (2024)_fr",
                    "Fallout_esp",
                    "Fallout (4K)",
                    "4K-AMZ - Fallout (2024) (US)",
                    "AL - Fallout (2024)",
                    "AMZ - Fallout (2024) (US)",
                    "AR-DE - Fallout (US)",
                    "LA - Fallout",
                    "EN| Fallout - 4K",
                    "MULTI| Fallout - 4K",
                    "Fallout ( مدبلج )",
                    "Fallout (Telugu)",
                    "|EN| Fallout - 4K",
                    "|MULTI| Fallout",
                    "|TR| Fallout",
                ],
            ),
            (
                "the last of us",
                &[
                    "The Last of Us",
                    "The Last Of Us",
                    "The Last of Us (2023) 4K",
                    "The Last of Us (2023) AF",
                    "The Last of Us_tr",
                    "The Last of Us--esp",
                    "The Last of Us-DE",
                    "The Last of Us-esp",
                    "The Last of Us [L]",
                    "The Last of Us ( HD )",
                    "4K-OSN+ - The Last of Us (2023)",
                    "IS - The Last of Us (2023) (US)",
                    "RU - The Last of Us",
                    "ALB| The Last of Us",
                ],
            ),
            (
                "breaking bad",
                &[
                    "Breaking Bad",
                    "Breaking Bad (2008)_fr",
                    "Breaking Bad (US)_msub",
                    "Breaking Bad_it",
                    "Breaking Bad-DE",
                    "Breaking Bad-eng",
                    "Breaking Bad ( عائلي )",
                    "Breaking Bad (Pure)",
                    "Breaking Bad - Multi",
                    "Breaking Bad ES",
                    "AR-DE - Breaking Bad",
                    "EN| Breaking Bad SUB",
                    "MULTI| Breaking Bad",
                    "AR| Breaking Bad",
                ],
            ),
        ];
        for (expected, corpus) in corpora {
            for name in *corpus {
                assert_eq!(normalize_title_keys(name).base, *expected, "input: {name}");
            }
        }
    }

    #[test]
    fn years() {
        assert!(title_years_compatible(None, Some(2049)));
        assert!(title_years_compatible(Some(1999), None));
        assert!(title_years_compatible(Some(1999), Some(2000)));
        assert!(!title_years_compatible(Some(1982), Some(2049)));

        assert_eq!(
            extract_year(Some("1999-03-31"), Some("Movie 2005")),
            Some(1999)
        );
        assert_eq!(extract_year(None, Some("The Matrix (1999)")), Some(1999));
        assert_eq!(
            extract_year(Some(""), Some("The Matrix 2021 4K")),
            Some(2021)
        );
        assert_eq!(extract_year(None, Some("The Matrix")), None);
        assert_eq!(extract_year(Some("invalid"), None), None);
        // ASCII word boundary, as in JS: Cyrillic letters are not word chars.
        assert_eq!(extract_year(None, Some("Фильм2019")), Some(2019));
        assert_eq!(extract_year(None, Some("x19999")), None);
        assert_eq!(extract_year(None, Some("Фильм 2019")), Some(2019));

        assert_eq!(release_tag_year("Dune (2021)"), Some(2021));
        assert_eq!(release_tag_year("Dune [ 2021 ]"), Some(2021));
        assert_eq!(release_tag_year("The Matrix 1999"), Some(1999));
        assert_eq!(release_tag_year("2001: A Space Odyssey"), None);
        assert_eq!(release_tag_year(""), None);
    }
}
