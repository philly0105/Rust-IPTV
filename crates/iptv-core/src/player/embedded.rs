//! Embedded mpv session (`mpv.*`).
//!
//! Windows only. `mpv.attach` asks the registered [`ChildWindowFactory`] for a
//! child HWND inside the main window, starts `mpv.exe --wid=<hwnd>
//! --input-ipc-server=\\.\pipe\tsrust-iptv-mpv-<pid> ...`, connects to the
//! named pipe (retrying for up to 5 s), observes the playback properties, and
//! pushes throttled `mpv.state` events (4/s). A watcher task notices when mpv
//! exits on its own (crash, killed) and turns that into `state.error` plus a
//! full detach. Everything lives in one [`MpvManager`] stored in
//! `AppState.extensions["mpv"]`.
//!
//! Every operation is serialized by the manager's op lock, so attach, load,
//! and detach never interleave.

use super::args::{embedded_mpv_args, loadfile_options, mpv_pipe_name, validate_play_url};
use super::detect::{find_mpv, DetectEnv};
use super::ipc::MpvClient;
use super::mpv_state::OBSERVED_PROPERTIES;
use super::{embedded_unavailable_reason, window_factory, Bounds, ChildWindowFactory};
use crate::error::{CoreError, CoreResult};
use crate::model::{MpvState, PlayerSource};
use crate::state::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

/// `AppState.extensions` key of the [`MpvManager`].
pub const MPV_EXT_KEY: &str = "mpv";

/// `mpv.state` events are throttled to one per this interval (4/s).
pub const STATE_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// How long `mpv.attach` waits for mpv's IPC pipe.
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long `mpv.detach` waits for mpv to quit before killing it.
const QUIT_GRACE: Duration = Duration::from_secs(2);

/// IPC commands `mpv.command` accepts besides [`PROPERTY_COMMANDS`]: what
/// the player UI sends (`seek`) and read-only property queries. Everything
/// else is refused, including mpv's command prefixes (`no-osd`, `async`,
/// `raw`, ...), which would otherwise smuggle any command in as an argument,
/// and `keybind`, `run`, `loadfile`, `dump-cache`, `screenshot-to-file`.
const ALLOWED_COMMANDS: &[&str] = &["seek", "get_property", "get_property_string"];

/// Properties `mpv.setProperty` (and property commands sent through
/// `mpv.command`) may change: the playback controls the UI exposes. Anything
/// else is refused, notably `stream-record` / `dump-cache`-style properties
/// that write to a path (recording goes through `mpv.record`).
pub const SETTABLE_PROPERTIES: &[&str] = &[
    "pause",
    "volume",
    "mute",
    "speed",
    "aid",
    "sid",
    "vid",
    "audio-delay",
    "sub-delay",
    "sub-visibility",
    "time-pos",
];

/// IPC commands whose first argument names a property to change; accepted
/// only for [`SETTABLE_PROPERTIES`].
const PROPERTY_COMMANDS: &[&str] = &[
    "set",
    "set_property",
    "set_property_string",
    "add",
    "multiply",
    "cycle",
    "cycle-values",
];

/// Refuses property names outside [`SETTABLE_PROPERTIES`].
pub fn validate_property(name: &str) -> CoreResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::invalid("property name is empty"));
    }
    if !SETTABLE_PROPERTIES.contains(&name) {
        return Err(CoreError::invalid(format!(
            "mpv property {name:?} cannot be set from the UI"
        )));
    }
    Ok(())
}

/// The single embedded mpv session holder.
#[derive(Default)]
pub struct MpvManager {
    /// Serializes attach / load / detach.
    op: tokio::sync::Mutex<()>,
    session: Mutex<Option<Arc<Session>>>,
    /// State reported while detached (keeps the last error and volume).
    last: Mutex<MpvState>,
    next_id: AtomicU64,
}

struct Session {
    id: u64,
    hwnd: isize,
    factory: Arc<dyn ChildWindowFactory>,
    client: Arc<MpvClient>,
    child: Mutex<tokio::process::Child>,
    pid: u32,
    detaching: AtomicBool,
    emitter: Mutex<Option<JoinHandle<()>>>,
    watcher: Mutex<Option<JoinHandle<()>>>,
    /// Title of the loaded item (names recordings).
    title: Mutex<String>,
}

impl Session {
    fn exited(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(Some(_)) | Err(_))
    }

    fn state(&self) -> MpvState {
        let mut s = self.client.state();
        s.attached = true;
        s
    }

    /// Aborts the emitter and, unless called from the watcher itself, the
    /// watcher.
    fn stop_tasks(&self, from_watcher: bool) {
        if let Some(t) = self.emitter.lock().take() {
            t.abort();
        }
        let watcher = self.watcher.lock().take();
        if let Some(t) = watcher {
            if !from_watcher {
                t.abort();
            }
        }
    }
}

fn manager(state: &AppState) -> Arc<MpvManager> {
    state.ext_or_insert_with(MPV_EXT_KEY, || Arc::new(MpvManager::default()))
}

fn current(mgr: &MpvManager) -> Option<Arc<Session>> {
    mgr.session.lock().clone()
}

fn not_attached() -> CoreError {
    CoreError::Conflict(
        "Embedded mpv is not attached. Start playback with the embedded player first.".into(),
    )
}

/// Returns `Unsupported` off Windows.
pub fn ensure_platform() -> CoreResult<()> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err(CoreError::Unsupported(
            embedded_unavailable_reason(false, false, false).unwrap_or_default(),
        ))
    }
}

/// `mpv.state`.
pub fn state(state: &AppState) -> MpvState {
    let mgr = manager(state);
    let s = current(&mgr);
    match s {
        Some(s) => s.state(),
        None => mgr.last.lock().clone(),
    }
}

/// Optional `mpv.attach` arguments: the UI's saved volume (0..100) and mute
/// state, applied before mpv plays anything and before the first state event.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AttachOptions {
    pub volume: Option<f64>,
    pub muted: Option<bool>,
}

/// `mpv.attach`: creates the child window and starts mpv; when a session is
/// already running it only moves the window.
pub async fn attach(
    state: &Arc<AppState>,
    bounds: Bounds,
    opts: AttachOptions,
) -> CoreResult<MpvState> {
    ensure_platform()?;
    let mgr = manager(state);
    let _op = mgr.op.lock().await;

    if let Some(s) = current(&mgr) {
        if !s.exited() && !s.client.is_closed() {
            set_window_bounds(&s.factory, s.hwnd, bounds).await?;
            return Ok(s.state());
        }
        // A dead session the watcher has not reaped yet.
        teardown(state, &mgr, &s, None, false).await;
    }

    let factory = window_factory(state).ok_or_else(|| {
        CoreError::Unsupported(embedded_unavailable_reason(true, true, false).unwrap_or_default())
    })?;
    let settings = state.settings_snapshot();
    let configured = settings.mpv_path.clone();
    let mpv =
        tokio::task::spawn_blocking(move || find_mpv(configured.as_deref(), &DetectEnv::current()))
            .await?
            .ok_or_else(|| {
                CoreError::NotFound(
                    embedded_unavailable_reason(true, false, true).unwrap_or_default(),
                )
            })?;

    let hwnd = {
        let f = Arc::clone(&factory);
        tokio::task::spawn_blocking(move || f.create(bounds)).await??
    };

    let pipe = mpv_pipe_name(std::process::id());
    let (initial_volume, initial_muted) = {
        let mut last = mgr.last.lock();
        if let Some(v) = opts.volume.filter(|v| v.is_finite()) {
            last.volume = v.clamp(0.0, 100.0);
        }
        if let Some(m) = opts.muted {
            last.muted = m;
        }
        (last.volume, last.muted)
    };
    let args = embedded_mpv_args(
        hwnd,
        &pipe,
        &settings.mpv_args,
        initial_volume,
        initial_muted,
    );
    let started = platform::start(&mpv, &args, &pipe).await;
    let (child, stream) = match started {
        Ok(v) => v,
        Err(e) => {
            destroy_window(&factory, hwnd).await;
            let mut last = mgr.last.lock();
            last.attached = false;
            last.error = Some(e.to_string());
            return Err(e);
        }
    };
    let pid = child.id().unwrap_or(0);

    let last = mgr.last.lock().clone();
    let client = MpvClient::new(
        stream,
        MpvState {
            attached: true,
            volume: last.volume,
            muted: last.muted,
            ..MpvState::default()
        },
    );
    let session = Arc::new(Session {
        id: mgr.next_id.fetch_add(1, Ordering::Relaxed),
        hwnd,
        factory,
        client: Arc::clone(&client),
        child: Mutex::new(child),
        pid,
        detaching: AtomicBool::new(false),
        emitter: Mutex::new(None),
        watcher: Mutex::new(None),
        title: Mutex::new(String::new()),
    });

    if let Err(e) = client.observe(OBSERVED_PROPERTIES).await {
        teardown(
            state,
            &mgr,
            &session,
            Some(format!("mpv did not accept property observers: {e}")),
            false,
        )
        .await;
        return Err(e);
    }

    let emit_state = Arc::clone(state);
    let emitter = client.spawn_state_emitter(STATE_EMIT_INTERVAL, move |mut s| {
        s.attached = true;
        emit_state.emit("mpv.state", s);
    });
    let watcher = tokio::spawn(watch_session(Arc::clone(state), Arc::clone(&session)));
    *session.emitter.lock() = Some(emitter);
    *session.watcher.lock() = Some(watcher);
    *mgr.session.lock() = Some(Arc::clone(&session));

    tracing::info!(pid, hwnd, "embedded mpv attached");
    let st = session.state();
    state.emit("mpv.state", &st);
    Ok(st)
}

/// `mpv.load`: `loadfile <url> replace -1 {per-file options}`.
pub async fn load(state: &Arc<AppState>, source: &PlayerSource) -> CoreResult<()> {
    ensure_platform()?;
    validate_play_url(source)?;
    let mgr = manager(state);
    let _op = mgr.op.lock().await;
    let s = current(&mgr).ok_or_else(not_attached)?;
    // A recording belongs to the item it started on.
    if s.client.state().recording {
        stop_recording(&s).await;
    }
    *s.title.lock() = source.title.trim().to_string();
    s.client.update_state(|st| {
        st.loaded = false;
        st.error = None;
        st.time_pos = 0.0;
        st.duration = None;
        st.tracks.clear();
    });

    let opts = loadfile_options(source);
    // mpv >= 0.38 takes `loadfile url flags index options`.
    let modern = vec![
        json!("loadfile"),
        json!(source.url),
        json!("replace"),
        json!(-1),
        Value::Object(opts.clone()),
    ];
    match s.client.command(modern).await {
        Ok(_) => Ok(()),
        Err(CoreError::Invalid(_)) => {
            // Older mpv: `loadfile url flags "k=v,..."` with `%len%` escaping.
            let legacy = vec![
                json!("loadfile"),
                json!(source.url),
                json!("replace"),
                json!(legacy_options(&opts)),
            ];
            s.client.command(legacy).await.map(|_| ())
        }
        Err(e) => Err(e),
    }
}

/// Encodes per-file options in mpv's legacy `key=value,...` form; every value
/// uses `%<bytes>%` length quoting so commas and quotes survive.
pub fn legacy_options(opts: &serde_json::Map<String, Value>) -> String {
    opts.iter()
        .map(|(k, v)| {
            let v = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            format!("{k}=%{}%{v}", v.len())
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// `mpv.command`: a raw IPC command; returns mpv's `data`.
pub async fn command(state: &Arc<AppState>, cmd: Vec<Value>) -> CoreResult<Value> {
    ensure_platform()?;
    validate_command(&cmd)?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    s.client.command(cmd).await
}

/// Accepts only [`ALLOWED_COMMANDS`] and [`PROPERTY_COMMANDS`] aimed at
/// [`SETTABLE_PROPERTIES`], with scalar arguments.
pub fn validate_command(cmd: &[Value]) -> CoreResult<()> {
    let Some(name) = cmd.first().and_then(Value::as_str) else {
        return Err(CoreError::invalid(
            "mpv command must start with a command name",
        ));
    };
    if !ALLOWED_COMMANDS.contains(&name) && !PROPERTY_COMMANDS.contains(&name) {
        return Err(CoreError::invalid(format!(
            "mpv command {name:?} is not allowed here"
        )));
    }
    if cmd.iter().any(|v| v.is_object() || v.is_array()) {
        return Err(CoreError::invalid(
            "mpv command arguments must be strings, numbers, or booleans",
        ));
    }
    if PROPERTY_COMMANDS.contains(&name) {
        // `cycle-values` may lead with the `!reverse` flag.
        let prop = cmd[1..]
            .iter()
            .find(|v| v.as_str() != Some("!reverse"))
            .and_then(Value::as_str)
            .unwrap_or("");
        validate_property(prop)?;
    }
    Ok(())
}

/// `mpv.record` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResult {
    pub recording: bool,
    pub path: Option<String>,
}

/// The IPC command that starts (`Some(path)`) or stops (`None`) mpv's
/// `stream-record`: mpv writes the demuxed stream to the file as it plays,
/// without re-encoding.
pub fn stream_record_command(path: Option<&Path>) -> Vec<Value> {
    let value = path.map(|p| p.display().to_string()).unwrap_or_default();
    vec![json!("set_property"), json!("stream-record"), json!(value)]
}

/// Recording file name: `<title>-<yyyyMMdd-HHmm>.ts`, with characters that
/// are invalid in Windows file names replaced and the title shortened.
pub fn recording_file_name<Tz: chrono::TimeZone>(title: &str, now: chrono::DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let clean: String = title
        .trim()
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .take(80)
        .collect();
    let clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let clean = if clean.is_empty() { "recording" } else { clean };
    format!("{clean}-{}.ts", now.format("%Y%m%d-%H%M"))
}

/// `settings.recordingsDir`, else `<downloadsDir>/recordings`.
pub fn recordings_dir(state: &AppState) -> PathBuf {
    let settings = state.settings_snapshot();
    match settings
        .recordings_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        Some(d) => PathBuf::from(d),
        None => crate::downloads::dir(state).join("recordings"),
    }
}

/// First free path for `name` in `dir` (`name (1).ts`, ...).
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, "ts"));
    (1..1000)
        .map(|i| dir.join(format!("{stem} ({i}).{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// `mpv.record`: starts or stops writing the playing stream to disk.
pub async fn record(state: &Arc<AppState>, start: bool) -> CoreResult<RecordResult> {
    ensure_platform()?;
    let mgr = manager(state);
    let _op = mgr.op.lock().await;
    let s = current(&mgr).ok_or_else(not_attached)?;
    let st = s.client.state();
    if !start {
        if st.recording {
            stop_recording(&s).await;
            tracing::info!("recording stopped");
        }
        return Ok(RecordResult {
            recording: false,
            path: None,
        });
    }
    if st.recording {
        return Ok(RecordResult {
            recording: true,
            path: st.record_path,
        });
    }
    if !st.loaded {
        return Err(CoreError::Conflict(
            "Nothing is playing in the embedded player, so there is nothing to record.".into(),
        ));
    }
    let dir = recordings_dir(state);
    let title = s.title.lock().clone();
    let path = {
        let target = dir.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<PathBuf> {
            std::fs::create_dir_all(&target)?;
            Ok(unique_path(
                &target,
                &recording_file_name(&title, chrono::Local::now()),
            ))
        })
        .await?
        .map_err(|e| {
            CoreError::Io(std::io::Error::new(
                e.kind(),
                format!("cannot create the recordings folder {}: {e}", dir.display()),
            ))
        })?
    };
    s.client.command(stream_record_command(Some(&path))).await?;
    let shown = path.display().to_string();
    s.client.update_state(|st| {
        st.recording = true;
        st.record_path = Some(shown.clone());
    });
    tracing::info!(dir = %dir.display(), "recording started");
    Ok(RecordResult {
        recording: true,
        path: Some(shown),
    })
}

async fn stop_recording(s: &Session) {
    if let Err(e) = s.client.command(stream_record_command(None)).await {
        tracing::warn!(error = %e, "stopping the recording failed");
    }
    s.client.update_state(|st| {
        st.recording = false;
        st.record_path = None;
    });
}

/// `mpv.setProperty`.
pub async fn set_property(state: &Arc<AppState>, name: &str, value: Value) -> CoreResult<()> {
    ensure_platform()?;
    validate_property(name)?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    s.client.set_property(name.trim(), value).await
}

/// `mpv.setBounds`.
pub async fn set_bounds(state: &Arc<AppState>, bounds: Bounds) -> CoreResult<()> {
    ensure_platform()?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    set_window_bounds(&s.factory, s.hwnd, bounds).await
}

/// `mpv.detach`: asks mpv to quit, kills it after 2 s, destroys the window.
/// Idempotent.
pub async fn detach(state: &Arc<AppState>) -> CoreResult<()> {
    ensure_platform()?;
    let mgr = manager(state);
    let _op = mgr.op.lock().await;
    let Some(s) = current(&mgr) else {
        return Ok(());
    };
    s.detaching.store(true, Ordering::SeqCst);
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        s.client.command(vec![json!("quit")]),
    )
    .await;
    teardown(state, &mgr, &s, None, false).await;
    tracing::info!(pid = s.pid, "embedded mpv detached");
    Ok(())
}

/// Async shutdown for app exit: same as `mpv.detach`, ignoring errors.
pub async fn shutdown(state: &Arc<AppState>) {
    if cfg!(windows) {
        let _ = detach(state).await;
    }
}

/// Synchronous last-resort cleanup for app exit (no runtime needed): kills
/// the embedded mpv process so it never outlives the app.
pub fn kill_embedded(state: &AppState) {
    let Some(mgr) = state.ext::<MpvManager>(MPV_EXT_KEY) else {
        return;
    };
    let session = mgr.session.lock().take();
    if let Some(s) = session {
        s.detaching.store(true, Ordering::SeqCst);
        let _ = s.child.lock().start_kill();
        s.client.shutdown();
        s.stop_tasks(false);
    }
}

/// Stops the process (grace period, then kill), the IPC client, the tasks,
/// and the window; records the final detached state and emits it. `error`
/// marks an unexpected stop; `from_watcher` is true when the session's own
/// watcher task runs the teardown (it must not abort itself).
async fn teardown(
    state: &Arc<AppState>,
    mgr: &MpvManager,
    s: &Arc<Session>,
    error: Option<String>,
    from_watcher: bool,
) {
    s.detaching.store(true, Ordering::SeqCst);
    if !wait_exit(s, QUIT_GRACE).await {
        let _ = s.child.lock().start_kill();
        if !wait_exit(s, Duration::from_secs(2)).await {
            tracing::warn!(pid = s.pid, "embedded mpv did not exit after kill");
        }
    }
    let mut final_state = s.client.state();
    s.client.shutdown();
    s.stop_tasks(from_watcher);
    destroy_window(&s.factory, s.hwnd).await;

    final_state.attached = false;
    final_state.loaded = false;
    final_state.paused = true;
    final_state.time_pos = 0.0;
    final_state.duration = None;
    final_state.tracks.clear();
    final_state.fullscreen = false;
    final_state.recording = false;
    final_state.record_path = None;
    final_state.error = error;
    *mgr.last.lock() = final_state.clone();
    {
        let mut cur = mgr.session.lock();
        if cur.as_ref().is_some_and(|c| c.id == s.id) {
            *cur = None;
        }
    }
    state.emit("mpv.state", final_state);
}

async fn wait_exit(s: &Session, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if s.exited() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Watches for mpv exiting (or its pipe closing) without a detach and turns
/// it into an error state plus a full teardown.
async fn watch_session(state: Arc<AppState>, s: Arc<Session>) {
    loop {
        tokio::select! {
            _ = s.client.closed() => {}
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
        }
        if s.detaching.load(Ordering::SeqCst) {
            return;
        }
        if s.client.is_closed() {
            // The pipe usually closes a moment before the exit is visible;
            // give the process a second so the error carries its exit code.
            wait_exit(&s, Duration::from_secs(1)).await;
            if s.detaching.load(Ordering::SeqCst) {
                return;
            }
        }
        let status = s.child.lock().try_wait();
        let reason = match status {
            Ok(Some(st)) => Some(match st.code() {
                Some(code) => format!("mpv stopped unexpectedly (exit code {code}). Start playback again to restart it."),
                None => "mpv stopped unexpectedly. Start playback again to restart it.".to_string(),
            }),
            Ok(None) if s.client.is_closed() => {
                Some("Lost the connection to mpv. Start playback again to restart it.".to_string())
            }
            Ok(None) => None,
            Err(e) => Some(format!("mpv could not be monitored ({e}). Start playback again.")),
        };
        if let Some(reason) = reason {
            tracing::warn!(pid = s.pid, "embedded mpv stopped without detach");
            let mgr = manager(&state);
            // Let a concurrent attach/detach finish first; it may already
            // have torn this session down.
            let _op = mgr.op.lock().await;
            if s.detaching.swap(true, Ordering::SeqCst) {
                return;
            }
            teardown(&state, &mgr, &s, Some(reason), true).await;
            return;
        }
    }
}

async fn set_window_bounds(
    factory: &Arc<dyn ChildWindowFactory>,
    hwnd: isize,
    bounds: Bounds,
) -> CoreResult<()> {
    let f = Arc::clone(factory);
    tokio::task::spawn_blocking(move || f.set_bounds(hwnd, bounds)).await?
}

async fn destroy_window(factory: &Arc<dyn ChildWindowFactory>, hwnd: isize) {
    let f = Arc::clone(factory);
    match tokio::task::spawn_blocking(move || f.destroy(hwnd)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(error = %e, "destroying the mpv window failed"),
        Err(e) => tracing::warn!(error = %e, "destroying the mpv window panicked"),
    }
}

#[cfg(windows)]
mod platform {
    use crate::error::{CoreError, CoreResult};
    use std::path::Path;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ERROR_PIPE_BUSY: i32 = 231;

    /// Spawns mpv and connects to its IPC pipe.
    pub async fn start(
        mpv: &Path,
        args: &[String],
        pipe: &str,
    ) -> CoreResult<(tokio::process::Child, NamedPipeClient)> {
        evict_stale_server(pipe).await;

        let mut cmd = tokio::process::Command::new(mpv);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW);
        if let Some(dir) = mpv.parent().filter(|d| !d.as_os_str().is_empty()) {
            cmd.current_dir(dir);
        }
        let mut child = cmd.spawn().map_err(|e| {
            CoreError::Io(std::io::Error::new(
                e.kind(),
                format!("could not start mpv ({}): {e}", mpv.display()),
            ))
        })?;
        if let Some(handle) = child.raw_handle() {
            if let Err(e) = job::assign(handle) {
                tracing::warn!(error = %e, "could not tie embedded mpv to the app's lifetime");
            }
        }

        match connect(pipe, &mut child, super::PIPE_CONNECT_TIMEOUT).await {
            Ok(client) => Ok((child, client)),
            Err(e) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                Err(e)
            }
        }
    }

    async fn connect(
        pipe: &str,
        child: &mut tokio::process::Child,
        limit: Duration,
    ) -> CoreResult<NamedPipeClient> {
        let started = Instant::now();
        loop {
            match ClientOptions::new().open(pipe) {
                Ok(c) => return Ok(c),
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotFound
                        || e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {}
                Err(e) => return Err(CoreError::Io(e)),
            }
            if let Ok(Some(status)) = child.try_wait() {
                let code = status
                    .code()
                    .map(|c| format!(" (exit code {c})"))
                    .unwrap_or_default();
                return Err(CoreError::Other(anyhow::anyhow!(
                    "mpv exited during startup{code}. Check the mpv build in vendor\\mpv or the extra mpv arguments in Settings > Players."
                )));
            }
            if started.elapsed() >= limit {
                return Err(CoreError::Timeout(
                    "mpv started but its control pipe did not open within 5 s".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// A kill-on-close Job Object that holds embedded mpv. Its handle is
    /// never closed, so Windows closes it when this process ends, however it
    /// ends (crash, Task Manager), and that kills mpv with it.
    pub mod job {
        use std::ffi::c_void;
        use std::sync::OnceLock;

        const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

        #[repr(C)]
        #[derive(Default)]
        struct BasicLimitInformation {
            per_process_user_time_limit: i64,
            per_job_user_time_limit: i64,
            limit_flags: u32,
            minimum_working_set_size: usize,
            maximum_working_set_size: usize,
            active_process_limit: u32,
            affinity: usize,
            priority_class: u32,
            scheduling_class: u32,
        }

        #[repr(C)]
        #[derive(Default)]
        struct IoCounters {
            counters: [u64; 6],
        }

        #[repr(C)]
        #[derive(Default)]
        struct ExtendedLimitInformation {
            basic: BasicLimitInformation,
            io: IoCounters,
            process_memory_limit: usize,
            job_memory_limit: usize,
            peak_process_memory_used: usize,
            peak_job_memory_used: usize,
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
            fn SetInformationJobObject(
                job: *mut c_void,
                class: i32,
                info: *const c_void,
                len: u32,
            ) -> i32;
            fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        }

        /// The job handle as an integer (raw pointers are not `Sync`).
        static JOB: OnceLock<Option<usize>> = OnceLock::new();

        fn job() -> Option<*mut c_void> {
            let h = JOB.get_or_init(|| {
                // SAFETY: null attributes and name are allowed; the returned
                // handle is checked before use and intentionally never closed.
                let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
                if h.is_null() {
                    return None;
                }
                let info = ExtendedLimitInformation {
                    basic: BasicLimitInformation {
                        limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                // SAFETY: `info` is a valid JOBOBJECT_EXTENDED_LIMIT_INFORMATION
                // (repr(C), same layout) that outlives the call.
                let ok = unsafe {
                    SetInformationJobObject(
                        h,
                        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                        (&info as *const ExtendedLimitInformation).cast(),
                        std::mem::size_of::<ExtendedLimitInformation>() as u32,
                    )
                };
                (ok != 0).then_some(h as usize)
            });
            h.map(|h| h as *mut c_void)
        }

        /// Puts the process behind `process` into the kill-on-close job.
        pub fn assign(process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
            let Some(job) = job() else {
                return Err(std::io::Error::last_os_error());
            };
            // SAFETY: `job` is a live job handle and `process` a live process
            // handle owned by the caller's `Child`.
            if unsafe { AssignProcessToJobObject(job, process) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    /// A previous mpv of this process that survived a kill would still own
    /// the pipe name; ask it to quit so we never talk to the wrong instance.
    async fn evict_stale_server(pipe: &str) {
        use tokio::io::AsyncWriteExt;
        let Ok(mut stale) = ClientOptions::new().open(pipe) else {
            return;
        };
        tracing::warn!("a stale embedded mpv owned the IPC pipe; asking it to quit");
        let _ = stale.write_all(b"{\"command\":[\"quit\"]}\n").await;
        drop(stale);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && ClientOptions::new().open(pipe).is_ok() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use crate::error::{CoreError, CoreResult};
    use std::path::Path;

    /// Embedded mpv is Windows-only; this is never reached because
    /// `ensure_platform` fails first.
    pub async fn start(
        _mpv: &Path,
        _args: &[String],
        _pipe: &str,
    ) -> CoreResult<(tokio::process::Child, tokio::io::DuplexStream)> {
        Err(CoreError::Unsupported(
            "embedded mpv is only available on Windows".into(),
        ))
    }
}
