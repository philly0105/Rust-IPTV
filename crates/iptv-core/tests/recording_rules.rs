//! Series recording rules (Run 2 C5, check 8) on a `ManualClock`: a rule
//! schedules every matching airing in the next 7 days, a cancelled airing
//! stays cancelled, a guide refresh adds new airings, duplicates conflict,
//! removing a rule cancels its recordings, the per-rule cap, the EPG offset
//! and the backup round trip.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::epg;
use iptv_core::model::{ContentType, ItemRef};
use iptv_core::recording::engine::{force_engine, Engine};
use iptv_core::recording::scheduler::ManualClock;
use iptv_core::recording::{
    self, Recording, RecordingKind, RecordingRuleBackup, RecordingStatus, ScheduleRequest,
};
use iptv_core::rpc::RpcRouter;
use iptv_core::RpcErrorCode;
use serde_json::{json, Value};
use std::sync::Arc;
use support::*;

const HOUR: i64 = 3600;
const DAY: i64 = 86_400;
const SHOW: &str = "The Daily Show";

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
    clock: Arc<ManualClock>,
    item: ItemRef,
    guide: String,
    /// The clock's start: the next full hour of the real clock, so the
    /// guide lies inside the ingest window.
    base: i64,
}

async fn rig() -> Rig {
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
    let clock = Arc::new(ManualClock::new(base));
    recording::set_clock(&env.state, clock.clone());
    let guide = env
        .dir
        .path()
        .join("guide.xml")
        .to_string_lossy()
        .into_owned();
    env.state.settings.write().epg_urls = vec![guide.clone()];
    Rig {
        env,
        router,
        clock,
        item,
        guide,
        base,
    }
}

impl Rig {
    /// Writes the guide for channel `alpha` (half-hour programmes at
    /// `base + offset`) and refreshes it.
    async fn guide(&self, programmes: &[(i64, &str)]) {
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n<channel id=\"alpha\"><display-name>Alpha</display-name></channel>\n",
        );
        for (offset, title) in programmes {
            let s = self.base + offset;
            xml.push_str(&format!(
                "<programme start=\"{}\" stop=\"{}\" channel=\"alpha\"><title>{title}</title></programme>\n",
                xmltv_ts(s),
                xmltv_ts(s + HOUR / 2)
            ));
        }
        xml.push_str("</tv>\n");
        std::fs::write(&self.guide, xml).unwrap();
        epg::refresh_now(self.env.state.clone(), &self.guide)
            .await
            .unwrap();
    }

    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.env.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e:?}"))
    }

    async fn call_err(&self, cmd: &str, args: Value) -> RpcErrorCode {
        self.router
            .dispatch(self.env.state.clone(), cmd, args)
            .await
            .expect_err("expected an error")
            .code
    }

    async fn add_rule(&self, title: &str) -> Value {
        self.call(
            "recordings.addRule",
            json!({"ref": self.item, "channelName": "Alpha", "title": title}),
        )
        .await
    }

    async fn rules(&self) -> Vec<Value> {
        self.call("recordings.rules", Value::Null)
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    async fn recordings(&self) -> Vec<Recording> {
        let mut rows = recording::list_recordings(&self.env.state).await.unwrap();
        rows.sort_by_key(|r| r.start.clone());
        rows
    }

    /// `(start offset from base, status)` of the recordings of a rule.
    async fn of_rule(&self, rule: &Value) -> Vec<(i64, RecordingStatus)> {
        let id = rule["id"].as_str().unwrap();
        self.recordings()
            .await
            .into_iter()
            .filter(|r| r.rule_id.as_deref() == Some(id))
            .map(|r| (self.offset(&r.start), r.status))
            .collect()
    }

    /// The recordings titled `title`, by start.
    async fn titled(&self, title: &str) -> Vec<Recording> {
        self.recordings()
            .await
            .into_iter()
            .filter(|r| r.title.as_deref() == Some(title))
            .collect()
    }

    /// `(start offset from base, status, made by a rule)` of every recording.
    async fn all(&self) -> Vec<(i64, RecordingStatus, bool)> {
        self.recordings()
            .await
            .into_iter()
            .map(|r| (self.offset(&r.start), r.status, r.rule_id.is_some()))
            .collect()
    }

    async fn scheduled(&self, rule: &Value) -> Vec<i64> {
        self.of_rule(rule)
            .await
            .into_iter()
            .filter(|(_, s)| *s == RecordingStatus::Scheduled)
            .map(|(o, _)| o)
            .collect()
    }

    fn offset(&self, at: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(at)
            .unwrap()
            .timestamp()
            - self.base
    }

    /// Moves past the re-match interval and runs one scheduler pass.
    async fn tick_later(&self) {
        self.clock.advance(6 * 60);
        recording::tick(&self.env.state).await.unwrap();
    }
}

fn rule_title(rule: &Value) -> &str {
    rule["title"].as_str().unwrap()
}

#[tokio::test]
async fn a_rule_schedules_every_matching_airing_in_the_next_seven_days() {
    let r = rig().await;
    r.guide(&[
        (-2 * HOUR, SHOW),
        (HOUR, SHOW),
        (2 * HOUR, "Daily Show Special"),
        (25 * HOUR, SHOW),
        (3 * DAY + 2 * HOUR, "THE DAILY SHOW!"),
        (6 * DAY + 20 * HOUR, SHOW),
        (7 * DAY + 2 * HOUR, SHOW),
    ])
    .await;
    let rule = r.add_rule("  The Daily Show ").await;
    assert_eq!(rule_title(&rule), SHOW);
    assert_eq!(rule["channelName"], "Alpha");
    assert_eq!(rule["ref"], serde_json::to_value(&r.item).unwrap());
    assert_eq!(rule["enabled"], true);
    assert_eq!(rule["createdAt"], rfc(r.base));
    assert_eq!(rule["upcoming"], 4);
    assert_eq!(rule["nextStart"], rfc(r.base + HOUR));

    let want = vec![HOUR, 25 * HOUR, 3 * DAY + 2 * HOUR, 6 * DAY + 20 * HOUR];
    assert_eq!(r.scheduled(&rule).await, want);
    let rows = r.recordings().await;
    assert_eq!(rows.len(), 4, "only the rule's airings: {rows:?}");
    for row in &rows {
        assert_eq!(row.kind, RecordingKind::Programme);
        assert_eq!(row.channel_name, "Alpha");
        assert_eq!(row.item_ref, r.item);
        assert_eq!(r.offset(&row.end) - r.offset(&row.start), HOUR / 2);
    }
    // The recording keeps the guide's title.
    assert_eq!(rows[2].title.as_deref(), Some("THE DAILY SHOW!"));
    let wire = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(wire["ruleId"], rule["id"]);

    // Later passes add nothing twice; the airing a week out joins once in range.
    r.tick_later().await;
    assert_eq!(r.scheduled(&rule).await, want);
    r.clock.advance(2 * HOUR + 30 * 60);
    recording::tick(&r.env.state).await.unwrap();
    let rules = r.rules().await;
    assert_eq!(rules.len(), 1);
    assert_eq!(
        r.of_rule(&rule).await.last().unwrap(),
        &(7 * DAY + 2 * HOUR, RecordingStatus::Scheduled)
    );
}

#[tokio::test]
async fn a_cancelled_airing_is_not_recreated() {
    let r = rig().await;
    r.guide(&[(HOUR, SHOW), (25 * HOUR, SHOW), (49 * HOUR, SHOW)])
        .await;
    let rule = r.add_rule(SHOW).await;
    assert_eq!(r.scheduled(&rule).await, vec![HOUR, 25 * HOUR, 49 * HOUR]);
    let second = r
        .recordings()
        .await
        .into_iter()
        .find(|x| r.offset(&x.start) == 25 * HOUR)
        .unwrap();
    recording::cancel(&r.env.state, &second.id).await.unwrap();

    r.tick_later().await;
    assert_eq!(
        r.of_rule(&rule).await,
        vec![
            (HOUR, RecordingStatus::Scheduled),
            (25 * HOUR, RecordingStatus::Cancelled),
            (49 * HOUR, RecordingStatus::Scheduled),
        ]
    );
    // Removing the cancelled row leaves the skip behind.
    recording::remove(&r.env.state, &second.id).await.unwrap();
    r.tick_later().await;
    assert_eq!(r.scheduled(&rule).await, vec![HOUR, 49 * HOUR]);
    assert_eq!(r.of_rule(&rule).await.len(), 2);
    // So does a refresh, and switching the rule off and on.
    r.guide(&[(HOUR, SHOW), (25 * HOUR, SHOW), (49 * HOUR, SHOW)])
        .await;
    recording::tick(&r.env.state).await.unwrap();
    let id = rule["id"].clone();
    r.call(
        "recordings.setRuleEnabled",
        json!({"id": id, "enabled": false}),
    )
    .await;
    let back = r
        .call(
            "recordings.setRuleEnabled",
            json!({"id": id, "enabled": true}),
        )
        .await;
    assert_eq!(back["upcoming"], 2);
    assert_eq!(r.scheduled(&rule).await, vec![HOUR, 49 * HOUR]);
}

#[tokio::test]
async fn an_epg_refresh_adds_new_airings() {
    let r = rig().await;
    r.guide(&[(HOUR, SHOW)]).await;
    let rule = r.add_rule(SHOW).await;
    assert_eq!(r.scheduled(&rule).await, vec![HOUR]);

    // The refresh moves the first airing and adds two more; no clock change
    // is needed (the guide generation changed).
    r.guide(&[
        (HOUR + HOUR / 2, SHOW),
        (2 * DAY, SHOW),
        (4 * DAY + 5 * HOUR, SHOW),
    ])
    .await;
    recording::tick(&r.env.state).await.unwrap();
    assert_eq!(
        r.scheduled(&rule).await,
        vec![HOUR + HOUR / 2, 2 * DAY, 4 * DAY + 5 * HOUR],
        "the moved airing is followed, not scheduled twice"
    );
    assert_eq!(r.recordings().await.len(), 3);
}

/// Review fix: the re-match never moves a recording onto an airing another
/// recording of the channel already holds (one airing, two recordings).
#[tokio::test]
async fn a_retitled_airing_never_doubles_up_with_the_next_one() {
    let r = rig().await;
    let (first, second) = (HOUR, HOUR + HOUR / 2);
    r.guide(&[(first, SHOW), (second, SHOW)]).await;
    let rule = r.add_rule(SHOW).await;
    assert_eq!(r.scheduled(&rule).await, vec![first, second]);

    // The first airing becomes something else: its recording does not jump
    // onto the second airing; the rule no longer wants it, so it goes.
    r.guide(&[(first, "Weather"), (second, SHOW)]).await;
    recording::tick(&r.env.state).await.unwrap();
    assert_eq!(
        r.all().await,
        vec![(second, RecordingStatus::Scheduled, true)]
    );

    // The title comes back: the rule schedules it again.
    r.guide(&[(first, SHOW), (second, SHOW)]).await;
    recording::tick(&r.env.state).await.unwrap();
    assert_eq!(r.scheduled(&rule).await, vec![first, second]);

    // Both airings move half an hour later: each recording follows one of
    // them, and none lands on the other's slot.
    let third = second + HOUR / 2;
    r.guide(&[(second, SHOW), (third, SHOW)]).await;
    recording::tick(&r.env.state).await.unwrap();
    assert_eq!(r.scheduled(&rule).await, vec![second, third]);
    assert_eq!(r.recordings().await.len(), 2);
}

/// Review fix: a one-off recording whose airing changes title stays where
/// the user put it, instead of moving onto the rule's recording.
#[tokio::test]
async fn a_one_off_recording_of_a_retitled_airing_stays_put() {
    let r = rig().await;
    let (first, second) = (HOUR, HOUR + HOUR / 2);
    r.guide(&[(first, SHOW), (second, SHOW)]).await;
    recording::schedule(
        &r.env.state,
        ScheduleRequest {
            item_ref: r.item.clone(),
            channel_name: "Alpha".into(),
            title: Some(SHOW.into()),
            start: Some(rfc(r.base + first)),
            end: Some(rfc(r.base + second)),
            duration_minutes: None,
        },
    )
    .await
    .unwrap();
    let rule = r.add_rule(SHOW).await;
    assert_eq!(r.scheduled(&rule).await, vec![second]);

    r.guide(&[(first, "Weather"), (second, SHOW)]).await;
    recording::tick(&r.env.state).await.unwrap();
    assert_eq!(
        r.all().await,
        vec![
            (first, RecordingStatus::Scheduled, false),
            (second, RecordingStatus::Scheduled, true)
        ]
    );
}

/// Review fix (C5): a cancelled airing the guide moves stays cancelled at
/// its new time, with or without its cancelled row in the library.
#[tokio::test]
async fn a_cancelled_airing_the_guide_moves_is_not_recreated() {
    let r = rig().await;
    r.guide(&[(HOUR, SHOW), (25 * HOUR, SHOW), (49 * HOUR, SHOW)])
        .await;
    let rule = r.add_rule(SHOW).await;
    let second = r
        .recordings()
        .await
        .into_iter()
        .find(|x| r.offset(&x.start) == 25 * HOUR)
        .unwrap();
    recording::cancel(&r.env.state, &second.id).await.unwrap();

    // Five minutes later in the refreshed guide.
    let moved = 25 * HOUR + 300;
    r.guide(&[(HOUR, SHOW), (moved, SHOW), (49 * HOUR, SHOW)])
        .await;
    recording::tick(&r.env.state).await.unwrap();
    assert_eq!(
        r.of_rule(&rule).await,
        vec![
            (HOUR, RecordingStatus::Scheduled),
            (moved, RecordingStatus::Cancelled),
            (49 * HOUR, RecordingStatus::Scheduled),
        ]
    );
    let row = r
        .recordings()
        .await
        .into_iter()
        .find(|x| x.id == second.id)
        .unwrap();
    assert_eq!(r.offset(&row.end) - r.offset(&row.start), HOUR / 2);

    // Removed from the library, the cancellation still follows the airing.
    recording::remove(&r.env.state, &second.id).await.unwrap();
    let later = 25 * HOUR + HOUR / 2;
    r.guide(&[(HOUR, SHOW), (later, SHOW), (49 * HOUR, SHOW)])
        .await;
    recording::tick(&r.env.state).await.unwrap();
    r.tick_later().await;
    assert_eq!(r.scheduled(&rule).await, vec![HOUR, 49 * HOUR]);
    assert_eq!(r.recordings().await.len(), 2);
}

/// Review fix: a manual Record and a series rule handling the same airing
/// at the same moment record it once (the check and the insert are one
/// write transaction).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_manual_record_racing_a_rule_records_the_airing_once() {
    let r = rig().await;
    let shows: Vec<(i64, String)> = (1..=40).map(|k| (k * HOUR, format!("Show {k}"))).collect();
    let guide: Vec<(i64, &str)> = shows.iter().map(|(o, t)| (*o, t.as_str())).collect();
    r.guide(&guide).await;
    for (n, (offset, title)) in shows.iter().enumerate() {
        let state = r.env.state.clone();
        let req = ScheduleRequest {
            item_ref: r.item.clone(),
            channel_name: "Alpha".into(),
            title: Some(title.clone()),
            start: Some(rfc(r.base + offset)),
            end: Some(rfc(r.base + offset + HOUR / 2)),
            duration_minutes: None,
        };
        let delay = std::time::Duration::from_micros(150 * (n as u64 % 10));
        let manual = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            recording::schedule(&state, req).await
        });
        let state = r.env.state.clone();
        let add =
            serde_json::from_value(json!({"ref": r.item, "channelName": "Alpha", "title": title}))
                .unwrap();
        let rule = tokio::spawn(async move { recording::rules::add(&state, add).await });
        rule.await.unwrap().unwrap();
        if let Err(e) = manual.await.unwrap() {
            assert_eq!(e.code(), RpcErrorCode::Conflict, "{title}: {e}");
        }
        let at: Vec<_> = r
            .all()
            .await
            .into_iter()
            .filter(|(o, s, _)| o == offset && *s == RecordingStatus::Scheduled)
            .collect();
        assert_eq!(at.len(), 1, "{title}: {at:?}");
    }
}

#[tokio::test]
async fn duplicate_and_invalid_rules_are_refused() {
    let r = rig().await;
    r.guide(&[(HOUR, SHOW)]).await;
    r.add_rule(SHOW).await;
    for title in [SHOW, "  the daily SHOW. ", "THE-DAILY-SHOW"] {
        assert_eq!(
            r.call_err(
                "recordings.addRule",
                json!({"ref": r.item, "channelName": "Alpha", "title": title})
            )
            .await,
            RpcErrorCode::Conflict,
            "{title}"
        );
    }
    let other = r.add_rule("Daily Show Special").await;
    assert_eq!(other["upcoming"], 0);
    assert!(other.get("nextStart").is_none());
    assert_eq!(r.rules().await.len(), 2);

    let vod = ItemRef::new(r.item.source_id.clone(), ContentType::Movie, "m1");
    for (args, code) in [
        (json!({"ref": vod, "title": "Film"}), RpcErrorCode::Invalid),
        (
            json!({"ref": r.item, "title": "   "}),
            RpcErrorCode::Invalid,
        ),
        (
            json!({"ref": r.item, "title": "!!!"}),
            RpcErrorCode::Invalid,
        ),
        (
            json!({"ref": r.item, "title": "x".repeat(201)}),
            RpcErrorCode::Invalid,
        ),
        (
            json!({"ref": {"sourceId": "nope", "contentType": "live", "itemId": "a"}, "title": "News"}),
            RpcErrorCode::NotFound,
        ),
    ] {
        assert_eq!(
            r.call_err("recordings.addRule", args.clone()).await,
            code,
            "{args}"
        );
    }
    // Without a channel name the item id stands in.
    let bare = r
        .call(
            "recordings.addRule",
            json!({"ref": r.item, "title": "Late News"}),
        )
        .await;
    assert_eq!(bare["channelName"], r.item.item_id.as_str());
    for (cmd, args) in [
        (
            "recordings.setRuleEnabled",
            json!({"id": "nope", "enabled": true}),
        ),
        ("recordings.removeRule", json!({"id": "nope"})),
    ] {
        assert_eq!(r.call_err(cmd, args).await, RpcErrorCode::NotFound, "{cmd}");
    }
}

#[tokio::test]
async fn removing_a_rule_cancels_its_scheduled_recordings() {
    let r = rig().await;
    r.guide(&[
        (HOUR, SHOW),
        (2 * HOUR, "News at Ten"),
        (25 * HOUR, SHOW),
        (26 * HOUR, "News at Ten"),
        (50 * HOUR, "Film"),
    ])
    .await;
    let show = r.add_rule(SHOW).await;
    let news = r.add_rule("News at Ten").await;
    // A one-off recording is not the rule's.
    recording::schedule(
        &r.env.state,
        ScheduleRequest {
            item_ref: r.item.clone(),
            channel_name: "Alpha".into(),
            title: Some("Film".into()),
            start: Some(rfc(r.base + 50 * HOUR)),
            end: Some(rfc(r.base + 50 * HOUR + HOUR / 2)),
            duration_minutes: None,
        },
    )
    .await
    .unwrap();

    r.call("recordings.removeRule", json!({"id": show["id"]}))
        .await;
    assert_eq!(
        r.of_rule(&show).await,
        vec![
            (HOUR, RecordingStatus::Cancelled),
            (25 * HOUR, RecordingStatus::Cancelled)
        ]
    );
    assert_eq!(r.scheduled(&news).await, vec![2 * HOUR, 26 * HOUR]);
    r.call(
        "recordings.removeRule",
        json!({"id": news["id"], "keepScheduled": true}),
    )
    .await;
    // The kept recordings stay scheduled as one-off recordings: they no
    // longer name the deleted rule.
    assert!(r.of_rule(&news).await.is_empty());
    let kept = r.titled("News at Ten").await;
    assert_eq!(
        kept.iter()
            .map(|x| (r.offset(&x.start), x.status, x.rule_id.clone()))
            .collect::<Vec<_>>(),
        vec![
            (2 * HOUR, RecordingStatus::Scheduled, None),
            (26 * HOUR, RecordingStatus::Scheduled, None)
        ]
    );
    assert!(r.rules().await.is_empty());
    let film = r.titled("Film").await;
    assert_eq!(film.len(), 1);
    assert_eq!(film[0].status, RecordingStatus::Scheduled);
    assert_eq!(film[0].rule_id, None);

    // A kept recording outlives its rule: it can still be cancelled, and
    // nothing comes back.
    recording::cancel(&r.env.state, &kept[0].id).await.unwrap();
    r.tick_later().await;
    let scheduled = |rows: Vec<Recording>| {
        rows.iter()
            .filter(|x| x.status == RecordingStatus::Scheduled)
            .count()
    };
    assert_eq!(scheduled(r.recordings().await), 2);

    // The same rule added again does not take them over, so removing it
    // with "also cancel scheduled" leaves them alone.
    let again = r.add_rule("News at Ten").await;
    assert_eq!(again["upcoming"], 0, "the airings already have recordings");
    r.call("recordings.removeRule", json!({"id": again["id"]}))
        .await;
    assert_eq!(
        r.titled("News at Ten")
            .await
            .iter()
            .map(|x| (r.offset(&x.start), x.status))
            .collect::<Vec<_>>(),
        vec![
            (2 * HOUR, RecordingStatus::Cancelled),
            (26 * HOUR, RecordingStatus::Scheduled)
        ]
    );
    assert_eq!(scheduled(r.recordings().await), 2);
}

#[tokio::test]
async fn a_rule_added_again_reschedules_what_its_removal_cancelled() {
    let r = rig().await;
    r.guide(&[(HOUR, SHOW), (25 * HOUR, SHOW)]).await;
    let first = r.add_rule(SHOW).await;
    assert_eq!(first["upcoming"], 2);
    r.call("recordings.removeRule", json!({"id": first["id"]}))
        .await;
    let cancelled = r.titled(SHOW).await;
    assert_eq!(cancelled.len(), 2);
    for x in &cancelled {
        assert_eq!(x.status, RecordingStatus::Cancelled);
        assert_eq!(x.error_code.as_deref(), Some("ruleRemoved"), "{x:?}");
    }

    // The user removed the rule, not the airings: the same rule added again
    // schedules them again, in place of the cancelled rows.
    let again = r.add_rule(SHOW).await;
    assert_eq!(again["upcoming"], 2, "{again}");
    assert_eq!(
        r.titled(SHOW)
            .await
            .iter()
            .map(|x| (r.offset(&x.start), x.status))
            .collect::<Vec<_>>(),
        vec![
            (HOUR, RecordingStatus::Scheduled),
            (25 * HOUR, RecordingStatus::Scheduled)
        ]
    );
}

#[tokio::test]
async fn a_disabled_rule_schedules_nothing_new() {
    let r = rig().await;
    r.guide(&[(HOUR, SHOW)]).await;
    let rule = r.add_rule(SHOW).await;
    let off = r
        .call(
            "recordings.setRuleEnabled",
            json!({"id": rule["id"], "enabled": false}),
        )
        .await;
    assert_eq!(off["enabled"], false);
    assert_eq!(off["upcoming"], 1, "disabling keeps what is scheduled");
    r.guide(&[(HOUR, SHOW), (30 * HOUR, SHOW)]).await;
    r.tick_later().await;
    assert_eq!(r.scheduled(&rule).await, vec![HOUR]);
    let on = r
        .call(
            "recordings.setRuleEnabled",
            json!({"id": rule["id"], "enabled": true}),
        )
        .await;
    assert_eq!(on["enabled"], true);
    assert_eq!(on["upcoming"], 2);
    assert_eq!(r.scheduled(&rule).await, vec![HOUR, 30 * HOUR]);
}

#[tokio::test]
async fn a_rule_keeps_at_most_twenty_upcoming() {
    let r = rig().await;
    let airings: Vec<(i64, &str)> = (0..30)
        .map(|i| (HOUR + i * 4 * HOUR, "Hourly News"))
        .collect();
    r.guide(&airings).await;
    let rule = r.add_rule("Hourly News").await;
    assert_eq!(rule["upcoming"], 20);
    let first: Vec<i64> = airings[..20].iter().map(|a| a.0).collect();
    assert_eq!(r.scheduled(&rule).await, first);
    // A finished slot frees room for the next airing.
    let gone = r.recordings().await.remove(0);
    recording::cancel(&r.env.state, &gone.id).await.unwrap();
    r.tick_later().await;
    let mut want: Vec<i64> = airings[1..21].iter().map(|a| a.0).collect();
    want.sort_unstable();
    assert_eq!(r.scheduled(&rule).await, want);
}

#[tokio::test]
async fn rule_airings_follow_the_epg_offset() {
    let r = rig().await;
    iptv_core::settings::update(&r.env.state, json!({"epgOffsetMinutes": 30}))
        .await
        .unwrap();
    // Guide time base + 1 h shows (and records) at base + 1 h 30.
    r.guide(&[(HOUR, SHOW), (-HOUR / 4, SHOW)]).await;
    let rule = r.add_rule(SHOW).await;
    // The airing at guide time base - 15 min shows at base + 15 min: still ahead.
    assert_eq!(r.scheduled(&rule).await, vec![HOUR / 4, HOUR + HOUR / 2]);
}

#[tokio::test]
async fn rules_round_trip_through_the_backup() {
    let r = rig().await;
    r.guide(&[(HOUR, SHOW)]).await;
    let show = r.add_rule(SHOW).await;
    let news = r.add_rule("News at Ten").await;
    r.call(
        "recordings.setRuleEnabled",
        json!({"id": news["id"], "enabled": false}),
    )
    .await;
    let src = r.item.source_id.clone();
    let key = src.clone();
    let exported = r
        .env
        .state
        .db_call(move |c| recording::export_rules(c, &key))
        .await
        .unwrap();
    assert_eq!(exported.len(), 2);
    assert_eq!(exported[0].title, SHOW);
    assert!(exported[0].enabled);
    assert_eq!(exported[1].title, "News at Ten");
    assert!(!exported[1].enabled);
    assert_eq!(exported[0].created_at, show["createdAt"].as_str().unwrap());
    let wire = serde_json::to_value(&exported[0]).unwrap();
    assert_eq!(wire["contentType"], "live");
    assert_eq!(wire["itemId"], r.item.item_id.as_str());

    // Same database: every rule is a duplicate.
    let (key, rules) = (src.clone(), exported.clone());
    let written = r
        .env
        .state
        .db_call(move |c| recording::import_rules(c, &key, &rules))
        .await
        .unwrap();
    assert_eq!(written, 0);

    for rule in [&show, &news] {
        r.call(
            "recordings.removeRule",
            json!({"id": rule["id"], "keepScheduled": true}),
        )
        .await;
    }
    let mut rules = exported.clone();
    rules.push(RecordingRuleBackup {
        content_type: ContentType::Movie,
        item_id: "m1".into(),
        channel_name: "Film".into(),
        title: "A film".into(),
        enabled: true,
        created_at: "2026-01-01T00:00:00Z".into(),
    });
    rules.push(RecordingRuleBackup {
        content_type: ContentType::Live,
        item_id: "  ".into(),
        channel_name: String::new(),
        title: "No channel".into(),
        enabled: true,
        created_at: "yesterday".into(),
    });
    rules.push(RecordingRuleBackup {
        content_type: ContentType::Live,
        item_id: r.item.item_id.clone(),
        channel_name: String::new(),
        title: "   ".into(),
        enabled: true,
        created_at: String::new(),
    });
    let key = src.clone();
    let written = r
        .env
        .state
        .db_call(move |c| recording::import_rules(c, &key, &rules))
        .await
        .unwrap();
    assert_eq!(written, 2);
    let back = r.rules().await;
    assert_eq!(back.len(), 2);
    assert_eq!(back[0]["title"], SHOW);
    assert_eq!(back[0]["createdAt"], show["createdAt"]);
    assert_eq!(back[0]["enabled"], true);
    assert_eq!(back[1]["enabled"], false);
    assert_eq!(back[0]["ref"], serde_json::to_value(&r.item).unwrap());
    // Imported rules join on the next re-match pass; the kept recording
    // already covers the one airing.
    r.tick_later().await;
    assert_eq!(r.scheduled(&back[0]).await, Vec::<i64>::new());
    assert_eq!(
        r.recordings()
            .await
            .iter()
            .filter(|x| x.status == RecordingStatus::Scheduled)
            .count(),
        1
    );
}

#[tokio::test]
async fn at_most_one_hundred_rules() {
    let r = rig().await;
    let rules: Vec<RecordingRuleBackup> = (0..105)
        .map(|i| RecordingRuleBackup {
            content_type: ContentType::Live,
            item_id: format!("ch{i}"),
            channel_name: format!("Channel {i}"),
            title: format!("Show {i}"),
            enabled: false,
            created_at: rfc(r.base),
        })
        .collect();
    let key = r.item.source_id.clone();
    let written = r
        .env
        .state
        .db_call(move |c| recording::import_rules(c, &key, &rules))
        .await
        .unwrap();
    assert_eq!(written, 100);
    assert_eq!(
        r.call_err(
            "recordings.addRule",
            json!({"ref": r.item, "title": "One more"})
        )
        .await,
        RpcErrorCode::Invalid
    );
}
