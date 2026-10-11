//! `m3u.*` RPC commands (SPEC C4).

use super::parser::M3uReader;
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// `m3u.parsePreview` reads at most this many bytes of the text.
pub const PREVIEW_BYTES: usize = 2 * 1024 * 1024;
/// Groups listed by `m3u.parsePreview` at most.
pub const PREVIEW_MAX_GROUPS: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawArgs {
    pub source_id: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawResult {
    pub text: String,
    pub sha256: String,
    pub fetched_at: String,
}

#[derive(Debug, Deserialize)]
pub struct PreviewArgs {
    pub text: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub channel_count: i64,
    pub groups: Vec<String>,
    pub epg_urls: Vec<String>,
}

pub async fn raw(state: Arc<AppState>, a: RawArgs) -> Result<RawResult, RpcError> {
    let sid = a.source_id.clone();
    let row = state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT raw, sha256, fetched_at FROM m3u_raw WHERE source_id = ?1",
                [&sid],
                |r| {
                    Ok(RawResult {
                        text: r.get(0)?,
                        sha256: r.get(1)?,
                        fetched_at: r.get(2)?,
                    })
                },
            )
            .optional()?)
        })
        .await?;
    row.ok_or_else(|| RpcError::not_found("no stored playlist for this source; refresh it first"))
}

/// Parses the first 2 MB of `text` (cut at a line boundary when possible).
pub fn preview(text: &str) -> PreviewResult {
    let mut cut = text.len().min(PREVIEW_BYTES);
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let head = &text[..cut];
    let head = if cut < text.len() {
        head.rfind('\n').map(|i| &head[..i]).unwrap_or(head)
    } else {
        head
    };
    let mut reader = M3uReader::new(std::io::Cursor::new(head.as_bytes()));
    let mut groups: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut count = 0i64;
    for e in reader.by_ref() {
        count += 1;
        if let Some(g) = e.group {
            if groups.len() < PREVIEW_MAX_GROUPS && seen.insert(g.clone()) {
                groups.push(g);
            }
        }
    }
    PreviewResult {
        channel_count: count,
        groups,
        epg_urls: reader.header().epg_urls.clone(),
    }
}

pub async fn parse_preview(
    _state: Arc<AppState>,
    a: PreviewArgs,
) -> Result<PreviewResult, RpcError> {
    let out = tokio::task::spawn_blocking(move || preview(&a.text))
        .await
        .map_err(|e| RpcError::internal(format!("preview failed: {e}")))?;
    Ok(out)
}

/// Registers every `m3u.*` command of C4.
pub fn register(r: &mut RpcRouter) {
    r.add("m3u.raw", raw);
    r.add("m3u.parsePreview", parse_preview);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_counts_groups_and_epg() {
        let p = preview("#EXTM3U x-tvg-url=\"http://e/g.xml\"\n#EXTINF:-1 group-title=\"A\",1\nhttp://1\n#EXTINF:-1 group-title=\"B\",2\nhttp://2\n#EXTINF:-1 group-title=\"A\",3\nhttp://3\n");
        assert_eq!(p.channel_count, 3);
        assert_eq!(p.groups, vec!["A", "B"]);
        assert_eq!(p.epg_urls, vec!["http://e/g.xml"]);
    }
}
