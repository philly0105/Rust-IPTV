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

use crate::error::CoreResult;
use crate::state::AppState;
use std::sync::{Arc, Weak};
use std::time::Duration;

/// Wait after launch before the first purge of expired cache rows, clear
/// of the reads the first screens make.
const PURGE_AFTER: Duration = Duration::from_secs(60);
/// Wait between purges in a process that keeps running (the server).
const PURGE_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// Purges expired `tmdb_cache` rows in the background, a minute after
/// launch and then daily. Optional: lookups also ignore expired rows, so a
/// purge only frees disk space, and it reads every cached payload (see
/// [`cache::TmdbCache::purge_expired`]), which launch should not wait for.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    spawn_purge(Arc::downgrade(&state), PURGE_AFTER);
    Ok(())
}

/// Purges after `first`, then every [`PURGE_EVERY`], until the state is
/// dropped. The purge is a write nobody waits on, so it goes through
/// `db_background` and user writes never queue behind it, one step of
/// [`cache::PURGE_BATCH`] rows per turn of the gate: the image cache index,
/// download progress and recordings, which share that gate, wait for one
/// step at most, not for a read of every cached payload.
fn spawn_purge(weak: Weak<AppState>, first: Duration) {
    tokio::spawn(async move {
        let mut wait = first;
        loop {
            tokio::time::sleep(wait).await;
            let Some(state) = weak.upgrade() else {
                return;
            };
            match purge(&state).await {
                Ok(0) => {}
                Ok(n) => tracing::debug!(rows = n, "tmdb expired cache rows purged"),
                Err(err) => tracing::warn!(error = %err, "tmdb cache purge failed"),
            }
            drop(state);
            wait = PURGE_EVERY;
        }
    });
}

/// Deletes the rows expired now, a step at a time; returns how many.
async fn purge(state: &AppState) -> CoreResult<u64> {
    let now = chrono::Utc::now();
    let mut purged = 0;
    let mut after = Some(i64::MIN);
    while let Some(from) = after {
        let (n, next) = state
            .db_background(move |c| cache::TmdbCache::purge_expired_step(c, now, from))
            .await?;
        purged += n;
        after = next;
    }
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::NoopSink;

    async fn keys(state: &AppState) -> Vec<String> {
        state
            .db_call(|c| {
                let mut stmt =
                    c.prepare("SELECT lookup_key FROM tmdb_cache ORDER BY lookup_key")?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                Ok(rows.collect::<Result<_, _>>()?)
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn launch_leaves_the_purge_to_a_background_task() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        state
            .db_call(|c| {
                c.execute_batch(
                    "INSERT INTO tmdb_cache (media_type, lookup_key, fetched_at, expires_at) VALUES
                       ('movie', 'expired', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
                       ('movie', 'fresh', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z')",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        init(state.clone()).await.unwrap();
        assert_eq!(
            keys(&state).await,
            ["expired", "fresh"],
            "init reads nothing"
        );

        spawn_purge(Arc::downgrade(&state), Duration::ZERO);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while keys(&state).await.len() > 1 {
            assert!(tokio::time::Instant::now() < deadline, "never purged");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(keys(&state).await, ["fresh"]);
    }
}
