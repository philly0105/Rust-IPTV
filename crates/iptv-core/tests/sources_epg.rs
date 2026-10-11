//! Sources (B1): a successful import starts background refreshes of the
//! source's guide URLs, so a new source has a guide without any UI call.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::model::{ContentType, EpgLinks, ItemRef};
use iptv_core::rpc::RpcRouter;
use iptv_core::{epg, sources, AppEvent, AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use support::*;
use tokio::sync::broadcast::Receiver;

fn router() -> RpcRouter {
    let mut r = support::router();
    epg::rpc::register(&mut r);
    r
}

async fn call(r: &RpcRouter, st: &Arc<AppState>, cmd: &str, args: Value) -> Value {
    match r.dispatch(st.clone(), cmd, args).await {
        Ok(v) => v,
        Err(e) => panic!("{cmd} failed: {}", e.message),
    }
}

/// Waits for the terminal `epg.progress` of `url`; returns its phase.
async fn wait_guide(events: &mut Receiver<AppEvent>, url: &str) -> String {
    let fut = async {
        loop {
            let ev = events.recv().await.expect("event stream open");
            if ev.kind == "epg.progress" && ev.payload["url"] == url {
                let phase = ev.payload["phase"].as_str().unwrap_or_default().to_string();
                if phase == "done" || phase == "error" {
                    return (phase, ev.payload.clone());
                }
            }
        }
    };
    let (phase, payload) = tokio::time::timeout(Duration::from_secs(30), fut)
        .await
        .expect("guide refresh finished within 30 s");
    assert_eq!(phase, "done", "guide refresh failed: {payload}");
    phase
}

/// True when any `epg.progress` event of `url` arrives within `wait`.
async fn guide_activity(events: &mut Receiver<AppEvent>, url: &str, wait: Duration) -> bool {
    tokio::time::timeout(wait, async {
        loop {
            let ev = events.recv().await.expect("event stream open");
            if ev.kind == "epg.progress" && ev.payload["url"] == url {
                return;
            }
        }
    })
    .await
    .is_ok()
}

async fn item_for(st: &AppState, source_id: &str, tvg_id: &str) -> String {
    let (sid, tvg) = (source_id.to_string(), tvg_id.to_string());
    st.db_call(move |c| {
        Ok(c.query_row(
            "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = 'live' AND epg_channel_id = ?2",
            [&sid, &tvg],
            |r| r.get::<_, String>(0),
        )?)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn adding_a_source_fetches_its_detected_guide() {
    let mock = iptv_fixtures::spawn_mock().await;
    let mut env = env().await;
    let st = env.state.clone();
    let r = router();
    let guide = mock.url("/xmltv/sample.xml");

    let src = call(
        &r,
        &st,
        "sources.add",
        json!({ "kind": "m3u", "name": "Sample", "m3u": { "url": mock.url("/m3u/sample.m3u") } }),
    )
    .await;
    let id = src["id"].as_str().unwrap().to_string();
    assert_eq!(src["epg"]["detectedUrls"], json!([guide]));

    // No epg.refresh call: the import itself queued the guide.
    wait_guide(&mut env.events, &guide).await;

    let item = item_for(&st, &id, "bbc1.uk").await;
    let key = ItemRef::new(id.clone(), ContentType::Live, item.clone()).key();
    let refs = json!([{ "sourceId": id, "contentType": "live", "itemId": item }]);
    let nn = call(&r, &st, "epg.nowNext", json!({ "refs": refs })).await;
    assert!(
        nn[&key]["now"]["title"].is_string(),
        "nowNext has a current programme: {nn}"
    );
    let now = chrono::Utc::now();
    let grid = call(
        &r,
        &st,
        "epg.grid",
        json!({
            "refs": refs,
            "from": (now - chrono::Duration::hours(1)).to_rfc3339(),
            "to": (now + chrono::Duration::hours(3)).to_rfc3339(),
        }),
    )
    .await;
    assert!(
        grid[&key].as_array().is_some_and(|l| !l.is_empty()),
        "grid has programmes: {grid}"
    );

    let status = call(&r, &st, "epg.sources", json!({})).await;
    let row = status
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["url"] == guide)
        .expect("guide listed");
    assert_eq!(row["status"], "ok");
    assert_eq!(row["sourceId"], id);

    // A refresh while the guide is fresh does not fetch it again.
    call(&r, &st, "sources.refresh", json!({ "id": id })).await;
    assert!(
        !guide_activity(&mut env.events, &guide, Duration::from_millis(800)).await,
        "fresh guide was refetched"
    );

    // The UI's explicit refresh still works.
    call(&r, &st, "epg.refresh", json!({ "url": guide })).await;
    wait_guide(&mut env.events, &guide).await;
}

#[tokio::test]
async fn disabled_guides_are_not_fetched_and_failures_do_not_fail_the_import() {
    let mock = iptv_fixtures::spawn_mock().await;
    let mut env = env().await;
    let st = env.state.clone();
    let guide = mock.url("/xmltv/sample.xml");
    let broken = mock.url("/xmltv/missing-guide.xml");

    // Text playlist that names the mock guide plus one that 404s.
    let text = format!(
        "#EXTM3U x-tvg-url=\"{guide},{broken}\"\n#EXTINF:-1 tvg-id=\"bbc1.uk\",BBC One\nhttp://127.0.0.1:9/a.ts\n"
    );
    let src = sources::add(st.clone(), text_args("Two guides", &text))
        .await
        .expect("import succeeds even when a guide is broken");
    let mut detected = src.epg.detected_urls.clone();
    detected.sort();
    let mut expected = vec![guide.clone(), broken.clone()];
    expected.sort();
    assert_eq!(detected, expected);

    // The broken guide reports an error on its own; the good one loads.
    wait_guide(&mut env.events, &guide).await;
    let list = epg::sources(&st).await.unwrap();
    let bad = loop {
        let list = epg::sources(&st).await.unwrap();
        let bad = list.iter().find(|s| s.url == broken).unwrap().clone();
        if bad.status == iptv_core::model::EpgFetchStatus::Error {
            break bad;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(bad.error.is_some());
    assert!(list.iter().any(|s| s.url == guide));
    let got = sources::get(&st, &src.id).await.unwrap();
    assert!(
        got.last_error.is_none(),
        "import kept clean: {:?}",
        got.last_error
    );

    // Disabling a guide on the source keeps a later refresh from fetching it.
    let other = mock.url("/xmltv/sample.xml?copy=1");
    sources::update(
        &st,
        &src.id,
        serde_json::from_value(json!({
            "epg": { "manualUrls": [other], "disabledUrls": [other] }
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    sources::run_import(st.clone(), &src.id).await.unwrap();
    assert!(
        !guide_activity(&mut env.events, &other, Duration::from_millis(800)).await,
        "disabled guide was fetched"
    );
}

#[test]
fn guide_urls_merge_detected_and_manual_minus_disabled() {
    let links = EpgLinks {
        detected_urls: vec![
            " http://a/x.xml ".into(),
            "http://b/y.xml".into(),
            "".into(),
        ],
        manual_urls: vec!["http://a/x.xml".into(), "http://c/z.xml".into()],
        disabled_urls: vec!["http://b/y.xml".into()],
    };
    assert_eq!(
        sources::guide_urls(&links),
        vec!["http://a/x.xml".to_string(), "http://c/z.xml".to_string()]
    );
}
