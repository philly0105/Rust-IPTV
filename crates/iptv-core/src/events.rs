//! App events pushed from the core to the UI (SPEC C1).
//!
//! Desktop: the Tauri sink emits `app-event`. Server: `BroadcastSink` feeds the
//! `/api/events` WebSocket. Tests use `BroadcastSink` or `NoopSink`.
//!
//! Event kinds used across slices: `import.progress`, `sources.changed`,
//! `epg.progress`, `epg.changed`, `downloads.update`, `downloads.progress`,
//! `remote.command`, `mpv.state`, `settings.changed`, `player.external`,
//! `parental.changed` (payload `ParentalStatus`), `watchlist.changed`
//! (payload `{}`).

use serde::{Deserialize, Serialize};

/// One event. JSON: `{"type": "<kind>", "payload": ...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: serde_json::Value,
}

impl AppEvent {
    /// Builds an event; a payload that fails to serialize becomes `null`.
    pub fn new(kind: &str, payload: impl Serialize) -> Self {
        let payload = serde_json::to_value(payload).unwrap_or_else(|err| {
            tracing::warn!(kind, %err, "event payload failed to serialize");
            serde_json::Value::Null
        });
        Self {
            kind: kind.to_string(),
            payload,
        }
    }
}

/// Destination for app events. Implementations must not block.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: AppEvent);
}

/// Broadcast-channel sink used by the server and by tests.
pub struct BroadcastSink(pub tokio::sync::broadcast::Sender<AppEvent>);

impl BroadcastSink {
    /// Creates a sink with the given channel capacity and returns it with a first receiver.
    pub fn channel(capacity: usize) -> (Self, tokio::sync::broadcast::Receiver<AppEvent>) {
        let (tx, rx) = tokio::sync::broadcast::channel(capacity);
        (Self(tx), rx)
    }

    /// New receiver for a WebSocket client or test.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AppEvent> {
        self.0.subscribe()
    }
}

impl EventSink for BroadcastSink {
    fn emit(&self, event: AppEvent) {
        // No receivers is normal (no UI connected); ignore.
        let _ = self.0.send(event);
    }
}

/// Sink that drops every event.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopSink;

impl EventSink for NoopSink {
    fn emit(&self, _event: AppEvent) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_json_uses_type_key() {
        let e = AppEvent::new("sources.changed", serde_json::json!({}));
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "sources.changed");
        assert!(v["payload"].is_object());
    }

    #[tokio::test]
    async fn broadcast_sink_delivers() {
        let (sink, mut rx) = BroadcastSink::channel(8);
        sink.emit(AppEvent::new("x", 1));
        assert_eq!(rx.recv().await.unwrap().kind, "x");
    }
}
