//! mpv JSON IPC framing, parsing, request correlation, state tracking, and
//! the throttled state emitter, against a fake mpv on a `tokio::io::duplex`.

use iptv_core::error::CoreError;
use iptv_core::model::{MpvState, MpvTrackType};
use iptv_core::player::ipc::{encode_command, parse_line, IpcMessage, MpvClient};
use iptv_core::player::mpv_state::{
    apply_event, apply_property, parse_tracks, seekable_range, OBSERVED_PROPERTIES,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

// ---- framing ------------------------------------------------------------------

#[test]
fn encode_is_one_json_line_with_request_id() {
    let line = encode_command(7, &[json!("seek"), json!(10.5), json!("relative")]);
    assert_eq!(*line.last().unwrap(), b'\n');
    assert_eq!(line.iter().filter(|b| **b == b'\n').count(), 1);
    let v: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(
        v,
        json!({"command": ["seek", 10.5, "relative"], "request_id": 7})
    );
}

#[test]
fn parse_reply_event_and_garbage() {
    assert_eq!(
        parse_line(r#"{"data":12.5,"error":"success","request_id":3}"#),
        Some(IpcMessage::Reply {
            request_id: 3,
            error: "success".into(),
            data: json!(12.5)
        })
    );
    assert_eq!(
        parse_line("{\"error\":\"property unavailable\",\"request_id\":4}\r\n"),
        Some(IpcMessage::Reply {
            request_id: 4,
            error: "property unavailable".into(),
            data: Value::Null
        })
    );
    let ev = parse_line(r#"{"event":"property-change","id":1,"name":"pause","data":true}"#);
    assert!(matches!(ev, Some(IpcMessage::Event(v)) if v["name"] == "pause"));
    assert_eq!(parse_line(""), None);
    assert_eq!(parse_line("not json"), None);
    assert_eq!(parse_line("[1,2]"), None);
    assert_eq!(parse_line(r#"{"hello":"world"}"#), None);
}

// ---- reducers -----------------------------------------------------------------

#[test]
fn property_changes_update_state() {
    let mut st = MpvState::default();
    assert!(apply_property(&mut st, "pause", Some(&json!(false))));
    assert!(!st.paused);
    assert!(
        !apply_property(&mut st, "pause", Some(&json!(false))),
        "no-op change reports false"
    );
    assert!(apply_property(&mut st, "time-pos", Some(&json!(12.25))));
    assert_eq!(st.time_pos, 12.25);
    assert!(apply_property(&mut st, "duration", Some(&json!(3600.0))));
    assert_eq!(st.duration, Some(3600.0));
    assert!(apply_property(&mut st, "duration", None));
    assert_eq!(st.duration, None);
    assert!(apply_property(&mut st, "volume", Some(&json!(55))));
    assert_eq!(st.volume, 55.0);
    assert!(apply_property(&mut st, "mute", Some(&json!(true))));
    assert!(st.muted);
    assert!(apply_property(&mut st, "fullscreen", Some(&json!(true))));
    assert!(st.fullscreen);
    assert!(apply_property(&mut st, "time-pos", Some(&Value::Null)));
    assert_eq!(st.time_pos, 0.0);
    assert!(
        !apply_property(&mut st, "speed", Some(&json!(2.0))),
        "unobserved property ignored"
    );
}

#[test]
fn track_list_parsing() {
    let tracks = parse_tracks(&json!([
        {"id": 1, "type": "video", "selected": true, "codec": "h264"},
        {"id": 1, "type": "audio", "lang": "eng", "title": "Stereo", "selected": true},
        {"id": 2, "type": "audio", "lang": "ger", "selected": false},
        {"id": 1, "type": "sub", "lang": "", "title": "  ", "selected": false},
        {"id": 9, "type": "attachment"},
        {"type": "audio"}
    ]));
    assert_eq!(tracks.len(), 4);
    assert_eq!(tracks[1].track_type, MpvTrackType::Audio);
    assert_eq!(tracks[1].lang.as_deref(), Some("eng"));
    assert_eq!(tracks[1].title.as_deref(), Some("Stereo"));
    assert!(tracks[1].selected);
    assert_eq!(tracks[3].track_type, MpvTrackType::Sub);
    assert_eq!(tracks[3].lang, None, "blank strings become None");
    assert_eq!(tracks[3].title, None);
    assert!(parse_tracks(&json!(null)).is_empty());
}

#[test]
fn file_lifecycle_events() {
    let mut st = MpvState::default();
    assert!(apply_event(&mut st, &json!({"event": "file-loaded"})));
    assert!(st.loaded);
    assert!(apply_event(
        &mut st,
        &json!({"event": "end-file", "reason": "error", "file_error": "loading failed"})
    ));
    assert!(!st.loaded);
    assert!(st.error.as_deref().unwrap().contains("loading failed"));
    assert!(apply_event(&mut st, &json!({"event": "start-file"})));
    assert!(st.error.is_none());
    assert!(!apply_event(&mut st, &json!({"event": "seek"})));
    assert!(!apply_event(&mut st, &json!({"no": "event"})));
}

#[test]
fn observed_properties_match_contract() {
    let names: Vec<&str> = OBSERVED_PROPERTIES.iter().map(|(_, n)| *n).collect();
    assert_eq!(
        names,
        [
            "pause",
            "time-pos",
            "duration",
            "volume",
            "mute",
            "track-list",
            "fullscreen",
            "demuxer-cache-state",
            "paused-for-cache"
        ]
    );
}

/// B8 (C3 additive): `paused-for-cache` drives `buffering`; it is absent
/// from the JSON until mpv reports it and cleared when the file changes.
#[test]
fn paused_for_cache_sets_buffering() {
    let mut st = MpvState::default();
    assert!(serde_json::to_value(&st)
        .unwrap()
        .get("buffering")
        .is_none());
    assert!(apply_property(
        &mut st,
        "paused-for-cache",
        Some(&json!(true))
    ));
    assert_eq!(st.buffering, Some(true));
    assert_eq!(serde_json::to_value(&st).unwrap()["buffering"], true);
    assert!(!apply_property(
        &mut st,
        "paused-for-cache",
        Some(&json!(true))
    ));
    assert!(apply_property(
        &mut st,
        "paused-for-cache",
        Some(&json!(false))
    ));
    assert_eq!(st.buffering, Some(false));
    assert!(apply_property(&mut st, "paused-for-cache", None));
    assert_eq!(st.buffering, None);
    apply_property(&mut st, "paused-for-cache", Some(&json!(true)));
    assert!(apply_event(&mut st, &json!({"event": "start-file"})));
    assert_eq!(st.buffering, None);
    apply_property(&mut st, "paused-for-cache", Some(&json!(true)));
    apply_event(&mut st, &json!({"event": "end-file", "reason": "eof"}));
    assert_eq!(st.buffering, None);
    // Older clients' JSON without the field still deserializes.
    let old: MpvState = serde_json::from_value(json!({
        "attached": true, "loaded": true, "paused": false, "timePos": 1.0,
        "volume": 50.0, "muted": false, "fullscreen": false
    }))
    .unwrap();
    assert_eq!(old.buffering, None);
}

// ---- fake mpv ---------------------------------------------------------------------

/// The mpv end of a duplex pipe: reads command lines and writes replies/events.
struct FakeMpv {
    lines: tokio::io::Lines<BufReader<ReadHalf<DuplexStream>>>,
    out: WriteHalf<DuplexStream>,
}

impl FakeMpv {
    async fn next_command(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .expect("client sent nothing")
            .unwrap()
            .expect("client closed");
        serde_json::from_str(&line).unwrap()
    }

    async fn send(&mut self, v: Value) {
        let mut line = serde_json::to_vec(&v).unwrap();
        line.push(b'\n');
        self.out.write_all(&line).await.unwrap();
    }

    async fn reply(&mut self, cmd: &Value, error: &str, data: Value) {
        let id = cmd["request_id"].clone();
        self.send(json!({"request_id": id, "error": error, "data": data}))
            .await;
    }
}

fn pair(timeout: Duration) -> (Arc<MpvClient>, FakeMpv) {
    let (client_end, mpv_end) = tokio::io::duplex(64 * 1024);
    let client = MpvClient::with_timeout(
        client_end,
        MpvState {
            attached: true,
            ..MpvState::default()
        },
        timeout,
    );
    let (r, w) = tokio::io::split(mpv_end);
    (
        client,
        FakeMpv {
            lines: BufReader::new(r).lines(),
            out: w,
        },
    )
}

async fn eventually(mut f: impl FnMut() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

#[tokio::test]
async fn command_roundtrip_and_concurrent_correlation() {
    let (client, mut mpv) = pair(Duration::from_secs(5));
    let c1 = Arc::clone(&client);
    let c2 = Arc::clone(&client);
    let a = tokio::spawn(async move { c1.get_property("duration").await });
    let b = tokio::spawn(async move { c2.get_property("volume").await });

    let first = mpv.next_command().await;
    let second = mpv.next_command().await;
    assert_ne!(first["request_id"], second["request_id"]);
    // Answer out of order: correlation is by request_id, not arrival.
    for cmd in [&second, &first] {
        let data = match cmd["command"][1].as_str().unwrap() {
            "duration" => json!(321.5),
            "volume" => json!(70),
            other => panic!("unexpected {other}"),
        };
        mpv.reply(cmd, "success", data).await;
    }
    assert_eq!(a.await.unwrap().unwrap(), json!(321.5));
    assert_eq!(b.await.unwrap().unwrap(), json!(70));
}

#[tokio::test]
async fn mpv_error_reply_becomes_invalid() {
    let (client, mut mpv) = pair(Duration::from_secs(5));
    let c = Arc::clone(&client);
    let call = tokio::spawn(async move { c.set_property("nope", json!(1)).await });
    let cmd = mpv.next_command().await;
    assert_eq!(cmd["command"], json!(["set_property", "nope", 1]));
    mpv.reply(&cmd, "property not found", Value::Null).await;
    let err = call.await.unwrap().unwrap_err();
    assert!(
        matches!(err, CoreError::Invalid(ref m) if m.contains("property not found")),
        "{err:?}"
    );
}

#[tokio::test]
async fn unanswered_command_times_out() {
    let (client, mut mpv) = pair(Duration::from_millis(150));
    let c = Arc::clone(&client);
    let call =
        tokio::spawn(async move { c.command(vec![json!("get_property"), json!("pause")]).await });
    let _ = mpv.next_command().await;
    let err = call.await.unwrap().unwrap_err();
    assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
}

#[tokio::test]
async fn observe_then_property_changes_flow_into_state() {
    let (client, mut mpv) = pair(Duration::from_secs(5));
    let c = Arc::clone(&client);
    let observe = tokio::spawn(async move { c.observe(OBSERVED_PROPERTIES).await });
    for (id, name) in OBSERVED_PROPERTIES {
        let cmd = mpv.next_command().await;
        assert_eq!(cmd["command"], json!(["observe_property", id, name]));
        mpv.reply(&cmd, "success", Value::Null).await;
    }
    observe.await.unwrap().unwrap();

    let mut events = client.subscribe_events();
    mpv.send(json!({"event": "start-file", "playlist_entry_id": 1}))
        .await;
    mpv.send(json!({"event": "property-change", "id": 1, "name": "pause", "data": false}))
        .await;
    mpv.send(json!({"event": "property-change", "id": 2, "name": "time-pos", "data": 42.0}))
        .await;
    mpv.send(json!({"event": "property-change", "id": 3, "name": "duration", "data": 5400.0}))
        .await;
    mpv.send(
        json!({"event": "property-change", "id": 6, "name": "track-list", "data": [
            {"id": 1, "type": "audio", "lang": "eng", "selected": true},
            {"id": 2, "type": "sub", "lang": "fre", "selected": false}
        ]}),
    )
    .await;
    mpv.send(json!({"event": "file-loaded"})).await;

    eventually(|| client.state().loaded).await;
    let st = client.state();
    assert!(st.attached);
    assert!(!st.paused);
    assert_eq!(st.time_pos, 42.0);
    assert_eq!(st.duration, Some(5400.0));
    assert_eq!(st.tracks.len(), 2);
    assert_eq!(st.tracks[1].track_type, MpvTrackType::Sub);
    assert_eq!(events.recv().await.unwrap()["event"], "start-file");
}

#[tokio::test]
async fn partial_writes_and_multiple_lines_per_write_are_framed() {
    let (client, mut mpv) = pair(Duration::from_secs(5));
    // One line split across writes, then two lines in one write.
    mpv.out
        .write_all(br#"{"event":"property-change","id":4,"na"#)
        .await
        .unwrap();
    mpv.out.flush().await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    mpv.out
        .write_all(b"me\":\"volume\",\"data\":33}\n{\"event\":\"property-change\",\"id\":5,\"name\":\"mute\",\"data\":true}\n")
        .await
        .unwrap();
    eventually(|| client.state().muted).await;
    assert_eq!(client.state().volume, 33.0);
}

#[tokio::test]
async fn closed_connection_fails_pending_and_future_commands() {
    let (client, mut mpv) = pair(Duration::from_secs(5));
    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move { c.get_property("pause").await });
    let _ = mpv.next_command().await;
    drop(mpv);
    let err = pending.await.unwrap().unwrap_err();
    assert!(matches!(err, CoreError::Conflict(_)), "{err:?}");
    tokio::time::timeout(Duration::from_secs(2), client.closed())
        .await
        .expect("closed resolves");
    assert!(client.is_closed());
    let err = client.get_property("pause").await.unwrap_err();
    assert!(matches!(err, CoreError::Conflict(_)), "{err:?}");
}

#[tokio::test]
async fn state_emitter_is_throttled_and_delivers_last_state() {
    let (client, mut mpv) = pair(Duration::from_secs(5));
    let emitted = Arc::new(parking_lot::Mutex::new(Vec::<MpvState>::new()));
    let sink = Arc::clone(&emitted);
    let interval = Duration::from_millis(250);
    let handle = client.spawn_state_emitter(interval, move |s| sink.lock().push(s));

    // 50 updates within ~100 ms.
    for i in 0..50 {
        mpv.send(
            json!({"event": "property-change", "id": 2, "name": "time-pos", "data": i as f64}),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    tokio::time::sleep(Duration::from_millis(700)).await;

    let got = emitted.lock().clone();
    assert!(!got.is_empty());
    assert!(
        got.len() <= 4,
        "expected throttling to <= 4 emits, got {}",
        got.len()
    );
    assert_eq!(
        got.last().unwrap().time_pos,
        49.0,
        "trailing emission carries the final state"
    );

    // Closing the connection ends the emitter.
    drop(mpv);
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("emitter stops")
        .unwrap();
}

#[tokio::test]
async fn update_state_wakes_emitter_only_on_change() {
    let (client, _mpv) = pair(Duration::from_secs(5));
    let emitted = Arc::new(parking_lot::Mutex::new(0usize));
    let sink = Arc::clone(&emitted);
    let _h = client.spawn_state_emitter(Duration::from_millis(20), move |_| *sink.lock() += 1);
    client.update_state(|s| s.attached = true); // already true: no change
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(*emitted.lock(), 0);
    client.update_state(|s| s.loaded = true);
    eventually(|| *emitted.lock() == 1).await;
}

#[test]
fn demuxer_cache_state_gives_the_rewind_window() {
    let cache =
        json!({"seekable-ranges": [{"start": 10.0, "end": 40.0}, {"start": 100.0, "end": 400.5}]});
    // The range holding the playback position wins; otherwise the newest.
    assert_eq!(
        seekable_range(&cache, 20.0).map(|r| (r.start, r.end)),
        Some((10.0, 40.0))
    );
    assert_eq!(
        seekable_range(&cache, 60.0).map(|r| (r.start, r.end)),
        Some((100.0, 400.5))
    );
    assert_eq!(seekable_range(&json!({"seekable-ranges": []}), 0.0), None);
    assert_eq!(seekable_range(&json!({}), 0.0), None);

    let mut st = MpvState {
        time_pos: 300.0,
        ..MpvState::default()
    };
    assert!(apply_property(&mut st, "demuxer-cache-state", Some(&cache)));
    assert_eq!(st.seekable.map(|r| r.end), Some(400.5));
    // A new file starts without a window.
    assert!(apply_event(&mut st, &json!({"event": "start-file"})));
    assert_eq!(st.seekable, None);
}

/// B9: an mpv that stops reading its pipe must not hang callers forever. The
/// write shares the reply deadline; a write cut short closes the connection
/// (the stream would be misframed) and later commands fail fast.
#[tokio::test]
async fn a_pipe_mpv_stops_reading_times_out_and_closes() {
    // A 64-byte pipe nobody reads: the first long command blocks in write.
    let (ours, _theirs) = tokio::io::duplex(64);
    let client = MpvClient::with_timeout(
        ours,
        MpvState {
            attached: true,
            ..MpvState::default()
        },
        Duration::from_millis(300),
    );
    let long = "x".repeat(10_000);
    let started = std::time::Instant::now();
    let err = client
        .command(vec![json!("loadfile"), json!(long)])
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Timeout(_)), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(
        client.is_closed(),
        "a half-written line closes the connection"
    );
    let err = tokio::time::timeout(Duration::from_secs(1), client.get_property("pause"))
        .await
        .expect("later commands fail fast")
        .unwrap_err();
    assert!(matches!(err, CoreError::Conflict(_)), "{err:?}");
}

/// B9: a caller that gives up (its future is dropped) leaves no pending entry
/// and, when it stopped mid-write, no half line for the next caller.
#[tokio::test]
async fn a_dropped_call_mid_write_closes_instead_of_desyncing() {
    let (ours, _theirs) = tokio::io::duplex(64);
    let client = MpvClient::with_timeout(ours, MpvState::default(), Duration::from_secs(30));
    let long = "y".repeat(10_000);
    let r = tokio::time::timeout(
        Duration::from_millis(200),
        client.command(vec![json!("loadfile"), json!(long)]),
    )
    .await;
    assert!(r.is_err(), "still blocked in write");
    assert!(client.is_closed());
    assert_eq!(client.pending_len(), 0);
}

/// D11 (review round 1): a call dropped while waiting for its reply (the
/// write finished) removes its pending entry and keeps the connection.
#[tokio::test]
async fn a_dropped_call_awaiting_its_reply_leaves_no_pending_entry() {
    let (ours, _theirs) = tokio::io::duplex(64 * 1024);
    let client = MpvClient::with_timeout(ours, MpvState::default(), Duration::from_secs(30));
    for _ in 0..3 {
        let r = tokio::time::timeout(
            Duration::from_millis(100),
            client.command(vec![json!("get_property"), json!("pause")]),
        )
        .await;
        assert!(r.is_err(), "no reply was sent");
    }
    assert!(!client.is_closed(), "a finished write must not close");
    assert_eq!(
        client.pending_len(),
        0,
        "dropped calls leaked pending entries"
    );
}
