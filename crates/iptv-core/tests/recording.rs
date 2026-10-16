//! Scheduled recording and guide reminders against the mock's timed live
//! stream (`/live/timed.ts`): real bytes on disk with the playlist's
//! headers, retry into a new part file, missed-on-launch, reminder firing,
//! settings validation and the backup round-trip of the recording settings.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::recording::engine::{force_engine, Engine};
use iptv_core::recording::scheduler::ManualClock;
use iptv_core::recording::{
    self, RecordingStatus, ReminderRequest, ReminderStatus, ScheduleRequest,
};
use iptv_core::rpc::RpcRouter;
use iptv_core::AppEvent;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use support::*;
use tokio::sync::broadcast::error::TryRecvError;

const UA: &str = "TsrustRecorder/1.0";

fn rfc(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .unwrap()
        .to_rfc3339()
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Imports a one-channel playlist whose stream is `url`; returns the channel ref.
async fn channel(env: &Env, url: &str) -> iptv_core::model::ItemRef {
    let text = format!(
        "#EXTM3U\n#EXTINF:-1 tvg-id=\"alpha\" group-title=\"News\",Alpha\n#EXTVLCOPT:http-user-agent={UA}\n{url}\n"
    );
    let src = add_text(&env.state, "Rec", &text).await;
    let r = router();
    let list = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": src.id}),
        )
        .await
        .unwrap();
    serde_json::from_value(list["items"][0]["ref"].clone()).unwrap()
}

async fn wait_status(
    env: &Env,
    id: &str,
    want: RecordingStatus,
    secs: u64,
) -> recording::Recording {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let rows = recording::list_recordings(&env.state).await.unwrap();
        let row = rows.into_iter().find(|r| r.id == id).expect("row");
        if row.status == want {
            return row;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "still {:?} ({:?}) after {secs} s",
            row.status,
            row.error
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn drain(env: &mut Env) -> Vec<AppEvent> {
    let mut out = Vec::new();
    loop {
        match env.events.try_recv() {
            Ok(e) => out.push(e),
            Err(TryRecvError::Lagged(_)) => continue,
            Err(_) => return out,
        }
    }
}

#[tokio::test]
async fn records_real_bytes_with_playlist_headers_and_rejoins_after_a_drop() {
    let env = env().await;
    let mock = iptv_fixtures::spawn_mock().await;
    // Not the desktop app: the folder is `<data dir>/downloads/recordings` (inside the temp dir).
    let out_dir = recording::dir(&env.state);
    assert!(out_dir.starts_with(env.dir.path()));
    iptv_core::settings::update(
        &env.state,
        json!({"recordingPaddingBeforeMinutes": 0, "recordingPaddingAfterMinutes": 0}),
    )
    .await
    .unwrap();
    force_engine(&env.state, Some(Engine::Http));
    // The stream ends after about 4 s (3 segments); the programme runs 12 s,
    // so the recorder reconnects (after a short-part backoff). The short
    // second part is joined onto the first, so the recording stays one
    // playable file, noted as having gaps.
    let url = mock.url(&format!("/live/timed.ts?seconds=6&ua={UA}"));
    let item = channel(&env, &url).await;
    let t = now();
    let res = recording::schedule(
        &env.state,
        ScheduleRequest {
            item_ref: item,
            channel_name: "Alpha".into(),
            title: Some("News: at six?".into()),
            start: Some(rfc(t - 1)),
            end: Some(rfc(t + 12)),
            duration_minutes: None,
        },
    )
    .await
    .unwrap();
    assert!(res.warning.is_none());
    let id = res.recording.id.clone();
    recording::tick(&env.state).await.unwrap();
    wait_status(&env, &id, RecordingStatus::Recording, 10).await;
    let done = wait_status(&env, &id, RecordingStatus::Completed, 60).await;

    assert!(done.bytes > 0, "{done:?}");
    assert_eq!(
        done.error.as_deref(),
        Some(recording::STREAM_GAPS_MESSAGE),
        "{done:?}"
    );
    assert_eq!(done.error_code.as_deref(), Some("streamGaps"), "{done:?}");
    assert_eq!(
        done.file_names.len(),
        1,
        "a short reconnect part joins the one before: {done:?}"
    );
    let first = &done.file_names[0];
    assert!(first.starts_with("Alpha - News_ at six_ - "), "{first}");
    assert!(
        first.ends_with(".ts") && !first.contains("(part"),
        "{first}"
    );
    let mut total = 0u64;
    for name in &done.file_names {
        let bytes = std::fs::read(out_dir.join(name)).unwrap();
        assert_eq!(bytes.first(), Some(&0x47), "{name} is MPEG-TS");
        total += bytes.len() as u64;
    }
    assert_eq!(total as i64, done.bytes);

    // The library lists the one file.
    let files = recording::library::list(&env.state).await.unwrap();
    assert_eq!(
        files
            .iter()
            .filter(|f| f.recording_id.as_deref() == Some(id.as_str()))
            .count(),
        done.file_names.len()
    );
    drop(mock);
}

#[tokio::test]
async fn wrong_headers_never_produce_a_file() {
    let env = env().await;
    let mock = iptv_fixtures::spawn_mock().await;
    force_engine(&env.state, Some(Engine::Http));
    // The playlist sends UA, the stream wants another one: 403 every time.
    let item = channel(&env, &mock.url("/live/timed.ts?seconds=4&ua=Other")).await;
    let res = recording::schedule(
        &env.state,
        ScheduleRequest {
            item_ref: item,
            channel_name: "Alpha".into(),
            title: None,
            start: None,
            end: None,
            duration_minutes: Some(1),
        },
    )
    .await
    .unwrap();
    recording::tick(&env.state).await.unwrap();
    let row = wait_status(&env, &res.recording.id, RecordingStatus::Recording, 10).await;
    assert_eq!(row.kind, recording::RecordingKind::Channel);
    // Stopping keeps nothing (no bytes) and reads as cancelled.
    tokio::time::sleep(Duration::from_millis(500)).await;
    recording::cancel(&env.state, &res.recording.id)
        .await
        .unwrap();
    let row = wait_status(&env, &res.recording.id, RecordingStatus::Cancelled, 20).await;
    assert!(row.file_names.is_empty() && row.bytes == 0, "{row:?}");
    drop(mock);
}

#[tokio::test]
async fn engine_missing_is_refused_when_scheduling() {
    let env = env().await;
    force_engine(&env.state, None);
    // An HLS address cannot be copied byte for byte, and there is no mpv:
    // refused now, not hours later with the user away.
    let item = channel(&env, "http://127.0.0.1:9/live/x.m3u8").await;
    let err = recording::schedule(
        &env.state,
        ScheduleRequest {
            item_ref: item,
            channel_name: "Alpha".into(),
            title: None,
            start: None,
            end: None,
            duration_minutes: Some(2),
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(err, iptv_core::error::CoreError::EngineMissing(_)),
        "{err:?}"
    );
    assert!(recording::list_recordings(&env.state)
        .await
        .unwrap()
        .is_empty());
    // A plain stream still schedules without mpv (HTTP copy).
    let plain = channel(&env, "http://127.0.0.1:9/live/x.ts").await;
    recording::schedule(
        &env.state,
        ScheduleRequest {
            item_ref: plain,
            channel_name: "Beta".into(),
            title: None,
            start: None,
            end: None,
            duration_minutes: Some(2),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_recording_due_while_closed_is_missed_on_launch() {
    let env = env().await;
    let clock = Arc::new(ManualClock::new(1_800_000_000));
    recording::set_clock(&env.state, clock.clone());
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    let t = 1_800_000_000;
    let res = recording::schedule(
        &env.state,
        ScheduleRequest {
            item_ref: item.clone(),
            channel_name: "Alpha".into(),
            title: Some("Late Show".into()),
            start: Some(rfc(t + 600)),
            end: Some(rfc(t + 1800)),
            duration_minutes: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(res.recording.padding_before_minutes, 1);
    assert_eq!(res.recording.padding_after_minutes, 5);
    // A second schedule of the same programme is refused.
    let dup = recording::schedule(
        &env.state,
        ScheduleRequest {
            item_ref: item,
            channel_name: "Alpha".into(),
            title: Some("Late Show".into()),
            start: Some(rfc(t + 600)),
            end: Some(rfc(t + 1800)),
            duration_minutes: None,
        },
    )
    .await;
    assert!(dup.is_err());

    // The app "starts" after the padded end: the first tick marks it missed.
    clock.set(t + 1800 + 5 * 60);
    recording::tick(&env.state).await.unwrap();
    let row = wait_status(&env, &res.recording.id, RecordingStatus::Missed, 5).await;
    assert_eq!(row.error.as_deref(), Some(recording::MISSED_MESSAGE));
    assert_eq!(row.error_code.as_deref(), Some("missedNotRunning"));
    // Finished rows can be removed; a missing one is NotFound.
    recording::remove(&env.state, &row.id).await.unwrap();
    assert!(recording::remove(&env.state, &row.id).await.is_err());
}

#[tokio::test]
async fn reminders_fire_once_then_clean_up() {
    let mut env = env().await;
    let t = 1_800_000_000;
    let clock = Arc::new(ManualClock::new(t));
    recording::set_clock(&env.state, clock.clone());
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    let req = ReminderRequest {
        item_ref: item.clone(),
        channel_name: "Alpha".into(),
        title: "Match".into(),
        start: rfc(t + 600),
        end: rfc(t + 3600),
    };
    let a = recording::add_reminder(&env.state, req.clone())
        .await
        .unwrap();
    let b = recording::add_reminder(&env.state, req).await.unwrap();
    assert_eq!(a.id, b.id, "adding twice returns the same reminder");
    // A programme that already started cannot be reminded.
    assert!(recording::add_reminder(
        &env.state,
        ReminderRequest {
            item_ref: item,
            channel_name: "Alpha".into(),
            title: "Old".into(),
            start: rfc(t - 60),
            end: rfc(t + 60),
        },
    )
    .await
    .is_err());
    drain(&mut env);

    recording::tick(&env.state).await.unwrap();
    assert!(drain(&mut env).iter().all(|e| e.kind != "reminders.fire"));

    // Default lead is 2 minutes.
    clock.set(t + 600 - 120);
    recording::tick(&env.state).await.unwrap();
    let fired: Vec<Value> = drain(&mut env)
        .into_iter()
        .filter(|e| e.kind == "reminders.fire")
        .map(|e| e.payload)
        .collect();
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0]["action"], "notify");
    assert_eq!(fired[0]["reminder"]["title"], "Match");
    let list = recording::list_reminders(&env.state).await.unwrap();
    assert_eq!(list[0].status, ReminderStatus::Fired);

    // Not again.
    clock.advance(30);
    recording::tick(&env.state).await.unwrap();
    assert!(drain(&mut env).iter().all(|e| e.kind != "reminders.fire"));

    // After the programme ends the reminder is gone.
    clock.set(t + 3600);
    recording::tick(&env.state).await.unwrap();
    assert!(recording::list_reminders(&env.state)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn reminders_off_marks_late_ones_missed() {
    let mut env = env().await;
    let t = 1_800_000_000;
    let clock = Arc::new(ManualClock::new(t));
    recording::set_clock(&env.state, clock.clone());
    iptv_core::settings::update(
        &env.state,
        json!({"remindersEnabled": false, "reminderAction": "switch"}),
    )
    .await
    .unwrap();
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    recording::add_reminder(
        &env.state,
        ReminderRequest {
            item_ref: item,
            channel_name: "Alpha".into(),
            title: "Match".into(),
            start: rfc(t + 600),
            end: rfc(t + 3600),
        },
    )
    .await
    .unwrap();
    drain(&mut env);
    clock.set(t + 600 + 400);
    recording::tick(&env.state).await.unwrap();
    assert!(drain(&mut env).iter().all(|e| e.kind != "reminders.fire"));
    let list = recording::list_reminders(&env.state).await.unwrap();
    assert_eq!(list[0].status, ReminderStatus::Missed);
}

#[tokio::test]
async fn recording_settings_validate_and_survive_a_backup() {
    let env = env().await;
    let s = iptv_core::settings::get(&env.state);
    assert_eq!(
        (
            s.recording_padding_before_minutes,
            s.recording_padding_after_minutes,
            s.reminders_enabled,
            s.reminder_lead_minutes
        ),
        (1, 5, true, 2)
    );
    assert!(
        iptv_core::settings::update(&env.state, json!({"recordingPaddingAfterMinutes": 500}))
            .await
            .is_err()
    );
    assert!(
        iptv_core::settings::update(&env.state, json!({"reminderAction": "shout"}))
            .await
            .is_err()
    );
    iptv_core::settings::update(
        &env.state,
        json!({
            "recordingPaddingBeforeMinutes": 3,
            "recordingPaddingAfterMinutes": 10,
            "remindersEnabled": false,
            "reminderLeadMinutes": 7,
            "reminderAction": "switch",
        }),
    )
    .await
    .unwrap();
    add_text(
        &env.state,
        "Rec",
        "#EXTM3U\n#EXTINF:-1,Alpha\nhttp://127.0.0.1:9/a.ts\n",
    )
    .await;

    let mut r = RpcRouter::new();
    iptv_core::backup::rpc::register(&mut r);
    let out = r
        .dispatch(
            env.state.clone(),
            "backup.export",
            json!({"includeSecrets": false}),
        )
        .await
        .unwrap();
    let manifest: Value = serde_json::from_str(out["json"].as_str().unwrap()).unwrap();
    assert_eq!(manifest["settings"]["reminderAction"], "switch");
    assert_eq!(manifest["settings"]["reminderLeadMinutes"], 7);

    let other = support::env().await;
    r.dispatch(
        other.state.clone(),
        "backup.import",
        json!({"json": out["json"], "mode": "replace"}),
    )
    .await
    .unwrap_or_else(|e| panic!("import: {}", e.message));
    let s = iptv_core::settings::get(&other.state);
    assert_eq!(
        (
            s.recording_padding_before_minutes,
            s.recording_padding_after_minutes,
            s.reminders_enabled,
            s.reminder_lead_minutes,
            serde_json::to_value(s.reminder_action).unwrap(),
        ),
        (3, 10, false, 7, json!("switch"))
    );
}

fn row(
    id: &str,
    item: &iptv_core::model::ItemRef,
    start: i64,
    end: i64,
    status: RecordingStatus,
    parts: Vec<String>,
) -> recording::store::RecordingRow {
    recording::store::RecordingRow {
        id: id.into(),
        item_ref: item.clone(),
        channel_name: "Alpha".into(),
        title: Some("Show".into()),
        kind: recording::RecordingKind::Programme,
        start_at: start,
        end_at: end,
        padding_before: 0,
        padding_after: 0,
        status,
        error_message: None,
        parts,
        bytes: 0,
        started_at: None,
        ended_at: None,
        engine: None,
        created_at: start - 1000,
        rule_id: None,
    }
}

async fn insert(env: &Env, r: recording::store::RecordingRow) {
    env.state
        .db_call(move |c| recording::store::insert_recording(c, &r))
        .await
        .unwrap();
}

async fn status_of(env: &Env, id: &str) -> recording::Recording {
    recording::list_recordings(&env.state)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == id)
        .expect("row")
}

/// R-recording-F1: in server mode the recording engine goes through the
/// same fetch guard as the stream proxy: private addresses, loopback and
/// non-http schemes are refused before mpv would ever start.
#[tokio::test]
async fn server_mode_refuses_private_and_non_http_recordings() {
    let env = env().await;
    let private = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    let metadata = channel(&env, "http://169.254.169.254/latest/meta-data").await;
    let rtsp = channel(&env, "rtsp://10.0.0.5/cam").await;
    iptv_core::http::ServerMode::install(&env.state, false).expect("server mode");
    // An mpv that does not exist: if the guard let a URL through, the
    // failure would read "could not start mpv" instead.
    force_engine(
        &env.state,
        Some(Engine::Mpv(env.dir.path().join("no-mpv.exe"))),
    );
    let mut ids = Vec::new();
    for item in [private, metadata, rtsp] {
        let res = recording::schedule(
            &env.state,
            ScheduleRequest {
                item_ref: item,
                channel_name: "Alpha".into(),
                title: None,
                start: None,
                end: None,
                duration_minutes: Some(1),
            },
        )
        .await
        .unwrap();
        ids.push(res.recording.id);
    }
    recording::tick(&env.state).await.unwrap();
    for id in &ids {
        let row = wait_status(&env, id, RecordingStatus::Failed, 10).await;
        let err = row.error.unwrap_or_default();
        assert!(
            err.contains("Refusing") || err.contains("only http and https"),
            "{err}"
        );
        assert!(row.file_names.is_empty());
    }
}

/// R-recording-F3: once shutdown began, a tick neither starts a due
/// recording nor resumes a `recording` row that has no engine.
#[tokio::test]
async fn nothing_starts_or_resumes_after_shutdown() {
    let env = env().await;
    let t = 1_800_000_000;
    let clock = Arc::new(ManualClock::new(t));
    recording::set_clock(&env.state, clock.clone());
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    insert(
        &env,
        row(
            "due",
            &item,
            t + 60,
            t + 600,
            RecordingStatus::Scheduled,
            vec![],
        ),
    )
    .await;
    insert(
        &env,
        row(
            "orphan",
            &item,
            t - 60,
            t + 600,
            RecordingStatus::Recording,
            vec![],
        ),
    )
    .await;
    recording::shutdown(&env.state).await;
    clock.set(t + 120);
    recording::tick(&env.state).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        status_of(&env, "due").await.status,
        RecordingStatus::Scheduled
    );
    let orphan = status_of(&env, "orphan").await;
    assert_eq!(orphan.status, RecordingStatus::Recording);
    assert!(orphan.started_at.is_none(), "not resumed: {orphan:?}");
}

/// R-recording-F6: a cancelled (or finished) row cannot be flipped back to
/// `recording` or overwritten by a stale engine.
#[tokio::test]
async fn stale_transitions_do_not_overwrite_a_newer_state() {
    let env = env().await;
    let t = 1_800_000_000;
    recording::set_clock(&env.state, Arc::new(ManualClock::new(t)));
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    insert(
        &env,
        row(
            "a",
            &item,
            t + 600,
            t + 1200,
            RecordingStatus::Scheduled,
            vec![],
        ),
    )
    .await;
    recording::cancel(&env.state, "a").await.unwrap();
    let (started, finished) = env
        .state
        .db_call(move |c| {
            let started = recording::store::mark_started(c, "a", t, "mpv")?;
            let finished = recording::store::transition(
                c,
                "a",
                &[RecordingStatus::Recording],
                RecordingStatus::Failed,
                Some(t),
                Some("late"),
            )?;
            Ok((started, finished))
        })
        .await
        .unwrap();
    assert!(!started && !finished);
    let a = status_of(&env, "a").await;
    assert_eq!(a.status, RecordingStatus::Cancelled);
    assert!(a.error.is_none() && a.started_at.is_none(), "{a:?}");
}

/// R-recording-F4 and F7: a fired reminder waits for a window to handle it,
/// and asking again for one that already fired re-arms it.
#[tokio::test]
async fn fired_reminders_wait_for_a_window_and_can_be_rearmed() {
    let mut env = env().await;
    let t = 1_800_000_000;
    let clock = Arc::new(ManualClock::new(t));
    recording::set_clock(&env.state, clock.clone());
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    let req = ReminderRequest {
        item_ref: item,
        channel_name: "Alpha".into(),
        title: "Match".into(),
        start: rfc(t + 600),
        end: rfc(t + 3600),
    };
    let r = recording::add_reminder(&env.state, req.clone())
        .await
        .unwrap();
    // Fires "before any window listens" (nobody reads the event).
    clock.set(t + 600 - 120);
    recording::tick(&env.state).await.unwrap();
    let waiting = recording::unhandled_reminders(&env.state);
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].reminder.id, r.id);
    recording::ack_reminder(&env.state, &r.id);
    assert!(recording::unhandled_reminders(&env.state).is_empty());

    // "Remind me" again on the fired reminder: pending again, fires again.
    let again = recording::add_reminder(&env.state, req).await.unwrap();
    assert_eq!(again.id, r.id);
    assert_eq!(again.status, ReminderStatus::Pending);
    drain(&mut env);
    recording::tick(&env.state).await.unwrap();
    assert_eq!(
        drain(&mut env)
            .iter()
            .filter(|e| e.kind == "reminders.fire")
            .count(),
        1
    );
    // Unhandled ones are dropped once the programme is over.
    clock.set(t + 3600);
    assert!(recording::unhandled_reminders(&env.state).is_empty());
}

/// R-recording-F8 / R-integration-F3: removing a source deletes its
/// reminders and cancels its scheduled recordings; finished rows stay.
#[tokio::test]
async fn removing_a_source_clears_its_schedule() {
    let env = env().await;
    let t = 1_800_000_000;
    recording::set_clock(&env.state, Arc::new(ManualClock::new(t)));
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    recording::add_reminder(
        &env.state,
        ReminderRequest {
            item_ref: item.clone(),
            channel_name: "Alpha".into(),
            title: "Match".into(),
            start: rfc(t + 600),
            end: rfc(t + 3600),
        },
    )
    .await
    .unwrap();
    insert(
        &env,
        row(
            "up",
            &item,
            t + 600,
            t + 1200,
            RecordingStatus::Scheduled,
            vec![],
        ),
    )
    .await;
    insert(
        &env,
        row(
            "done",
            &item,
            t - 1200,
            t - 600,
            RecordingStatus::Completed,
            vec![],
        ),
    )
    .await;
    iptv_core::sources::remove(&env.state, &item.source_id)
        .await
        .unwrap();
    assert!(recording::list_reminders(&env.state)
        .await
        .unwrap()
        .is_empty());
    let up = status_of(&env, "up").await;
    assert_eq!(up.status, RecordingStatus::Cancelled);
    assert_eq!(up.error_code.as_deref(), Some("sourceRemoved"));
    assert_eq!(
        status_of(&env, "done").await.status,
        RecordingStatus::Completed
    );
}

/// R-integration-F5: the folders of recorded parts are known, so the shell
/// can allow an earlier recordings folder.
#[tokio::test]
async fn known_dirs_lists_each_part_folder_once() {
    let env = env().await;
    let item = channel(&env, "http://127.0.0.1:9/live/a.ts").await;
    let a = env.dir.path().join("old");
    let b = env.dir.path().join("new");
    let p = |d: &std::path::Path, n: &str| d.join(n).to_string_lossy().into_owned();
    insert(
        &env,
        row(
            "x",
            &item,
            1,
            2,
            RecordingStatus::Completed,
            vec![p(&a, "1.ts"), p(&a, "1 (part 2).ts")],
        ),
    )
    .await;
    insert(
        &env,
        row(
            "y",
            &item,
            3,
            4,
            RecordingStatus::Completed,
            vec![p(&b, "2.ts")],
        ),
    )
    .await;
    let mut dirs = recording::known_dirs(&env.state).await.unwrap();
    dirs.sort();
    let mut want = vec![a, b];
    want.sort();
    assert_eq!(dirs, want);
}
