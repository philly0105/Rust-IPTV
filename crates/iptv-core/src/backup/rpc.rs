//! `backup.export` and `backup.import` RPC commands (SPEC C4/C15).

use super::{ExportResult, ImportMode, ImportReport};
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ExportArgs {
    include_secrets: bool,
    /// Desktop only: write the backup to this file instead of returning it.
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportArgs {
    json: String,
    #[serde(default)]
    mode: ImportMode,
    /// Merge only: return before the catalogs load (L2-settings-3).
    #[serde(default)]
    background: bool,
}

/// Registers `backup.export` and `backup.import`.
pub fn register(r: &mut RpcRouter) {
    r.add("backup.export", |state, a: ExportArgs| async move {
        let v = super::export(&state, a.include_secrets, a.path.as_deref()).await?;
        Ok::<ExportResult, RpcError>(v)
    });
    r.add("backup.import", |state, a: ImportArgs| async move {
        let v = super::import_with(&state, &a.json, a.mode, a.background).await?;
        Ok::<ImportReport, RpcError>(v)
    });
}
