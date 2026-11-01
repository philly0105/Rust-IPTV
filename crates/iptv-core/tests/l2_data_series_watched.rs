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
                headers: Default::default(),
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

impl App {
    async fn try_call(&self, cmd: &str, args: Value) -> Result<Value, iptv_core::RpcError> {
        self.router.dispatch(self.state.clone(), cmd, args).await
    }

    /// Episode ids with a watched row, sorted.
    async fn watched_episodes(&self, r: &ItemRef) -> Vec<String> {
        let rows = self.call("positions.forSeries", json!({"ref": r})).await;
        let mut eps: Vec<String> = rows
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["watched"] == true)
            .filter_map(|p| p["episodeId"].as_str().map(str::to_owned))
            .collect();
        eps.sort();
        eps
    }
}

#[tokio::test]
async fn a_season_or_series_marks_in_one_call() {
    let a = app().await;
    let r = series("310");
    a.episodes(&r, &["e1", "e2", "e3"]);

    // A season that leaves an episode unwatched does not mark the series.
    a.call(
        "userstate.setWatched",
        json!({"ref": r, "episodeIds": ["e1", "e2"], "watched": true}),
    )
    .await;
    assert_eq!(a.watched_episodes(&r).await, ["e1", "e2"]);
    assert!(!a.series_watched(&r).await);

    // The batch that finishes the list marks it, as one episode would.
    a.call(
        "userstate.setWatched",
        json!({"ref": r, "episodeIds": ["e3"], "watched": true}),
    )
    .await;
    assert!(a.series_watched(&r).await);

    // Unmarking a batch clears its episodes and the series row.
    a.call(
        "userstate.setWatched",
        json!({"ref": r, "episodeIds": ["e1", "e3"], "watched": false}),
    )
    .await;
    assert_eq!(a.watched_episodes(&r).await, ["e2"]);
    assert!(!a.series_watched(&r).await);
}

#[tokio::test]
async fn the_series_flag_writes_the_series_row_with_the_episodes() {
    let a = app().await;
    // No cached episode list and an unreachable provider: only the flag can
    // mark the series.
    let r = series("311");
    a.call(
        "userstate.setWatched",
        json!({"ref": r, "episodeIds": ["a", "b"], "watched": true, "series": true}),
    )
    .await;
    assert_eq!(a.watched_episodes(&r).await, ["a", "b"]);
    assert!(a.series_watched(&r).await);

    a.call(
        "userstate.setWatched",
        json!({"ref": r, "episodeIds": ["a", "b"], "watched": false, "series": true}),
    )
    .await;
    assert!(a.watched_episodes(&r).await.is_empty());
    assert!(!a.series_watched(&r).await);

    // No episodes left to change: the flag alone marks the series.
    a.call(
        "userstate.setWatched",
        json!({"ref": r, "episodeIds": [], "watched": true, "series": true}),
    )
    .await;
    assert!(a.series_watched(&r).await);
    assert!(a.watched_episodes(&r).await.is_empty());
}

#[tokio::test]
async fn a_bad_batch_is_invalid_and_writes_nothing() {
    let a = app().await;
    let r = series("312");
    let over: Vec<String> = (0..=iptv_core::userstate::MAX_WATCHED_EPISODES)
        .map(|i| format!("e{i}"))
        .collect();
    let bad = [
        json!({"ref": r, "episodeId": "e1", "episodeIds": ["e2"], "watched": true}),
        json!({"ref": r, "episodeId": "e1", "series": true, "watched": true}),
        json!({"ref": r, "episodeIds": over, "watched": true}),
        // A blank id would stand for the series row; the valid ids before
        // it are not written either.
        json!({"ref": r, "episodeIds": ["e1", " "], "watched": true}),
    ];
    for args in bad {
        let e = a.try_call("userstate.setWatched", args).await.unwrap_err();
        assert_eq!(e.code, iptv_core::RpcErrorCode::Invalid, "{}", e.message);
    }
    assert!(a.watched_episodes(&r).await.is_empty());
    assert!(!a.series_watched(&r).await);

    // An unknown source is not_found, for the batch as for one episode.
    let gone: ItemRef =
        serde_json::from_value(json!({"sourceId": "nope", "contentType": "series", "itemId": "1"}))
            .unwrap();
    let e = a
        .try_call(
            "userstate.setWatched",
            json!({"ref": gone, "episodeIds": ["e1", "e2"], "watched": true, "series": true}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, iptv_core::RpcErrorCode::NotFound);
}

/// A batch too long or with a blank id is refused at once, also while
/// another write (an import's save) holds the write gate.
#[tokio::test]
async fn a_bad_batch_is_refused_without_waiting_for_the_write_gate() {
    let a = app().await;
    let r = series("313");
    let (release, held) = std::sync::mpsc::channel::<()>();
    let (entered, writing) = tokio::sync::oneshot::channel::<()>();
    let write = {
        let state = a.state.clone();
        tokio::spawn(async move {
            state
                .db_write(move |_| {
                    let _ = entered.send(());
                    let _ = held.recv();
                    Ok(())
                })
                .await
        })
    };
    writing.await.unwrap();
    let over: Vec<String> = (0..=iptv_core::userstate::MAX_WATCHED_EPISODES)
        .map(|i| format!("e{i}"))
        .collect();
    for args in [
        json!({"ref": r, "episodeIds": over, "watched": true}),
        json!({"ref": r, "episodeIds": ["e1", ""], "watched": true, "series": true}),
    ] {
        let refused = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            a.try_call("userstate.setWatched", args),
        )
        .await
        .expect("the batch waited for the write gate");
        assert_eq!(refused.unwrap_err().code, iptv_core::RpcErrorCode::Invalid);
    }
    release.send(()).unwrap();
    write.await.unwrap().unwrap();
}

/// Marking a long series watched: one `userstate.setWatched` per episode, all
/// in flight at once as the detail page used to send them, against one
/// batched call. Each single call is its own gated write plus a series sync
/// that rebuilds the episode list and reads every watched row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "timing only; run with --release -- --ignored --nocapture"]
async fn time_marking_a_long_series() {
    let a = Arc::new(app().await);
    for n in [200usize, 1000] {
        let ids: Vec<String> = (0..n).map(|i| format!("e{i}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();

        let single = series(&format!("single-{n}"));
        a.episodes(&single, &refs);
        let t = std::time::Instant::now();
        let calls = ids.iter().map(|ep| {
            let (a, r, ep) = (a.clone(), single.clone(), ep.clone());
            tokio::spawn(async move {
                a.call(
                    "userstate.setWatched",
                    json!({"ref": r, "episodeId": ep, "watched": true}),
                )
                .await
            })
        });
        for c in calls.collect::<Vec<_>>() {
            c.await.unwrap();
        }
        a.call(
            "userstate.setWatched",
            json!({"ref": single, "watched": true}),
        )
        .await;
        let per_episode = t.elapsed();
        assert!(a.series_watched(&single).await);

        let batch = series(&format!("batch-{n}"));
        a.episodes(&batch, &refs);
        let t = std::time::Instant::now();
        a.call(
            "userstate.setWatched",
            json!({"ref": batch, "episodeIds": ids, "watched": true, "series": true}),
        )
        .await;
        let batched = t.elapsed();
        assert!(a.series_watched(&batch).await);
        assert_eq!(a.watched_episodes(&batch).await.len(), n);

        println!(
            "series_watched: {n} episodes: {per_episode:?} one call per episode, {batched:?} one batched call"
        );
    }
}
