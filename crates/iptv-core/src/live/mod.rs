//! Live channel alternates (`live.alternates`): the same channel on other
//! sources, and duplicates inside one source, for live failover.
//!
//! Matching, strongest first:
//!
//! 1. The EPG id: the manual mapping (`epg_channel_map`) when there is one,
//!    else the item's `epg_channel_id`, looked up through `idx_items_epg`.
//!    Ids that are placeholders ("none", "0") or shared by more than
//!    [`EPG_CANDIDATE_CAP`] channels are ignored. A match must also agree on
//!    timeshift ("+1") and region, since "+1" feeds often reuse the id.
//! 2. The normalized name ([`matcher::signature`]). Candidates come from the
//!    `items_fts` index (a phrase query on the key words), so a lookup reads
//!    a handful of rows even with 50k channels per source; each candidate is
//!    then compared by its full signature.
//!
//! Channels in categories the user hid, and channels hidden with a channel
//! edit (Run 2 C2), are never candidates, like every other catalog read.
//! While the Live TV quality filter is on, neither are the live channels it
//! hides: [`QualityFilter::keeps`] on the candidate's signature quality,
//! which is the [`matcher::quality`] the catalog stores
//! ([`crate::catalog::quality`]). The channel itself may fail the filter;
//! radio is never filtered. Matching uses provider names; the RPC shows
//! custom names ([`rpc::alternates`]).
//!
//! Order: same quality tier as the channel first, then source order
//! (`sources.position`), then playlist order.

pub mod matcher;
pub mod rpc;

use crate::catalog::quality::QualityFilter;
use crate::catalog::{read_named, NamedRow, SELECT_NAMED};
use crate::error::{CoreError, CoreResult};
use crate::model::{Channel, ContentType, ItemRef, SourceKind};
use matcher::{signature, Quality, Signature};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Most alternates returned.
pub const MAX_ALTERNATES: usize = 50;
/// Most rows read for one EPG id; more means the id is not specific.
pub const EPG_CANDIDATE_CAP: usize = 200;
/// Most name candidates read from the FTS index.
pub const NAME_CANDIDATE_CAP: usize = 2000;

/// How an alternate was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    Epg,
    Name,
}

/// One alternate stream for a channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAlternate {
    pub channel: Channel,
    pub source_name: String,
    pub source_kind: SourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<Quality>,
    pub matched_by: MatchKind,
}

/// `live.alternates` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alternates {
    /// The channel's match key ("sky sports 1"); the UI keys source pins by it.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<Quality>,
    pub alternates: Vec<LiveAlternate>,
}

struct SourceInfo {
    name: String,
    kind: SourceKind,
    position: i64,
}

/// Alternates for a live or radio channel, best first. `quality` is the Live
/// TV quality filter (`catalog::rpc::quality_filter`); it drops the
/// candidates of a live channel it hides, never the channel itself.
pub fn alternates(
    conn: &Connection,
    r: &ItemRef,
    quality: Option<QualityFilter>,
) -> CoreResult<Alternates> {
    if !matches!(r.content_type, ContentType::Live | ContentType::Radio) {
        return Err(CoreError::Invalid(
            "live.alternates supports live and radio channels".into(),
        ));
    }
    let Some(original) = crate::catalog::get(conn, r)? else {
        return Err(CoreError::NotFound(format!(
            "channel {} not found",
            r.item_id
        )));
    };
    let sig = signature(&original.title);
    let ct = r.content_type.as_str();
    // C2: a channel the user hid is never offered as a fallback. One PK probe
    // per candidate, and none at all while no channel is hidden anywhere.
    let visible = if crate::channeledit::any_hidden(conn)? {
        format!(" AND {}", crate::channeledit::VISIBLE_PREDICATE)
    } else {
        String::new()
    };

    // (row, matched_by), keyed by (source, item) so a channel found both ways is listed once.
    let mut found: HashMap<(String, String), (NamedRow, Signature, MatchKind)> = HashMap::new();

    if let Some(epg) = effective_epg_id(conn, r, original.epg_channel_id.as_deref())? {
        let rows = epg_candidates(conn, ct, &epg, &visible)?;
        if rows.len() <= EPG_CANDIDATE_CAP {
            for row in rows {
                let cand = signature(&row.row.title);
                if cand.timeshift == sig.timeshift && cand.region_compatible(&sig) {
                    let k = (row.row.source_id.clone(), row.row.item_id.clone());
                    found.insert(k, (row, cand, MatchKind::Epg));
                }
            }
        }
    }

    if let Some(phrase) = sig.fts_phrase() {
        let sql = format!(
            "{SELECT_NAMED} WHERE i.content_type = ?2 AND i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?1) AND COALESCE(c.hidden, 0) = 0{visible} LIMIT {NAME_CANDIDATE_CAP}"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![phrase, ct], read_named)?;
        for row in rows {
            let row = row?;
            let k = (row.row.source_id.clone(), row.row.item_id.clone());
            if found.contains_key(&k) {
                continue;
            }
            let cand = signature(&row.row.title);
            if cand.same_name(&sig) {
                found.insert(k, (row, cand, MatchKind::Name));
            }
        }
    }

    let sources = source_infos(conn)?;
    // Radio has no picture quality to filter on.
    let quality = quality.filter(|_| r.content_type == ContentType::Live);
    let mut list: Vec<(NamedRow, Signature, MatchKind)> = found
        .into_values()
        .filter(|(row, cand, _)| {
            let n = &row.row;
            let itself = n.source_id == r.source_id && n.item_id == r.item_id;
            // The same URL again would fail the same way.
            let same_url = n.url.is_some() && n.url == original.url;
            let kept = quality.is_none_or(|f| f.keeps(cand.quality));
            !itself && !same_url && kept && sources.contains_key(&n.source_id)
        })
        .collect();
    list.sort_by_key(|(row, cand, _)| {
        let src = &sources[&row.row.source_id];
        (
            cand.quality != sig.quality,
            src.position,
            row.row.source_id.clone(),
            row.row.position,
            row.row.item_id.clone(),
        )
    });
    list.truncate(MAX_ALTERNATES);

    let alternates = list
        .into_iter()
        .map(|(row, cand, matched_by)| {
            let src = &sources[&row.row.source_id];
            LiveAlternate {
                source_name: src.name.clone(),
                source_kind: src.kind,
                quality: cand.quality,
                matched_by,
                channel: row.into_channel(),
            }
        })
        .collect();
    Ok(Alternates {
        key: sig.key,
        quality: sig.quality,
        alternates,
    })
}

/// Ids providers use for "no guide".
fn placeholder_epg_id(id: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    id.is_empty()
        || matches!(
            id.as_str(),
            "none"
                | "null"
                | "0"
                | "-"
                | "n/a"
                | "na"
                | "undefined"
                | "noepg"
                | "no-epg"
                | "no_epg"
        )
}

/// The manual mapping when one exists (`NULL` there means "unmapped"), else
/// the item's own id; placeholders count as none.
fn effective_epg_id(
    conn: &Connection,
    r: &ItemRef,
    own: Option<&str>,
) -> CoreResult<Option<String>> {
    let mapped: Option<Option<String>> = conn
        .prepare_cached(
            "SELECT epg_channel_id FROM epg_channel_map WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get(0),
        )
        .optional()?;
    let id = match mapped {
        Some(m) => m,
        None => own.map(str::to_string),
    };
    Ok(id.filter(|i| !placeholder_epg_id(i)))
}

/// Channels whose effective EPG id is `epg`: their own id without a manual
/// mapping, or a manual mapping to it. Reads at most one row over the cap.
/// `visible` is the channel-edit clause of [`alternates`] (or empty).
fn epg_candidates(
    conn: &Connection,
    ct: &str,
    epg: &str,
    visible: &str,
) -> CoreResult<Vec<NamedRow>> {
    let cap = EPG_CANDIDATE_CAP + 1;
    let own = format!(
        "{SELECT_NAMED} LEFT JOIN epg_channel_map m ON m.source_id = i.source_id AND m.content_type = i.content_type AND m.item_id = i.item_id \
         WHERE i.epg_channel_id = ?1 AND i.content_type = ?2 AND m.item_id IS NULL AND COALESCE(c.hidden, 0) = 0{visible} LIMIT {cap}"
    );
    let mut out = Vec::new();
    let mut stmt = conn.prepare_cached(&own)?;
    for row in stmt.query_map(params![epg, ct], read_named)? {
        out.push(row?);
    }
    if out.len() > EPG_CANDIDATE_CAP {
        return Ok(out);
    }

    // Manual mappings to `epg`: the map first, then each channel by its key. Joined
    // the other way round, SQLite walks every channel of the type and probes the map
    // for each (the map has no index on the guide id): about 100 ms over 150k
    // channels in a debug build, on every lookup.
    let keys: Vec<(String, String)> = conn
        .prepare_cached(
            "SELECT source_id, item_id FROM epg_channel_map WHERE epg_channel_id = ?1 AND content_type = ?2",
        )?
        .query_map(params![epg, ct], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let one = format!(
        "{SELECT_NAMED} WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.item_id = ?3 AND COALESCE(c.hidden, 0) = 0{visible}"
    );
    let mut stmt = conn.prepare_cached(&one)?;
    for (source_id, item_id) in keys {
        if let Some(row) = stmt
            .query_row(params![source_id, ct, item_id], read_named)
            .optional()?
        {
            out.push(row);
            if out.len() > EPG_CANDIDATE_CAP {
                break;
            }
        }
    }
    Ok(out)
}

fn source_infos(conn: &Connection) -> CoreResult<HashMap<String, SourceInfo>> {
    let mut stmt = conn.prepare_cached("SELECT id, name, kind, position FROM sources")?;
    let rows = stmt.query_map([], |row| {
        let kind: String = row.get(2)?;
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            kind,
            row.get::<_, i64>(3)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, name, kind, position) = row?;
        let Ok(kind) = kind.parse::<SourceKind>() else {
            continue;
        };
        out.insert(
            id,
            SourceInfo {
                name,
                kind,
                position,
            },
        );
    }
    Ok(out)
}

/// The live module has no background runtime.
pub async fn init(_state: std::sync::Arc<crate::state::AppState>) -> CoreResult<()> {
    Ok(())
}
