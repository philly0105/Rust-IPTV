//! L2-vod-4: a series' own watched row follows its episodes in the core, on
//! every write path (the player's `positions.set`, `userstate.setWatched`
//! from Recently watched or the remote): watching the last unwatched episode
//! marks the series, unmarking an episode clears it. Same rule as the detail
//! page's `seriesWatchedWrite`.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::model::{ItemRef, XtreamSourceConfig};
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::sources::{store, store::SourceConfig};
use iptv_core::xtream::raw::RawSeriesInfo;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

struct App {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
}

/// An Xtream source whose provider is unreachable (port 9), so the only
/// episode list is the one primed into the series cache.
async fn app() -> App {
    let support::Env { dir, state, .. } = support::env().await;
    state
        .db_call(|c| {
            let cfg = SourceConfig::Xtream(XtreamSourceConfig {
                server_url: "http://127.0.0.1:9".into(),
                username: "demo".into(),
                password: "secret".into(),
            });
            store::insert(c, "x1", "Xtream", false, &cfg, None)
        })
        .await
        .unwrap();
    App {
        _dir: dir,
        state,
        router: build_router(),
    }
}

fn series(id: &str) -> ItemRef {
    serde_json::from_value(json!({"sourceId": "x1", "contentType": "series", "itemId": id}))
        .unwrap()
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {} {:?}", e.message, e.code))
    }

    /// Primes the series cache with episodes `ids` (season 1).
    fn episodes(&self, r: &ItemRef, ids: &[&str]) {
        let eps: Vec<Value> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| json!({"id": id, "episode_num": i + 1, "season": 1, "title": format!("E{id}")}))
            .collect();
        let raw: RawSeriesInfo =
            serde_json::from_value(json!({"info": {"name": "Northbound"}, "episodes": {"1": eps}}))
                .unwrap();
        let rt = iptv_core::xtream::meta::runtime(&self.state);
        iptv_core::xtream::meta::put_series(&rt, &r.source_id, &r.item_id, Arc::new(raw));
    }

    async fn series_watched(&self, r: &ItemRef) -> bool {
        let v = self
            .call("positions.watchedContains", json!({"refs": [r]}))
            .await;
        !v.as_array().unwrap().is_empty()
    }

    async fn finish(&self, r: &ItemRef, ep: &str) {
        self.call(
            "positions.set",
            json!({"ref": r, "episodeId": ep, "positionSeconds": 2580, "durationSeconds": 2580}),
        )
        .await;
    }

    async fn mark(&self, r: &ItemRef, ep: &str, watched: bool) {
        self.call(
            "userstate.setWatched",
            json!({"ref": r, "episodeId": ep, "watched": watched}),
        )
        .await;
    }
}

#[tokio::test]
async fn finishing_the_last_episode_in_the_player_marks_the_series() {
    let a = app().await;
    let r = series("304");
    a.episodes(&r, &["e1", "e2", "e3"]);
    a.mark(&r, "e1", true).await;
    a.finish(&r, "e2").await;
    assert!(
        !a.series_watched(&r).await,
        "one episode is still unwatched"
    );

    // A save part-way through the last episode is not a finish.
    a.call(
        "positions.set",
        json!({"ref": r, "episodeId": "e3", "positionSeconds": 600, "durationSeconds": 2580}),
    )
    .await;
    assert!(!a.series_watched(&r).await);

    a.finish(&r, "e3").await;
    assert!(a.series_watched(&r).await, "every episode is watched");

    // Hide watched drops it too: the series row is the one the filters read.
    let rows = a.call("positions.forSeries", json!({"ref": r})).await;
    let series_row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p.get("episodeId").is_none())
        .expect("a series-level row");
    assert_eq!(series_row["watched"], true);
}

#[tokio::test]
async fn marks_from_recent_or_the_remote_follow_the_same_rule() {
    let a = app().await;
    let r = series("305");
    a.episodes(&r, &["a", "b"]);
    a.mark(&r, "a", true).await;
    assert!(!a.series_watched(&r).await);
    a.mark(&r, "b", true).await;
    assert!(a.series_watched(&r).await);

    // Unmarking any episode clears the series mark; its other episodes
    // keep theirs.
    a.mark(&r, "a", false).await;
    assert!(!a.series_watched(&r).await);
    let rows = a.call("positions.forSeries", json!({"ref": r})).await;
    let eps: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["episodeId"].as_str())
        .collect();
    assert_eq!(eps, vec!["b"]);

    // And marking it again marks the series again.
    a.mark(&r, "a", true).await;
    assert!(a.series_watched(&r).await);
}

#[tokio::test]
async fn an_unknown_episode_list_never_marks_the_series() {
    let a = app().await;
    // No cached list and an unreachable provider: the write still succeeds
    // and the series stays as it was.
    let r = series("306");
    a.finish(&r, "only").await;
    assert!(!a.series_watched(&r).await);

    // Episodes outside the provider's list do not count towards it.
    let r = series("307");
    a.episodes(&r, &["k1", "k2"]);
    a.mark(&r, "k1", true).await;
    a.mark(&r, "stray", true).await;
    assert!(!a.series_watched(&r).await);

    // A dated write (undo, restore) puts rows back exactly: no reconcile.
    let r = series("308");
    a.episodes(&r, &["d1"]);
    a.call(
        "positions.set",
        json!({"ref": r, "episodeId": "d1", "positionSeconds": 2580, "durationSeconds": 2580,
               "updatedAt": "2026-10-01T10:00:00Z", "watched": true}),
    )
    .await;
    assert!(!a.series_watched(&r).await);

    // A movie is not touched by the series rule.
    let m: ItemRef =
        serde_json::from_value(json!({"sourceId": "x1", "contentType": "movie", "itemId": "m1"}))
            .unwrap();
    a.call(
        "positions.set",
        json!({"ref": m, "positionSeconds": 100, "durationSeconds": 100}),
    )
    .await;
    let v = a
        .call("positions.watchedContains", json!({"refs": [m]}))
        .await;
    assert_eq!(v.as_array().unwrap().len(), 1);
}
