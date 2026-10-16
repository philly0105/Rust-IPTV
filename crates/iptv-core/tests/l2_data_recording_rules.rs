//! L2-guide-library-9: removing a series rule with "also cancel scheduled"
//! deletes the airings that never started instead of leaving a cancelled
//! row per airing, which sorted above real recordings in Recent recordings.
//! A rule added again still schedules them; kept and running ones stay.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::epg;
use iptv_core::model::ItemRef;
use iptv_core::recording::engine::{force_engine, Engine};
use iptv_core::recording::scheduler::ManualClock;
use iptv_core::recording::{self, Recording, RecordingStatus, ScheduleRequest};
use iptv_core::rpc::RpcRouter;
use serde_json::{json, Value};
use std::sync::Arc;
use support::*;

const HOUR: i64 = 3600;
const SHOW: &str = "Northbound";

fn rfc(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn xmltv_ts(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .format("%Y%m%d%H%M%S +0000")
        .to_string()
}

struct Rig {
    env: Env,
    router: RpcRouter,
    item: ItemRef,
    base: i64,
}

async fn rig(programmes: &[(i64, &str)]) -> Rig {
    let env = env().await;
    let mut router = router();
    recording::rpc::register(&mut router);
    force_engine(&env.state, Some(Engine::Http));
    let text = "#EXTM3U\n#EXTINF:-1 tvg-id=\"alpha\" group-title=\"News\",Alpha\nhttp://127.0.0.1:9/alpha.ts\n";
    let src = add_text(&env.state, "Rec", text).await;
    let list = router
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": src.id}),
        )
        .await
        .unwrap();
    let item: ItemRef = serde_json::from_value(list["items"][0]["ref"].clone()).unwrap();
    let now = chrono::Utc::now().timestamp();
    let base = now - now % HOUR + HOUR;
    recording::set_clock(&env.state, Arc::new(ManualClock::new(base)));
    let guide = env
        .dir
        .path()
        .join("guide.xml")
        .to_string_lossy()
        .into_owned();
    env.state.settings.write().epg_urls = vec![guide.clone()];
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n<channel id=\"alpha\"><display-name>Alpha</display-name></channel>\n",
    );
    for (offset, title) in programmes {
        let s = base + offset;
        xml.push_str(&format!(
            "<programme start=\"{}\" stop=\"{}\" channel=\"alpha\"><title>{title}</title></programme>\n",
            xmltv_ts(s),
            xmltv_ts(s + HOUR / 2)
        ));
    }
    xml.push_str("</tv>\n");
    std::fs::write(&guide, xml).unwrap();
    epg::refresh_now(env.state.clone(), &guide).await.unwrap();
    Rig {
        env,
        router,
        item,
        base,
    }
}

impl Rig {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.env.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e:?}"))
    }

    async fn add_rule(&self) -> Value {
        self.call(
            "recordings.addRule",
            json!({"ref": self.item, "channelName": "Alpha", "title": SHOW}),
        )
        .await
    }

    async fn recordings(&self) -> Vec<Recording> {
        let mut rows = recording::list_recordings(&self.env.state).await.unwrap();
        rows.sort_by_key(|r| r.start.clone());
        rows
    }

    /// `(start offset, status, made by a rule)` of every recording.
    async fn all(&self) -> Vec<(i64, RecordingStatus, bool)> {
        self.recordings()
            .await
            .into_iter()
            .map(|r| {
                let at = chrono::DateTime::parse_from_rfc3339(&r.start)
                    .unwrap()
                    .timestamp();
                (at - self.base, r.status, r.rule_id.is_some())
            })
            .collect()
    }
}

#[tokio::test]
async fn removing_a_rule_deletes_its_unstarted_airings() {
    let r = rig(&[
        (HOUR, SHOW),
        (25 * HOUR, SHOW),
        (49 * HOUR, SHOW),
        (73 * HOUR, SHOW),
    ])
    .await;
    // A one-off recording is not the rule's and stays.
    recording::schedule(
        &r.env.state,
        ScheduleRequest {
            item_ref: r.item.clone(),
            channel_name: "Alpha".into(),
            title: Some("Film".into()),
            start: Some(rfc(r.base + 10 * HOUR)),
            end: Some(rfc(r.base + 11 * HOUR)),
            duration_minutes: None,
        },
    )
    .await
    .unwrap();
    let rule = r.add_rule().await;
    assert_eq!(rule["upcoming"], 4);

    r.call("recordings.removeRule", json!({"id": rule["id"]}))
        .await;
    assert_eq!(
        r.all().await,
        vec![(10 * HOUR, RecordingStatus::Scheduled, false)],
        "no cancelled row per airing is left behind"
    );
    assert!(r
        .recordings()
        .await
        .iter()
        .all(|x| x.status != RecordingStatus::Cancelled));

    // The same rule added again schedules every airing again.
    let again = r.add_rule().await;
    assert_eq!(again["upcoming"], 4, "{again}");
    let scheduled = r
        .all()
        .await
        .into_iter()
        .filter(|(_, s, by_rule)| *s == RecordingStatus::Scheduled && *by_rule)
        .count();
    assert_eq!(scheduled, 4);

    // Keeping the scheduled ones still keeps them, as one-off recordings.
    r.call(
        "recordings.removeRule",
        json!({"id": again["id"], "keepScheduled": true}),
    )
    .await;
    let all = r.all().await;
    assert_eq!(all.len(), 5);
    assert!(all
        .iter()
        .all(|(_, s, by_rule)| *s == RecordingStatus::Scheduled && !by_rule));
}
