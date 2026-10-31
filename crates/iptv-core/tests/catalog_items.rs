//! `catalog.items`: `catalog.item` for many refs in one call. Each answer is
//! exactly what `catalog.item` gives for its ref: the row (with a custom
//! name, and an M3U movie's own link), `not_found` for a ref the catalog
//! dropped, and `not_found` with `details.parentalLocked` for an item
//! parental Hide mode locks.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::rpc::MAX_ITEMS_REFS;
use iptv_core::catalog::{self, ItemRow};
use iptv_core::model::{ContentType, XtreamSourceConfig};
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::sources::store::{self, SourceConfig};
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
        self.ref_in(&self.source_id().await, cmd, extra, name).await
    }

    /// [`App::ref_of`] in the source `source`.
    async fn ref_in(&self, source: &str, cmd: &str, extra: Value, name: &str) -> Value {
        let mut args = json!({"sourceId": source, "query": {"offset": 0, "limit": 50}});
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

const OTHER: &str = "#EXTM3U\n\
    #EXTINF:-1 group-title=\"Sport\",Sport One\nhttp://o/s1.ts\n\
    #EXTINF:-1 group-title=\"Sport\",Sport Two\nhttp://o/s2.ts\n\
    #EXTINF:-1 group-title=\"Films\",Ronin (1998)\nhttp://o/ronin.mkv\n";

/// One batch over the refs of several sources (two playlists, one with a
/// catch-up override, and an Xtream source) answers exactly what
/// `catalog.item` gives one ref at a time. The per-source reads (the
/// override, the custom names, the source's kind) are shared by the refs of
/// the call; order, a hidden channel with its custom name, a missing ref
/// and the movie links stay as they were.
#[tokio::test]
async fn a_batch_over_several_sources_answers_like_one_ref_at_a_time() {
    let a = app().await;
    let first = a.source_id().await;
    let other = support::add_text(&a.state, "Other", OTHER).await.id;
    a.state
        .db_call(|c| {
            let config = SourceConfig::Xtream(XtreamSourceConfig {
                server_url: "http://x".into(),
                username: "u".into(),
                password: "p".into(),
                headers: Default::default(),
            });
            store::insert(c, "x", "X", false, &config, None)?;
            let row = |ct: ContentType, id: &str, title: &str, url: &str| ItemRow {
                source_id: "x".into(),
                content_type: ct,
                item_id: id.into(),
                category_id: "c".into(),
                title: title.into(),
                url: Some(url.into()),
                ..Default::default()
            };
            catalog::replace_catalog(
                c,
                "x",
                ContentType::Live,
                &[],
                &mut std::iter::once(row(ContentType::Live, "x1", "X Sports", "http://x/1.ts")),
            )?;
            catalog::replace_catalog(
                c,
                "x",
                ContentType::Movie,
                &[],
                &mut std::iter::once(row(
                    ContentType::Movie,
                    "xm",
                    "Heat (1995)",
                    "http://x/m.mkv",
                )),
            )?;
            Ok(())
        })
        .await
        .unwrap();

    // Shift catch-up for every live channel of the first playlist.
    let mut m3u = a.ok("sources.get", json!({"id": first})).await["m3u"].clone();
    m3u["catchup"] = json!({"type": "shift", "days": 3});
    a.ok(
        "sources.update",
        json!({"id": first, "patch": {"m3u": m3u}}),
    )
    .await;

    let n1 = a.ref_of("catalog.channels", json!({}), "News One").await;
    let n2 = a.ref_of("catalog.channels", json!({}), "News Two").await;
    let radio = a
        .ref_of("catalog.channels", json!({"radio": true}), "Jazz FM")
        .await;
    let heat = a.ref_of("catalog.movies", json!({}), "Heat").await;
    let s1 = a
        .ref_in(&other, "catalog.channels", json!({}), "Sport One")
        .await;
    let s2 = a
        .ref_in(&other, "catalog.channels", json!({}), "Sport Two")
        .await;
    let ronin = a.ref_in(&other, "catalog.movies", json!({}), "Ronin").await;
    let x1 = json!({"sourceId": "x", "contentType": "live", "itemId": "x1"});
    let xm = json!({"sourceId": "x", "contentType": "movie", "itemId": "xm"});
    let gone = json!({"sourceId": other, "contentType": "live", "itemId": "no-such"});

    // Custom names in both playlists; Sport Two is also hidden.
    a.ok("channels.rename", json!({"ref": n2, "name": "My News"}))
        .await;
    a.ok("channels.rename", json!({"ref": s2, "name": "My Sport"}))
        .await;
    a.ok("channels.setHidden", json!({"refs": [s2], "hidden": true}))
        .await;

    let refs = [
        &n1, &s1, &x1, &heat, &xm, &s2, &radio, &gone, &ronin, &n2, &x1,
    ];
    let out = a.ok("catalog.items", json!({ "refs": refs })).await;
    let out = out.as_array().unwrap();
    assert_eq!(out.len(), refs.len());
    for (r, got) in refs.iter().zip(out) {
        assert_eq!(got, &a.single(r).await, "{r}");
    }
    let item = |i: usize| &out[i]["item"];
    assert_eq!(item(0)["catchup"]["type"], "shift", "{}", item(0));
    assert_eq!(item(0)["archive"]["durationHours"], 72);
    assert!(item(1).get("catchup").is_none(), "{}", item(1));
    assert!(item(2).get("catchup").is_none(), "{}", item(2));
    assert_eq!(item(3)["url"], "http://h/heat.mkv");
    assert!(item(4).get("url").is_none(), "an Xtream movie: {}", item(4));
    assert_eq!(item(5)["name"], "My Sport", "a hidden channel answers");
    assert!(item(6).get("catchup").is_none(), "radio: {}", item(6));
    assert_eq!(out[7]["error"]["code"], "not_found");
    assert_eq!(item(8)["url"], "http://o/ronin.mkv");
    assert_eq!(item(9)["name"], "My News");
    assert_eq!(item(9)["catchup"]["type"], "shift");
    assert_eq!(item(10), item(2));
}
