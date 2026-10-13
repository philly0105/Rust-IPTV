//! `account.*` RPC commands.

use super::AccountStatus;
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::Deserialize;
use std::sync::Arc;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &["account.status", "account.statusAll"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusArgs {
    pub source_id: String,
    /// Ask the provider now (rate limited to one check per 20 s per source).
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Default, Deserialize)]
pub struct NoArgs {}

/// Registers the `account.*` commands.
pub fn register(r: &mut RpcRouter) {
    r.add(
        "account.status",
        |s: Arc<AppState>, a: StatusArgs| async move {
            Ok::<Option<AccountStatus>, RpcError>(super::status(&s, &a.source_id, a.refresh).await?)
        },
    );
    r.add(
        "account.statusAll",
        |s: Arc<AppState>, _a: NoArgs| async move {
            Ok::<Vec<AccountStatus>, RpcError>(super::status_all(&s).await?)
        },
    );
}
