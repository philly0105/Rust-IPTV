//! Finding other copies of a title: movies by title
//! ([`catalog::same_title`]), episodes by their series' title and then the
//! same season and episode numbers.

use super::Candidate;
use crate::catalog::{self, ItemRow};
use crate::error::{CoreError, CoreResult};
use crate::live::matcher;
use crate::model::{ContentType, CopyRef, ItemRef, Season, SourceKind};
use crate::state::AppState;
use futures::StreamExt;
use rusqlite::{Connection, OptionalExtension};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

/// Series whose seasons are read at once while matching an episode.
const SEASON_READS: usize = 4;
/// How long one series' seasons may take (a slow portal costs only its
/// own copy).
const SEASON_LIMIT: Duration = Duration::from_secs(20);

/// Whether mirrors apply to `item` at all: a movie, or one episode of a
/// series. Live channels, radio and catch-up (a live ref) never have them.
pub(super) fn applies(item: &CopyRef) -> bool {
    match item.item_ref.content_type {
        ContentType::Movie => true,
        ContentType::Series => item
            .episode_id
            .as_deref()
            .is_some_and(|e| !e.trim().is_empty()),
        ContentType::Live | ContentType::Radio => false,
    }
}

/// Rows with `item`'s title on other sources. An item no longer in the
/// catalog has none.
fn same_title(conn: &Connection, item: &CopyRef) -> CoreResult<Vec<ItemRow>> {
    match catalog::same_title(conn, &item.item_ref, None) {
        Ok(rows) => Ok(rows.into_iter().map(|n| n.row).collect()),
        Err(CoreError::NotFound(_)) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

pub(super) fn has_candidates(conn: &Connection, item: &CopyRef) -> CoreResult<bool> {
    Ok(applies(item) && !same_title(conn, item)?.is_empty())
}

/// The kind of source `id`; `None` for a removed source or an unknown kind.
fn source_kind(conn: &Connection, id: &str) -> CoreResult<Option<SourceKind>> {
    let kind: Option<String> = conn
        .query_row("SELECT kind FROM sources WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;
    Ok(kind.and_then(|k| SourceKind::from_str(&k).ok()))
}

/// A container extension as compared: lowercase, no leading dot.
fn container(ext: Option<&str>) -> Option<String> {
    ext.map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// The extension of a playlist link's path ("…/film.mkv?token=1" -> "mkv").
fn url_container(url: Option<&str>) -> Option<String> {
    let url = url::Url::parse(url?.trim()).ok()?;
    let last = url.path_segments()?.next_back()?.to_string();
    let (_, ext) = last.rsplit_once('.')?;
    container(Some(ext))
}

/// The row's container: its own extension, else (M3U) its link's.
fn row_container(row: &ItemRow) -> Option<String> {
    container(row.container_extension.as_deref()).or_else(|| url_container(row.url.as_deref()))
}

pub(super) async fn candidates(
    state: &Arc<AppState>,
    item: &CopyRef,
) -> CoreResult<Vec<Candidate>> {
    if !applies(item) {
        return Ok(Vec::new());
    }
    let (key, own) = (item.clone(), item.item_ref.source_id.clone());
    let (rows, own_kind) = state
        .db_call(move |c| {
            let rows = same_title(c, &key)?
                .into_iter()
                .map(|row| Ok((source_kind(c, &row.source_id)?, row)))
                .collect::<CoreResult<Vec<_>>>()?;
            Ok((rows, source_kind(c, &own)?))
        })
        .await?;
    let rows: Vec<(SourceKind, ItemRow)> = rows
        .into_iter()
        .filter_map(|(kind, row)| Some((kind?, row)))
        .collect();
    if item.item_ref.content_type == ContentType::Movie {
        return Ok(rows
            .into_iter()
            .map(|(kind, row)| Candidate {
                copy: CopyRef::new(
                    ItemRef::new(
                        row.source_id.clone(),
                        ContentType::Movie,
                        row.item_id.clone(),
                    ),
                    None,
                ),
                kind,
                container: row_container(&row),
                quality: matcher::quality(&row.title),
                title: row.title,
            })
            .collect());
    }
    episodes(state, item, own_kind, rows).await
}

/// Episode candidates: the episode of each same-title series with the
/// primary episode's season and episode numbers.
async fn episodes(
    state: &Arc<AppState>,
    item: &CopyRef,
    own_kind: Option<SourceKind>,
    rows: Vec<(SourceKind, ItemRow)>,
) -> CoreResult<Vec<Candidate>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let Some(own_kind) = own_kind else {
        return Ok(Vec::new());
    };
    let episode_id = item.episode_id.as_deref().unwrap_or_default();
    let own = seasons(state, own_kind, &item.item_ref).await?;
    let Some((season, number)) = own
        .iter()
        .flat_map(|s| s.episodes.iter())
        .find(|e| e.id == episode_id)
        .map(|e| (e.season, e.episode))
    else {
        tracing::debug!(
            source = %item.item_ref.source_id,
            "the episode is not in its own series any more; no mirrors"
        );
        return Ok(Vec::new());
    };
    let found: Vec<Vec<Candidate>> = futures::stream::iter(rows)
        .map(|(kind, row)| async move {
            let r = ItemRef::new(row.source_id.clone(), ContentType::Series, row.item_id.clone());
            let list = match seasons(state, kind, &r).await {
                Ok(list) => list,
                Err(err) => {
                    // Stalker and M3U are best effort, and one Xtream panel
                    // that fails costs only its own copy.
                    tracing::debug!(source = %r.source_id, error = %err, "no seasons for a mirror candidate");
                    return Vec::new();
                }
            };
            let quality = matcher::quality(&row.title);
            list.iter()
                .filter(|s| s.number == season)
                .flat_map(|s| s.episodes.iter())
                .filter(|e| e.season == season && e.episode == number)
                .map(|e| Candidate {
                    copy: CopyRef::new(r.clone(), Some(e.id.clone())),
                    kind,
                    title: row.title.clone(),
                    container: container(e.container_extension.as_deref()),
                    quality,
                })
                .collect()
        })
        .buffered(SEASON_READS)
        .collect()
        .await;
    Ok(found.into_iter().flatten().collect())
}

/// Seasons of series `r` on a source of `kind`: Xtream through the cached
/// series info, M3U from the catalog, Stalker from the portal.
async fn seasons(state: &Arc<AppState>, kind: SourceKind, r: &ItemRef) -> CoreResult<Vec<Season>> {
    let read = async {
        match kind {
            SourceKind::Xtream => crate::xtream::service::series_seasons(state, r).await,
            SourceKind::M3u => Ok(crate::m3u::series::series_detail(state, r).await?.seasons),
            SourceKind::Stalker => Ok(crate::stalker::vod::series_detail(state, r).await?.seasons),
        }
    };
    tokio::time::timeout(SEASON_LIMIT, read)
        .await
        .unwrap_or_else(|_| {
            Err(CoreError::Timeout(
                "the series' seasons took too long".into(),
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containers_compare_lowercase_without_the_dot() {
        assert_eq!(container(Some(".MKV")), Some("mkv".into()));
        assert_eq!(container(Some(" mp4 ")), Some("mp4".into()));
        assert_eq!(container(Some("")), None);
        assert_eq!(container(Some("m3u8?x")), None);
        assert_eq!(container(None), None);
        assert_eq!(
            url_container(Some("http://h/movie/a/b/12.MKV?token=1")),
            Some("mkv".into())
        );
        assert_eq!(url_container(Some("http://h/play?id=12")), None);
        assert_eq!(url_container(Some("not a url")), None);
    }

    #[test]
    fn mirrors_apply_to_movies_and_episodes_only() {
        let r = |t| ItemRef::new("s", t, "1");
        assert!(applies(&CopyRef::new(r(ContentType::Movie), None)));
        assert!(applies(&CopyRef::new(
            r(ContentType::Series),
            Some("7".into())
        )));
        assert!(!applies(&CopyRef::new(r(ContentType::Series), None)));
        assert!(!applies(&CopyRef::new(
            r(ContentType::Series),
            Some(" ".into())
        )));
        assert!(!applies(&CopyRef::new(
            r(ContentType::Live),
            Some("catchup:1:2".into())
        )));
        assert!(!applies(&CopyRef::new(r(ContentType::Radio), None)));
    }
}
