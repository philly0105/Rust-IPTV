//! Mapping catalog items to XMLTV channel ids (SPEC C4 resolution order):
//! manual map row (NULL = explicitly none) > `items.epg_channel_id` known to
//! the EPG > normalized title match against channel display names (exact,
//! then strsim >= 0.9 among channels with the same numbers, timeshift and
//! East / West, refused when two channels score about the same) > none.

use super::ingest::EpgRuntime;
use super::query::{self, tvg_shift_sql};
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
/// Most title results, and most programme checks, a directory remembers;
/// each memo is cleared when full.
const MEMO_CAP: usize = 50_000;

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
    /// The channel's own guide shift in minutes (`epg.setChannelShift`),
    /// filled by `epg.resolve` only; absent when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift_minutes: Option<i32>,
}

impl Resolution {
    fn none() -> Self {
        Self {
            epg_channel_id: None,
            via: Via::None,
            shift_minutes: None,
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
    name_key(&strip_affixes(name))
}

/// The last steps of [`normalize_name`], on a name [`strip_affixes`] has
/// already been through: `&` read as "and", `+` as "plus", then only
/// letters and digits kept, in one pass.
fn name_key(stripped: &str) -> String {
    let mut key = String::with_capacity(stripped.len());
    for c in stripped.chars() {
        match c {
            '&' => key.push_str("and"),
            '+' => key.push_str("plus"),
            c if c.is_alphanumeric() => key.push(c),
            _ => {}
        }
    }
    key
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
    stripped_qualifiers(&strip_affixes(name))
}

/// [`qualifiers`] of a name [`strip_affixes`] has already been through.
fn stripped_qualifiers(stripped: &str) -> Vec<String> {
    let chars: Vec<char> = stripped.chars().collect();
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

/// Snapshot of the channels of every enabled EPG url, for id and name lookup.
pub struct ChannelDirectory {
    generation: u64,
    /// lowercase id -> canonical id.
    ids: HashMap<String, String>,
    /// normalized name -> index in `entries` of its channel (first enabled
    /// url wins).
    names: HashMap<String, usize>,
    /// (normalized name, channel id, [`qualifiers`]) for fuzzy matching.
    entries: Vec<(String, String, Vec<String>)>,
    /// Title -> index in `entries` of its match, exact or fuzzy, or `None`
    /// ([`Self::find_name`]). The directory is replaced when the generation
    /// moves, and this with it.
    titles: Mutex<HashMap<String, Option<usize>>>,
    /// Channel id -> whether any feed has programmes for it
    /// ([`Self::has_programmes`]). Programmes change only through a refresh,
    /// a prune and `epg.clearAll`, each followed by a bump that replaces
    /// this directory and its memos (the boot cleanup runs before any
    /// directory is built).
    programmes: Mutex<HashMap<String, bool>>,
    /// Fuzzy scans run, for tests.
    #[cfg(test)]
    fuzzy_scans: std::sync::atomic::AtomicUsize,
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
            titles: Mutex::new(HashMap::new()),
            programmes: Mutex::new(HashMap::new()),
            #[cfg(test)]
            fuzzy_scans: Default::default(),
        };
        for row in rows {
            let (id, name) = row?;
            dir.ids
                .entry(id.to_lowercase())
                .or_insert_with(|| id.clone());
            // The display name and the id without its country suffix
            // ("BBCOne.uk" -> "bbcone"), each stripped once for both its key
            // and its qualifiers. Building the key ([`normalize_name`]) and
            // then the qualifiers ([`qualifiers`]) stripped each twice and read
            // the id's suffix twice: about 8-10 regex searches per channel,
            // while every EPG read waited on this build after a refresh (R2-4).
            let base = id_base(&id);
            for source in [name.as_str(), base.as_str()] {
                let stripped = strip_affixes(source);
                let key = name_key(&stripped);
                if key.is_empty() || dir.names.contains_key(&key) {
                    continue;
                }
                dir.names.insert(key.clone(), dir.entries.len());
                dir.entries
                    .push((key, id.clone(), stripped_qualifiers(&stripped)));
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
    /// it is ambiguous and refused.
    ///
    /// Every result, exact, fuzzy or none, is remembered per title and
    /// looked up before the title is normalized: only fuzzy results were,
    /// so every `epg.nowNext` and grid call ran the affix regexes again for
    /// each channel matched by name or not at all (R2-5).
    pub fn find_name(&self, title: &str) -> Option<&str> {
        if let Some(&found) = self.titles.lock().get(title) {
            return found.map(|i| self.entries[i].1.as_str());
        }
        let found = self.match_name(title);
        let mut memo = self.titles.lock();
        if memo.len() >= MEMO_CAP {
            memo.clear();
        }
        memo.insert(title.to_string(), found);
        found.map(|i| self.entries[i].1.as_str())
    }

    /// Index in `entries` of the match of `title`, see [`Self::find_name`].
    fn match_name(&self, title: &str) -> Option<usize> {
        let key = normalize_name(title);
        if key.is_empty() {
            return None;
        }
        if let Some(&i) = self.names.get(&key) {
            return Some(i);
        }
        if key.chars().count() < MIN_FUZZY_KEY {
            return None;
        }
        self.fuzzy_match(&key, title)
    }

    /// Index in `entries` of the fuzzy match of `title` (normalized `key`),
    /// see [`Self::find_name`].
    fn fuzzy_match(&self, key: &str, title: &str) -> Option<usize> {
        #[cfg(test)]
        self.fuzzy_scans
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
        self.names.get(&key).map(|&i| self.entries[i].1.as_str())
    }

    /// Whether any feed has programmes for `channel_id` ([`has_programmes`]),
    /// remembered for this snapshot: a catalog whose tvg-ids the guide does
    /// not declare probed `epg_programs` once per such channel on every
    /// `epg.nowNext` and grid call (R2-5). Guide search shares it.
    pub(crate) fn has_programmes(&self, conn: &Connection, channel_id: &str) -> CoreResult<bool> {
        if let Some(&known) = self.programmes.lock().get(channel_id) {
            return Ok(known);
        }
        let known = has_programmes(conn, channel_id)?;
        let mut memo = self.programmes.lock();
        if memo.len() >= MEMO_CAP {
            memo.clear();
        }
        memo.insert(channel_id.to_string(), known);
        Ok(known)
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
/// build instead of each loading every guide channel. The write paths that
/// bump the generation build it before they announce the change
/// ([`super::ingest::bump_and_prewarm`]), so the reads that follow find it.
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

/// The manual mapping statement of [`manual_mapping`].
const MANUAL_SQL: &str = "SELECT epg_channel_id FROM epg_channel_map WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3";

/// Manual mapping of `r`: `None` = no row, `Some(None)` = explicitly unmapped.
pub fn manual_mapping(conn: &Connection, r: &ItemRef) -> CoreResult<Option<Option<String>>> {
    Ok(conn
        .prepare_cached(MANUAL_SQL)?
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

/// One ref's catalog row with its manual mapping and its channel shift:
/// title, `epg_channel_id`, `tvg-shift` ([`tvg_shift_sql`]), whether a
/// manual mapping exists and its channel (NULL = explicitly none), and the
/// channel's own shift in minutes. One statement per ref instead of four
/// or five (the mapping, the row, the channel shift, the row again for
/// `extra_json`): about 540 for a 120-ref page and 2,250 for a 500-ref
/// Sports chunk before any programme was read (R2-5).
pub const ITEM_SQL: &str = concat!(
    "SELECT i.title, i.epg_channel_id, ",
    tvg_shift_sql!(),
    ", m.item_id IS NOT NULL, m.epg_channel_id, sh.shift_minutes
     FROM items i
     LEFT JOIN epg_channel_map m
       ON m.source_id = i.source_id AND m.content_type = i.content_type AND m.item_id = i.item_id
     LEFT JOIN epg_channel_shift sh
       ON sh.source_id = i.source_id AND sh.content_type = i.content_type AND sh.item_id = i.item_id
     WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.item_id = ?3"
);

/// What [`resolve_item`] reads of one ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemGuide {
    pub resolution: Resolution,
    /// The channel's own guide shift in minutes (`epg.setChannelShift`).
    pub channel_shift_minutes: Option<i32>,
    /// Its `tvg-shift` in seconds; 0 without one.
    pub tvg_shift: i64,
}

impl ItemGuide {
    /// The channel's guide shift in seconds before its source's
    /// ([`query::item_shift`]): its own shift, else its `tvg-shift`.
    pub fn shift(&self) -> i64 {
        query::channel_shift_secs(self.channel_shift_minutes, self.tvg_shift)
    }
}

fn manual(epg_channel_id: Option<String>) -> Resolution {
    Resolution {
        epg_channel_id: epg_channel_id.filter(|s| !s.trim().is_empty()),
        via: Via::Manual,
        shift_minutes: None,
    }
}

/// Resolves `r` to an XMLTV channel id ([`ItemGuide::resolution`]) and
/// reads its own guide shift, with one statement ([`ITEM_SQL`]) while its
/// catalog row exists. The order stays: manual mapping, then an
/// `epg_channel_id` known to the guide, then one with programmes, then the
/// name. Without the row, a manual mapping and a channel shift still apply
/// (both are kept by the stable catalog id, so they outlive an item a
/// refresh dropped).
pub fn resolve_item(
    conn: &Connection,
    dir: &ChannelDirectory,
    r: &ItemRef,
) -> CoreResult<ItemGuide> {
    type Row = (
        String,
        Option<String>,
        i64,
        bool,
        Option<String>,
        Option<i32>,
    );
    let row: Option<Row> = conn
        .prepare_cached(ITEM_SQL)?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    query::tvg_shift_secs(row.get_ref(2)?),
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((title, item_epg, tvg_shift, mapped, mapped_to, channel_shift_minutes)) = row else {
        return Ok(ItemGuide {
            resolution: manual_mapping(conn, r)?.map_or_else(Resolution::none, manual),
            channel_shift_minutes: query::channel_shift_minutes(conn, r)?,
            tvg_shift: 0,
        });
    };
    let resolution = if mapped {
        manual(mapped_to)
    } else {
        resolve_unmapped(conn, dir, &title, item_epg.as_deref())?
    };
    Ok(ItemGuide {
        resolution,
        channel_shift_minutes,
        tvg_shift,
    })
}

/// Resolution of a catalog row without a manual mapping.
fn resolve_unmapped(
    conn: &Connection,
    dir: &ChannelDirectory,
    title: &str,
    item_epg: Option<&str>,
) -> CoreResult<Resolution> {
    if let Some(id) = item_epg.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(canonical) = dir.find_id(id) {
            return Ok(Resolution {
                epg_channel_id: Some(canonical.to_string()),
                via: Via::Item,
                shift_minutes: None,
            });
        }
        // Programmes for channels the feed never declared with <channel>.
        if dir.has_programmes(conn, id)? {
            return Ok(Resolution {
                epg_channel_id: Some(id.to_string()),
                via: Via::Item,
                shift_minutes: None,
            });
        }
    }
    if let Some(id) = dir.find_name(title) {
        return Ok(Resolution {
            epg_channel_id: Some(id.to_string()),
            via: Via::Name,
            shift_minutes: None,
        });
    }
    Ok(Resolution::none())
}

/// Resolves `r` to an XMLTV channel id ([`resolve_item`] without the shift).
pub fn resolve(conn: &Connection, dir: &ChannelDirectory, r: &ItemRef) -> CoreResult<Resolution> {
    Ok(resolve_item(conn, dir, r)?.resolution)
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
        assert_eq!(normalize_name(&id_base("BBCOne.uk")), "bbcone");
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

    /// [`normalize_name`] as it was before R2-4 split it.
    fn normalize_name_before(name: &str) -> String {
        let s = strip_affixes(name).replace('&', "and").replace('+', "plus");
        s.chars().filter(|c| c.is_alphanumeric()).collect()
    }

    const NAMES: &[&str] = &[
        "UK: BBC One HD",
        "BBC One +1",
        "BBC One + 2",
        "Sky Sports 1 HD",
        "|UK| Sky Sports F1 ◉",
        "AT&T SportsNet",
        "Canal+ HD",
        "E4 +1",
        "Discovery Channel West",
        "Ελληνικά & Νέα",
        "Thời sự 24/7",
        "  [DE] Das Erste (1080p) ",
        "HD",
        "&+",
        "",
    ];

    /// R2-4: the one-pass key gives the key of the replace-and-filter steps.
    #[test]
    fn name_key_matches_the_steps_it_replaced() {
        for name in NAMES {
            assert_eq!(
                normalize_name(name),
                normalize_name_before(name),
                "{name:?}"
            );
        }
    }

    /// R2-4: stripping each name and id once gives the directory that
    /// normalizing and qualifying each of them separately gave.
    #[test]
    fn directory_entries_match_separate_normalization() {
        let ids = [
            "bbcone.uk",
            "BBCOnePlus1.uk",
            "bbc1plus2.uk",
            "SkySports1.uk",
            "skyf1.uk",
            "att.us",
            "CanalPlus.fr",
            "E4.uk",
            "dw.us",
            "ert.gr",
            "vtv.vn",
            "daserste.de",
            "hd",
            "x.tv",
            "empty",
        ];
        let channels: Vec<(&str, &str)> = ids.iter().copied().zip(NAMES.iter().copied()).collect();
        let d = dir(&channels);
        // The directory reads one feed's channels in key (id) order.
        let mut channels = channels;
        channels.sort_unstable();
        let mut names: HashMap<String, String> = HashMap::new();
        let mut entries: Vec<(String, String, Vec<String>)> = Vec::new();
        for (id, name) in &channels {
            let base = id_base(id);
            for (key, source) in [
                (normalize_name_before(name), name.to_string()),
                (normalize_name_before(&id_base(id)), base),
            ] {
                if key.is_empty() || names.contains_key(&key) {
                    continue;
                }
                names.insert(key.clone(), id.to_string());
                entries.push((key, id.to_string(), qualifiers(&source)));
            }
        }
        let by_name: HashMap<String, String> = d
            .names
            .iter()
            .map(|(k, &i)| (k.clone(), d.entries[i].1.clone()))
            .collect();
        assert_eq!(by_name, names);
        assert_eq!(d.entries, entries);
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
        assert_eq!(
            d.fuzzy_scans.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "no scan for a short key"
        );
    }

    /// EP-2: a fuzzy result is computed once per title and directory.
    #[test]
    fn fuzzy_results_are_remembered() {
        let d = dir(&[("ss1.uk", "Sky Sports 1"), ("ss2.uk", "Sky Sports 2")]);
        assert_eq!(d.find_name("Sky Sprts 2"), Some("ss2.uk"));
        assert_eq!(d.find_name("Sky Sprts 2"), Some("ss2.uk"));
        assert_eq!(d.find_name("Sky Sprots 3"), None);
        assert_eq!(d.find_name("Sky Sprots 3"), None);
        assert_eq!(d.titles.lock().len(), 2);
        assert_eq!(d.fuzzy_scans.load(std::sync::atomic::Ordering::Relaxed), 2);
    }

    /// A guide feed `u` (One, Sky Sports 1 and 2, and programmes for an id
    /// it never declares) and catalog rows covering every resolution path,
    /// manual mappings and shifts; `k` and `l` have no catalog row.
    fn catalog() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO sources(id, kind, name, config_json, epg_json) VALUES ('s', 'm3u', 's', '{}', '{}');
               INSERT INTO epg_sources(url) VALUES ('u');
               INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES
                 ('u', 'one.uk', 'Channel One'), ('u', 'ss1.uk', 'Sky Sports 1'), ('u', 'ss2.uk', 'Sky Sports 2');
               INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('u', 'undeclared.tv', 0, 60, 'x');
               INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id, extra_json) VALUES
                 ('s', 'live', 'a', 'c', 'Whatever', 'ONE.UK', '{}'),
                 ('s', 'live', 'b', 'c', 'Channel One HD', NULL, '{}'),
                 ('s', 'live', 'c', 'c', 'Sky Sprts 2', 'nope.tv', '{}'),
                 ('s', 'live', 'd', 'c', 'Unknown Thing', ' undeclared.tv ', '{}'),
                 ('s', 'live', 'e', 'c', 'Nothing Here At All', '', '{}'),
                 ('s', 'live', 'f', 'c', 'Channel One', NULL, '{}'),
                 ('s', 'live', 'g', 'c', 'Channel One', 'one.uk', '{}'),
                 ('s', 'live', 'h', 'c', 'Channel One', NULL, '{"tvgShift":"3"}'),
                 ('s', 'live', 'i', 'c', 'Channel One', NULL, '{"tvgShift":"+1.5"}'),
                 ('s', 'live', 'j', 'c', 'Channel One', NULL, '{"tvgShift":2}'),
                 ('s', 'live', 'm', 'c', 'ss', NULL, 'not json');
               INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES
                 ('s', 'live', 'f', 'ss1.uk'), ('s', 'live', 'g', NULL), ('s', 'live', 'h', '  '),
                 ('s', 'live', 'k', 'one.uk');
               INSERT INTO epg_channel_shift(source_id, content_type, item_id, shift_minutes) VALUES
                 ('s', 'live', 'j', -30), ('s', 'live', 'k', 15);"#,
        )
        .unwrap();
        conn
    }

    /// `tvg-shift` as read before R2-5: the row again, through serde.
    fn tvg_shift_before(conn: &Connection, r: &ItemRef) -> i64 {
        let extra: Option<String> = conn
            .query_row(
                "SELECT extra_json FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                params![r.source_id, r.content_type.as_str(), r.item_id],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        extra
            .and_then(|e| serde_json::from_str::<serde_json::Value>(&e).ok())
            .and_then(|v| match v.get("tvgShift")? {
                serde_json::Value::String(s) => Some(query::parse_shift(s)),
                serde_json::Value::Number(n) => Some(query::parse_shift(&n.to_string())),
                _ => None,
            })
            .unwrap_or(0)
    }

    /// Resolution and channel shift as read before R2-5: the mapping, the
    /// row, the programme probe, the channel shift and the row again.
    fn resolve_before(conn: &Connection, dir: &ChannelDirectory, r: &ItemRef) -> ItemGuide {
        let channel_shift_minutes = query::channel_shift_minutes(conn, r).unwrap();
        let tvg_shift = tvg_shift_before(conn, r);
        let done = |resolution| ItemGuide {
            resolution,
            channel_shift_minutes,
            tvg_shift,
        };
        if let Some(m) = manual_mapping(conn, r).unwrap() {
            return done(manual(m));
        }
        let item: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT title, epg_channel_id FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                params![r.source_id, r.content_type.as_str(), r.item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap();
        let Some((title, item_epg)) = item else {
            return done(Resolution::none());
        };
        let via = |id: &str, via| Resolution {
            epg_channel_id: Some(id.to_string()),
            via,
            shift_minutes: None,
        };
        if let Some(id) = item_epg.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(canonical) = dir.find_id(id) {
                return done(via(canonical, Via::Item));
            }
            if has_programmes(conn, id).unwrap() {
                return done(via(id, Via::Item));
            }
        }
        match dir.find_name(&title) {
            Some(id) => done(via(id, Via::Name)),
            None => done(Resolution::none()),
        }
    }

    fn runs(conn: &Connection, sql: &str) -> i32 {
        conn.prepare_cached(sql)
            .unwrap()
            .get_status(rusqlite::StatementStatus::Run)
    }

    /// R2-5: one statement per ref resolves every path (manual, explicit
    /// none, blank, item id in any case, an undeclared id with programmes,
    /// exact and fuzzy names, no match, a key too short to match) and reads
    /// the shift (channel shift over tvg-shift, string and number forms,
    /// malformed JSON) as the separate reads did; a ref whose row is gone
    /// keeps its manual mapping and channel shift.
    #[test]
    fn resolve_item_matches_the_separate_reads() {
        let conn = catalog();
        let dir = ChannelDirectory::load(&conn, 0).unwrap();
        let ids = [
            "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "m", "k", "l",
        ];
        let expect: [(Option<&str>, Via, i64); 13] = [
            (Some("one.uk"), Via::Item, 0),
            (Some("one.uk"), Via::Name, 0),
            (Some("ss2.uk"), Via::Name, 0),
            (Some("undeclared.tv"), Via::Item, 0),
            (None, Via::None, 0),
            (Some("ss1.uk"), Via::Manual, 0),
            (None, Via::Manual, 0),
            (None, Via::Manual, 3 * 3600),
            (Some("one.uk"), Via::Name, 5400),
            (Some("one.uk"), Via::Name, -1800),
            (None, Via::None, 0),
            (Some("one.uk"), Via::Manual, 900),
            (None, Via::None, 0),
        ];
        for (id, (channel, via, shift)) in ids.iter().zip(expect) {
            let r = ItemRef::new("s", crate::model::ContentType::Live, *id);
            let got = resolve_item(&conn, &dir, &r).unwrap();
            assert_eq!(got, resolve_before(&conn, &dir, &r), "{id}");
            assert_eq!(got.resolution.epg_channel_id.as_deref(), channel, "{id}");
            assert_eq!(got.resolution.via, via, "{id}");
            assert_eq!(got.shift(), shift, "{id}");
        }
        // Rows that exist take one statement each; only the two gone rows
        // fall back to the mapping probe.
        let conn = catalog();
        let dir = ChannelDirectory::load(&conn, 0).unwrap();
        for id in ids {
            resolve_item(
                &conn,
                &dir,
                &ItemRef::new("s", crate::model::ContentType::Live, id),
            )
            .unwrap();
        }
        assert_eq!(runs(&conn, ITEM_SQL), ids.len() as i32);
        assert_eq!(runs(&conn, MANUAL_SQL), 2);
    }

    /// R2-5: the one statement reads each of its three rows by key.
    #[test]
    fn item_statement_reads_its_rows_by_key() {
        let conn = catalog();
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {ITEM_SQL}"))
            .unwrap();
        let plan: Vec<String> = stmt
            .query_map(["s", "live", "a"], |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(plan.len(), 3, "{plan:?}");
        for d in &plan {
            assert!(d.starts_with("SEARCH") && d.contains("INDEX"), "{plan:?}");
        }
    }

    /// R2-5: the programme probe and the title match are remembered per
    /// directory, every title result included; a new directory asks again.
    #[test]
    fn programme_checks_and_title_results_are_remembered() {
        let conn = catalog();
        let dir = ChannelDirectory::load(&conn, 0).unwrap();
        assert!(dir.has_programmes(&conn, "undeclared.tv").unwrap());
        assert!(!dir.has_programmes(&conn, "later.tv").unwrap());
        conn.execute(
            "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('u', 'later.tv', 0, 60, 'x')",
            [],
        )
        .unwrap();
        assert!(
            !dir.has_programmes(&conn, "later.tv").unwrap(),
            "remembered"
        );
        let fresh = ChannelDirectory::load(&conn, 1).unwrap();
        assert!(fresh.has_programmes(&conn, "later.tv").unwrap());

        assert_eq!(dir.find_name("Channel One HD"), Some("one.uk"));
        assert_eq!(dir.find_name("Nothing Here At All"), None);
        assert_eq!(dir.find_name("ss"), None);
        assert_eq!(dir.find_name("Channel One HD"), Some("one.uk"));
        let memo = dir.titles.lock();
        assert_eq!(memo.len(), 3, "exact, none and short results");
        assert_eq!(memo.get("ss"), Some(&None));
    }
}
