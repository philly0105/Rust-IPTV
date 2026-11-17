//! Connection-limit probes: finding how many connections a panel really
//! allows, beyond what the account reports.
//!
//! Every function here is a placeholder that keeps today's behaviour (no
//! probes, no learned limits). The real bodies replace them; the signatures
//! are the contract.

use super::manager::TaskCtl;
use super::shared::{Endpoint, ProbeOutcome};
use super::DownloadManager;
use crate::error::CoreResult;
use crate::model::SourceConnectionLimit;
use crate::state::AppState;
use std::sync::Arc;
use std::time::Duration;

/// Sync. True when `ctl` should probe `source` now: settings allow it, the
/// source is Xtream or Stalker, its record is missing or due, nothing plays
/// or records from it, no probe runs on it, it is not blocked, `ctl` holds
/// everything it may there, and the effective limit is below the engine's
/// cap plus one.
pub fn probe_due(_state: &AppState, _mgr: &DownloadManager, _ctl: &TaskCtl, _source: &str) -> bool {
    false
}

/// Runs one probe round for `ctl` on `ep` (a file of `total` bytes) and
/// records the result. `None` when no round ran.
pub async fn probe(
    _state: &Arc<AppState>,
    _mgr: &DownloadManager,
    _ctl: &TaskCtl,
    _ep: &Endpoint,
    _total: i64,
) -> Option<ProbeOutcome> {
    None
}

/// Every source's connection limit as downloads see it
/// (`downloads.connectionLimits`).
pub async fn list(_state: &Arc<AppState>) -> CoreResult<Vec<SourceConnectionLimit>> {
    Ok(Vec::new())
}

/// Forgets what probes learned about `source_id`, so the next eligible
/// transfer may probe again (`downloads.resetConnectionLimit`).
pub async fn reset(_state: &Arc<AppState>, _source_id: &str) -> CoreResult<()> {
    Ok(())
}

/// Test hook: moves `source_id`'s probe record `by` into the past.
pub async fn age(_state: &Arc<AppState>, _source_id: &str, _by: Duration) -> CoreResult<()> {
    Ok(())
}
