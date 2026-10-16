//! `epg.*` RPC commands (SPEC C4).

use crate::error::RpcError;
use crate::model::ItemRef;
use crate::rpc::RpcRouter;
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RefreshArgs {
    url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NowNextArgs {
    refs: Vec<ItemRef>,
    /// `settings.epgOffsetMinutes`; "now" is matched against `now - offset`.
    #[serde(default)]
    offset_minutes: Option<i32>,
    /// False leaves programme descriptions out (default true).
    #[serde(default)]
    with_description: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgramsArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    from: String,
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GridArgs {
    refs: Vec<ItemRef>,
    from: String,
    to: String,
    /// False leaves programme descriptions out (default true).
    #[serde(default)]
    with_description: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchArgs {
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetMappingArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    #[serde(default)]
    epg_channel_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEnabledArgs {
    url: String,
    enabled: bool,
}

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("epg.sources", |s, _a: ()| async move {
        super::sources(&s).await.map_err(RpcError::from)
    });
    r.add("epg.refresh", |s, a: RefreshArgs| async move {
        super::refresh(s, a.url).await.map_err(RpcError::from)
    });
    r.add("epg.nowNext", |s, a: NowNextArgs| async move {
        super::now_next_opts(
            &s,
            a.refs,
            a.offset_minutes.unwrap_or(0),
            a.with_description.unwrap_or(true),
        )
        .await
        .map_err(RpcError::from)
    });
    r.add("epg.programs", |s, a: ProgramsArgs| async move {
        super::programs(&s, a.item_ref, &a.from, &a.to)
            .await
            .map_err(RpcError::from)
    });
    r.add("epg.grid", |s, a: GridArgs| async move {
        super::grid_opts(
            &s,
            a.refs,
            &a.from,
            &a.to,
            a.with_description.unwrap_or(true),
        )
        .await
        .map_err(RpcError::from)
    });
    r.add("epg.channelsSearch", |s, a: SearchArgs| async move {
        super::channels_search(&s, a.query, a.limit)
            .await
            .map_err(RpcError::from)
    });
    r.add("epg.setMapping", |s, a: SetMappingArgs| async move {
        super::set_mapping(&s, a.item_ref, a.epg_channel_id)
            .await
            .map_err(RpcError::from)
    });
    r.add("epg.clearMapping", |s, a: RefArgs| async move {
        super::clear_mapping(&s, a.item_ref)
            .await
            .map_err(RpcError::from)
    });
    r.add("epg.resolve", |s, a: RefArgs| async move {
        super::resolve_ref(&s, a.item_ref)
            .await
            .map_err(RpcError::from)
    });
    r.add("epg.setEnabled", |s, a: SetEnabledArgs| async move {
        super::set_enabled(s, a.url, a.enabled)
            .await
            .map_err(RpcError::from)
    });
    r.add("epg.clearAll", |s, _a: ()| async move {
        let deleted = s
            .db_call(|c| {
                let deleted = super::store::clear_all(c)?;
                // Guide search (C5): re-index what is left (staging rows only).
                super::search::refresh_index(c);
                Ok(deleted)
            })
            .await
            .map_err(RpcError::from)?;
        super::ingest::runtime(&s).bump();
        tracing::info!(programs = deleted, "EPG data cleared");
        s.emit("epg.changed", serde_json::json!({}));
        Ok::<(), RpcError>(())
    });
    // guide: programme search (Run 2 C5).
    r.add(
        "epg.search",
        |s, a: super::search::SearchRequest| async move {
            super::search::search(&s, a).await.map_err(RpcError::from)
        },
    );
}
