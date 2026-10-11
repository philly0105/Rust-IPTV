//! `stalker` module (SPEC C4 stalker): Stalker/Ministra portal support.
//!
//! - [`protocol`]: pure helpers (endpoint candidates, encoding, response
//!   classification, playback command resolution, lenient field readers).
//! - [`session`]: MAG headers, discovery, handshake/profile, token cache in
//!   `app_state` (`stalker_token:<sourceId>`), one re-handshake on auth failure.
//! - [`mapping`]: portal JSON -> catalog rows and model types.
//! - [`sync`]: the importer (live + radio into the catalog; VOD and series
//!   categories only, because VOD is paged live from the portal).
//! - [`vod`]: live-paged movies/series, details, season plans, search.
//! - [`playback`]: `create_link`, catch-up, short EPG, account info.
//!
//! See `docs/architecture/stalker.md`.

pub mod mapping;
pub mod playback;
pub mod protocol;
pub mod rpc;
pub mod session;
mod sha1;
pub mod sync;
pub mod vod;

use crate::error::CoreResult;
use crate::model::ItemRef;
use crate::state::AppState;
use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;

/// `AppState.extensions` key of the stalker runtime.
pub const RUNTIME_KEY: &str = "stalker";
/// Cap of the in-memory VOD item cache (entries); cleared when exceeded.
const ITEM_CACHE_CAP: usize = 5000;
/// Cap of cached season plans.
const PLAN_CACHE_CAP: usize = 500;

/// A portal VOD/series row remembered from a listing, so details and
/// playback do not need to re-page the portal.
#[derive(Debug, Clone)]
pub struct CachedItem {
    pub raw: Value,
    pub category_name: Option<String>,
}

/// Process-wide stalker state.
#[derive(Default)]
pub struct Runtime {
    /// Session per source id.
    pub sessions: DashMap<String, Arc<tokio::sync::Mutex<session::SessionState>>>,
    /// Raw VOD/series rows keyed by `ItemRef::key()`.
    pub items: DashMap<String, CachedItem>,
    /// Season plans keyed by `ItemRef::key()`.
    pub plans: DashMap<String, Arc<Vec<vod::SeasonPlan>>>,
    /// Portal page size keyed by `<sourceId>|<type>`.
    pub page_sizes: DashMap<String, i64>,
}

impl Runtime {
    /// The runtime singleton (created on first use).
    pub fn get(state: &AppState) -> Arc<Runtime> {
        state.ext_or_insert_with::<Runtime>(RUNTIME_KEY, || Arc::new(Runtime::default()))
    }

    pub fn remember(&self, r: &ItemRef, item: CachedItem) {
        if self.items.len() >= ITEM_CACHE_CAP {
            self.items.clear();
        }
        self.items.insert(r.key(), item);
    }

    pub fn remember_plan(&self, r: &ItemRef, plan: Arc<Vec<vod::SeasonPlan>>) {
        if self.plans.len() >= PLAN_CACHE_CAP {
            self.plans.clear();
        }
        self.plans.insert(r.key(), plan);
    }

    /// Drops every cached row and plan of a source (after a resync or config change).
    pub fn forget_source(&self, source_id: &str) {
        let prefix = format!("{source_id}|");
        self.items.retain(|k, _| !k.starts_with(&prefix));
        self.plans.retain(|k, _| !k.starts_with(&prefix));
        self.page_sizes.retain(|k, _| !k.starts_with(&prefix));
    }
}

/// Registers the stalker importer (amendment A1) and creates the runtime.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let _ = Runtime::get(&state);
    crate::sources::register_importer(&state, Arc::new(sync::StalkerImporter));
    Ok(())
}
