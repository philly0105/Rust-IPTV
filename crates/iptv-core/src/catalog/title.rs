//! Title normalization for multi-source VOD matching (`catalog::title_base`).
//!
//! Provider titles carry noise around the real title: language prefixes
//! (`EN - `, `|FR| `, `[DE] `), quality tags (`[4K]`, `FHD`, `1080p`, `HEVC`),
//! and the year (`(2019)`, `- 2019`). `title_base` strips that noise so the
//! same movie from two providers compares equal, and returns the year when one
//! was present.

use once_cell::sync::Lazy;
use regex::Regex;

/// Two/three-letter codes accepted before a colon (`EN: Title`). A colon after
/// arbitrary capitals is too risky (`CSI: Miami`, `NCIS: Los Angeles`).
const COLON_PREFIX_CODES: &[&str] = &[
    "AL", "AR", "AT", "AU", "BE", "BG", "BR", "CA", "CH", "CN", "CZ", "DE", "DK", "EN", "ES", "EX",
    "FI", "FR", "GR", "HR", "HU", "IE", "IL", "IN", "IR", "IT", "JP", "KR", "KU", "LAT", "MX",
    "NL", "NO", "PK", "PL", "PT", "RO", "RS", "RU", "SE", "SI", "SK", "SQ", "TR", "UA", "UK", "US",
    "VOD", "VOSE", "4K",
];

/// `|EN|`, `[EN]`, `(EN)` style prefix tags (short, no spaces inside).
static BRACKET_PREFIX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:\|[^|\s]{1,8}\||\[[^\]\s]{1,8}\]|\([A-Za-z]{2,3}\))\s*[-:|]?\s*").unwrap()
});
/// `EN - Title`, `EN-US - Title`, `EN | Title`, `4K-EN - Title`.
static DASH_PREFIX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*[A-Z0-9]{1,3}[A-Z](?:[-_][A-Z]{2,4})?\s*(?:\s-|\|)\s+").unwrap());
/// `EN: Title` (code checked against [`COLON_PREFIX_CODES`]).
static COLON_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*([A-Z0-9]{2,4})\s*:\s+").unwrap());
/// `(2019)` or `[2019]` anywhere.
static PAREN_YEAR: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]").unwrap());
/// `Title - 2019` at the end.
static DASH_YEAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s[-–]\s*((?:19|20)\d{2})\s*$").unwrap());
/// Any bracketed tag (after the year has been extracted): `[4K]`, `[MULTI-SUB]`.
static BRACKET_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[[^\]]*\]").unwrap());
/// Parenthesized quality/language tags: `(4K)`, `(VOSTFR)`, `(Dual Audio)`.
static PAREN_TAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\(\s*(?:4k|uhd|fhd|hd|sd|hdr|hdr10|dv|1080p|720p|2160p|480p|hevc|x26[45]|h\.?26[45]|multi(?:[- ]?sub)?|vostfr|vost|vf|vo|dual(?: audio)?|sub(?:bed|s)?|dubbed|extended|remastered|imax|3d)\s*\)").unwrap()
});
/// Trailing quality tokens, repeated: `Title FHD`, `Title 1080p HEVC`.
static TRAILING_QUALITY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)[\s._|-]+(?:4k|uhd|fhd|hd|sd|hdr|hdr10|1080p|720p|2160p|480p|hevc|x26[45]|h\.?26[45]|multi(?:[- ]?sub)?|vostfr|vost|dual|imax|3d)\s*$").unwrap()
});
static SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

/// Upper bound for a plausible release year (current year + 2).
fn max_year() -> i64 {
    use chrono::Datelike;
    i64::from(chrono::Utc::now().year()) + 2
}

fn plausible_year(s: &str) -> Option<i64> {
    let y: i64 = s.parse().ok()?;
    (1900..=max_year()).contains(&y).then_some(y)
}

/// Strips language prefixes, quality tags and the year from a provider title.
/// Returns the cleaned base title and the year when one was found. When
/// stripping would leave nothing, the trimmed original is returned.
pub fn title_base(title: &str) -> (String, Option<i64>) {
    let original = title.trim();
    let mut s = original.to_string();
    let mut year = None;

    // Prefixes may stack: "|EN| 4K - Title".
    for _ in 0..3 {
        let before = s.len();
        if let Some(m) = BRACKET_PREFIX.find(&s) {
            if m.end() < s.len() {
                s = s[m.end()..].to_string();
            }
        }
        if let Some(m) = DASH_PREFIX.find(&s) {
            if m.end() < s.len() {
                s = s[m.end()..].to_string();
            }
        }
        if let Some(c) = COLON_PREFIX.captures(&s) {
            let code = c.get(1).map(|m| m.as_str()).unwrap_or_default();
            let end = c.get(0).map(|m| m.end()).unwrap_or(0);
            if COLON_PREFIX_CODES.contains(&code) && end < s.len() {
                s = s[end..].to_string();
            }
        }
        if s.len() == before {
            break;
        }
    }

    if let Some(c) = PAREN_YEAR.captures(&s) {
        if let Some(y) = c.get(1).and_then(|m| plausible_year(m.as_str())) {
            year = Some(y);
            let range = c.get(0).map(|m| m.range()).unwrap_or(0..0);
            s.replace_range(range, " ");
        }
    }
    if year.is_none() {
        if let Some(c) = DASH_YEAR.captures(&s) {
            if let Some(y) = c.get(1).and_then(|m| plausible_year(m.as_str())) {
                year = Some(y);
                let start = c.get(0).map(|m| m.start()).unwrap_or(s.len());
                s.truncate(start);
            }
        }
    }

    s = BRACKET_TAG.replace_all(&s, " ").into_owned();
    s = PAREN_TAG.replace_all(&s, " ").into_owned();
    loop {
        let next = TRAILING_QUALITY.replace(&s, "").into_owned();
        if next.len() == s.len() || next.trim().is_empty() {
            break;
        }
        s = next;
    }

    let s = SPACES.replace_all(&s, " ");
    let s = s.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c, '-' | '–' | ':' | '|' | '_' | '.' | ',')
    });
    if s.is_empty() {
        (original.to_string(), year)
    } else {
        (s.to_string(), year)
    }
}

#[cfg(test)]
mod tests {
    use super::title_base;

    fn tb(s: &str) -> (String, Option<i64>) {
        title_base(s)
    }

    #[test]
    fn strips_years_and_tags() {
        assert_eq!(tb("The Matrix (1999)"), ("The Matrix".into(), Some(1999)));
        assert_eq!(
            tb("The Matrix [4K] (1999)"),
            ("The Matrix".into(), Some(1999))
        );
        assert_eq!(tb("The Matrix - 1999"), ("The Matrix".into(), Some(1999)));
        assert_eq!(
            tb("Dune Part Two (2024) [MULTI-SUB] FHD"),
            ("Dune Part Two".into(), Some(2024))
        );
        assert_eq!(tb("Inception 1080p HEVC"), ("Inception".into(), None));
        assert_eq!(tb("Heat (VOSTFR) (1995)"), ("Heat".into(), Some(1995)));
    }

    #[test]
    fn strips_language_prefixes() {
        assert_eq!(
            tb("EN - The Matrix (1999)"),
            ("The Matrix".into(), Some(1999))
        );
        assert_eq!(tb("|EN| The Matrix"), ("The Matrix".into(), None));
        assert_eq!(tb("[FR] Amélie (2001)"), ("Amélie".into(), Some(2001)));
        assert_eq!(tb("EN: Up (2009)"), ("Up".into(), Some(2009)));
        assert_eq!(
            tb("4K-EN - Oppenheimer (2023)"),
            ("Oppenheimer".into(), Some(2023))
        );
    }

    #[test]
    fn keeps_meaningful_titles() {
        assert_eq!(tb("CSI: Miami").0, "CSI: Miami");
        assert_eq!(tb("24: Legacy").0, "24: Legacy");
        assert_eq!(tb("Blade Runner 2049"), ("Blade Runner 2049".into(), None));
        assert_eq!(tb("1917 (2019)"), ("1917".into(), Some(2019)));
        assert_eq!(tb("HD"), ("HD".into(), None));
        assert_eq!(tb("  "), ("".into(), None));
        assert_eq!(tb("Movie (3000)").1, None);
    }
}
