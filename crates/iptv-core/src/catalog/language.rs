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
//! "4K") all stay visible.
//!
//! The rule splits into a title half and a category half ([`title_verdict`],
//! [`category_verdict`], joined by [`combine`]) so that SQL never runs the
//! category keyword scan once per item. Readers of one source and content
//! type use [`english_only_scoped`]: one cheap title test per row and two
//! category-id sets built once per statement. Readers across sources use
//! [`ENGLISH_ONLY_SQL`] (`non_english(title, category_name)`), whose category
//! half is memoized per connection. Both are registered on every connection
//! by [`register`].
//!
//! Since migration 0018 the verdict is also stored with each item
//! (`items.non_english`, written by the catalog writer), and readers filter
//! on it ([`STORED_SQL`]); the SQL rule is only used for catalogs written
//! before the migration until [`backfill_pending`] stores theirs.
//! `catalog_perf` and `l2_query_perf` hold the readers to their budgets.

use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;
use std::borrow::Cow;
use std::collections::HashMap;

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
    NOT_LANGUAGE.iter().any(|n| n.eq_ignore_ascii_case(token))
}

/// `text` without bidi marks; borrowed (no copy) when it has none.
fn without_bidi(text: &str) -> Cow<'_, str> {
    if text.is_ascii() || !text.chars().any(is_bidi_mark) {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.chars().filter(|c| !is_bidi_mark(*c)).collect())
    }
}

fn has_foreign_script(text: &str) -> bool {
    !text.is_ascii() && text.chars().any(is_foreign_script)
}

fn from_category(category: Option<&str>) -> Option<Lang> {
    let name = category?;
    if let Some(m) = CATEGORY_BRACKET.captures(name).and_then(|c| c.get(1)) {
        if let Some(hit) = resolve(m.as_str(), category) {
            return Some(hit);
        }
    }
    let clean = without_bidi(name);
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

/// The language a title's own leading tag names, if it names one.
fn title_language(title: &str, category: Option<&str>) -> Option<Lang> {
    let clean = without_bidi(title);
    let tag = leading_tag(&clean)
        .filter(|t| !not_language(t) && !t.bytes().any(|b| b.is_ascii_lowercase()))?;
    resolve(tag, category)
}

/// Language from the raw provider title and category name, if either says.
/// A title tag counts only in capitals ("IT - Film", not "It: Chapter Two").
pub fn item_language(title: &str, category: Option<&str>) -> Option<Lang> {
    title_language(title, category).or_else(|| from_category(category))
}

/// True for a detected language English-only hides: everything but English,
/// multi-subtitle and African (often English-language) groups.
fn hides(lang: Lang) -> bool {
    match lang {
        T(tag) => tag != "en" && !tag.starts_with("en-"),
        G(g) => !matches!(g, Multisub | African),
    }
}

/// [`title_verdict`]: the title's tag names English or a kept group.
pub const TITLE_KEEP: i64 = 0;
/// [`title_verdict`]: the title's tag names another language.
pub const TITLE_HIDE: i64 = 1;
/// [`title_verdict`]: no deciding tag; the title has no foreign script.
pub const TITLE_UNDECIDED: i64 = 2;
/// [`title_verdict`]: no deciding tag; the title has foreign-script letters.
pub const TITLE_UNDECIDED_FOREIGN: i64 = 3;

/// [`category_verdict`]: the name says English or a kept group.
pub const CATEGORY_KEEP: i64 = 0;
/// [`category_verdict`]: the name says another language, or names none
/// but is written in a foreign script.
pub const CATEGORY_HIDE: i64 = 1;
/// [`category_verdict`]: the name says nothing (also: no category).
pub const CATEGORY_UNDECIDED: i64 = 2;

/// The title half of [`is_non_english`]. It does not depend on the
/// category: the one category-dependent code ("MA": Malayalam or Moroccan)
/// hides either way.
pub fn title_verdict(title: &str) -> i64 {
    match title_language(title, None) {
        Some(lang) if hides(lang) => TITLE_HIDE,
        Some(_) => TITLE_KEEP,
        None if has_foreign_script(title) => TITLE_UNDECIDED_FOREIGN,
        None => TITLE_UNDECIDED,
    }
}

/// The category half of [`is_non_english`], from the category name.
pub fn category_verdict(name: &str) -> i64 {
    match from_category(Some(name)) {
        Some(lang) if hides(lang) => CATEGORY_HIDE,
        Some(_) => CATEGORY_KEEP,
        None if has_foreign_script(name) => CATEGORY_HIDE,
        None => CATEGORY_UNDECIDED,
    }
}

/// Joins the halves: the title's tag wins; without one the category
/// decides, and with neither saying, foreign-script letters in either hide.
pub fn combine(title: i64, category: i64) -> bool {
    match title {
        TITLE_KEEP => false,
        TITLE_HIDE => true,
        TITLE_UNDECIDED => category == CATEGORY_HIDE,
        _ => category != CATEGORY_KEEP,
    }
}

/// True when the item is clearly in a language other than English. Unknown,
/// multi-subtitle and African (often English-language) items stay visible.
pub fn is_non_english(title: &str, category: Option<&str>) -> bool {
    combine(
        title_verdict(title),
        category.map_or(CATEGORY_UNDECIDED, category_verdict),
    )
}

/// SQL name of [`is_non_english`]: `non_english(title, category_name)` is 1
/// for clearly non-English items, else 0.
pub const SQL_FUNCTION: &str = "non_english";
/// SQL name of [`title_verdict`]: `english_title(title)`.
pub const TITLE_SQL_FUNCTION: &str = "english_title";
/// SQL name of [`category_verdict`]: `english_category(name)`.
pub const CATEGORY_SQL_FUNCTION: &str = "english_category";

/// `AND` clause for readers whose query joins categories as `c` and spans
/// sources (search, recently added): few rows reach it.
pub const ENGLISH_ONLY_SQL: &str = " AND non_english(i.title, c.name) = 0";

/// `AND` clause for rows of `items i` from one source and content type
/// (`src` and `ty` are the statement's placeholders or literals for them,
/// e.g. `?1`, `?2`). Needs no join: per row it runs only the title test,
/// and the category half is two non-correlated category-id sets that SQLite
/// builds once per statement (250 names, not 50k rows). Same rows as
/// [`ENGLISH_ONLY_SQL`]; an item whose category row is missing counts as an
/// undecided category, as the `LEFT JOIN` there does.
pub fn english_only_scoped(src: &str, ty: &str) -> String {
    format!(" AND {}", keep_predicate(src, ty))
}

fn keep_predicate(src: &str, ty: &str) -> String {
    let set = |verdict: i64| {
        format!(
            "SELECT category_id FROM categories WHERE source_id = {src} AND content_type = {ty} AND {CATEGORY_SQL_FUNCTION}(name) = {verdict}"
        )
    };
    format!(
        "(CASE {TITLE_SQL_FUNCTION}(i.title) WHEN {TITLE_KEEP} THEN 1 WHEN {TITLE_HIDE} THEN 0 WHEN {TITLE_UNDECIDED} THEN i.category_id NOT IN ({}) ELSE i.category_id IN ({}) END)",
        set(CATEGORY_HIDE),
        set(CATEGORY_KEEP),
    )
}

/// `AND` clause over the verdict stored with each item (`items.non_english`,
/// migration 0018): a column of every catalog index, so pages and counts stay
/// index-only scans whatever else the database writes. Valid for every
/// (source, type) that is not [`is_pending`].
pub const STORED_SQL: &str = " AND i.non_english = 0";

/// The stored verdict of an item before its category is known: what
/// [`combine`] answers for a category whose name says nothing. The catalog
/// writer stores it per row and corrects the few rows a category decides
/// once the categories are written (see [`category_changes`]).
pub fn title_guess(title: i64) -> bool {
    combine(title, CATEGORY_UNDECIDED)
}

/// Which stored guesses a category's verdict overturns: `(undecided titles
/// become hidden, foreign-script titles become shown)`. Titles with their own
/// tag never change.
pub fn category_changes(category: i64) -> (bool, bool) {
    (
        combine(TITLE_UNDECIDED, category) != title_guess(TITLE_UNDECIDED),
        combine(TITLE_UNDECIDED_FOREIGN, category) != title_guess(TITLE_UNDECIDED_FOREIGN),
    )
}

/// True while the items of `source_id` / `content_type` were written before
/// migration 0018 and their stored verdicts are not computed yet (see
/// [`backfill_pending`]). Readers use [`hidden_rowids`] for such a pair.
pub fn is_pending(
    conn: &Connection,
    source_id: &str,
    content_type: &str,
) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM english_pending WHERE source_id = ?1 AND content_type = ?2)",
    )?
    .query_row(rusqlite::params![source_id, content_type], |r| r.get(0))
}

/// True while any catalog waits for its stored verdicts.
pub fn any_pending(conn: &Connection) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM english_pending)")?
        .query_row([], |r| r.get(0))
}

/// `AND` clause of English-only for readers across sources whose query joins
/// categories as `c`: the stored verdict, or the per-row rule
/// ([`ENGLISH_ONLY_SQL`]) while a catalog is still pending.
pub fn english_only_joined(conn: &Connection) -> rusqlite::Result<&'static str> {
    Ok(if any_pending(conn)? {
        ENGLISH_ONLY_SQL
    } else {
        STORED_SQL
    })
}

/// Computes the stored verdicts of every pending catalog (written before
/// migration 0018), one write transaction per (source, type) so user writes
/// interleave. Only the hidden rows are written: the column defaults to 0.
/// Returns the number of catalogs done. Runs in the background at boot.
pub fn backfill_pending(conn: &mut Connection) -> rusqlite::Result<usize> {
    let pairs: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT source_id, content_type FROM english_pending")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut done = 0;
    for (source_id, content_type) in pairs {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // A catalog rewrite since the list was read already stored them.
        if is_pending(&tx, &source_id, &content_type)? {
            tx.execute(
                &format!(
                    "UPDATE items AS i SET non_english = 1 WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.non_english = 0 AND NOT {}",
                    keep_predicate("?1", "?2")
                ),
                rusqlite::params![source_id, content_type],
            )?;
            tx.execute(
                "DELETE FROM english_pending WHERE source_id = ?1 AND content_type = ?2",
                rusqlite::params![source_id, content_type],
            )?;
            done += 1;
        }
        tx.commit()?;
    }
    Ok(done)
}

/// The `AND` clause [`hidden_rowids`] returns.
pub const HIDDEN_ROWIDS_SQL: &str =
    " AND i.rowid NOT IN (SELECT item_rowid FROM temp.english_hidden)";

/// `AND` clause dropping the rows of `items i` that English-only hides, for
/// a (source, type) whose stored verdicts are still [`is_pending`]; every
/// other reader uses [`STORED_SQL`].
///
/// Testing every row on every call costs a count over 50k channels about
/// 20 ms in release and 50 ms in a debug build, twice per deep page. So the
/// hidden rowids of the source and type last asked for are kept in a temp
/// table of this connection, `temp.english_hidden`, built with
/// [`english_only_scoped`] and probed through its primary key.
///
/// The set is rebuilt when anything may have changed it: another source or
/// type, a commit by another connection (`PRAGMA data_version`) or any
/// write by this one (`total_changes()`). That is after almost every write
/// to the database, which is why the verdict is stored instead (loop 2).
pub fn hidden_rowids(
    conn: &Connection,
    source_id: &str,
    content_type: &str,
) -> rusqlite::Result<&'static str> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS english_hidden (item_rowid INTEGER PRIMARY KEY);
         CREATE TEMP TABLE IF NOT EXISTS english_hidden_for (
           id INTEGER PRIMARY KEY CHECK (id = 1), source_id TEXT NOT NULL,
           content_type TEXT NOT NULL, data_version INTEGER NOT NULL, changes INTEGER NOT NULL);",
    )?;
    let version: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    let fresh: bool = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM temp.english_hidden_for WHERE source_id = ?1 AND content_type = ?2 AND data_version = ?3 AND changes = total_changes())",
        )?
        .query_row(rusqlite::params![source_id, content_type, version], |r| {
            r.get(0)
        })?;
    if fresh {
        return Ok(HIDDEN_ROWIDS_SQL);
    }
    conn.execute("DELETE FROM temp.english_hidden", [])?;
    conn.execute("DELETE FROM temp.english_hidden_for", [])?;
    conn.prepare_cached(&format!(
        "INSERT INTO temp.english_hidden (item_rowid) SELECT i.rowid FROM items i WHERE i.source_id = ?1 AND i.content_type = ?2 AND NOT {}",
        keep_predicate("?1", "?2")
    ))?
    .execute(rusqlite::params![source_id, content_type])?;
    // `total_changes()` is read before this statement's own row counts:
    // after it, the total is one more.
    conn.prepare_cached(
        "INSERT INTO temp.english_hidden_for (id, source_id, content_type, data_version, changes) VALUES (1, ?1, ?2, ?3, total_changes() + 1)",
    )?
    .execute(rusqlite::params![source_id, content_type, version])?;
    Ok(HIDDEN_ROWIDS_SQL)
}

/// Category verdicts by name for one connection's SQL functions. A name
/// repeats on every item of its category, and its keyword scan (some forty
/// regexes) is the costly half of the rule. The verdict is a pure function
/// of the name, so the memo never goes stale; it is cleared when it outgrows
/// [`CategoryMemo::CAP`] names.
#[derive(Default)]
struct CategoryMemo(HashMap<String, i64>);

impl CategoryMemo {
    const CAP: usize = 4096;

    fn verdict(&mut self, name: Option<&str>) -> i64 {
        let Some(name) = name else {
            return CATEGORY_UNDECIDED;
        };
        if let Some(v) = self.0.get(name) {
            return *v;
        }
        let v = category_verdict(name);
        if self.0.len() >= Self::CAP {
            self.0.clear();
        }
        self.0.insert(name.to_owned(), v);
        v
    }
}

fn text_arg<'a>(
    ctx: &'a rusqlite::functions::Context<'_>,
    i: usize,
) -> rusqlite::Result<Option<&'a str>> {
    ctx.get_raw(i)
        .as_str_or_null()
        .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))
}

/// Registers [`SQL_FUNCTION`], [`TITLE_SQL_FUNCTION`] and
/// [`CATEGORY_SQL_FUNCTION`] on `conn`, and `adult_category` from
/// [`crate::parental::register_sql`].
pub fn register(conn: &Connection) -> rusqlite::Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    let mut memo = CategoryMemo::default();
    conn.create_scalar_function(SQL_FUNCTION, 2, flags, move |ctx| {
        let title = text_arg(ctx, 0)?.unwrap_or_default();
        let category = memo.verdict(text_arg(ctx, 1)?);
        Ok(combine(title_verdict(title), category))
    })?;
    conn.create_scalar_function(TITLE_SQL_FUNCTION, 1, flags, |ctx| {
        Ok(title_verdict(text_arg(ctx, 0)?.unwrap_or_default()))
    })?;
    let mut memo = CategoryMemo::default();
    conn.create_scalar_function(CATEGORY_SQL_FUNCTION, 1, flags, move |ctx| {
        Ok(memo.verdict(text_arg(ctx, 0)?))
    })?;
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

    const TITLES: [&str; 32] = [
        // The scoped clause's GLOB prefilter must send every one of these
        // shapes to the title test.
        " DE - Leading space",
        "  EN | Two spaces",
        "\tFR - Tab",
        "[DE] Der Film",
        "|FR| Le Film",
        "(IT) Il Film",
        "[ ES ] Spaced bracket",
        "\u{3000}FR - Ideographic space",
        "D+ - Show",
        "fr - lowercase",
        "FR - Le Film",
        "EN - Interstellar",
        "US: CNN",
        "ENG - Interstellar",
        "Interstellar (2014)",
        "ESPN",
        "NF - Show",
        "It: Chapter Two",
        "Pokémon: Amélie",
        "",
        "MA - Film",
        "STH - Film",
        "MULTI - Film",
        "AF - Film",
        "Первый канал",
        "\u{202B}AR - Show",
        "\u{200E}EN - Show",
        "4K - Hungry",
        "TOP - Film (1994)",
        "XX - Unknown code",
        "مسلسل",
        "Channel 12",
    ];
    const CATEGORIES: [Option<&str>; 16] = [
        None,
        Some(""),
        Some("FRANCE"),
        Some("UK | ENTERTAINMENT"),
        Some("VOD - INDIA"),
        Some("[EXYU]"),
        Some("SPORTS"),
        Some("NETFLIX [MULTISUB]"),
        Some("AF - NOLLYWOOD"),
        Some("HORROR"),
        Some("مسلسلات"),
        Some("Новости"),
        Some("VOD - ENGLISH 4K"),
        Some("|DE| ALLGEMEIN"),
        Some("LATINO"),
        Some("Group 7"),
    ];

    /// The rule before it split into halves, kept as the reference.
    fn reference(title: &str, category: Option<&str>) -> bool {
        match item_language(title, category) {
            Some(T(tag)) => tag != "en" && !tag.starts_with("en-"),
            Some(G(g)) => !matches!(g, Multisub | African),
            None => {
                title.chars().any(is_foreign_script)
                    || category.is_some_and(|c| c.chars().any(is_foreign_script))
            }
        }
    }

    #[test]
    fn split_rule_matches_the_whole_rule() {
        for title in TITLES {
            for category in CATEGORIES {
                assert_eq!(
                    is_non_english(title, category),
                    reference(title, category),
                    "{title:?} in {category:?}"
                );
            }
        }
    }

    /// The writer's stored guess, corrected by the category as
    /// [`category_changes`] says, is the whole rule for every shape.
    #[test]
    fn stored_guess_and_category_correction_match_the_rule() {
        for title in TITLES {
            for category in CATEGORIES {
                let t = title_verdict(title);
                let c = category.map_or(CATEGORY_UNDECIDED, category_verdict);
                let (hide_untagged, show_foreign) = category_changes(c);
                let stored = match t {
                    TITLE_UNDECIDED if hide_untagged => true,
                    TITLE_UNDECIDED_FOREIGN if show_foreign => false,
                    _ => title_guess(t),
                };
                assert_eq!(
                    stored,
                    is_non_english(title, category),
                    "{title:?} in {category:?}"
                );
            }
        }
    }

    /// The set-based clause keeps exactly the rows the joined clause keeps,
    /// including items whose category row is missing.
    #[test]
    fn scoped_clause_matches_the_joined_clause() {
        let conn = Connection::open_in_memory().unwrap();
        register(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE categories (source_id TEXT, content_type TEXT, category_id TEXT, name TEXT, PRIMARY KEY (source_id, content_type, category_id));
             CREATE TABLE items (source_id TEXT, content_type TEXT, item_id TEXT, category_id TEXT NOT NULL, title TEXT NOT NULL);",
        )
        .unwrap();
        let mut n = 0;
        for (ci, category) in CATEGORIES.iter().enumerate() {
            if let Some(name) = category {
                conn.execute(
                    "INSERT INTO categories VALUES ('s', 'live', ?1, ?2)",
                    rusqlite::params![format!("c{ci}"), name],
                )
                .unwrap();
            }
            for title in TITLES {
                n += 1;
                conn.execute(
                    "INSERT INTO items VALUES ('s', 'live', ?1, ?2, ?3)",
                    rusqlite::params![n.to_string(), format!("c{ci}"), title],
                )
                .unwrap();
            }
        }
        // Another source with the same category ids and opposite names must
        // not leak into the sets.
        conn.execute(
            "INSERT INTO categories VALUES ('t', 'live', 'c6', 'FRANCE')",
            [],
        )
        .unwrap();
        let ids = |clause: &str, join: bool| -> Vec<i64> {
            let from = if join {
                "items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id"
            } else {
                "items i"
            };
            let sql = format!(
                "SELECT CAST(i.item_id AS INTEGER) FROM {from} WHERE i.source_id = ?1 AND i.content_type = ?2{clause} ORDER BY 1"
            );
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows = stmt
                .query_map(["s", "live"], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<i64>, _>>()
                .unwrap();
            rows
        };
        let joined = ids(ENGLISH_ONLY_SQL, true);
        let scoped = ids(&english_only_scoped("?1", "?2"), false);
        assert_eq!(scoped, joined);
        assert!(!joined.is_empty() && joined.len() < n, "{}", joined.len());
        // And both agree with the Rust rule.
        let mut expected = Vec::new();
        let mut k = 0;
        for category in CATEGORIES {
            for title in TITLES {
                k += 1;
                if !is_non_english(title, category) {
                    expected.push(k);
                }
            }
        }
        assert_eq!(joined, expected);
    }

    /// The cached rowid set follows every write: this connection's, another
    /// connection's, and a switch of source; and it is not rebuilt while
    /// nothing changed.
    #[test]
    fn hidden_rowids_cache_follows_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let open = || {
            let c = Connection::open(&path).unwrap();
            register(&c).unwrap();
            c.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
            c
        };
        let a = open();
        a.execute_batch(
            "CREATE TABLE categories (source_id TEXT, content_type TEXT, category_id TEXT, name TEXT, PRIMARY KEY (source_id, content_type, category_id));
             CREATE TABLE items (source_id TEXT, content_type TEXT, item_id TEXT, category_id TEXT NOT NULL, title TEXT NOT NULL);
             INSERT INTO categories VALUES ('s', 'live', 'fr', 'FRANCE'), ('s', 'live', 'gen', 'GENERAL'), ('t', 'live', 'gen', 'GENERAL');
             INSERT INTO items VALUES ('s', 'live', '1', 'fr', 'TF1'), ('s', 'live', '2', 'fr', 'EN - BBC'),
               ('s', 'live', '3', 'gen', 'Channel 3'), ('s', 'live', '4', 'gen', 'DE - ZDF'), ('t', 'live', '5', 'gen', 'PL - TVP');",
        )
        .unwrap();
        let b = open();
        let visible = |c: &Connection, source: &str| -> Vec<String> {
            let clause = hidden_rowids(c, source, "live").unwrap();
            let mut stmt = c
                .prepare(&format!(
                    "SELECT i.item_id FROM items i WHERE i.source_id = ?1 AND i.content_type = 'live'{clause} ORDER BY 1"
                ))
                .unwrap();
            let rows = stmt
                .query_map([source], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap();
            rows
        };
        let total = |c: &Connection| -> i64 {
            c.query_row("SELECT total_changes()", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(visible(&a, "s"), ["2", "3"]);
        // Fresh: a second call writes nothing.
        let before = total(&a);
        assert_eq!(visible(&a, "s"), ["2", "3"]);
        assert_eq!(total(&a), before);
        // A write on this connection.
        a.execute(
            "UPDATE items SET title = 'IT - Rai' WHERE item_id = '3'",
            [],
        )
        .unwrap();
        assert_eq!(visible(&a, "s"), ["2"]);
        // A commit on another connection.
        b.execute(
            "UPDATE categories SET name = 'UK | NEWS' WHERE category_id = 'fr'",
            [],
        )
        .unwrap();
        assert_eq!(visible(&a, "s"), ["1", "2"]);
        // Another source; then back.
        assert_eq!(visible(&a, "t"), Vec::<String>::new());
        assert_eq!(visible(&a, "s"), ["1", "2"]);
        // Each connection keeps its own set.
        assert_eq!(visible(&b, "s"), ["1", "2"]);
    }

    #[test]
    fn category_memo_is_bounded_and_answers_like_the_rule() {
        let mut memo = CategoryMemo::default();
        for i in 0..(CategoryMemo::CAP + 10) {
            let name = format!("FRANCE {i}");
            assert_eq!(memo.verdict(Some(&name)), CATEGORY_HIDE);
        }
        assert!(memo.0.len() <= CategoryMemo::CAP);
        assert_eq!(memo.verdict(Some("SPORTS")), CATEGORY_UNDECIDED);
        assert_eq!(memo.verdict(Some("UK | NEWS")), CATEGORY_KEEP);
        assert_eq!(memo.verdict(Some("Новости")), CATEGORY_HIDE);
        assert_eq!(memo.verdict(None), CATEGORY_UNDECIDED);
    }
}
