//! Mapping catalog items to XMLTV channel ids (SPEC C4 resolution order):
//! manual map row (NULL = explicitly none) > `items.epg_channel_id` known to
//! the EPG > normalized title match against channel display names (exact,
//! then strsim >= 0.9) > none.

use super::ingest::EpgRuntime;
use super::store::STAGING_ORIGIN;
use crate::error::CoreResult;
use crate::model::ItemRef;
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Minimum normalized Levenshtein similarity for a fuzzy name match.
pub const FUZZY_THRESHOLD: f64 = 0.9;

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
    let s = s.replace('&', "and").replace('+', "plus");
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Normalized key of an XMLTV channel id: "BBCOne.uk" -> "bbcone".
fn normalize_id(id: &str) -> String {
    let lower = id.trim().to_lowercase();
    let base = TLD.replace(&lower, "");
    normalize_name(&base)
}

/// Snapshot of the channels of every enabled EPG url, for id and name lookup.
pub struct ChannelDirectory {
    generation: u64,
    /// lowercase id -> canonical id.
    ids: HashMap<String, String>,
    /// normalized name -> channel id (first enabled url wins).
    names: HashMap<String, String>,
    /// (normalized name, channel id) for fuzzy matching.
    entries: Vec<(String, String)>,
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
        };
        for row in rows {
            let (id, name) = row?;
            dir.ids
                .entry(id.to_lowercase())
                .or_insert_with(|| id.clone());
            for key in [normalize_name(&name), normalize_id(&id)] {
                if key.is_empty() {
                    continue;
                }
                if !dir.names.contains_key(&key) {
                    dir.names.insert(key.clone(), id.clone());
                    dir.entries.push((key, id.clone()));
                }
            }
        }
        Ok(dir)
    }

    /// Canonical id for `id` (exact, then case-insensitive).
    pub fn find_id(&self, id: &str) -> Option<&str> {
        self.ids.get(&id.to_lowercase()).map(String::as_str)
    }

    /// Channel id whose normalized display name matches `title`.
    pub fn find_name(&self, title: &str) -> Option<&str> {
        let key = normalize_name(title);
        if key.is_empty() {
            return None;
        }
        if let Some(id) = self.names.get(&key) {
            return Some(id);
        }
        if key.chars().count() < 4 {
            return None;
        }
        let klen = key.chars().count() as f64;
        let mut best: Option<(f64, &str)> = None;
        for (name, id) in &self.entries {
            let nlen = name.chars().count() as f64;
            // Similarity can never reach the threshold when lengths differ this much.
            if (klen - nlen).abs() / klen.max(nlen) > 1.0 - FUZZY_THRESHOLD {
                continue;
            }
            let score = strsim::normalized_levenshtein(&key, name);
            if score >= FUZZY_THRESHOLD && best.is_none_or(|(b, _)| score > b) {
                best = Some((score, id));
            }
        }
        best.map(|(_, id)| id)
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

/// The cached directory, rebuilt when the runtime generation changed.
pub fn directory(conn: &Connection, rt: &EpgRuntime) -> CoreResult<Arc<ChannelDirectory>> {
    let generation = rt.generation();
    if let Some(d) = rt.names.lock().as_ref() {
        if d.generation == generation {
            return Ok(d.clone());
        }
    }
    let d = Arc::new(ChannelDirectory::load(conn, generation)?);
    *rt.names.lock() = Some(d.clone());
    Ok(d)
}

/// Manual mapping of `r`: `None` = no row, `Some(None)` = explicitly unmapped.
pub fn manual_mapping(conn: &Connection, r: &ItemRef) -> CoreResult<Option<Option<String>>> {
    Ok(conn
        .query_row(
            "SELECT epg_channel_id FROM epg_channel_map WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?)
}

pub(crate) fn has_programmes(conn: &Connection, channel_id: &str) -> CoreResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM epg_programs WHERE channel_id = ?1 LIMIT 1",
            [channel_id],
            |_| Ok(()),
        )
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
        .query_row(
            "SELECT title, epg_channel_id FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
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
}
