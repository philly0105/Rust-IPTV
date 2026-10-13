//! `mpv.stats`: a one-shot snapshot of what the embedded mpv is decoding, for
//! the stream info overlay.
//!
//! Nothing is observed for this: the UI calls `mpv.stats` about once a second
//! while its panel is open, and each call reads [`STATS_PROPERTIES`] with
//! `get_property`. With the panel closed, mpv is asked for nothing extra.
//! The stream URL is never part of the answer (it can carry credentials).

use serde::Serialize;
use serde_json::Value;

/// Properties read per `mpv.stats` call, in [`MpvStats::from_values`] order.
pub const STATS_PROPERTIES: &[&str] = &[
    "video-format",
    "width",
    "height",
    "estimated-vf-fps",
    "container-fps",
    "video-bitrate",
    "audio-codec-name",
    "audio-params/channel-count",
    "audio-bitrate",
    "hwdec-current",
    "frame-drop-count",
    "decoder-frame-drop-count",
    "demuxer-cache-duration",
    "file-format",
];

/// `mpv.stats` result. Every field is omitted when mpv does not know it (no
/// file loaded, audio-only stream, property missing in an older mpv).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStats {
    /// Short codec name (`h264`, `hevc`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Measured output frame rate, else the container's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    /// Bits per second.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_bitrate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_channels: Option<u32>,
    /// Bits per second.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_bitrate: Option<f64>,
    /// The hardware decoder in use (`d3d11va`), or `None` for software decoding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hwdec: Option<String>,
    /// True once mpv reported its decoder state (so `hwdec: None` means software).
    pub hwdec_known: bool,
    /// Frames dropped by the video output plus by the decoder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_frames: Option<u64>,
    /// Seconds of stream buffered ahead of playback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_seconds: Option<f64>,
    /// Container (`mpegts`, `hls`, `mp4`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

fn positive(v: Option<&Value>) -> Option<f64> {
    number(v).filter(|n| *n > 0.0)
}

fn count(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_u64)
}

impl MpvStats {
    /// Builds the snapshot from the replies to [`STATS_PROPERTIES`], in the
    /// same order; `None` (or a missing entry) stands for a property mpv
    /// could not give.
    pub fn from_values(values: &[Option<Value>]) -> Self {
        let get = |name: &str| -> Option<&Value> {
            let i = STATS_PROPERTIES.iter().position(|p| *p == name)?;
            values.get(i)?.as_ref().filter(|v| !v.is_null())
        };
        let hwdec_raw = text(get("hwdec-current"));
        let dropped = match (
            count(get("frame-drop-count")),
            count(get("decoder-frame-drop-count")),
        ) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        let container = text(get("file-format")).map(|f| {
            // libavformat lists aliases: "mov,mp4,m4a,3gp,3g2,mj2".
            let first = f.split(',').next().unwrap_or(&f).trim().to_string();
            if first.is_empty() {
                f
            } else {
                first
            }
        });
        MpvStats {
            video_codec: text(get("video-format")),
            width: positive(get("width")).map(|n| n as u32),
            height: positive(get("height")).map(|n| n as u32),
            fps: positive(get("estimated-vf-fps")).or_else(|| positive(get("container-fps"))),
            video_bitrate: positive(get("video-bitrate")),
            audio_codec: text(get("audio-codec-name")),
            audio_channels: positive(get("audio-params/channel-count")).map(|n| n as u32),
            audio_bitrate: positive(get("audio-bitrate")),
            hwdec_known: hwdec_raw.is_some(),
            hwdec: hwdec_raw.filter(|h| h != "no"),
            dropped_frames: dropped,
            cache_seconds: number(get("demuxer-cache-duration")),
            container,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn values(pairs: &[(&str, Value)]) -> Vec<Option<Value>> {
        STATS_PROPERTIES
            .iter()
            .map(|p| pairs.iter().find(|(k, _)| k == p).map(|(_, v)| v.clone()))
            .collect()
    }

    #[test]
    fn full_snapshot() {
        let s = MpvStats::from_values(&values(&[
            ("video-format", json!("h264")),
            ("width", json!(1920)),
            ("height", json!(1080)),
            ("estimated-vf-fps", json!(25.0)),
            ("container-fps", json!(50.0)),
            ("video-bitrate", json!(4_200_000.0)),
            ("audio-codec-name", json!("aac")),
            ("audio-params/channel-count", json!(6)),
            ("audio-bitrate", json!(192_000.0)),
            ("hwdec-current", json!("d3d11va")),
            ("frame-drop-count", json!(3)),
            ("decoder-frame-drop-count", json!(2)),
            ("demuxer-cache-duration", json!(12.5)),
            ("file-format", json!("mov,mp4,m4a,3gp,3g2,mj2")),
        ]));
        assert_eq!(
            s,
            MpvStats {
                video_codec: Some("h264".into()),
                width: Some(1920),
                height: Some(1080),
                fps: Some(25.0),
                video_bitrate: Some(4_200_000.0),
                audio_codec: Some("aac".into()),
                audio_channels: Some(6),
                audio_bitrate: Some(192_000.0),
                hwdec: Some("d3d11va".into()),
                hwdec_known: true,
                dropped_frames: Some(5),
                cache_seconds: Some(12.5),
                container: Some("mov".into()),
            }
        );
    }

    #[test]
    fn missing_and_unavailable_properties_are_omitted() {
        let s = MpvStats::from_values(&values(&[
            ("container-fps", json!(29.97)),
            ("width", json!(0)),
            ("video-bitrate", Value::Null),
            ("hwdec-current", json!("no")),
            ("decoder-frame-drop-count", json!(4)),
            ("file-format", json!("mpegts")),
        ]));
        assert_eq!(s.fps, Some(29.97));
        assert_eq!(s.width, None);
        assert_eq!(s.video_bitrate, None);
        assert_eq!(s.hwdec, None);
        assert!(s.hwdec_known, "\"no\" means software decoding");
        assert_eq!(s.dropped_frames, Some(4));
        assert_eq!(s.container.as_deref(), Some("mpegts"));

        let empty = MpvStats::from_values(&[]);
        assert_eq!(empty, MpvStats::default());
        let json = serde_json::to_value(&empty).unwrap();
        assert_eq!(json, json!({"hwdecKnown": false}));
    }

    #[test]
    fn serializes_camel_case_without_the_url() {
        let s = MpvStats {
            video_codec: Some("hevc".into()),
            cache_seconds: Some(3.0),
            ..MpvStats::default()
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["videoCodec"], json!("hevc"));
        assert_eq!(v["cacheSeconds"], json!(3.0));
        for p in STATS_PROPERTIES {
            assert!(
                !p.contains("path") && !p.contains("url") && !p.contains("filename"),
                "{p}"
            );
        }
    }
}
