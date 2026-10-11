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
/// with a full refresh, and records the outcome the same way.
async fn sync(state: Arc<AppState>, a: SyncArgs) -> Result<ImportSummary, RpcError> {
    let sid = a.source_id.clone();
    let source = state.db_call(move |c| load_source(c, &sid)).await?;
    let plan = SyncPlan::from_types(a.content_types.as_deref());
    if plan == SyncPlan::ALL {
        let (_, summary) = sources::run_import(state, &source.id).await?;
        return Ok(summary);
    }
    let id = source.id.clone();
    let result = sources::run_import_with(&state, &id, async {
        // Re-read under the lock: a refresh or edit that finished while we
        // waited may have changed (or removed) the source.
        let sid = id.clone();
        let source = state.db_call(move |c| load_source(c, &sid)).await?;
        let result = sync_source(state.clone(), &id, &source.config, plan).await;
        let error = result.as_ref().err().map(sources::error_text);
        let sid = id.clone();
        let err2 = error.clone();
        if let Err(err) = state
            .db_call(move |c| sources::store::record_import(c, &sid, err2.as_deref()))
            .await
        {
            tracing::warn!(source_id = %id, error = %err, "could not record xtream sync outcome");
        }
        match (&result, &error) {
            (Ok(s), _) => {
                let total = (s.channels + s.movies + s.series).max(0) as u64;
                sources::progress(&state, &id, "done", total, Some(total), None);
            }
            (Err(_), msg) => sources::progress(&state, &id, "error", 0, None, msg.as_deref()),
        }
        sources::emit_changed(&state);
        result
    })
    .await;
    Ok(result?)
}
