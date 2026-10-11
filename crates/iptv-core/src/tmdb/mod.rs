//! TMDB v3 enrichment (SPEC C4 tmdb, C3 `tmdb_cache`). See
//! `docs/architecture/tmdb.md`.
//!
//! This product uses the TMDB API but is not endorsed or certified by TMDB.

pub mod cache;
pub mod client;
pub mod config;
pub mod map;
pub mod matcher;
pub mod normalize;
pub mod raw;
pub mod rpc;
pub mod service;

pub use service::{TestKeyResult, Tmdb};

/// Purges expired `tmdb_cache` rows. Optional: lookups also ignore expired
/// rows, so skipping this only costs disk space.
pub async fn init(state: std::sync::Arc<crate::state::AppState>) -> crate::error::CoreResult<()> {
    let n = cache::TmdbCache::purge_expired(&state.db).await?;
    if n > 0 {
        tracing::debug!(rows = n, "tmdb expired cache rows purged");
    }
    Ok(())
}
