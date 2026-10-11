//! `m3u` module (B1): streaming M3U parser, the m3u [`Importer`](crate::sources::Importer),
//! and `m3u.*` rpc. See `docs/architecture/m3u.md`.

pub mod importer;
pub mod parser;
pub mod rpc;

pub use importer::{classify, group_id, import_source, item_id, M3uImporter, RowBuilder};
pub use parser::{parse_str, M3uEntry, M3uHeader, M3uReader, ParseStats};

use crate::error::CoreResult;
use crate::state::AppState;
use std::sync::Arc;

/// Registers the m3u importer and clears temp files left by a crash.
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
    Ok(())
}
