//! `lists.*` RPC commands (Run 2 contract C3).
//!
//! Each handler runs the synchronous function of the same name in the parent
//! module through [`AppState::db_call`]. Every write that changed something
//! emits [`super::CHANGED_EVENT`] with `{}` once it has committed; calls
//! that change nothing (removing an absent list or channel, adding only
//! channels already there, an update to the current values) emit nothing.
//! Readers and the writes that report counts apply the parental hide filter
//! ([`crate::parental::hide_filter`]) and the Live TV quality filter
//! (`catalog::rpc::quality_filter`).

use super::{CustomList, CustomListEntry, NewItem, CHANGED_EVENT};
use crate::catalog::rpc::NeighborsResult;
use crate::error::RpcError;
use crate::model::ItemRef;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &[
    "lists.list",
    "lists.create",
    "lists.update",
    "lists.remove",
    "lists.reorder",
    "lists.items",
    "lists.addItems",
    "lists.removeItems",
    "lists.reorderItems",
    "lists.containing",
    "lists.neighbors",
];

/// `lists.create`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    pub name: String,
    #[serde(default)]
    pub items: Option<Vec<NewItem>>,
}

/// `lists.update`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub on_dashboard: Option<bool>,
}

/// `lists.remove` and `lists.items`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub id: String,
}

/// `lists.reorder`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderArgs {
    pub ids: Vec<String>,
}

/// `lists.addItems`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddItemsArgs {
    pub id: String,
    pub items: Vec<NewItem>,
}

/// `lists.addItems` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedResult {
    pub added: usize,
}

/// `lists.removeItems` and `lists.reorderItems`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsArgs {
    pub id: String,
    pub refs: Vec<ItemRef>,
}

/// `lists.containing`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
}

/// `lists.neighbors`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborsArgs {
    pub id: String,
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
}

type S = Arc<AppState>;

fn changed(state: &AppState) {
    state.emit(CHANGED_EVENT, json!({}));
}

/// Registers every `lists.*` command.
pub fn register(r: &mut RpcRouter) {
    r.add("lists.list", |s: S, _: ()| async move {
        let hide = crate::parental::hide_filter(&s).await?;
        let quality = crate::catalog::rpc::quality_filter(&s);
        let v = s.db_call(move |c| super::list(c, hide, quality)).await?;
        Ok::<Vec<CustomList>, RpcError>(v)
    });
    r.add("lists.create", |s: S, a: CreateArgs| async move {
        let hide = crate::parental::hide_filter(&s).await?;
        let quality = crate::catalog::rpc::quality_filter(&s);
        let items = a.items.unwrap_or_default();
        let v = s
            .db_write(move |c| super::create(c, &a.name, &items, hide, quality))
            .await?;
        changed(&s);
        Ok::<CustomList, RpcError>(v)
    });
    r.add("lists.update", |s: S, a: UpdateArgs| async move {
        let hide = crate::parental::hide_filter(&s).await?;
        let quality = crate::catalog::rpc::quality_filter(&s);
        let (v, did) = s
            .db_write(move |c| {
                super::update(c, &a.id, a.name.as_deref(), a.on_dashboard, hide, quality)
            })
            .await?;
        if did {
            changed(&s);
        }
        Ok::<CustomList, RpcError>(v)
    });
    r.add("lists.remove", |s: S, a: IdArgs| async move {
        if s.db_write(move |c| super::remove(c, &a.id)).await? {
            changed(&s);
        }
        Ok::<(), RpcError>(())
    });
    r.add("lists.reorder", |s: S, a: ReorderArgs| async move {
        s.db_write(move |c| super::reorder(c, &a.ids)).await?;
        changed(&s);
        Ok::<(), RpcError>(())
    });
    r.add("lists.items", |s: S, a: IdArgs| async move {
        let hide = crate::parental::hide_filter(&s).await?;
        let quality = crate::catalog::rpc::quality_filter(&s);
        let v = s
            .db_call(move |c| super::items(c, &a.id, hide, quality))
            .await?;
        Ok::<Vec<CustomListEntry>, RpcError>(v)
    });
    r.add("lists.addItems", |s: S, a: AddItemsArgs| async move {
        let added = s
            .db_write(move |c| super::add_items(c, &a.id, &a.items))
            .await?;
        if added > 0 {
            changed(&s);
        }
        Ok::<_, RpcError>(AddedResult { added })
    });
    r.add("lists.removeItems", |s: S, a: RefsArgs| async move {
        if s.db_write(move |c| super::remove_items(c, &a.id, &a.refs))
            .await?
            > 0
        {
            changed(&s);
        }
        Ok::<(), RpcError>(())
    });
    r.add("lists.reorderItems", |s: S, a: RefsArgs| async move {
        s.db_write(move |c| super::reorder_items(c, &a.id, &a.refs))
            .await?;
        changed(&s);
        Ok::<(), RpcError>(())
    });
    r.add("lists.containing", |s: S, a: RefArgs| async move {
        let v = s
            .db_call(move |c| super::containing(c, &a.item_ref))
            .await?;
        Ok::<Vec<String>, RpcError>(v)
    });
    r.add("lists.neighbors", |s: S, a: NeighborsArgs| async move {
        let hide = crate::parental::hide_filter(&s).await?;
        let quality = crate::catalog::rpc::quality_filter(&s);
        let (prev, next) = s
            .db_call(move |c| super::neighbors(c, &a.id, &a.item_ref, hide, quality))
            .await?;
        Ok::<_, RpcError>(NeighborsResult { prev, next })
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

        for args in [Value::Null, json!({})] {
            let v = r.dispatch(state.clone(), "lists.list", args).await.unwrap();
            assert_eq!(v, json!([]));
        }
        let movie = json!({"sourceId": "s1", "contentType": "movie", "itemId": "7"});
        let snap = json!({"title": "Film", "contentType": "movie"});
        for (cmd, bad) in [
            ("lists.create", json!({})),
            ("lists.create", json!({"name": ""})),
            ("lists.create", json!({"name": 5})),
            (
                "lists.create",
                json!({"name": "A", "items": [{"ref": movie, "snapshot": snap}]}),
            ),
            ("lists.update", json!({"name": "A"})),
            ("lists.reorder", json!({"ids": ["x"]})),
            ("lists.items", Value::Null),
            ("lists.addItems", json!({"id": "x"})),
            ("lists.removeItems", json!({"id": "x", "refs": "s1"})),
            ("lists.reorderItems", json!({"refs": []})),
            (
                "lists.containing",
                json!({"ref": {"sourceId": "", "contentType": "live", "itemId": "1"}}),
            ),
            ("lists.neighbors", json!({"id": "x"})),
        ] {
            let e = r
                .dispatch(state.clone(), cmd, bad.clone())
                .await
                .unwrap_err();
            assert_eq!(e.code, RpcErrorCode::Invalid, "{cmd} {bad}: {e:?}");
        }
        // A movie ref is in no list; menus may ask anyway.
        let v = r
            .dispatch(state.clone(), "lists.containing", json!({"ref": movie}))
            .await
            .unwrap();
        assert_eq!(v, json!([]));
        for (cmd, args) in [
            ("lists.update", json!({"id": "x", "name": "A"})),
            ("lists.items", json!({"id": "x"})),
            ("lists.addItems", json!({"id": "x", "items": []})),
            ("lists.removeItems", json!({"id": "x", "refs": []})),
            ("lists.reorderItems", json!({"id": "x", "refs": []})),
            (
                "lists.neighbors",
                json!({"id": "x", "ref": {"sourceId": "s", "contentType": "live", "itemId": "1"}}),
            ),
        ] {
            let e = r
                .dispatch(state.clone(), cmd, args.clone())
                .await
                .unwrap_err();
            assert_eq!(e.code, RpcErrorCode::NotFound, "{cmd} {args}: {e:?}");
        }
        // Removing an unknown list is a no-op.
        r.dispatch(state.clone(), "lists.remove", json!({"id": "x"}))
            .await
            .unwrap();
    }
}
