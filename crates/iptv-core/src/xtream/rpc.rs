//! `xtream.*` RPC commands (SPEC C4).

use super::service::{self, ConnectionTestResult, XtreamAccountInfo};
use super::sync::{load_source, sync_source, SyncPlan};
use crate::error::RpcError;
use crate::model::{
    ContentType, EpgProgram, ImportSummary, ItemRef, PlayerSource, SeriesDetail, VodDetail,
    XtreamSourceConfig,
};
use crate::rpc::RpcRouter;
use crate::sources;
use crate::state::AppState;
use serde::Deserialize;
use std::sync::Arc;

/// Every command this module registers, in C4 order.
pub const COMMANDS: &[&str] = &[
    "xtream.sync",
    "xtream.vodDetail",
    "xtream.seriesDetail",
    "xtream.streamUrl",
    "xtream.catchupUrl",
    "xtream.shortEpg",
    "xtream.accountInfo",
    "xtream.test",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncArgs {
    pub source_id: String,
    #[serde(default)]
    pub content_types: Option<Vec<ContentType>>,
}

#[derive(Debug, Deserialize)]
pub struct RefArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamUrlArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub episode_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchupArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub start: String,
    pub duration_minutes: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortEpgArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArgs {
    pub source_id: String,
}

#[derive(Debug, Deserialize)]
pub struct TestArgs {
    pub config: XtreamSourceConfig,
}

/// Registers the C4 xtream commands.
pub fn register(r: &mut RpcRouter) {
    r.add(
        "xtream.sync",
        |s, a: SyncArgs| async move { sync(s, a).await },
    );
    r.add("xtream.vodDetail", |s, a: RefArgs| async move {
        Ok::<VodDetail, RpcError>(service::vod_detail(&s, &a.item_ref).await?)
    });
    r.add("xtream.seriesDetail", |s, a: RefArgs| async move {
        Ok::<SeriesDetail, RpcError>(service::series_detail(&s, &a.item_ref).await?)
    });
    r.add("xtream.streamUrl", |s, a: StreamUrlArgs| async move {
        Ok::<PlayerSource, RpcError>(
            service::stream_url(&s, &a.item_ref, a.episode_id.as_deref()).await?,
        )
    });
    r.add("xtream.catchupUrl", |s, a: CatchupArgs| async move {
        Ok::<PlayerSource, RpcError>(
            service::catchup_url(&s, &a.item_ref, &a.start, a.duration_minutes).await?,
        )
    });
    r.add("xtream.shortEpg", |s, a: ShortEpgArgs| async move {
        Ok::<Vec<EpgProgram>, RpcError>(service::short_epg(&s, &a.item_ref, a.limit).await?)
    });
    r.add("xtream.accountInfo", |s, a: SourceArgs| async move {
        Ok::<XtreamAccountInfo, RpcError>(service::account_info(&s, &a.source_id).await?)
    });
    r.add("xtream.test", |s, a: TestArgs| async move {
        Ok::<ConnectionTestResult, RpcError>(service::test(&s, &a.config).await?)
    });
}

/// `xtream.sync`. A full sync is `sources::run_import` (per-source lock,
/// `last_refresh_at` / `last_error`, `done` / `error` progress,
/// `sources.changed`). A subset (`contentTypes`) runs under the same
/// per-source lock via `sources::run_import_with`, so it never interleaves
/// with a full refresh, and records the outcome the same way: a failure is
/// recorded with its error code (C10); a cancelled run (C8) records nothing,
/// keeps the previous catalog, and rejects with `details.cancelled`.
async fn sync(state: Arc<AppState>, a: SyncArgs) -> Result<ImportSummary, RpcError> {
    let sid = a.source_id.clone();
    let source = state.db_call(move |c| load_source(c, &sid)).await?;
    let plan = SyncPlan::from_types(a.content_types.as_deref());
    let id = source.id.clone();
    if plan == SyncPlan::ALL {
        return match sources::run_import(state, &id).await {
            Ok((_, summary)) => Ok(summary),
            Err(err) => Err(sync_rpc_error(&id, err)),
        };
    }
    let result = sources::run_import_with(&state, &id, async {
        // Re-read under the lock: a refresh or edit that finished while we
        // waited may have changed (or removed) the source.
        let sid = id.clone();
        let source = state.db_call(move |c| load_source(c, &sid)).await?;
        let result = sync_source(state.clone(), &id, &source.config, plan).await;
        let cancelled = sources::is_import_cancelled()
            || result.as_ref().err().is_some_and(sources::is_cancelled_error);
        if cancelled {
            // `run_import_with` emits the "cancelled" progress.
            tracing::info!(source_id = %id, "xtream sync cancelled; previous catalog kept");
            return Err(if user_cancelled(&state, &id) {
                sources::user_cancelled_error()
            } else {
                sources::import_cancelled_error()
            });
        }
        let sid = id.clone();
        let failure = result
            .as_ref()
            .err()
            .map(|err| (sources::error_text(err), err.code()));
        let stored = failure
            .as_ref()
            .map(|(msg, code)| (crate::logging::redact_text(msg).into_owned(), *code));
        let recorded = state
            .db_call(move |c| match &stored {
                Some((msg, code)) => sources::store::record_import_error(c, &sid, msg, *code),
                None => sources::store::record_import(c, &sid, None),
            })
            .await;
        if let Err(err) = recorded {
            tracing::warn!(source_id = %id, error = %err, "could not record xtream sync outcome");
        }
        match (&result, failure) {
            (Ok(s), _) => {
                let total = (s.channels + s.movies + s.series).max(0) as u64;
                sources::progress(&state, &id, "done", total, Some(total), None);
            }
            (Err(_), Some((msg, code))) => {
                tracing::warn!(source_id = %id, error = %msg, code = code.as_str(), "xtream sync failed; previous catalog kept");
                sources::progress_error(&state, &id, &msg, code);
            }
            (Err(_), None) => {}
        }
        sources::emit_changed(&state);
        result
    })
    .await;
    result.map_err(|err| sync_rpc_error(&id, err))
}

/// RPC error of `xtream.sync`: a cancelled run carries
/// `details: {sourceId, cancelled: true}` (C8).
fn sync_rpc_error(source_id: &str, err: crate::error::CoreError) -> RpcError {
    if sources::is_cancelled_error(&err) {
        RpcError::from(err)
            .with_details(serde_json::json!({ "sourceId": source_id, "cancelled": true }))
    } else {
        RpcError::from(err)
    }
}

/// True when the run in progress for `source_id` was stopped by
/// `sources.cancelImport` (versus a remove or settings change).
fn user_cancelled(state: &AppState, source_id: &str) -> bool {
    type ActiveMap = dashmap::DashMap<String, Arc<sources::ActiveRun>>;
    state
        .ext::<ActiveMap>(sources::ACTIVE_KEY)
        .and_then(|m| m.get(source_id).map(|r| r.value().clone()))
        .is_some_and(|r| r.user_cancelled.load(std::sync::atomic::Ordering::SeqCst))
}
