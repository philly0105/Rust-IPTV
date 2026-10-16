//! Pure reducers from mpv JSON IPC events to [`MpvState`].

use crate::model::{MpvSeekRange, MpvState, MpvTrack, MpvTrackType};
use serde_json::Value;

/// Properties the embedded session observes, with their observer ids.
pub const OBSERVED_PROPERTIES: &[(u64, &str)] = &[
    (1, "pause"),
    (2, "time-pos"),
    (3, "duration"),
    (4, "volume"),
    (5, "mute"),
    (6, "track-list"),
    (7, "fullscreen"),
    (8, "demuxer-cache-state"),
    (9, "paused-for-cache"),
];

/// Applies one `property-change` to `state`. `data` is `None` when mpv
/// reports the property as unavailable (no file loaded). Returns true when
/// the state changed.
pub fn apply_property(state: &mut MpvState, name: &str, data: Option<&Value>) -> bool {
    let data = data.filter(|v| !v.is_null());
    let before = state.clone();
    match name {
        "pause" => {
            if let Some(b) = data.and_then(Value::as_bool) {
                state.paused = b;
            }
        }
        "time-pos" => {
            state.time_pos = data
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
                .unwrap_or(0.0)
                .max(0.0);
        }
        "duration" => {
            state.duration = data
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v > 0.0);
        }
        "volume" => {
            if let Some(v) = data.and_then(Value::as_f64).filter(|v| v.is_finite()) {
                state.volume = v;
            }
        }
        "mute" => {
            if let Some(b) = data.and_then(Value::as_bool) {
                state.muted = b;
            }
        }
        "track-list" => {
            state.tracks = data.map(parse_tracks).unwrap_or_default();
        }
        "fullscreen" => {
            if let Some(b) = data.and_then(Value::as_bool) {
                state.fullscreen = b;
            }
        }
        "demuxer-cache-state" => {
            state.seekable = data.and_then(|d| seekable_range(d, state.time_pos));
        }
        "paused-for-cache" => {
            state.buffering = data.and_then(Value::as_bool);
        }
        _ => return false,
    }
    *state != before
}

/// The cached range from `demuxer-cache-state.seekable-ranges` that holds
/// `pos` (else the newest one), or `None` when nothing is seekable.
pub fn seekable_range(cache_state: &Value, pos: f64) -> Option<MpvSeekRange> {
    let ranges: Vec<MpvSeekRange> = cache_state
        .get("seekable-ranges")?
        .as_array()?
        .iter()
        .filter_map(|r| {
            let start = r.get("start")?.as_f64()?;
            let end = r.get("end")?.as_f64()?;
            (start.is_finite() && end.is_finite() && end > start)
                .then_some(MpvSeekRange { start, end })
        })
        .collect();
    ranges
        .iter()
        .find(|r| r.start <= pos && pos <= r.end)
        .or_else(|| ranges.iter().max_by(|a, b| a.end.total_cmp(&b.end)))
        .copied()
}

/// Parses mpv's `track-list` array. Entries with an unknown type or no id
/// are skipped.
pub fn parse_tracks(data: &Value) -> Vec<MpvTrack> {
    let Some(arr) = data.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|t| {
            let id = t.get("id")?.as_i64()?;
            let track_type = match t.get("type")?.as_str()? {
                "audio" => MpvTrackType::Audio,
                "sub" => MpvTrackType::Sub,
                "video" => MpvTrackType::Video,
                _ => return None,
            };
            let text = |k: &str| {
                t.get(k)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            // An external subtitle without a title shows its file name.
            let title = text("title").or_else(|| match track_type {
                MpvTrackType::Sub => text("external-filename")
                    .and_then(|f| f.rsplit(['/', '\\']).next().map(str::to_string))
                    .filter(|n| !n.is_empty()),
                _ => None,
            });
            Some(MpvTrack {
                id,
                track_type,
                title,
                lang: text("lang"),
                selected: t.get("selected").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// The error for a live stream that reached its end: the provider stopped
/// sending it. The player's recovery retries it, then fails over.
pub const LIVE_ENDED: &str = "The live stream stopped: the provider closed the connection.";

/// Applies any IPC event object (`{"event": ...}`) to `state`. Handles
/// `property-change`, `start-file`, `file-loaded`, and `end-file`.
/// Returns true when the state changed.
pub fn apply_event(state: &mut MpvState, event: &Value) -> bool {
    let Some(name) = event.get("event").and_then(Value::as_str) else {
        return false;
    };
    let before = state.clone();
    match name {
        "property-change" => {
            let Some(prop) = event.get("name").and_then(Value::as_str) else {
                return false;
            };
            return apply_property(state, prop, event.get("data"));
        }
        "start-file" => {
            state.loaded = false;
            state.error = None;
            state.seekable = None;
            state.buffering = None;
        }
        "file-loaded" => {
            state.loaded = true;
            state.error = None;
        }
        "end-file" => {
            let was_loaded = state.loaded;
            state.loaded = false;
            state.buffering = None;
            match event.get("reason").and_then(Value::as_str) {
                Some("error") => {
                    let detail = event
                        .get("file_error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error");
                    state.error = Some(format!(
                        "mpv could not play this stream ({detail}). Check the source or try another player."
                    ));
                }
                // Only live items end at EOF (`keep-open=no`, `args::loadfile_options`);
                // everything else pauses on its last frame. A live stream that ends was
                // dropped by the provider. `was_loaded`: the end of the file a new load
                // just replaced (`embedded::load` clears `loaded` first) is not news.
                Some("eof") if was_loaded => state.error = Some(LIVE_ENDED.to_string()),
                _ => {}
            }
        }
        _ => return false,
    }
    *state != before
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn untitled_external_subtitle_is_named_after_its_file() {
        let tracks = parse_tracks(&json!([
            {"id": 1, "type": "sub", "external": true,
             "external-filename": r"C:\Subs\Movie.en.srt", "selected": true},
            {"id": 2, "type": "sub", "external-filename": "/home/u/a.ass", "title": "Signs"},
            {"id": 3, "type": "sub", "external-filename": "C:/Subs/"},
            {"id": 1, "type": "audio", "external-filename": r"C:\a.mka"}
        ]));
        assert_eq!(tracks[0].title.as_deref(), Some("Movie.en.srt"));
        assert!(tracks[0].selected);
        assert_eq!(tracks[1].title.as_deref(), Some("Signs"), "a title wins");
        assert_eq!(tracks[2].title, None);
        assert_eq!(tracks[3].title, None, "only subtitles get the fallback");
    }

    /// L2-desktop-2: a live stream that plays out its cache and ends (the
    /// provider dropped it) is an error the player recovers from, not a pause.
    #[test]
    fn a_live_stream_that_ends_is_reported_as_dropped() {
        let mut st = MpvState {
            attached: true,
            ..MpvState::default()
        };
        apply_event(&mut st, &json!({"event": "start-file"}));
        apply_event(&mut st, &json!({"event": "file-loaded"}));
        assert!(apply_event(
            &mut st,
            &json!({"event": "end-file", "reason": "eof"})
        ));
        assert!(!st.loaded);
        assert_eq!(st.error.as_deref(), Some(LIVE_ENDED));
        // The next load starts clean.
        apply_event(&mut st, &json!({"event": "start-file"}));
        assert_eq!(st.error, None);
    }

    #[test]
    fn replacing_a_file_or_a_late_eof_after_a_new_load_is_not_an_error() {
        let mut st = MpvState::default();
        apply_event(&mut st, &json!({"event": "file-loaded"}));
        // `loadfile replace` ends the old file with reason `stop`.
        apply_event(&mut st, &json!({"event": "end-file", "reason": "stop"}));
        assert_eq!(st.error, None);
        // `embedded::load` clears `loaded` before it sends `loadfile`: the old
        // file's EOF that was already in flight is not the new item's drop.
        apply_event(&mut st, &json!({"event": "file-loaded"}));
        st.loaded = false;
        apply_event(&mut st, &json!({"event": "end-file", "reason": "eof"}));
        assert_eq!(st.error, None);
    }
}
