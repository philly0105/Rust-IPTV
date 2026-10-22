//! `catalog.items`: `catalog.item` for many refs in one call. Each answer is
//! exactly what `catalog.item` gives for its ref: the row (with a custom
//! name, and an M3U movie's own link), `not_found` for a ref the catalog
//! dropped, and `not_found` with `details.parentalLocked` for an item
//! parental Hide mode locks.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::rpc::MAX_ITEMS_REFS;
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::{AppState, RpcErrorCode};
use serde_json::{json, Value};
use std::sync::Arc;

const PLAYLIST: &str = "#EXTM3U\n\
    #EXTINF:-1 group-title=\"News\",News One\nhttp://h/n1.ts\n\
    #EXTINF:-1 group-title=\"News\",News Two\nhttp://h/n2.ts\n\
    #EXTINF:-1 group-title=\"Kids\",Cartoons\nhttp://h/k1.ts\n\
    #EXTINF:-1 radio=\"true\" group-title=\"Radio\",Jazz FM\nhttp://h/r1.mp3\n\
    #EXTINF:-1 group-title=\"Movies\",Heat (1995)\nhttp://h/heat.mkv\n";

struct App {
    _env: support::Env,
    state: Arc<AppState>,
    router: RpcRouter,
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Result<Value, iptv_core::RpcError> {
        self.router.dispatch(self.state.clone(), cmd, args).await
    }

    async fn ok(&self, cmd: &str, args: Value) -> Value {
        self.call(cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {} {:?}", e.message, e.code))
    }

    /// The ref of the first row whose name or title starts with `name` in a `catalog.channels` or `catalog.movies` page.
    async fn ref_of(&self, cmd: &str, extra: Value, name: &str) -> Value {
        let mut args =
            json!({"sourceId": self.source_id().await, "query": {"offset": 0, "limit": 50}});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let page = self.ok(cmd, args).await;
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| {
                // Channels carry a name, movies a title.
                let shown = c["name"].as_str().or(c["title"].as_str());
                shown.is_some_and(|n| n.starts_with(name))
            })
            .unwrap_or_else(|| panic!("{name} not in {page}"))["ref"]
            .clone()
    }

    async fn source_id(&self) -> String {
        self.ok("sources.list", Value::Null).await[0]["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// `catalog.item`'s answer for `r`, in the shape `catalog.items` gives it.
    async fn single(&self, r: &Value) -> Value {
        match self.call("catalog.item", json!({ "ref": r })).await {
            Ok(item) => json!({ "item": item }),
            Err(e) => json!({ "error": serde_json::to_value(e).unwrap() }),
        }
    }
}

async fn app() -> App {
    let env = support::env().await;
    support::add_text(&env.state, "Demo", PLAYLIST).await;
    App {
        state: env.state.clone(),
        _env: env,
        router: build_router(),
    }
}

#[tokio::test]
async fn every_answer_is_what_catalog_item_gives_for_its_ref() {
    let a = app().await;
    let source = a.source_id().await;
    let n1 = a.ref_of("catalog.channels", json!({}), "News One").await;
    let n2 = a.ref_of("catalog.channels", json!({}), "News Two").await;
    let kids = a.ref_of("catalog.channels", json!({}), "Cartoons").await;
    let radio = a
        .ref_of("catalog.channels", json!({"radio": true}), "Jazz FM")
        .await;
    let movie = a.ref_of("catalog.movies", json!({}), "Heat").await;
    let gone = json!({"sourceId": source, "contentType": "live", "itemId": "no-such"});

    // A custom name, and Hide mode locking one channel.
    a.ok("channels.rename", json!({"ref": n2, "name": "My News"}))
        .await;
    a.ok("parental.setPin", json!({"newPin": "2580"})).await;
    a.ok(
        "parental.setLocked",
        json!({"target": {"sourceId": source, "contentType": "live", "kind": "item", "targetId": kids["itemId"], "name": "Cartoons"}, "locked": true}),
    )
    .await;

    // Order is kept, and a ref asked twice gets two answers.
    let refs = [&n1, &n2, &kids, &radio, &movie, &gone, &n1];
    let out = a.ok("catalog.items", json!({ "refs": refs })).await;
    let out = out.as_array().unwrap();
    assert_eq!(out.len(), refs.len());
    for (r, got) in refs.iter().zip(out) {
        assert_eq!(got, &a.single(r).await, "{r}");
    }
    assert_eq!(out[1]["item"]["name"], "My News");
    assert_eq!(out[4]["item"]["url"], "http://h/heat.mkv");
    assert_eq!(out[2]["error"]["code"], "not_found");
    assert_eq!(out[2]["error"]["details"], json!({"parentalLocked": true}));
    assert_eq!(out[5]["error"]["code"], "not_found");
    assert!(out[5]["error"].get("details").is_none(), "{}", out[5]);

    // Unlocked, the locked channel answers like any other.
    a.ok("parental.unlock", json!({"pin": "2580"})).await;
    let out = a.ok("catalog.items", json!({ "refs": [kids] })).await;
    assert_eq!(out[0]["item"]["name"], "Cartoons");
}

#[tokio::test]
async fn no_refs_answer_nothing_and_too_many_are_refused() {
    let a = app().await;
    assert_eq!(a.ok("catalog.items", json!({"refs": []})).await, json!([]));
    let r = json!({"sourceId": "s", "contentType": "live", "itemId": "x"});
    let refs = vec![r; MAX_ITEMS_REFS + 1];
    let e = a
        .call("catalog.items", json!({ "refs": refs }))
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Invalid);
}
