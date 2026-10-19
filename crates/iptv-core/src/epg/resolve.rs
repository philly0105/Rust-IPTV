//! Mapping catalog items to XMLTV channel ids (SPEC C4 resolution order):
//! manual map row (NULL = explicitly none) > `items.epg_channel_id` known to
//! the EPG > normalized title match against channel display names (exact,
//! then strsim >= 0.9 among channels with the same numbers, timeshift and
//! East / West, refused when two channels score about the same) > none.

use super::ingest::EpgRuntime;
use super::store::STAGING_ORIGIN;
use crate::error::CoreResult;
use crate::model::ItemRef;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Minimum normalized Levenshtein similarity for a fuzzy name match.
pub const FUZZY_THRESHOLD: f64 = 0.9;
/// A fuzzy match must beat every other channel by more than this.
pub const FUZZY_MARGIN: f64 = 0.02;
/// Shortest normalized key a fuzzy match can reach [`FUZZY_THRESHOLD`] with.
/// Two different keys score at most `1 - 1 / longer` and `shorter / longer`,
/// so a score of 0.9 needs the longer one to have 10 characters and the
/// shorter 9 or more; shorter keys only match exactly.
const MIN_FUZZY_KEY: usize = 9;
/// Most fuzzy results a directory remembers; the memo is cleared when full.
const FUZZY_MEMO_CAP: usize = 50_000;

/// How a ref was resolved (`epg.resolve`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Via {
    Manual,
    Item,
    Name,
    None,
}

/// `epg.resolve` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epg_channel_id: Option<String>,
    pub via: Via,
}

impl Resolution {
    fn none() -> Self {
        Self {
            epg_channel_id: None,
            via: Via::None,
        }
    }
}

static PREFIX: Lazy<Regex> = Lazy::new(|| {
    // "UK: ", "UK | ", "|UK| ", "[UK] ", "(UK) ", "UK - ", "VIP UK: " style prefixes.
    Regex::new(
        r"^\s*(?:[\[\(\|]\s*[\p{L}0-9]{2,4}\s*[\]\)\|]|[\p{L}0-9]{2,4}\s*[:\|]|[a-z]{2}\s+-\s)\s*",
    )
    .expect("prefix regex")
});
static SUFFIX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?:\s|^)[\(\[]?(?:hd|fhd|uhd|sd|hq|4k|8k|hevc|h\.?26[45]|1080[pi]?|720p?|2160p|50fps|60fps|hdr|backup|raw|multi|vip)[\)\]]?\s*$",
    )
    .expect("suffix regex")
});
static TLD: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.[a-z]{2,3}$").expect("tld regex"));

/// Normalizes a channel name for matching: lowercase, country prefixes like
/// "UK:" / "|UK|" / "[UK]" stripped, quality suffixes like " HD" / " FHD" /
/// " 4K" stripped (repeatedly), `&` read as "and", then only letters and
/// digits kept. Empty input yields an empty key.
pub fn normalize_name(name: &str) -> String {
    let s = strip_affixes(name).replace('&', "and").replace('+', "plus");
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// The first steps of [`normalize_name`]: lowercase, decorative symbols,
/// country prefixes and quality suffixes removed.
fn strip_affixes(name: &str) -> String {
    let mut s = name.trim().to_lowercase();
    // Decorative symbols some providers put around names.
    s.retain(|c| !matches!(c, '◉' | '●' | '★' | '☆'));
    for _ in 0..2 {
        let stripped = PREFIX.replace(&s, "");
        if stripped.len() == s.len() || stripped.trim().is_empty() {
            break;
        }
        s = stripped.into_owned();
    }
    for _ in 0..4 {
        let stripped = SUFFIX.replace(&s, "");
        if stripped.len() == s.len() || stripped.trim().is_empty() {
            break;
        }
        s = stripped.trim_end().to_string();
    }
    s
}

/// What tells sibling channels apart, sorted: channel numbers ("Sky Sports
/// 1" / "2", leading zeros dropped), timeshifts ("+1", "plus 1") and East /
/// West feeds. A fuzzy match needs them equal. Quality tags (HD, 4K, 1080p,
/// H.264) are not among them: [`normalize_name`] reads "BBC One HD" as
/// "BBC One" on purpose (same schedule), and their digits are no channel
/// number.
fn qualifiers(name: &str) -> Vec<String> {
    let chars: Vec<char> = strip_affixes(name).chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        if chars[i].is_ascii_digit() {
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            let digits: String = chars[start..i].iter().collect();
            let mut j = i;
            while j < chars.len() && chars[j].is_alphabetic() {
                j += 1;
            }
            let unit: String = chars[i..j].iter().collect();
            let after_h = start > 0
                && (chars[start - 1] == 'h'
                    || (start > 1 && chars[start - 2..start] == ['h', '.']));
            let quality = matches!(unit.as_str(), "k" | "fps")
                || (matches!(unit.as_str(), "p" | "i")
                    && matches!(digits.as_str(), "480" | "576" | "720" | "1080" | "2160"))
                || (after_h && matches!(digits.as_str(), "264" | "265"));
            if quality {
                continue;
            }
            let mut p = start;
            while p > 0 && chars[p - 1] == ' ' {
                p -= 1;
            }
            let shifted = (p > 0 && chars[p - 1] == '+')
                || (p >= 4 && chars[p - 4..p].iter().collect::<String>() == "plus");
            let n = digits.trim_start_matches('0');
            let n = if n.is_empty() { "0" } else { n };
            out.push(if shifted {
                format!("+{n}")
            } else {
                n.to_string()
            });
        } else if chars[i].is_alphabetic() {
            while i < chars.len() && chars[i].is_alphabetic() {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if word == "east" || word == "west" {
                out.push(word);
            }
        } else {
            i += 1;
        }
    }
    out.sort_unstable();
    out
}

/// An XMLTV channel id without its country suffix: "BBCOne.uk" -> "bbcone".
fn id_base(id: &str) -> String {
    let lower = id.trim().to_lowercase();
    TLD.replace(&lower, "").into_owned()
}

/// Normalized key of an XMLTV channel id: "BBCOne.uk" -> "bbcone".
fn normalize_id(id: &str) -> String {
    normalize_name(&id_base(id))
}

/// Snapshot of the channels of every enabled EPG url, for id and name lookup.
pub struct ChannelDirectory {
    generation: u64,
    /// lowercase id -> canonical id.
    ids: HashMap<String, String>,
    /// normalized name -> channel id (first enabled url wins).
    names: HashMap<String, String>,
    /// (normalized name, channel id, [`qualifiers`]) for fuzzy matching.
    entries: Vec<(String, String, Vec<String>)>,
    /// Title -> index in `entries` of its fuzzy match ([`Self::find_name`]).
    /// The directory is replaced when the generation moves, and this with it.
    fuzzy: Mutex<HashMap<String, Option<usize>>>,
}

impl ChannelDirectory {
    fn load(conn: &Connection, generation: u64) -> CoreResult<Self> {
        let mut stmt = conn.prepare(
            "SELECT c.channel_id, c.display_name FROM epg_channels c
             JOIN epg_sources s ON s.url = c.epg_url
             WHERE s.enabled = 1 AND s.origin <> ?1 ORDER BY s.rowid",
        )?;
        let rows = stmt.query_map([STAGING_ORIGIN], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut dir = Self {
            generation,
            ids: HashMap::new(),
            names: HashMap::new(),
            entries: Vec::new(),
            fuzzy: Mutex::new(HashMap::new()),
        };
        for row in rows {
            let (id, name) = row?;
            dir.ids
                .entry(id.to_lowercase())
                .or_insert_with(|| id.clone());
            let base = id_base(&id);
            for (key, source) in [(normalize_name(&name), &name), (normalize_id(&id), &base)] {
                if key.is_empty() {
                    continue;
                }
                if !dir.names.contains_key(&key) {
                    dir.names.insert(key.clone(), id.clone());
                    dir.entries.push((key, id.clone(), qualifiers(source)));
                }
            }
        }
        Ok(dir)
    }

    /// Canonical id for `id` (exact, then case-insensitive).
    pub fn find_id(&self, id: &str) -> Option<&str> {
        self.ids.get(&id.to_lowercase()).map(String::as_str)
    }

    /// Channel id whose normalized display name matches `title`: exactly,
    /// else the most similar name (>= [`FUZZY_THRESHOLD`]) among channels
    /// with the same [`qualifiers`], so "Sky Sports 1" never takes "Sky
    /// Sports 2" and "BBC One +1" never takes "BBC One +2". A fuzzy match
    /// whose runner-up (another channel) scores within [`FUZZY_MARGIN`] of
    /// it is ambiguous and refused. Fuzzy results are remembered per title.
    pub fn find_name(&self, title: &str) -> Option<&str> {
        let key = normalize_name(title);
        if key.is_empty() {
            return None;
        }
        if let Some(id) = self.names.get(&key) {
            return Some(id);
        }
        if key.chars().count() < MIN_FUZZY_KEY {
            return None;
        }
        if let Some(&found) = self.fuzzy.lock().get(title) {
            return found.map(|i| self.entries[i].1.as_str());
        }
        let found = self.fuzzy_match(&key, title);
        let mut memo = self.fuzzy.lock();
        if memo.len() >= FUZZY_MEMO_CAP {
            memo.clear();
        }
        memo.insert(title.to_string(), found);
        found.map(|i| self.entries[i].1.as_str())
    }

    /// Index in `entries` of the fuzzy match of `title` (normalized `key`),
    /// see [`Self::find_name`].
    fn fuzzy_match(&self, key: &str, title: &str) -> Option<usize> {
        let quals = qualifiers(title);
        let floor = FUZZY_THRESHOLD - FUZZY_MARGIN;
        let klen = key.chars().count() as f64;
        let mut best: Option<(f64, usize)> = None;
        // Best score of a channel other than `best`.
        let mut runner_up = 0.0_f64;
        for (i, (name, id, q)) in self.entries.iter().enumerate() {
            if *q != quals {
                continue;
            }
            let nlen = name.chars().count() as f64;
            // Similarity can never reach the floor when lengths differ this much.
            if (klen - nlen).abs() / klen.max(nlen) > 1.0 - floor {
                continue;
            }
            let score = strsim::normalized_levenshtein(key, name);
            if score < floor {
                continue;
            }
            match best {
                None => best = Some((score, i)),
                Some((b, bi)) if score > b => {
                    if self.entries[bi].1 != *id {
                        runner_up = runner_up.max(b);
                    }
                    best = Some((score, i));
                }
                Some((_, bi)) => {
                    if self.entries[bi].1 != *id {
                        runner_up = runner_up.max(score);
                    }
                }
            }
        }
        let (score, i) = best?;
        (score >= FUZZY_THRESHOLD && score - runner_up > FUZZY_MARGIN).then_some(i)
    }

    /// Channel id whose normalized display name (or id) equals the
    /// normalized `title`, without the similarity step of [`Self::find_name`]
    /// (guide search maps hits this way, C5).
    pub fn find_name_exact(&self, title: &str) -> Option<&str> {
        if self.names.is_empty() {
            return None;
        }
        let key = normalize_name(title);
        if key.is_empty() {
            return None;
        }
        self.names.get(&key).map(String::as_str)
    }

    /// The runtime generation this snapshot was loaded at.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}

/// The cached directory, rebuilt when the runtime generation changed. The
/// lock is held while it is rebuilt, so concurrent callers wait for one
/// build instead of each loading every guide channel.
pub fn directory(conn: &Connection, rt: &EpgRuntime) -> CoreResult<Arc<ChannelDirectory>> {
    let generation = rt.generation();
    let mut cached = rt.names.lock();
    if let Some(d) = cached.as_ref() {
        if d.generation >= generation {
            return Ok(d.clone());
        }
    }
    let d = Arc::new(ChannelDirectory::load(conn, generation)?);
    *cached = Some(d.clone());
    Ok(d)
}

/// Manual mapping of `r`: `None` = no row, `Some(None)` = explicitly unmapped.
pub fn manual_mapping(conn: &Connection, r: &ItemRef) -> CoreResult<Option<Option<String>>> {
    Ok(conn
        .prepare_cached(
            "SELECT epg_channel_id FROM epg_channel_map WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?)
}

pub(crate) fn has_programmes(conn: &Connection, channel_id: &str) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM epg_programs WHERE channel_id = ?1 LIMIT 1")?
        .query_row([channel_id], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Resolves `r` to an XMLTV channel id.
pub fn resolve(conn: &Connection, dir: &ChannelDirectory, r: &ItemRef) -> CoreResult<Resolution> {
    if let Some(manual) = manual_mapping(conn, r)? {
        return Ok(Resolution {
            epg_channel_id: manual.filter(|s| !s.trim().is_empty()),
            via: Via::Manual,
        });
    }
    let item: Option<(String, Option<String>)> = conn
        .prepare_cached(
            "SELECT title, epg_channel_id FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((title, item_epg)) = item else {
        return Ok(Resolution::none());
    };
    if let Some(id) = item_epg.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(canonical) = dir.find_id(id) {
            return Ok(Resolution {
                epg_channel_id: Some(canonical.to_string()),
                via: Via::Item,
            });
        }
        // Programmes for channels the feed never declared with <channel>.
        if has_programmes(conn, id)? {
            return Ok(Resolution {
                epg_channel_id: Some(id.to_string()),
                via: Via::Item,
            });
        }
    }
    if let Some(id) = dir.find_name(&title) {
        return Ok(Resolution {
            epg_channel_id: Some(id.to_string()),
            via: Via::Name,
        });
    }
    Ok(Resolution::none())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize_name("UK: BBC One HD"), "bbcone");
        assert_eq!(normalize_name("|UK| BBC One FHD"), "bbcone");
        assert_eq!(normalize_name("[UK] BBC One"), "bbcone");
        assert_eq!(normalize_name("UK | BBC ONE 4K"), "bbcone");
        assert_eq!(normalize_name("uk - BBC One (HD)"), "bbcone");
        assert_eq!(normalize_name("BBC One HD backup"), "bbcone");
        assert_eq!(normalize_name("Sky Sports F1 ◉"), "skysportsf1");
        assert_eq!(normalize_name("AT&T SportsNet"), "atandtsportsnet");
        assert_eq!(normalize_name("Canal+ HD"), "canalplus");
        assert_eq!(normalize_name("HD"), "hd");
        assert_eq!(normalize_name(""), "");
        assert_eq!(normalize_id("BBCOne.uk"), "bbcone");
    }

    #[test]
    fn qualifiers_keep_numbers_shifts_and_feeds_but_not_quality() {
        let q = |s: &str| qualifiers(s);
        assert_eq!(q("UK: Sky Sports 1 HD"), ["1"]);
        assert_eq!(q("Sky Sports 01"), ["1"]);
        assert_eq!(q("BBC One HD +1"), ["+1"]);
        assert_eq!(q("BBC One + 2"), ["+2"]);
        assert_eq!(q("bbconeplus1"), ["+1"]);
        assert_eq!(q("E4 +1"), ["+1", "4"]);
        assert_eq!(q("Discovery Channel West"), ["west"]);
        assert_eq!(q("BBC One 4K"), Vec::<String>::new());
        assert_eq!(q("BBC One 1080p H.264 50fps"), Vec::<String>::new());
        assert_eq!(q("Sky Sports F1"), ["1"]);
        assert_eq!(q("HBOEast"), Vec::<String>::new());
    }

    fn dir(channels: &[(&str, &str)]) -> ChannelDirectory {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
            .unwrap();
        for (id, name) in channels {
            conn.execute(
                "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES ('u', ?1, ?2)",
                params![id, name],
            )
            .unwrap();
        }
        ChannelDirectory::load(&conn, 0).unwrap()
    }

    /// L1-core-12: a fuzzy match gave sibling channels the same guide.
    #[test]
    fn fuzzy_match_keeps_siblings_apart() {
        let d = dir(&[("ss2.uk", "Sky Sports 2"), ("b2.uk", "BBC One +2")]);
        assert_eq!(d.find_name("Sky Sports 1"), None);
        assert_eq!(d.find_name("BBC One +1"), None);
        assert_eq!(d.find_name("BBC One HD +1"), None);
        // A typo still matches the channel with the same number.
        let d = dir(&[("ss1.uk", "Sky Sports 1"), ("ss2.uk", "Sky Sports 2")]);
        assert_eq!(d.find_name("Sky Sprts 2"), Some("ss2.uk"));
        assert_eq!(d.find_name("Sky Sports 2 HD"), Some("ss2.uk"));
        // East and West feeds of one channel.
        let d = dir(&[("dw.us", "Discovery Channel West")]);
        assert_eq!(d.find_name("Discovery Channel East"), None);
        assert_eq!(d.find_name("Discovery Chanel West"), Some("dw.us"));
    }

    /// L1-core-12: two channels about as close to the name are ambiguous.
    #[test]
    fn fuzzy_match_refuses_near_ties() {
        let d = dir(&[("nuk", "Nickelodeon UK"), ("nus", "Nickelodeon US")]);
        assert_eq!(d.find_name("Nickelodeon U"), None);
        let d = dir(&[("nuk", "Nickelodeon UK")]);
        assert_eq!(d.find_name("Nickelodeon U"), Some("nuk"));
    }

    /// EP-2: keys shorter than [`MIN_FUZZY_KEY`] can never score
    /// [`FUZZY_THRESHOLD`] against a different key, so they skip the scan.
    #[test]
    fn short_keys_cannot_reach_the_fuzzy_threshold() {
        let best = |k: usize, n: usize| {
            let (short, long) = (k.min(n) as f64, k.max(n) as f64);
            (1.0 - 1.0 / long).min(short / long)
        };
        for k in 1..MIN_FUZZY_KEY {
            for n in 1..=40 {
                assert!(best(k, n) < FUZZY_THRESHOLD, "{k} vs {n}");
            }
        }
        assert!(best(MIN_FUZZY_KEY, MIN_FUZZY_KEY + 1) >= FUZZY_THRESHOLD);
        let d = dir(&[("e.uk", "Eurosport")]);
        assert_eq!(d.find_name("Eurosprt"), None);
        assert!(d.fuzzy.lock().is_empty(), "no scan for a short key");
    }

    /// EP-2: a fuzzy result is computed once per title and directory.
    #[test]
    fn fuzzy_results_are_remembered() {
        let d = dir(&[("ss1.uk", "Sky Sports 1"), ("ss2.uk", "Sky Sports 2")]);
        assert_eq!(d.find_name("Sky Sprts 2"), Some("ss2.uk"));
        assert_eq!(d.find_name("Sky Sprts 2"), Some("ss2.uk"));
        assert_eq!(d.find_name("Sky Sprots 3"), None);
        assert_eq!(d.find_name("Sky Sprots 3"), None);
        assert_eq!(d.fuzzy.lock().len(), 2);
    }
}
