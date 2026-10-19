//! `watchlist.*` RPC commands (contract C3).
//!
//! Each handler runs the synchronous function of the same name in the parent
//! module through [`AppState::db_call`]. Every write that changes My List
//! emits [`super::CHANGED_EVENT`] with `{}` once it has committed, so other
//! windows and the remote refresh their copy.

use super::{WatchlistEntry, CHANGED_EVENT};
use crate::error::RpcError;
use crate::model::{ContentType, ItemRef, ItemSnapshot};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &[
    "watchlist.list",
    "watchlist.toggle",
    "watchlist.contains",
    "watchlist.remove",
    "watchlist.reorder",
];

/// `watchlist.list`: optional source and content type filters (`movie` or `series`).
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListArgs {
    pub source_id: Option<String>,
    pub content_type: Option<ContentType>,
}

/// `watchlist.toggle`: adds the item when absent, removes it when present.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub snapshot: ItemSnapshot,
}

/// `watchlist.toggle` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleResult {
    pub in_list: bool,
}

/// `watchlist.contains` and `watchlist.reorder`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsArgs {
    pub refs: Vec<ItemRef>,
}

/// `watchlist.remove`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
}

type S = Arc<AppState>;

fn changed(state: &AppState) {
    state.emit(CHANGED_EVENT, json!({}));
}

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("watchlist.list", |s: S, a: ListArgs| async move {
        let hide = crate::parental::hide_filter(&s).await?;
        let v = s
            .db_call(move |c| super::list_filtered(c, a.source_id.as_deref(), a.content_type, hide))
            .await?;
        Ok::<Vec<WatchlistEntry>, RpcError>(v)
    });
    r.add("watchlist.toggle", |s: S, a: ToggleArgs| async move {
        let in_list = s
            .db_write(move |c| super::toggle(c, &a.item_ref, &a.snapshot))
            .await?;
        changed(&s);
        Ok::<_, RpcError>(ToggleResult { in_list })
    });
    r.add("watchlist.contains", |s: S, a: RefsArgs| async move {
        let v = s.db_call(move |c| super::contains(c, &a.refs)).await?;
        Ok::<Vec<ItemRef>, RpcError>(v)
    });
    r.add("watchlist.remove", |s: S, a: RefArgs| async move {
        // Removing an absent item is a no-op: nothing changed, no event.
        if s.db_write(move |c| super::remove(c, &a.item_ref)).await? {
            changed(&s);
        }
        Ok::<(), RpcError>(())
    });
    r.add("watchlist.reorder", |s: S, a: RefsArgs| async move {
        s.db_write(move |c| super::reorder(c, &a.refs)).await?;
        changed(&s);
        Ok::<(), RpcError>(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::RpcErrorCode;
    use crate::events::NoopSink;
    use serde_json::Value;

    #[tokio::test]
    async fn registers_the_contract_and_rejects_bad_args() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        let mut r = RpcRouter::new();
        register(&mut r);
        let mut expected = COMMANDS.to_vec();
        expected.sort_unstable();
        assert_eq!(
            r.names(),
            expected,
            "COMMANDS lists exactly what register adds"
        );

        // `{}` and null both work for the all-optional list filter.
        for args in [Value::Null, json!({})] {
            let v = r
                .dispatch(state.clone(), "watchlist.list", args)
                .await
                .unwrap();
            assert_eq!(v, json!([]));
        }
        // Malformed payloads, and refs My List cannot hold, fail as invalid.
        let live = json!({"sourceId": "s1", "contentType": "live", "itemId": "7"});
        for (cmd, bad) in [
            ("watchlist.list", json!({"contentType": "tv"})),
            ("watchlist.list", json!({"contentType": "radio"})),
            ("watchlist.toggle", json!({"ref": {"sourceId": "s1"}})),
            (
                "watchlist.toggle",
                json!({"ref": live, "snapshot": {"title": "BBC", "contentType": "live"}}),
            ),
            ("watchlist.contains", json!({"refs": "s1"})),
            ("watchlist.remove", Value::Null),
            ("watchlist.remove", json!({"ref": live})),
            ("watchlist.reorder", json!({})),
            ("watchlist.reorder", json!({"refs": [live]})),
        ] {
            let e = r
                .dispatch(state.clone(), cmd, bad.clone())
                .await
                .unwrap_err();
            assert_eq!(e.code, RpcErrorCode::Invalid, "{cmd} {bad}: {e:?}");
        }
    }
}
