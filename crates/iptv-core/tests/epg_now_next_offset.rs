//! `epg.nowNext` with `offsetMinutes`: the UI shows programmes moved by
//! `settings.epgOffsetMinutes`, so "now" must be the programme the raw guide
//! has airing at `now - offset` (the old app's display-offset "clock form").
//! Programmes come back unshifted.

use iptv_core::epg;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

const URL: &str = "http://guide.example/epg.xml";

/// Three two-hour programmes: Earlier [now-3h, now-1h), Current [now-1h, now+1h),
/// Later [now+1h, now+3h), mapped to item `s|live|1`.
async fn setup() -> (tempfile::TempDir, Arc<AppState>, RpcRouter) {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(16);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}')",
                [],
            )?;
            c.execute(
                "INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES ('s', 'live', '1', 'one')",
                [],
            )?;
            c.execute(
                "INSERT INTO epg_sources(url, origin, status, channel_count, program_count) VALUES (?1, 'settings', 'ok', 1, 3)",
                [URL],
            )?;
            c.execute(
                "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, 'one', 'One')",
                [URL],
            )?;
            for (start, title) in [(now - 3 * 3600, "Earlier"), (now - 3600, "Current"), (now + 3600, "Later")] {
                c.execute(
                    "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, 'one', ?2, ?3, ?4)",
                    params![URL, start, start + 2 * 3600, title],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    epg::rpc::register(&mut router);
    (tmp, state, router)
}

fn titles(out: &Value) -> (Option<&str>, Option<&str>) {
    let nn = &out["s|live|1"];
    (nn["now"]["title"].as_str(), nn["next"]["title"].as_str())
}

async fn now_next(state: &Arc<AppState>, router: &RpcRouter, args: Value) -> Value {
    router
        .dispatch(state.clone(), "epg.nowNext", args)
        .await
        .unwrap()
}

#[tokio::test]
async fn offset_picks_the_programme_airing_on_the_shifted_clock() {
    let (_tmp, state, router) = setup().await;
    let refs = json!([{ "sourceId": "s", "contentType": "live", "itemId": "1" }]);

    // No offset (argument omitted or 0): the raw guide's airing programme.
    let out = now_next(&state, &router, json!({ "refs": refs })).await;
    assert_eq!(titles(&out), (Some("Current"), Some("Later")));
    let out = now_next(&state, &router, json!({ "refs": refs, "offsetMinutes": 0 })).await;
    assert_eq!(titles(&out), (Some("Current"), Some("Later")));

    // +120: every programme displays two hours later, so "Earlier" is the one airing on screen.
    let out = now_next(
        &state,
        &router,
        json!({ "refs": refs, "offsetMinutes": 120 }),
    )
    .await;
    assert_eq!(titles(&out), (Some("Earlier"), Some("Current")));

    // -120: programmes display two hours earlier, so "Later" is on now.
    let out = now_next(
        &state,
        &router,
        json!({ "refs": refs, "offsetMinutes": -120 }),
    )
    .await;
    assert_eq!(titles(&out), (Some("Later"), None));

    // Times come back unshifted (the UI applies the display shift).
    let earlier_start = out["s|live|1"]["now"]["start"]
        .as_str()
        .unwrap()
        .to_string();
    let raw = now_next(&state, &router, json!({ "refs": refs })).await;
    assert_eq!(
        raw["s|live|1"]["next"]["start"].as_str(),
        Some(earlier_start.as_str())
    );

    // The library entry point keeps its no-offset behaviour.
    let lib = epg::now_next(
        &state,
        vec![iptv_core::model::ItemRef::new(
            "s",
            iptv_core::model::ContentType::Live,
            "1",
        )],
    )
    .await
    .unwrap();
    let nn = lib.values().next().unwrap();
    assert_eq!(nn.now.as_ref().map(|p| p.title.as_str()), Some("Current"));
}

#[tokio::test]
async fn offset_outside_the_setting_range_is_rejected() {
    let (_tmp, state, router) = setup().await;
    let refs = json!([{ "sourceId": "s", "contentType": "live", "itemId": "1" }]);
    for bad in [721, -721] {
        let err = router
            .dispatch(
                state.clone(),
                "epg.nowNext",
                json!({ "refs": refs, "offsetMinutes": bad }),
            )
            .await
            .unwrap_err();
        assert!(err.message.contains("offsetMinutes"), "{}", err.message);
    }
    let edge = now_next(
        &state,
        &router,
        json!({ "refs": refs, "offsetMinutes": 720 }),
    )
    .await;
    assert!(edge["s|live|1"].is_object());
}

/// Guide shift per channel (`epg.setChannelShift`) and per source
/// (`EpgLinks.shiftMinutes`): both move the programmes in the core, the
/// channel's own shift in place of its `tvg-shift` and the source's on top.
#[tokio::test]
async fn channel_and_source_shifts_move_the_programmes() {
    let (_tmp, state, router) = setup().await;
    let refs = json!([{ "sourceId": "s", "contentType": "live", "itemId": "1" }]);
    let r = json!({ "sourceId": "s", "contentType": "live", "itemId": "1" });

    // +120 on the channel: "Earlier" airs now.
    router
        .dispatch(
            state.clone(),
            "epg.setChannelShift",
            json!({ "ref": r, "minutes": 120 }),
        )
        .await
        .unwrap();
    let out = now_next(&state, &router, json!({ "refs": refs })).await;
    assert_eq!(titles(&out), (Some("Earlier"), Some("Current")));
    let res = router
        .dispatch(state.clone(), "epg.resolve", json!({ "ref": r }))
        .await
        .unwrap();
    assert_eq!(res["shiftMinutes"], 120);

    // -240 on the source adds to it: -120 in all, "Later" airs now.
    state
        .db_call(|c| {
            c.execute(
                "UPDATE sources SET epg_json = ?1 WHERE id = 's'",
                [r#"{"detectedUrls":[],"manualUrls":[],"disabledUrls":[],"shiftMinutes":-240}"#],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let out = now_next(&state, &router, json!({ "refs": refs })).await;
    assert_eq!(titles(&out), (Some("Later"), None));
    // epg.programs (the grid's reader) moves them the same way.
    let at = |secs: i64| {
        chrono::DateTime::from_timestamp(chrono::Utc::now().timestamp() + secs, 0)
            .unwrap()
            .to_rfc3339()
    };
    let list = router
        .dispatch(
            state.clone(),
            "epg.programs",
            json!({ "ref": r, "from": at(-600), "to": at(600) }),
        )
        .await
        .unwrap();
    let titles_now: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["title"].as_str())
        .collect();
    assert_eq!(titles_now, ["Later"]);

    // Null removes the channel's shift; the source's -240 remains.
    router
        .dispatch(
            state.clone(),
            "epg.setChannelShift",
            json!({ "ref": r, "minutes": null }),
        )
        .await
        .unwrap();
    let out = now_next(&state, &router, json!({ "refs": refs })).await;
    assert_eq!(titles(&out), (None, None));
    let res = router
        .dispatch(state.clone(), "epg.resolve", json!({ "ref": r }))
        .await
        .unwrap();
    assert!(res.get("shiftMinutes").is_none());

    // Beyond 12 hours either way is refused.
    for bad in [721, -721] {
        let err = router
            .dispatch(
                state.clone(),
                "epg.setChannelShift",
                json!({ "ref": r, "minutes": bad }),
            )
            .await
            .unwrap_err();
        assert!(err.message.contains("guide shift"), "{}", err.message);
    }
}
