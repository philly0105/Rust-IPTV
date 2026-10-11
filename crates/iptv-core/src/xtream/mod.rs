//! Xtream Codes portals (SPEC C4 xtream): `player_api.php` client with lenient
//! JSON, catalog sync into `crate::catalog`, detail pages, stream / catch-up
//! URLs, short EPG, account info and connection test.
//!
//! Layout: [`url`] (normalization + URL builders), [`raw`] (wire types),
//! [`client`] (HTTP + retry + auth check), [`meta`] (server clock / formats
//! cache, time helpers), [`sync`] (importer), [`service`] (everything else),
//! [`rpc`] (command registration). See `docs/architecture/xtream.md`.
//!
//! Secrets: the password only ever appears in request queries and in stream
//! URLs handed to the player. Logs carry server, username and action; errors
//! come from reqwest with the URL stripped.

pub mod client;
pub mod meta;
pub mod raw;
pub mod rpc;
pub mod service;
pub mod sync;
pub mod url;

use crate::error::{CoreError, CoreResult};
use crate::model::{ImportSummary, Source, SourceKind};
use crate::sources::{register_importer, Importer};
use crate::state::AppState;
use std::sync::Arc;

pub use client::XtreamClient;
pub use sync::{sync_source, SyncPlan};

/// The xtream [`Importer`]: a full sync of live, movies and series.
pub struct XtreamImporter;

#[async_trait::async_trait]
impl Importer for XtreamImporter {
    fn kind(&self) -> SourceKind {
        SourceKind::Xtream
    }

    async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary> {
        let cfg = source.xtream.as_ref().ok_or_else(|| {
            CoreError::invalid(format!(
                "Source \"{}\" has no Xtream settings. Edit the source and enter the server, username and password.",
                source.name
            ))
        })?;
        sync_source(state, &source.id, cfg, SyncPlan::ALL).await
    }
}

/// Registers the xtream importer (amendment A1). Called by `crate::rpc::init_all`.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    register_importer(&state, Arc::new(XtreamImporter));
    Ok(())
}
