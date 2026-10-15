//! `m3u` module (B1): streaming M3U parser, the m3u [`Importer`](crate::sources::Importer),
//! and `m3u.*` rpc. See `docs/architecture/m3u.md`.

pub mod body;
pub mod importer;
pub mod parser;
mod remap;
pub mod rpc;

pub use importer::{
    cached_playlist_path, classify, group_id, import_source, item_id, place_raw_text,
    remove_cached_playlist, stored_text, M3uImporter, RowBuilder,
};
pub use parser::{parse_str, M3uEntry, M3uHeader, M3uReader, ParseStats};

use crate::error::CoreResult;
use crate::state::AppState;
use std::sync::Arc;

/// Registers the m3u importer, clears temp files left by a crash, and deletes
/// cached playlist copies whose source no longer exists.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    crate::sources::register_importer(&state, Arc::new(M3uImporter));
    let tmp = state.data_dir.join("tmp");
    if let Ok(mut dir) = tokio::fs::read_dir(&tmp).await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("m3u-") && name.ends_with(".part") {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
    if let Err(err) = sweep_playlists(&state).await {
        tracing::warn!(%err, "could not sweep orphan playlist copies");
    }
    Ok(())
}

/// Deletes `playlists/<id>.m3u` files without a `sources` row (left by a
/// crash, a DB quarantine or an older Replace import) and interrupted
/// `.m3u.part` writes.
async fn sweep_playlists(state: &AppState) -> CoreResult<()> {
    let dir = state.data_dir.join("playlists");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    let ids: std::collections::HashSet<String> = state
        .db_call(|c| {
            let mut stmt = c.prepare("SELECT id FROM sources")?;
            let ids = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(ids)
        })
        .await?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let orphan = name.ends_with(".m3u.part")
            || name
                .strip_suffix(".m3u")
                .is_some_and(|id| !ids.contains(id));
        if orphan {
            match std::fs::remove_file(entry.path()) {
                Ok(()) => tracing::info!(file = %name, "removed orphan playlist copy"),
                Err(err) => {
                    tracing::warn!(%err, file = %name, "could not remove orphan playlist copy")
                }
            }
        }
    }
    Ok(())
}
