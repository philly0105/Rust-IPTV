//! mpv JSON IPC client, independent of the transport.
//!
//! Protocol (mpv `--input-ipc-server`): newline-delimited JSON in both
//! directions. Requests are `{"command": [...], "request_id": n}`; replies
//! are `{"request_id": n, "error": "success" | "<reason>", "data": ...}`;
//! unsolicited events are `{"event": "<name>", ...}`, among them
//! `property-change` (`{"event":"property-change","id":k,"name":"pause","data":true}`)
//! for every `observe_property`.
//!
//! [`MpvClient::new`] takes any `AsyncRead + AsyncWrite` stream: the Windows
//! named pipe in production, `tokio::io::duplex` in tests. A reader task
//! routes replies to waiting callers by `request_id`, folds events into the
//! client's [`MpvState`], and re-broadcasts raw events.

use super::mpv_state;
use crate::error::{CoreError, CoreResult};
use crate::model::MpvState;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, oneshot, watch, Notify};
use tokio::task::JoinHandle;

/// Default time to wait for a reply.
pub const DEFAULT_REPLY_TIMEOUT: Duration = Duration::from_secs(5);

/// Lines longer than this are discarded (defensive; real lines are KBs).
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// One decoded line from mpv.
#[derive(Debug, Clone, PartialEq)]
pub enum IpcMessage {
    /// Reply to a command we sent.
    Reply {
        request_id: u64,
        /// `"success"` or mpv's error string.
        error: String,
        data: Value,
    },
    /// Unsolicited event; the whole object is kept (`event`, `name`, `data`,
    /// `reason`, `file_error`, ...).
    Event(Value),
}

/// Decodes one line. Blank, malformed, or unrecognized lines yield `None`.
pub fn parse_line(line: &str) -> Option<IpcMessage> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let obj = v.as_object()?;
    if obj.get("event").and_then(Value::as_str).is_some() {
        return Some(IpcMessage::Event(v));
    }
    let request_id = obj.get("request_id")?.as_u64()?;
    let error = obj
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("success")
        .to_string();
    let data = obj.get("data").cloned().unwrap_or(Value::Null);
    Some(IpcMessage::Reply {
        request_id,
        error,
        data,
    })
}

/// Encodes one request line, newline included.
pub fn encode_command(request_id: u64, args: &[Value]) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({ "command": args, "request_id": request_id }))
        .expect("serializing JSON values cannot fail");
    line.push(b'\n');
    line
}

type ReplySender = oneshot::Sender<Result<Value, String>>;

struct Shared {
    pending: Mutex<HashMap<u64, ReplySender>>,
    closed: AtomicBool,
    closed_tx: watch::Sender<bool>,
    state: Mutex<MpvState>,
    changed: Notify,
    events: broadcast::Sender<Value>,
}

impl Shared {
    fn close(&self) {
        let drained: Vec<ReplySender> = {
            let mut pending = self.pending.lock();
            self.closed.store(true, Ordering::SeqCst);
            pending.drain().map(|(_, tx)| tx).collect()
        };
        for tx in drained {
            let _ = tx.send(Err("connection closed".into()));
        }
        self.closed_tx.send_replace(true);
        self.changed.notify_one();
    }
}

/// Client end of one mpv IPC connection.
pub struct MpvClient {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    reader: Mutex<Option<JoinHandle<()>>>,
    reply_timeout: Duration,
}

impl MpvClient {
    /// Wraps a connected stream and starts the reader task. `initial` seeds
    /// the tracked state (the session passes `attached: true`).
    pub fn new<S>(stream: S, initial: MpvState) -> Arc<Self>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        Self::with_timeout(stream, initial, DEFAULT_REPLY_TIMEOUT)
    }

    /// [`Self::new`] with a custom reply timeout.
    pub fn with_timeout<S>(stream: S, initial: MpvState, reply_timeout: Duration) -> Arc<Self>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (read_half, write_half) = tokio::io::split(stream);
        let (closed_tx, _) = watch::channel(false);
        let (events, _) = broadcast::channel(256);
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            closed_tx,
            state: Mutex::new(initial),
            changed: Notify::new(),
            events,
        });
        let reader = tokio::spawn(read_loop(read_half, Arc::clone(&shared)));
        Arc::new(Self {
            writer: tokio::sync::Mutex::new(Box::new(write_half)),
            shared,
            next_id: AtomicU64::new(1),
            reader: Mutex::new(Some(reader)),
            reply_timeout,
        })
    }

    /// Sends a raw command (`["loadfile", url]`, `["seek", 10, "relative"]`)
    /// and returns the reply's `data`.
    pub async fn command(&self, args: Vec<Value>) -> CoreResult<Value> {
        let name = args
            .first()
            .and_then(Value::as_str)
            .unwrap_or("command")
            .to_string();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.shared.pending.lock();
            if self.shared.closed.load(Ordering::SeqCst) {
                return Err(not_running());
            }
            pending.insert(id, tx);
        }

        let line = encode_command(id, &args);
        let write = async {
            let mut w = self.writer.lock().await;
            w.write_all(&line).await?;
            w.flush().await
        };
        if let Err(e) = write.await {
            self.shared.pending.lock().remove(&id);
            tracing::debug!(error = %e, cmd = %name, "mpv ipc write failed");
            return Err(not_running());
        }

        match tokio::time::timeout(self.reply_timeout, rx).await {
            Ok(Ok(Ok(data))) => Ok(data),
            Ok(Ok(Err(err))) if err == "connection closed" => Err(not_running()),
            Ok(Ok(Err(err))) => Err(CoreError::invalid(format!("mpv rejected {name}: {err}"))),
            Ok(Err(_)) => Err(not_running()),
            Err(_) => {
                self.shared.pending.lock().remove(&id);
                Err(CoreError::Timeout(format!(
                    "mpv did not answer {name} in time"
                )))
            }
        }
    }

    /// `set_property name value`.
    pub async fn set_property(&self, name: &str, value: Value) -> CoreResult<()> {
        self.command(vec![json!("set_property"), json!(name), value])
            .await
            .map(|_| ())
    }

    /// `get_property name`.
    pub async fn get_property(&self, name: &str) -> CoreResult<Value> {
        self.command(vec![json!("get_property"), json!(name)]).await
    }

    /// Registers `observe_property` for each `(id, name)`.
    pub async fn observe(&self, props: &[(u64, &str)]) -> CoreResult<()> {
        for (id, name) in props {
            self.command(vec![json!("observe_property"), json!(id), json!(name)])
                .await?;
        }
        Ok(())
    }

    /// Current tracked state.
    pub fn state(&self) -> MpvState {
        self.shared.state.lock().clone()
    }

    /// Mutates the tracked state and wakes the emitter when it changed.
    pub fn update_state(&self, f: impl FnOnce(&mut MpvState)) {
        let changed = {
            let mut st = self.shared.state.lock();
            let before = st.clone();
            f(&mut st);
            *st != before
        };
        if changed {
            self.shared.changed.notify_one();
        }
    }

    /// Raw event stream (every `{"event": ...}` object).
    pub fn subscribe_events(&self) -> broadcast::Receiver<Value> {
        self.shared.events.subscribe()
    }

    /// True once the connection is gone.
    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    /// Resolves when the connection closes.
    pub async fn closed(&self) {
        let mut rx = self.shared.closed_tx.subscribe();
        let _ = rx.wait_for(|c| *c).await;
    }

    /// Closes our side: stops the reader and fails pending requests.
    pub fn shutdown(&self) {
        if let Some(h) = self.reader.lock().take() {
            h.abort();
        }
        self.shared.close();
    }

    /// Spawns a task that calls `emit` with the current state whenever it
    /// changes, at most once per `interval` (leading edge plus a trailing
    /// emission, so the last state is always delivered). Ends when the
    /// connection closes.
    pub fn spawn_state_emitter<F>(self: &Arc<Self>, interval: Duration, emit: F) -> JoinHandle<()>
    where
        F: Fn(MpvState) + Send + 'static,
    {
        let client = Arc::clone(self);
        tokio::spawn(async move {
            let mut closed = client.shared.closed_tx.subscribe();
            loop {
                tokio::select! {
                    _ = client.shared.changed.notified() => {}
                    _ = closed.wait_for(|c| *c) => break,
                }
                if client.is_closed() {
                    break;
                }
                emit(client.state());
                tokio::time::sleep(interval).await;
            }
        })
    }
}

impl Drop for MpvClient {
    fn drop(&mut self) {
        if let Some(h) = self.reader.get_mut().take() {
            h.abort();
        }
    }
}

fn not_running() -> CoreError {
    CoreError::Conflict("embedded mpv is not running; start playback again".into())
}

async fn read_loop<R: AsyncRead + Send + Unpin>(read_half: R, shared: Arc<Shared>) {
    let mut reader = BufReader::new(read_half);
    let mut buf = Vec::with_capacity(4096);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                tracing::debug!(error = %e, "mpv ipc read failed");
                break;
            }
        }
        if buf.len() > MAX_LINE_BYTES {
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        match parse_line(&line) {
            Some(IpcMessage::Reply {
                request_id,
                error,
                data,
            }) => {
                if let Some(tx) = shared.pending.lock().remove(&request_id) {
                    let _ = tx.send(if error == "success" {
                        Ok(data)
                    } else {
                        Err(error)
                    });
                }
            }
            Some(IpcMessage::Event(ev)) => {
                let changed = mpv_state::apply_event(&mut shared.state.lock(), &ev);
                if changed {
                    shared.changed.notify_one();
                }
                let _ = shared.events.send(ev);
            }
            None => {}
        }
    }
    shared.close();
}
