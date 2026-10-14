//! `favorites.*`, `recent.*` and `positions.*` RPC commands (SPEC C4).

use super::PositionInput;
use crate::error::RpcError;
use crate::model::{FavoriteEntry, ItemRef, ItemSnapshot, PlaybackPosition, RecentEntry};
use crate::rpc::RpcRouter;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct SourceFilter {
    source_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefSnapshot {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    snapshot: ItemSnapshot,
    /// C7: RFC 3339; restores an entry's original date (Recent undo).
    #[serde(default)]
    viewed_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefOnly {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefEpisode {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    #[serde(default)]
    episode_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemovePositionArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    #[serde(default)]
    episode_id: Option<String>,
    /// C13: drop every unfinished row of the item (all episodes of a series).
    #[serde(default)]
    all_episodes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Refs {
    refs: Vec<ItemRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderArgs {
    #[serde(default)]
    source_id: Option<String>,
    refs: Vec<ItemRef>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RecentListArgs {
    source_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPositionArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    #[serde(default)]
    episode_id: Option<String>,
    position_seconds: f64,
    #[serde(default)]
    duration_seconds: Option<f64>,
    #[serde(default)]
    snapshot: Option<ItemSnapshot>,
    /// C14: RFC 3339; undo/restore puts a row back with its original time.
    #[serde(default)]
    updated_at: Option<String>,
    /// Undo of Mark watched/unwatched puts a watched row back as watched.
    #[serde(default)]
    watched: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetWatchedArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    #[serde(default)]
    episode_id: Option<String>,
    watched: bool,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct LimitArgs {
    limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToggleResult {
    is_favorite: bool,
}

/// Players report fractional seconds; store whole seconds.
fn secs(v: f64) -> Result<i64, RpcError> {
    if !v.is_finite() {
        return Err(RpcError::invalid("seconds must be a finite number"));
    }
    Ok(v.floor() as i64)
}

/// Registers every `favorites.*`, `recent.*`, `positions.*` command and
/// `userstate.setWatched`.
pub fn register(r: &mut RpcRouter) {
    // favorites
    r.add("favorites.list", |state, a: SourceFilter| async move {
        let hide = crate::parental::hide_filter(&state).await?;
        let v = state
            .db_call(move |c| super::favorites_list_filtered(c, a.source_id.as_deref(), hide))
            .await?;
        Ok::<Vec<FavoriteEntry>, RpcError>(v)
    });
    r.add("favorites.toggle", |state, a: RefSnapshot| async move {
        let is_favorite = state
            .db_call(move |c| super::favorite_toggle(c, &a.item_ref, &a.snapshot))
            .await?;
        Ok::<_, RpcError>(ToggleResult { is_favorite })
    });
    r.add("favorites.contains", |state, a: Refs| async move {
        let v = state
            .db_call(move |c| super::favorites_contains(c, &a.refs))
            .await?;
        Ok::<Vec<ItemRef>, RpcError>(v)
    });
    r.add("favorites.reorder", |state, a: ReorderArgs| async move {
        state
            .db_call(move |c| super::favorites_reorder(c, a.source_id.as_deref(), &a.refs))
            .await?;
        Ok::<(), RpcError>(())
    });
    r.add("favorites.remove", |state, a: RefOnly| async move {
        state
            .db_call(move |c| super::favorite_remove(c, &a.item_ref).map(|_| ()))
            .await?;
        Ok::<(), RpcError>(())
    });

    // recent
    r.add("recent.list", |state, a: RecentListArgs| async move {
        let hide = crate::parental::hide_filter(&state).await?;
        let v = state
            .db_call(move |c| super::recent_list_filtered(c, a.source_id.as_deref(), a.limit, hide))
            .await?;
        Ok::<Vec<RecentEntry>, RpcError>(v)
    });
    r.add("recent.add", |state, a: RefSnapshot| async move {
        state
            .db_call(move |c| {
                super::recent_add_at(c, &a.item_ref, &a.snapshot, a.viewed_at.as_deref())
            })
            .await?;
        Ok::<(), RpcError>(())
    });
    r.add("recent.remove", |state, a: RefOnly| async move {
        state
            .db_call(move |c| super::recent_remove(c, &a.item_ref))
            .await?;
        Ok::<(), RpcError>(())
    });
    r.add("recent.clear", |state, a: SourceFilter| async move {
        state
            .db_call(move |c| super::recent_clear(c, a.source_id.as_deref()).map(|_| ()))
            .await?;
        Ok::<(), RpcError>(())
    });

    // positions
    r.add("positions.get", |state, a: RefEpisode| async move {
        let v = state
            .db_call(move |c| super::position_get(c, &a.item_ref, a.episode_id.as_deref()))
            .await?;
        Ok::<Option<PlaybackPosition>, RpcError>(v)
    });
    r.add("positions.set", |state, a: SetPositionArgs| async move {
        let snapshot_json = a.snapshot.as_ref().map(serde_json::to_string).transpose()?;
        let input = PositionInput {
            item_ref: a.item_ref,
            episode_id: a.episode_id,
            position_seconds: secs(a.position_seconds)?,
            duration_seconds: a.duration_seconds.map(secs).transpose()?,
            snapshot_json,
            updated_at: a
                .updated_at
                .as_deref()
                .map(|t| super::parse_viewed_at(t, "updatedAt"))
                .transpose()?,
            watched: a.watched,
        };
        state
            .db_call(move |c| super::position_set(c, &input).map(|_| ()))
            .await?;
        Ok::<(), RpcError>(())
    });
    r.add("positions.forSeries", |state, a: RefOnly| async move {
        let v = state
            .db_call(move |c| super::positions_for_series(c, &a.item_ref))
            .await?;
        Ok::<Vec<PlaybackPosition>, RpcError>(v)
    });
    r.add(
        "positions.continueWatching",
        |state, a: LimitArgs| async move {
            let hide = crate::parental::hide_filter(&state).await?;
            let v = state
                .db_call(move |c| super::continue_watching_filtered(c, a.limit, hide))
                .await?;
            Ok::<Vec<PlaybackPosition>, RpcError>(v)
        },
    );
    r.add(
        "positions.remove",
        |state, a: RemovePositionArgs| async move {
            state
                .db_call(move |c| {
                    if a.all_episodes {
                        super::position_remove_unfinished(c, &a.item_ref).map(|_| ())
                    } else {
                        super::position_remove(c, &a.item_ref, a.episode_id.as_deref())
                    }
                })
                .await?;
            Ok::<(), RpcError>(())
        },
    );
    r.add(
        "userstate.setWatched",
        |state, a: SetWatchedArgs| async move {
            state
                .db_call(move |c| {
                    super::set_watched(c, &a.item_ref, a.episode_id.as_deref(), a.watched)
                })
                .await?;
            Ok::<(), RpcError>(())
        },
    );
}
