//! Language of a catalog item, for the English-only mode (`englishOnly`).
//!
//! Providers tag titles with a language or country prefix ("FR - Le Film",
//! "|DE| ZDF", "[AR] MBC") and categories with a code or a name ("VOD - SPAIN
//! [ES]", "FRANCE HD", "ARABIC"). The title prefix wins; the category is the
//! fallback for titles without one. Mirrors `src/features/vod/lib/language.ts`
//! (keep both tables in step).
//!
//! The filter only hides what is clearly another language: no prefix, an
//! unknown code, a multi-subtitle group, or a service/quality prefix ("NF",
//! "4K") all stay visible. The rule runs in SQL as `non_english(title,
//! category_name)`, registered on every connection by [`register`].

use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;

/// Detected language: a BCP 47 tag, or a group of languages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Tag(&'static str),
    Group(Group),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Multisub,
    Scandinavian,
    African,
    Indian,
    SouthIndian,
    ExYu,
}

use Group::*;
use Lang::{Group as G, Tag as T};

/// Provider codes. Not ISO 639-1: country codes and three-letter forms are
/// what panels use.
fn code(upper: &str) -> Option<Lang> {
    Some(match upper {
        "EN" | "ENG" | "UK" | "US" | "USA" | "AU" | "NZ" | "IE" => T("en"),
        "FR" | "FRA" => T("fr"),
        "DE" | "GER" | "AT" => T("de"),
        "ES" | "SP" | "ESP" => T("es"),
        "LA" | "LAT" | "LATINO" | "LATAM" | "MX" => T("es-419"),
        "IT" | "ITA" => T("it"),
        "NL" | "NED" => T("nl"),
        "PL" | "POL" => T("pl"),
        "RU" | "RUS" => T("ru"),
        "PT" | "POR" => T("pt"),
        "BR" | "BRA" => T("pt-BR"),
        "AR" | "ARA" | "ARAB" => T("ar"),
        "HU" => T("hu"),
        "RO" => T("ro"),
        "TR" | "TUR" => T("tr"),
        "FI" | "FIN" => T("fi"),
        "NO" | "NOR" => T("no"),
        "SE" | "SV" | "SWE" => T("sv"),
        "IS" => T("is"),
        "GR" | "EL" | "GRE" => T("el"),
        "DK" | "DA" | "DEN" => T("da"),
        "AL" | "ALB" => T("sq"),
        "BG" => T("bg"),
        "IR" | "FA" => T("fa"),
        "SOM" | "SO" => T("so"),
        "PK" | "UR" => T("ur"),
        "PB" | "PA" => T("pa"),
        "TG" | "TE" => T("te"),
        "TM" | "TA" => T("ta"),
        "KD" | "KN" => T("kn"),
        "MR" => T("mr"),
        "ML" => T("ml"),
        "HI" => T("hi"),
        "EX" | "EXYU" | "YU" => G(ExYu),
        "HR" => T("hr"),
        "RS" | "SR" => T("sr"),
        "BA" => T("bs"),
        "CZ" | "CS" => T("cs"),
        "SK" => T("sk"),
        "UA" => T("uk"),
        "KU" => T("ku"),
        "KR" | "KO" => T("ko"),
        "JP" | "JA" => T("ja"),
        "CN" | "ZH" => T("zh"),
        "HE" | "IL" => T("he"),
        "VN" => T("vi"),
        "TH" => T("th"),
        "MULTISUB" | "MULTI" | "MU" => G(Multisub),
        "SC" | "SCAND" => G(Scandinavian),
        "AF" => G(African),
        "IN" | "IND" => G(Indian),
        "STH" => G(SouthIndian),
        _ => return None,
    })
}

/// Prefixes that name a service, a quality, or a list rather than a language.
const NOT_LANGUAGE: [&str; 17] = [
    "NF", "D+", "4K", "UHD", "FHD", "HD", "SD", "3D", "TOP", "SPT", "FBI", "EM", "VIP", "NEW",
    "KIDS", "VOD", "SRS",
];

/// Category keywords, for categories without a code. First match wins.
static CATEGORY_WORDS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    [
        (r"\bENGLISH\b", "EN"),
        (r"\bFRENCH\b|\bFRAN[CÇ]AIS\b|\bFRANCE\b|\bQUEBEC\b", "FR"),
        (r"\bGERMAN\b|\bDEUTSCH|\bGERMANY\b", "DE"),
        (r"\bSPANISH\b|\bESPA[NÑ]OL\b|\bSPAIN\b|\bESPA[NÑ]A\b", "ES"),
        (r"\bLATINO\b|\bLATAM\b|\bLATIN\b|\bMEXICO\b", "LAT"),
        (r"\bITALIAN\b|\bITALIANO\b|\bITALY\b|\bITALIA\b", "IT"),
        (r"\bPORTUGU|\bPORTUGAL\b", "PT"),
        (r"\bBRAZIL\b|\bBRASIL\b", "BR"),
        (r"\bTURK", "TR"),
        (r"\bPAKISTAN", "PK"),
        (r"\bPUNJABI\b", "PB"),
        (r"\bSOMALI", "SOM"),
        (r"\bINDIA\b|\bHINDI\b|\bBOLLYWOOD\b", "IN"),
        (r"\bMULTI-?SUBS?\b", "MULTISUB"),
        (r"\bNORDIC\b|\bSCANDINAVIA", "SC"),
        (r"\bPOLAND\b|\bPOLSKA\b|\bPOLISH\b", "PL"),
        (r"\bNETHERLANDS\b|\bHOLLAND\b|\bNEDERLAND\b|\bDUTCH\b", "NL"),
        (r"\bSWEDEN\b|\bSVERIGE\b|\bSWEDISH\b", "SE"),
        (r"\bNORWAY\b|\bNORGE\b|\bNORWEGIAN\b", "NO"),
        (r"\bDENMARK\b|\bDANMARK\b|\bDANISH\b", "DK"),
        (r"\bFINLAND\b|\bSUOMI\b|\bFINNISH\b", "FI"),
        (r"\bGREECE\b|\bGREEK\b", "GR"),
        (r"\bROMANIA", "RO"),
        (r"\bBULGARIA", "BG"),
        (r"\bHUNGARY\b|\bHUNGARIAN\b|\bMAGYAR\b", "HU"),
        (r"\bCZECH\b", "CZ"),
        (r"\bSLOVAK", "SK"),
        (r"\bRUSSIA", "RU"),
        (r"\bUKRAIN", "UA"),
        (r"\bALBANIA", "AL"),
        (r"\bISRAEL\b|\bHEBREW\b", "HE"),
        (r"\bIRAN\b|\bPERSIAN\b|\bFARSI\b", "IR"),
        (r"\bKURD", "KU"),
        (r"\bKOREA", "KR"),
        (r"\bJAPAN", "JP"),
        (r"\bCHINA\b|\bCHINESE\b", "CN"),
        (r"\bARABIC\b", "AR"),
        (r"\bEX-?YU\b|\bBALKAN", "EXYU"),
        (r"\bVIETNAM", "VN"),
        (r"\bTHAI\b|\bTHAILAND\b", "TH"),
    ]
    .into_iter()
    .map(|(re, code)| {
        let re = Regex::new(&format!("(?i){re}")).expect("static category regex");
        (re, code)
    })
    .collect()
});

/// "[ES]", "[EXYU]", "[MULTISUB]" anywhere in a category name.
static CATEGORY_BRACKET: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[([A-Za-z]{2,8})\]").expect("static bracket regex"));

fn is_bidi_mark(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn is_arabic(c: char) -> bool {
    ('\u{0600}'..='\u{06FF}').contains(&c)
}

/// Letters of scripts English never uses: Greek, Cyrillic, Hebrew, Arabic,
/// Indic, Thai, Georgian, Hangul, CJK and kana.
fn is_foreign_script(c: char) -> bool {
    matches!(c,
        '\u{0370}'..='\u{03FF}'
        | '\u{0400}'..='\u{052F}'
        | '\u{0590}'..='\u{05FF}'
        | '\u{0600}'..='\u{06FF}'
        | '\u{0750}'..='\u{077F}'
        | '\u{0900}'..='\u{0DFF}'
        | '\u{0E00}'..='\u{0E7F}'
        | '\u{10A0}'..='\u{10FF}'
        | '\u{1100}'..='\u{11FF}'
        | '\u{3040}'..='\u{30FF}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{4E00}'..='\u{9FFF}'
        | '\u{AC00}'..='\u{D7AF}'
    )
}

/// The code of a leading tag: "EN - ", "|FR| ", "[DE] ", "ES: ", "EN | ",
/// "(IT) ". A bare word needs a separator after it; a bracketed one does not.
fn leading_tag(text: &str) -> Option<&str> {
    let s = text.trim_start();
    let s = match s.chars().next() {
        Some(c @ ('[' | '|' | '(')) => s[c.len_utf8()..].trim_start(),
        _ => s,
    };
    let len = if s.starts_with("D+") {
        2
    } else {
        s.bytes().take_while(u8::is_ascii_alphanumeric).count()
    };
    let token = &s[..len];
    let valid = token == "D+"
        || token.eq_ignore_ascii_case("4K")
        || token.eq_ignore_ascii_case("3D")
        || ((2..=8).contains(&len) && token.bytes().all(|b| b.is_ascii_alphabetic()));
    if !valid {
        return None;
    }
    let rest = s[len..].trim_start();
    let closed = matches!(rest.chars().next(), Some(']' | '|' | ')'));
    let rest = if closed { rest[1..].trim_start() } else { rest };
    let separated = matches!(rest.chars().next(), Some('-' | ':' | '|' | '–' | '—'));
    (closed || separated).then_some(token)
}

fn resolve(code_text: &str, category: Option<&str>) -> Option<Lang> {
    let upper = code_text.to_ascii_uppercase();
    // "MA" is Malayalam in Indian categories and Moroccan elsewhere.
    if upper == "MA" {
        let india = category.is_some_and(|c| c.to_ascii_uppercase().contains("INDIA"));
        return Some(T(if india { "ml" } else { "ar-MA" }));
    }
    code(&upper)
}

fn not_language(token: &str) -> bool {
    NOT_LANGUAGE.contains(&token.to_ascii_uppercase().as_str())
}

fn from_category(category: Option<&str>) -> Option<Lang> {
    let name = category?;
    if let Some(m) = CATEGORY_BRACKET.captures(name).and_then(|c| c.get(1)) {
        if let Some(hit) = resolve(m.as_str(), category) {
            return Some(hit);
        }
    }
    let clean: String = name.chars().filter(|c| !is_bidi_mark(*c)).collect();
    if let Some(tag) = leading_tag(&clean).filter(|t| !not_language(t)) {
        if let Some(hit) = resolve(tag, category) {
            return Some(hit);
        }
    }
    for (re, code) in CATEGORY_WORDS.iter() {
        if re.is_match(name) {
            return resolve(code, category);
        }
    }
    if name.chars().any(is_arabic) {
        return resolve("AR", category);
    }
    None
}

/// Language from the raw provider title and category name, if either says.
/// A title tag counts only in capitals ("IT - Film", not "It: Chapter Two").
pub fn item_language(title: &str, category: Option<&str>) -> Option<Lang> {
    let clean: String = title.chars().filter(|c| !is_bidi_mark(*c)).collect();
    if let Some(tag) = leading_tag(&clean)
        .filter(|t| !not_language(t) && !t.bytes().any(|b| b.is_ascii_lowercase()))
    {
        if let Some(hit) = resolve(tag, category) {
            return Some(hit);
        }
    }
    from_category(category)
}

/// True when the item is clearly in a language other than English. Unknown,
/// multi-subtitle and African (often English-language) items stay visible.
pub fn is_non_english(title: &str, category: Option<&str>) -> bool {
    match item_language(title, category) {
        Some(T(tag)) => tag != "en" && !tag.starts_with("en-"),
        Some(G(g)) => !matches!(g, Multisub | African),
        None => {
            title.chars().any(is_foreign_script)
                || category.is_some_and(|c| c.chars().any(is_foreign_script))
        }
    }
}

/// SQL name of [`is_non_english`]: `non_english(title, category_name)` is 1
/// for clearly non-English items, else 0.
pub const SQL_FUNCTION: &str = "non_english";

/// `AND` clause for readers whose query joins categories as `c`.
pub const ENGLISH_ONLY_SQL: &str = " AND non_english(i.title, c.name) = 0";

/// Registers [`SQL_FUNCTION`] on `conn`, and `adult_category` from
/// [`crate::parental::register_sql`].
pub fn register(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        SQL_FUNCTION,
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let title = ctx
                .get_raw(0)
                .as_str_or_null()
                .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
            let category = ctx
                .get_raw(1)
                .as_str_or_null()
                .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
            Ok(is_non_english(title.unwrap_or_default(), category))
        },
    )?;
    // parental: the hide-mode filters match adult category names in SQL.
    crate::parental::register_sql(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden(title: &str, category: Option<&str>) -> bool {
        is_non_english(title, category)
    }

    #[test]
    fn reads_title_prefixes() {
        assert_eq!(
            item_language("EN - Interstellar (2014)", None),
            Some(T("en"))
        );
        assert_eq!(item_language("|FR| Le Film (2020)", None), Some(T("fr")));
        assert_eq!(item_language("[DE] Der Film", None), Some(T("de")));
        assert_eq!(item_language("ES: La Película", None), Some(T("es")));
        assert_eq!(item_language("EN | The Film", None), Some(T("en")));
        assert_eq!(item_language("\u{202B}AR - Show", None), Some(T("ar")));
        assert_eq!(item_language("US: CNN HD", None), Some(T("en")));
        assert_eq!(item_language("UK | BBC One", None), Some(T("en")));
        assert_eq!(item_language("FRA - TF1", None), Some(T("fr")));
        assert_eq!(
            item_language("MA - Film", Some("VOD - INDIA")),
            Some(T("ml"))
        );
        assert_eq!(item_language("MA - Film", None), Some(T("ar-MA")));
        assert_eq!(item_language("STH - Film", None), Some(G(SouthIndian)));
    }

    #[test]
    fn does_not_invent_a_language() {
        assert_eq!(item_language("Interstellar (2014)", None), None);
        assert_eq!(item_language("The Matrix - Reloaded (2003)", None), None);
        assert_eq!(item_language("It: Chapter Two (2019)", None), None);
        assert_eq!(item_language("Us - The Movie", None), None);
        assert_eq!(
            item_language("TOP - Film (1994)", Some("VOD - TOP 500 IMDB")),
            None
        );
        assert_eq!(item_language("ESPN 2", Some("SPORTS")), None);
        assert_eq!(item_language("NBA TV: Game 1", None), None);
    }

    #[test]
    fn falls_back_to_the_category() {
        assert_eq!(
            item_language("4K - Hungry", Some("VOD - ENGLISH 4K")),
            Some(T("en"))
        );
        assert_eq!(
            item_language("NF - Show", Some("VOD - NETFLIX [MULTISUB]")),
            Some(G(Multisub))
        );
        assert_eq!(item_language("TF1", Some("FRANCE HD")), Some(T("fr")));
        assert_eq!(item_language("ZDF", Some("DE | GENERAL")), Some(T("de")));
        assert_eq!(
            item_language("Film", Some("VOD - GERMANY 2024 [DE]")),
            Some(T("de"))
        );
        assert_eq!(item_language("MBC", Some("مسلسلات")), Some(T("ar")));
        assert_eq!(item_language("Canal", Some("LATINO")), Some(T("es-419")));
    }

    #[test]
    fn english_only_hides_only_clear_cases() {
        // Hidden: a non-English tag, category, group or script.
        assert!(hidden("FR - Le Film", None));
        assert!(hidden("TF1", Some("FRANCE")));
        assert!(hidden("Film", Some("VOD - INDIA")));
        assert!(hidden("EX - Film", Some("[EXYU]")));
        assert!(hidden("Первый канал", None));
        assert!(hidden("ZDF", Some("|DE| ALLGEMEIN")));
        // Shown: English, unknown, multi-subtitle, African, or an English
        // tag in a foreign category.
        assert!(!hidden("EN - Interstellar", None));
        assert!(!hidden("US: CNN", Some("ARABIC")));
        assert!(!hidden("ENG - Interstellar", Some("VOD - INDIA")));
        assert!(!hidden("Interstellar (2014)", None));
        assert!(!hidden("ESPN", Some("SPORTS")));
        assert!(!hidden("NF - Show", Some("NETFLIX [MULTISUB]")));
        assert!(!hidden("Film", Some("AF - NOLLYWOOD")));
        assert!(!hidden("It: Chapter Two", Some("HORROR")));
        assert!(!hidden("Pokémon: Amélie", None));
        assert!(!hidden("", None));
    }

    #[test]
    fn sql_function_matches_the_rust_rule() {
        let conn = Connection::open_in_memory().unwrap();
        register(&conn).unwrap();
        let f = |t: &str, c: Option<&str>| -> i64 {
            conn.query_row("SELECT non_english(?1, ?2)", rusqlite::params![t, c], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(f("FR - Film", None), 1);
        assert_eq!(f("BBC One", Some("UK | ENTERTAINMENT")), 0);
        assert_eq!(f("TF1", Some("FRANCE")), 1);
        let null_title: i64 = conn
            .query_row("SELECT non_english(NULL, NULL)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(null_title, 0);
    }
}
