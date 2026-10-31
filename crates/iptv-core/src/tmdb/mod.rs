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

/// Purges expired `tmdb_cache` rows in the background. Optional: lookups
/// also ignore expired rows, so skipping this only costs disk space.
///
/// Not awaited: `rpc::init_all` runs the module inits one after another and
/// server mode listens only after them, and this DELETE once read the whole
/// cache (R4-2). It passes the write gate like the cache writes themselves,
/// so it never takes a pooled connection outside one.
pub async fn init(state: std::sync::Arc<crate::state::AppState>) -> crate::error::CoreResult<()> {
    state.writer().spawn("tmdb cache purge", |conn| {
        let n = cache::TmdbCache::purge_expired(conn, chrono::Utc::now())?;
        if n > 0 {
            tracing::debug!(rows = n, "tmdb expired cache rows purged");
        }
        Ok(())
    });
    Ok(())
}
