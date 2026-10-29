//! Embedded mpv session (`mpv.*`).
//!
//! On Windows, `mpv.attach` creates a child HWND and starts `mpv.exe --wid`
//! with a named-pipe JSON IPC server. On macOS it creates an AppKit view and
//! uses libmpv's render API in process, bridging commands and events to the
//! same IPC client. Both backends observe the playback properties and
//! pushes throttled `mpv.state` events (4/s). A watcher task notices when mpv
//! exits on its own (crash, killed) and turns that into `state.error` plus a
//! full detach. Everything lives in one [`MpvManager`] stored in
//! `AppState.extensions["mpv"]`.
//!
//! Every operation is serialized by the manager's op lock, so attach, load,
//! and detach never interleave.

#[cfg(windows)]
use super::args::{embedded_mpv_args, mpv_pipe_name};
use super::args::{loadfile_options, UserProbeOptions};
#[cfg(windows)]
use super::detect::{find_mpv, DetectEnv};
use super::ipc::MpvClient;
use super::mpv_state::OBSERVED_PROPERTIES;
use super::stats::{MpvStats, STATS_PROPERTIES};
use super::{embedded_unavailable_reason, window_factory, Bounds, ChildWindowFactory};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, MpvState, PlayerSource};
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
#[cfg(windows)]
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long `mpv.detach` waits for mpv to quit before killing it.
const QUIT_GRACE: Duration = Duration::from_secs(2);

/// mpv's window takes the mouse over the video, so a left click there is bound
/// to this script message and comes back over IPC as `mpv.click`.
const CLICK_MESSAGE: &str = "tsrust-click";

/// IPC commands `mpv.command` accepts besides [`PROPERTY_COMMANDS`]: what
/// the player UI sends (`seek`, and `osd-overlay` for the dim under a
/// dialog's backdrop, see [`validate_osd_overlay`]) and read-only property
/// queries. Everything else is refused, including mpv's command prefixes (`no-osd`, `async`,
/// `raw`, ...), which would otherwise smuggle any command in as an argument,
/// and `keybind`, `run`, `loadfile`, `dump-cache`, `screenshot-to-file`.
/// `sub-add` is refused too: it reads any path, so it only runs through
/// `mpv.addSubtitle`, which checks the file first.
const ALLOWED_COMMANDS: &[&str] = &["seek", "get_property", "get_property_string", OSD_OVERLAY];

/// mpv's `osd-overlay`: draws ASS over the whole window (letterbox included).
const OSD_OVERLAY: &str = "osd-overlay";

/// Longest `osd-overlay` text the UI may send (one ASS drawing).
const OSD_OVERLAY_MAX: usize = 512;

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
    // subtitles:
    "sub-scale",
    "sub-color",
    "sub-back-color",
    "sub-border-style",
    "sub-border-size",
    "sub-shadow-offset",
    "sub-pos",
    "sub-ass-override",
    // picture (aspect, zoom, crop and deinterlace in the player menu):
    "video-aspect-override",
    "keepaspect",
    "panscan",
    "video-zoom",
    "deinterlace",
];

/// Subtitle style properties: their values are range-checked by
/// [`validate_property_value`], so only plain `set` commands may change them.
const STYLE_PROPERTIES: &[&str] = &[
    "sub-scale",
    "sub-color",
    "sub-back-color",
    "sub-border-style",
    "sub-border-size",
    "sub-shadow-offset",
    "sub-pos",
    "sub-ass-override",
];

/// Property commands that set a value outright (no relative change).
const SET_COMMANDS: &[&str] = &["set", "set_property", "set_property_string"];

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

/// A JSON number, or a string holding one (`set_property_string` sends
/// strings); non-finite values are refused.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

/// `#RRGGBB` or `#AARRGGBB`, the color forms mpv parses.
fn is_hex_color(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.strip_prefix('#').is_some_and(|hex| {
            (hex.len() == 6 || hex.len() == 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
        })
    })
}

/// Checks the value of a subtitle style property; other properties pass
/// unchecked. Keeps the UI's sliders and pickers inside sane ranges.
pub fn validate_property_value(name: &str, value: &Value) -> CoreResult<()> {
    let in_range = |lo: f64, hi: f64| number(value).is_some_and(|n| (lo..=hi).contains(&n));
    let one_of = |allowed: &[&str]| value.as_str().is_some_and(|s| allowed.contains(&s));
    let (ok, expected) = match name.trim() {
        "sub-scale" => (in_range(0.5, 3.0), "a number from 0.5 to 3"),
        "sub-color" | "sub-back-color" => (
            is_hex_color(value),
            "a color in the form #RRGGBB or #AARRGGBB",
        ),
        "sub-border-style" => (
            one_of(&["outline-and-shadow", "opaque-box", "background-box"]),
            "outline-and-shadow, opaque-box, or background-box",
        ),
        "sub-border-size" | "sub-shadow-offset" => (in_range(0.0, 10.0), "a number from 0 to 10"),
        "sub-pos" => (
            in_range(0.0, 150.0) && number(value).is_some_and(|n| n.fract() == 0.0),
            "a whole number from 0 to 150",
        ),
        "sub-ass-override" => (
            one_of(&["no", "yes", "scale", "force", "strip"]),
            "no, yes, scale, force, or strip",
        ),
        _ => return Ok(()),
    };
    if ok {
        Ok(())
    } else {
        Err(CoreError::invalid(format!(
            "mpv property {:?} must be {expected}.",
            name.trim()
        )))
    }
}

/// Largest subtitle file `mpv.addSubtitle` accepts.
pub const MAX_SUBTITLE_BYTES: u64 = 5 * 1024 * 1024;

/// Subtitle file extensions `mpv.addSubtitle` accepts (compared ignoring case).
pub const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "vtt", "ass", "ssa"];

/// Checks a subtitle file for `mpv.addSubtitle`: an absolute path to an
/// existing regular file with a subtitle extension, at most 5 MB. mpv's
/// `sub-add` opens whatever it is given (URLs and protocols included), so
/// only plain local files pass.
pub fn validate_subtitle_path(path: &str) -> CoreResult<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return Err(CoreError::invalid("Choose a subtitle file to add."));
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(CoreError::invalid(
            "The subtitle path must be a full path to a file, including the drive or share.",
        ));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !ext.is_some_and(|e| SUBTITLE_EXTENSIONS.contains(&e.as_str())) {
        return Err(CoreError::invalid(
            "Only .srt, .vtt, .ass, and .ssa subtitle files can be added.",
        ));
    }
    let meta = std::fs::metadata(&p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CoreError::invalid("The subtitle file was not found. Check that it still exists.")
        } else {
            CoreError::invalid(format!("The subtitle file could not be read ({e})."))
        }
    })?;
    if !meta.is_file() {
        return Err(CoreError::invalid(
            "The subtitle path is a folder, not a file. Choose a subtitle file.",
        ));
    }
    if meta.len() > MAX_SUBTITLE_BYTES {
        return Err(CoreError::invalid(
            "The subtitle file is larger than 5 MB. Choose a smaller file.",
        ));
    }
    Ok(p)
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
    child: Mutex<Option<tokio::process::Child>>,
    #[cfg(target_os = "macos")]
    native: Option<platform::NativeSession>,
    pid: u32,
    detaching: AtomicBool,
    emitter: Mutex<Option<JoinHandle<()>>>,
    /// Forwards clicks on the video as `mpv.click`.
    clicks: Mutex<Option<JoinHandle<()>>>,
    watcher: Mutex<Option<JoinHandle<()>>>,
    /// Title of the loaded item (names recordings).
    title: Mutex<String>,
    /// The live probe options the user's configuration set, read at attach.
    probe: Mutex<UserProbeOptions>,
}

impl Session {
    fn exited(&self) -> bool {
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            return !native.is_alive();
        }
        self.child
            .lock()
            .as_mut()
            .is_none_or(|child| matches!(child.try_wait(), Ok(Some(_)) | Err(_)))
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
        if let Some(t) = self.clicks.lock().take() {
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

/// Returns `Unsupported` outside Windows and macOS.
pub fn ensure_platform() -> CoreResult<()> {
    if cfg!(any(windows, target_os = "macos")) {
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
    let result = attach_locked(state, &mgr, bounds, opts).await;
    if let Err(e) = &result {
        // Every failed attach is visible to `mpv.state` polls and listeners
        // the same way (mpv missing, window or start failure, handshake).
        if current(&mgr).is_none() {
            let snapshot = {
                let mut last = mgr.last.lock();
                *last = detached_state(last.clone(), Some(e.to_string()));
                last.clone()
            };
            state.emit("mpv.state", snapshot);
        }
    }
    result
}

/// How long the attach handshake (property observers) may take in total.
const ATTACH_HANDSHAKE: Duration = Duration::from_secs(10);

/// Windows loader and image failures, as exit codes: `STATUS_DLL_NOT_FOUND`
/// (0xC0000135), `STATUS_INVALID_IMAGE_FORMAT` (0xC000007B, e.g. a 32-bit
/// DLL), `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139, a DLL of the wrong
/// version), `STATUS_DLL_INIT_FAILED` (0xC0000142) and
/// `STATUS_ILLEGAL_INSTRUCTION` (0xC000001D, a build for a newer CPU).
const LOADER_FAILURES: [i32; 5] = [
    0xC000_0135_u32 as i32,
    0xC000_007B_u32 as i32,
    0xC000_0139_u32 as i32,
    0xC000_0142_u32 as i32,
    0xC000_001D_u32 as i32,
];

/// Error for an mpv that exited before opening its control pipe. A loader
/// failure means the mpv build itself is broken or incomplete
/// (`engine_missing`); any other exit is a configuration problem the user can
/// fix (Invalid), not an app bug.
#[cfg_attr(not(windows), allow(dead_code))]
fn startup_exit_error(code: Option<i32>) -> CoreError {
    if code.is_some_and(|c| LOADER_FAILURES.contains(&c)) {
        return CoreError::EngineMissing(format!(
            "mpv could not start: a library it needs is missing or does not match (exit code {:#X}). Reinstall the mpv build in vendor\\mpv, or pick a complete mpv in Settings > Players.",
            code.unwrap_or_default() as u32
        ));
    }
    let code = code
        .map(|c| format!(" (exit code {c})"))
        .unwrap_or_default();
    CoreError::Invalid(format!(
        "mpv exited during startup{code}. Check the mpv build in vendor\\mpv or the extra mpv arguments in Settings > Players."
    ))
}

/// Reads mpv's global stream analysis options, which every source of the
/// user's configuration (`mpvArgs`, a `--profile` or `--include` in them,
/// `mpv.conf`) ends up in. Runs right after mpv starts, while it is idle:
/// during playback mpv reports the per-file values instead.
async fn read_user_probe_options(client: &MpvClient) -> UserProbeOptions {
    let (analyzeduration, lavf_o) = tokio::join!(
        client.get_property("demuxer-lavf-analyzeduration"),
        client.get_property("demuxer-lavf-o"),
    );
    UserProbeOptions::from_globals(analyzeduration.ok().as_ref(), lavf_o.ok().as_ref())
}

/// Registers the property observers, failing with a Timeout when mpv does
/// not answer within `limit` (a wedged or half-started mpv).
async fn handshake(client: &MpvClient, limit: Duration) -> CoreResult<()> {
    tokio::time::timeout(limit, client.observe(OBSERVED_PROPERTIES))
        .await
        .unwrap_or_else(|_| {
            Err(CoreError::Timeout(
                "mpv did not finish starting in time".into(),
            ))
        })
}

async fn attach_locked(
    state: &Arc<AppState>,
    mgr: &MpvManager,
    bounds: Bounds,
    opts: AttachOptions,
) -> CoreResult<MpvState> {
    if let Some(s) = current(mgr) {
        if !s.exited() && !s.client.is_closed() {
            set_window_bounds(&s.factory, s.hwnd, bounds).await?;
            return Ok(s.state());
        }
        // A dead session the watcher has not reaped yet.
        teardown(state, mgr, &s, None, false).await;
    }

    let factory = window_factory(state).ok_or_else(|| {
        CoreError::Unsupported(embedded_unavailable_reason(true, true, false).unwrap_or_default())
    })?;
    let settings = state.settings_snapshot();
    #[cfg(windows)]
    let configured = settings.mpv_path.clone();
    #[cfg(windows)]
    let mpv =
        tokio::task::spawn_blocking(move || find_mpv(configured.as_deref(), &DetectEnv::current()))
            .await?
            .ok_or_else(|| {
                CoreError::EngineMissing(
                    embedded_unavailable_reason(true, false, true).unwrap_or_default(),
                )
            })?;

    let hwnd = {
        let f = Arc::clone(&factory);
        tokio::task::spawn_blocking(move || f.create(bounds)).await??
    };

    // A fresh pipe name per session: an old mpv that survived its kill keeps
    // its pipe, and reusing the name would connect us to that process.
    let session_id = mgr.next_id.fetch_add(1, Ordering::Relaxed);
    #[cfg(windows)]
    let pipe = format!("{}-{session_id}", mpv_pipe_name(std::process::id()));
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
    #[cfg(windows)]
    let args = embedded_mpv_args(
        hwnd,
        &pipe,
        &settings.mpv_args,
        initial_volume,
        initial_muted,
    );
    #[cfg(windows)]
    let started = platform::start(&mpv, &args, &pipe)
        .await
        .map(|(child, stream)| (Some(child), stream));
    #[cfg(target_os = "macos")]
    let started = platform::start(hwnd, &settings.mpv_args, initial_volume, initial_muted)
        .await
        .map(|(native, stream)| (native, stream));
    #[cfg(not(any(windows, target_os = "macos")))]
    let started = platform::start(Path::new(""), &[], "")
        .await
        .map(|(child, stream)| (Some(child), stream));
    #[cfg(windows)]
    let (child, stream) = match started {
        Ok(v) => v,
        Err(e) => {
            destroy_window(&factory, hwnd).await;
            return Err(e);
        }
    };
    #[cfg(target_os = "macos")]
    let (native, stream) = match started {
        Ok(v) => v,
        Err(e) => {
            destroy_window(&factory, hwnd).await;
            return Err(e);
        }
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let (child, stream) = started?;
    #[cfg(windows)]
    let pid = child.as_ref().and_then(|child| child.id()).unwrap_or(0);
    #[cfg(target_os = "macos")]
    let pid = std::process::id();
    #[cfg(not(any(windows, target_os = "macos")))]
    let pid = child.as_ref().and_then(|child| child.id()).unwrap_or(0);

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
        id: session_id,
        hwnd,
        factory,
        client: Arc::clone(&client),
        child: Mutex::new({
            #[cfg(target_os = "macos")]
            {
                None
            }
            #[cfg(not(target_os = "macos"))]
            {
                child
            }
        }),
        #[cfg(target_os = "macos")]
        native: Some(native),
        pid,
        detaching: AtomicBool::new(false),
        emitter: Mutex::new(None),
        clicks: Mutex::new(None),
        watcher: Mutex::new(None),
        title: Mutex::new(String::new()),
        probe: Mutex::new(UserProbeOptions::default()),
    });

    if let Err(e) = handshake(&client, ATTACH_HANDSHAKE).await {
        teardown(
            state,
            mgr,
            &session,
            Some(format!("mpv did not accept property observers: {e}")),
            false,
        )
        .await;
        return Err(e);
    }
    let probe = read_user_probe_options(&client).await;
    *session.probe.lock() = probe;

    let emit_state = Arc::clone(state);
    let emitter = client.spawn_state_emitter(STATE_EMIT_INTERVAL, move |mut s| {
        s.attached = true;
        emit_state.emit("mpv.state", s);
    });
    let clicks = spawn_click_forwarder(Arc::clone(state), &client);
    // Older mpv builds lack `keybind`; the video then just ignores clicks.
    if let Err(e) = client
        .command(vec![
            json!("keybind"),
            json!("MBTN_LEFT"),
            json!(format!("script-message {CLICK_MESSAGE}")),
        ])
        .await
    {
        tracing::warn!(error = %e, "mpv did not accept the click binding");
    }
    let watcher = tokio::spawn(watch_session(Arc::clone(state), Arc::clone(&session)));
    *session.emitter.lock() = Some(emitter);
    *session.clicks.lock() = Some(clicks);
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
    let local = super::with_local_file(state, source).await?;
    let source = &local;
    let mgr = manager(state);
    let _op = mgr.op.lock().await;
    let s = current(&mgr).ok_or_else(not_attached)?;
    // A recording belongs to the item it started on.
    if s.client.state().recording {
        stop_recording(&s).await;
    }
    // mpv's loadfile "replace" reply can precede the old file's shutdown.
    // For a movie or episode, finish that shutdown before opening the next
    // provider stream. Live and catch-up (a channel's ref, so seeks reopen the
    // archive) keep their fast replace path. A stop that does not finish in
    // time falls back to replace rather than failing the load.
    let vod = source
        .item_ref
        .as_ref()
        .is_some_and(|r| matches!(r.content_type, ContentType::Movie | ContentType::Series));
    if vod && !source.is_live {
        if let Err(error) = stop_file(&s).await {
            tracing::warn!(%error, "embedded mpv did not close the previous stream; replacing it");
        }
    }
    *s.title.lock() = source.title.trim().to_string();
    s.client.update_state(|st| {
        st.loaded = false;
        st.error = None;
        st.time_pos = 0.0;
        st.duration = None;
        st.tracks.clear();
    });

    let opts = loadfile_options(source, *s.probe.lock());
    // mpv >= 0.38 takes `loadfile url flags index options`.
    let modern = vec![
        json!("loadfile"),
        json!(source.url),
        json!("replace"),
        json!(-1),
        Value::Object(opts.clone()),
    ];
    let loaded = match s.client.command(modern).await {
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
    };
    loaded?;
    #[cfg(target_os = "macos")]
    {
        // libmpv can retain its global pause flag when a file's `pause=no`
        // option is applied through loadfile. Set the actual property too, so
        // the observed pause state matches the playing video and controls.
        if let Err(error) = s.client.set_property("pause", json!(false)).await {
            tracing::warn!(%error, "could not clear macOS libmpv pause state after load");
        }
    }
    Ok(())
}

/// Close the current demuxer before another VOD stream is opened. `stop` is
/// asynchronous inside mpv, so its command reply alone does not establish
/// that the provider connection has gone away.
async fn stop_file(s: &Session) -> CoreResult<()> {
    let idle = s.client.get_property("idle-active").await?.as_bool() == Some(true);
    if idle {
        return Ok(());
    }
    // time-pos can become unavailable before end-file arrives. Mark the old
    // file unloaded first so UI state never saves its reset position as zero.
    s.client.update_state(|st| st.loaded = false);
    let began = std::time::Instant::now();
    s.client.command(vec![json!("stop")]).await?;
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if s.client.get_property("idle-active").await?.as_bool() == Some(true) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(CoreError::Timeout(
            "mpv did not close the previous stream in time".into(),
        ))
    });
    if closed.is_ok() {
        tracing::info!(
            elapsed_ms = began.elapsed().as_millis(),
            "embedded mpv closed previous stream"
        );
    }
    closed
}

/// Stop the current file but keep the embedded player ready for the next one.
/// Used as soon as a new movie or episode is selected, while its URL resolves.
pub async fn unload(state: &Arc<AppState>) -> CoreResult<()> {
    ensure_platform()?;
    let mgr = manager(state);
    let _op = mgr.op.lock().await;
    let Some(s) = current(&mgr) else {
        return Ok(());
    };
    if s.client.state().recording {
        stop_recording(&s).await;
    }
    stop_file(&s).await
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
/// [`SETTABLE_PROPERTIES`], with scalar arguments. Subtitle style properties
/// take only a plain set with a checked value: `add`, `multiply`, and
/// `cycle` would step past the allowed range.
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
    if name == OSD_OVERLAY {
        return validate_osd_overlay(cmd);
    }
    if PROPERTY_COMMANDS.contains(&name) {
        // `cycle-values` may lead with the `!reverse` flag.
        let prop = cmd[1..]
            .iter()
            .find(|v| v.as_str() != Some("!reverse"))
            .and_then(Value::as_str)
            .unwrap_or("");
        validate_property(prop)?;
        if STYLE_PROPERTIES.contains(&prop.trim()) {
            if !SET_COMMANDS.contains(&name) {
                return Err(CoreError::invalid(format!(
                    "mpv property {:?} can only be set to a value, not changed with {name:?}",
                    prop.trim()
                )));
            }
            match cmd {
                [_, _, value] => validate_property_value(prop, value)?,
                _ => {
                    return Err(CoreError::invalid(format!(
                        "mpv command {name:?} needs exactly one value for {:?}",
                        prop.trim()
                    )))
                }
            }
        }
    }
    Ok(())
}

/// `osd-overlay <id> <format> <data> [<res_x> <res_y> <z>]`, and nothing
/// more: an overlay id mpv accepts (0-63), ASS events or `none` (remove it),
/// one short line of ASS (no newline: a single event), and small integer
/// sizes. It only draws on mpv's own window.
fn validate_osd_overlay(cmd: &[Value]) -> CoreResult<()> {
    let ok = match cmd {
        [_, id, format, data, sizes @ ..] => {
            id.as_u64().is_some_and(|i| i < 64)
                && matches!(format.as_str(), Some("ass-events" | "none"))
                && data
                    .as_str()
                    .is_some_and(|d| d.len() <= OSD_OVERLAY_MAX && !d.contains(['\n', '\r']))
                && sizes.len() <= 3
                && sizes
                    .iter()
                    .all(|v| v.as_i64().is_some_and(|n| (0..=16384).contains(&n)))
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(CoreError::invalid(
            "osd-overlay takes an id (0-63), ass-events or none, one line of ASS, and up to three sizes",
        ))
    }
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

// screenshot:
/// The IPC command that saves the frame on screen to `path` (mpv picks the
/// format from the extension): `subtitles` includes the subtitles as shown,
/// `video` is the bare frame. It runs on the session's IPC client directly
/// ([`screenshot_to_file`]), never through `mpv.command`, whose allowlist
/// keeps refusing `screenshot-to-file`: the path is chosen by the core
/// (`crate::screenshot`), never by the caller.
pub fn screenshot_command(path: &Path, with_subtitles: bool) -> Vec<Value> {
    vec![
        json!("screenshot-to-file"),
        json!(path.display().to_string()),
        json!(if with_subtitles { "subtitles" } else { "video" }),
    ]
}

fn no_video_frame() -> CoreError {
    CoreError::Conflict(
        "There is no video frame to capture. Screenshots need a stream with video.".into(),
    )
}

/// The attached session when it shows something to capture: Conflict when
/// nothing is attached or loaded, or when mpv reports tracks but no selected
/// video track (an audio-only stream).
fn capturable_session(state: &AppState) -> CoreResult<Arc<Session>> {
    ensure_platform()?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    let st = s.client.state();
    if !st.loaded {
        return Err(CoreError::Conflict(
            "Nothing is playing in the embedded player, so there is nothing to capture.".into(),
        ));
    }
    let has_video = st
        .tracks
        .iter()
        .any(|t| t.selected && t.track_type == crate::model::MpvTrackType::Video);
    if !st.tracks.is_empty() && !has_video {
        return Err(no_video_frame());
    }
    Ok(s)
}

/// Title of the item playing in the embedded player (names screenshots;
/// may be empty). Unsupported off Windows; Conflict when no session is
/// attached, nothing is loaded, or the stream has no video.
pub fn playing_title(state: &AppState) -> CoreResult<String> {
    let s = capturable_session(state)?;
    let title = s.title.lock().clone();
    Ok(title)
}

/// Saves the current frame to `path` with [`screenshot_command`]. Does not
/// take the op lock (like `mpv.command`). mpv answers once the file is
/// written; the IPC client gives up after its reply timeout (5 s), which the
/// caller sees as Timeout while mpv may still finish the file. A failure mpv
/// reports ("error running command": no decoded frame yet, no video) is a
/// Conflict.
pub async fn screenshot_to_file(
    state: &AppState,
    path: &Path,
    with_subtitles: bool,
) -> CoreResult<()> {
    let s = capturable_session(state)?;
    match s
        .client
        .command(screenshot_command(path, with_subtitles))
        .await
    {
        Ok(_) => Ok(()),
        Err(CoreError::Invalid(reason)) => {
            tracing::warn!(%reason, "mpv could not take the screenshot");
            Err(no_video_frame())
        }
        Err(e) => Err(e),
    }
}

/// `mpv.setProperty`.
pub async fn set_property(state: &Arc<AppState>, name: &str, value: Value) -> CoreResult<()> {
    ensure_platform()?;
    validate_property(name)?;
    validate_property_value(name, &value)?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    s.client.set_property(name.trim(), value).await
}

/// `mpv.addSubtitle`: loads an external subtitle file into the playing item
/// and selects it. The path is checked before the session so a bad file is
/// Invalid even when nothing is attached.
pub async fn add_subtitle(state: &Arc<AppState>, path: &str) -> CoreResult<()> {
    ensure_platform()?;
    let path = validate_subtitle_path(path)?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    if !s.client.state().loaded {
        return Err(CoreError::Conflict(
            "Nothing is playing in the embedded player, so there is nothing to add subtitles to."
                .into(),
        ));
    }
    // The file name becomes the track title shown in the subtitle menu.
    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    s.client
        .command(vec![
            json!("sub-add"),
            json!(path.display().to_string()),
            json!("select"),
            json!(title),
        ])
        .await
        .map(|_| ())
}

/// How long `mpv.stats` waits for all of its property reads.
const STATS_TIMEOUT: Duration = Duration::from_secs(2);

/// `mpv.stats`: reads [`STATS_PROPERTIES`] once (concurrently, outside the op
/// lock, like `mpv.command`). A property mpv cannot give is left out.
pub async fn stats(state: &Arc<AppState>) -> CoreResult<MpvStats> {
    ensure_platform()?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    let reads = STATS_PROPERTIES
        .iter()
        .map(|name| s.client.get_property(name));
    let replies = tokio::time::timeout(STATS_TIMEOUT, futures::future::join_all(reads))
        .await
        .map_err(|_| CoreError::Timeout("mpv did not answer the stats request in time".into()))?;
    if s.client.is_closed() {
        return Err(not_attached());
    }
    let values: Vec<Option<Value>> = replies.into_iter().map(Result::ok).collect();
    Ok(MpvStats::from_values(&values))
}

/// `mpv.setBounds`.
pub async fn set_bounds(
    state: &Arc<AppState>,
    bounds: Bounds,
    holes: Vec<Bounds>,
) -> CoreResult<()> {
    ensure_platform()?;
    let s = current(&manager(state)).ok_or_else(not_attached)?;
    set_window_bounds(&s.factory, s.hwnd, bounds).await?;
    let f = Arc::clone(&s.factory);
    let hwnd = s.hwnd;
    tokio::task::spawn_blocking(move || f.set_holes(hwnd, holes)).await?
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
    if cfg!(any(windows, target_os = "macos")) {
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
        #[cfg(target_os = "macos")]
        if let Some(native) = &s.native {
            native.stop();
        }
        #[cfg(not(target_os = "macos"))]
        if let Some(child) = s.child.lock().as_mut() {
            let _ = child.start_kill();
        }
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
    #[cfg(target_os = "macos")]
    if let Some(native) = &s.native {
        native.stop();
    }
    if !wait_exit(s, QUIT_GRACE).await {
        #[cfg(not(target_os = "macos"))]
        if let Some(child) = s.child.lock().as_mut() {
            let _ = child.start_kill();
        }
        if !wait_exit(s, Duration::from_secs(2)).await {
            tracing::warn!(pid = s.pid, "embedded mpv did not exit after kill");
        }
    }
    let final_state = detached_state(s.client.state(), error);
    s.client.shutdown();
    s.stop_tasks(from_watcher);
    destroy_window(&s.factory, s.hwnd).await;

    *mgr.last.lock() = final_state.clone();
    {
        let mut cur = mgr.session.lock();
        if cur.as_ref().is_some_and(|c| c.id == s.id) {
            *cur = None;
        }
    }
    state.emit("mpv.state", final_state);
}

/// The state reported once a session is gone: only volume and mute carry
/// over to the next attach; everything about the dead file (position,
/// tracks, the rewind window, buffering) is cleared so the UI does not show
/// a seek bar for a stream that no longer plays.
pub fn detached_state(last: MpvState, error: Option<String>) -> MpvState {
    MpvState {
        attached: false,
        volume: last.volume,
        muted: last.muted,
        error,
        ..MpvState::default()
    }
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
/// Emits `mpv.click` for every `script-message tsrust-click` mpv sends.
fn spawn_click_forwarder(state: Arc<AppState>, client: &Arc<MpvClient>) -> JoinHandle<()> {
    let mut events = client.subscribe_events();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    if is_click_message(&ev) {
                        state.emit("mpv.click", json!({}));
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

/// True for `{"event":"client-message","args":["tsrust-click"]}`.
pub fn is_click_message(ev: &Value) -> bool {
    ev.get("event").and_then(Value::as_str) == Some("client-message")
        && ev
            .get("args")
            .and_then(|a| a.get(0))
            .and_then(Value::as_str)
            == Some(CLICK_MESSAGE)
}

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
        #[cfg(not(target_os = "macos"))]
        let status = s
            .child
            .lock()
            .as_mut()
            .map(|child| child.try_wait())
            .unwrap_or(Ok(None));
        #[cfg(target_os = "macos")]
        let status: std::io::Result<Option<std::process::ExitStatus>> = Ok(None);
        let reason = match status {
            Ok(Some(st)) => Some(match st.code() {
                Some(code) => format!("mpv stopped unexpectedly (exit code {code}). Start playback again to restart it."),
                None => "mpv stopped unexpectedly. Start playback again to restart it.".to_string(),
            }),
            Ok(None) if s.client.is_closed() => {
                Some("Lost the connection to mpv. Start playback again to restart it.".to_string())
            }
            #[cfg(target_os = "macos")]
            Ok(None) if s.exited() => Some("Embedded mpv stopped unexpectedly. Start playback again.".to_string()),
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
            let msg = format!("could not start mpv ({}): {e}", mpv.display());
            crate::player::spawn_error(e, msg)
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
                return Err(super::startup_exit_error(status.code()));
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

// recording:
/// Puts a recording mpv into the kill-on-close job that holds embedded mpv,
/// so it never outlives the app.
#[cfg(windows)]
pub fn job_assign(process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
    platform::job::assign(process)
}

#[cfg(target_os = "macos")]
mod platform {
    use crate::error::{CoreError, CoreResult};
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

    unsafe extern "C" {
        fn iptv_mpv_mac_available() -> i32;
        fn iptv_mpv_mac_session_open(
            host: *mut c_void,
            options: *const c_char,
            volume: f64,
            muted: i32,
            error: *mut *mut c_char,
        ) -> *mut c_void;
        fn iptv_mpv_mac_command(session: *mut c_void, command: *const c_char) -> *mut c_char;
        fn iptv_mpv_mac_next_event(session: *mut c_void) -> *mut c_char;
        fn iptv_mpv_mac_wait_frame(session: *mut c_void, timeout_ms: i32);
        fn iptv_mpv_mac_render(session: *mut c_void) -> i32;
        fn iptv_mpv_mac_session_close(session: *mut c_void);
        fn iptv_mpv_mac_free(text: *mut c_char);
    }

    pub fn available() -> bool {
        unsafe { iptv_mpv_mac_available() != 0 }
    }

    pub struct NativeSession {
        stop: Arc<AtomicBool>,
        alive: Arc<AtomicBool>,
    }

    impl NativeSession {
        pub fn is_alive(&self) -> bool {
            self.alive.load(Ordering::Acquire)
        }
        pub fn stop(&self) {
            self.stop.store(true, Ordering::Release);
        }
    }

    impl Drop for NativeSession {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn take_text(ptr: *mut c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        let value = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { iptv_mpv_mac_free(ptr) };
        Some(value)
    }

    pub async fn start(
        host: isize,
        user_args: &str,
        volume: f64,
        muted: bool,
    ) -> CoreResult<(NativeSession, DuplexStream)> {
        let options = serde_json::to_string(&super::super::args::split_shell_args(user_args))?;
        let options =
            CString::new(options).map_err(|_| CoreError::invalid("invalid mpv options"))?;
        let raw = tokio::task::spawn_blocking(move || {
            let mut error = std::ptr::null_mut();
            let session = unsafe {
                iptv_mpv_mac_session_open(
                    host as *mut c_void,
                    options.as_ptr(),
                    volume,
                    i32::from(muted),
                    &mut error,
                )
            };
            (session as usize, take_text(error))
        })
        .await?;
        if raw.0 == 0 {
            return Err(CoreError::EngineMissing(
                raw.1.unwrap_or_else(|| "could not start libmpv".into()),
            ));
        }
        let (client, server) = tokio::io::duplex(1024 * 1024);
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let worker_stop = Arc::clone(&stop);
        let worker_alive = Arc::clone(&alive);
        // libmpv recommends keeping its render API off the thread that calls
        // the normal client API. Software rendering can take longer than one
        // frame, and previously held up pause/volume commands and state events.
        let render_stop = Arc::clone(&stop);
        let render_raw = raw.0;
        let renderer = std::thread::Builder::new()
            .name("iptv-mpv-render".into())
            .spawn(move || {
                while !render_stop.load(Ordering::Acquire) {
                    // mpv wakes us for each new frame. The timeout checks view
                    // size while paused and bounds shutdown latency to 50 ms.
                    unsafe { iptv_mpv_mac_wait_frame(render_raw as *mut c_void, 50) };
                    if render_stop.load(Ordering::Acquire) {
                        break;
                    }
                    let _ = unsafe { iptv_mpv_mac_render(render_raw as *mut c_void) };
                }
            })
            .map_err(|error| {
                unsafe { iptv_mpv_mac_session_close(raw.0 as *mut c_void) };
                CoreError::EngineMissing(format!("could not start mpv renderer: {error}"))
            })?;
        tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut read = BufReader::new(read);
            let mut line = String::new();
            let mut tick = tokio::time::interval(Duration::from_millis(33));
            while !worker_stop.load(Ordering::Acquire) {
                tokio::select! {
                    read_result = read.read_line(&mut line) => {
                        match read_result {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                if let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) {
                                    let id = request.get("request_id").cloned().unwrap_or(serde_json::Value::Null);
                                    let args = request.get("command").cloned().unwrap_or(serde_json::Value::Null);
                                    if let Ok(command) = CString::new(args.to_string()) {
                                        let reply = take_text(unsafe { iptv_mpv_mac_command(raw.0 as *mut c_void, command.as_ptr()) });
                                        if let Some(reply) = reply.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
                                            let mut reply = reply;
                                            reply["request_id"] = id;
                                            if write.write_all(format!("{reply}\n").as_bytes()).await.is_err() { break; }
                                        }
                                    }
                                }
                                line.clear();
                            }
                        }
                    }
                    _ = tick.tick() => {
                        for _ in 0..32 {
                            let Some(event) = take_text(unsafe { iptv_mpv_mac_next_event(raw.0 as *mut c_void) }) else { break; };
                            if write.write_all(format!("{event}\n").as_bytes()).await.is_err() { break; }
                        }
                    }
                }
            }
            worker_stop.store(true, Ordering::Release);
            // The render context and mpv handle must outlive the render thread.
            // Joining here is bounded by a frame and the 50 ms wait above.
            let _ = renderer.join();
            unsafe { iptv_mpv_mac_session_close(raw.0 as *mut c_void) };
            worker_alive.store(false, Ordering::Release);
        });
        Ok((NativeSession { stop, alive }, client))
    }
}

#[cfg(target_os = "macos")]
pub fn native_available() -> bool {
    platform::available()
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use crate::error::{CoreError, CoreResult};
    use std::path::Path;

    /// Embedded mpv is unavailable on this platform; this is never reached because
    /// `ensure_platform` fails first.
    pub async fn start(
        _mpv: &Path,
        _args: &[String],
        _pipe: &str,
    ) -> CoreResult<(tokio::process::Child, tokio::io::DuplexStream)> {
        Err(CoreError::Unsupported(
            "embedded mpv is only available on Windows and macOS".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn osd_overlay_takes_only_one_short_ass_drawing() {
        use super::validate_command;
        use serde_json::json;
        let dim = "{\\an7\\pos(0,0)\\1c&H100804&\\1a&H47&\\p1}m -10 -10 l 10000 -10 10000 10000 -10 10000{\\p0}";
        assert!(validate_command(&[
            json!("osd-overlay"),
            json!(63),
            json!("ass-events"),
            json!(dim),
            json!(0),
            json!(720),
            json!(0)
        ])
        .is_ok());
        assert!(
            validate_command(&[json!("osd-overlay"), json!(63), json!("none"), json!("")]).is_ok()
        );
        // Other formats (bitmaps read from a file or memory), ids past mpv's 64, a second
        // event, oversized text, non-integer or extra arguments are refused.
        assert!(
            validate_command(&[json!("osd-overlay"), json!(63), json!("bgra"), json!("")]).is_err()
        );
        assert!(
            validate_command(&[json!("osd-overlay"), json!(64), json!("none"), json!("")]).is_err()
        );
        assert!(validate_command(&[
            json!("osd-overlay"),
            json!(1),
            json!("ass-events"),
            json!("a\nb")
        ])
        .is_err());
        assert!(validate_command(&[
            json!("osd-overlay"),
            json!(1),
            json!("ass-events"),
            json!("x".repeat(600))
        ])
        .is_err());
        assert!(validate_command(&[
            json!("osd-overlay"),
            json!(1),
            json!("ass-events"),
            json!("x"),
            json!("720")
        ])
        .is_err());
        assert!(validate_command(&[
            json!("osd-overlay"),
            json!(1),
            json!("ass-events"),
            json!("x"),
            json!(0),
            json!(720),
            json!(0),
            json!(true)
        ])
        .is_err());
        assert!(validate_command(&[json!("osd-overlay"), json!(1)]).is_err());
    }

    use super::*;

    /// Review round 2: an mpv that dies in the Windows loader (missing or
    /// mismatched DLL) is `engine_missing`; other startup exits stay Invalid.
    #[test]
    fn loader_failures_at_startup_are_engine_missing() {
        for code in [
            0xC000_0135_u32 as i32,
            0xC000_007B_u32 as i32,
            0xC000_0139_u32 as i32,
            0xC000_0142_u32 as i32,
            0xC000_001D_u32 as i32,
        ] {
            let err = startup_exit_error(Some(code));
            assert!(matches!(err, CoreError::EngineMissing(_)), "{err:?}");
            assert!(err.to_string().contains("0xC0000"), "{err}");
        }
        for code in [Some(1), Some(-1), None] {
            let err = startup_exit_error(code);
            assert!(
                matches!(err, CoreError::Invalid(ref m) if m.contains("exited during startup")),
                "{err:?}"
            );
        }
    }

    /// D14 (review round 1): an mpv that accepts the pipe but never answers
    /// fails the attach with a Timeout instead of hanging.
    #[tokio::test]
    async fn handshake_times_out_when_mpv_never_answers() {
        let (ours, _theirs) = tokio::io::duplex(64 * 1024);
        let client = MpvClient::with_timeout(ours, MpvState::default(), Duration::from_secs(60));
        let started = std::time::Instant::now();
        let err = tokio::time::timeout(
            Duration::from_secs(5),
            handshake(&client, Duration::from_millis(200)),
        )
        .await
        .expect("handshake must honor its limit")
        .unwrap_err();
        assert!(
            matches!(err, CoreError::Timeout(ref m) if m.contains("did not finish starting")),
            "{err:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// Answers each `get_property` with `globals(name)`, like an idle mpv.
    async fn fake_mpv(theirs: tokio::io::DuplexStream, globals: fn(&str) -> Option<Value>) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let (r, mut w) = tokio::io::split(theirs);
        let mut lines = tokio::io::BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let name = req["command"][1].as_str().unwrap_or_default();
            let reply = match globals(name) {
                Some(data) => {
                    json!({"data": data, "error": "success", "request_id": req["request_id"]})
                }
                None => json!({"error": "property not found", "request_id": req["request_id"]}),
            };
            w.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
        }
    }

    async fn probe_options_of(globals: fn(&str) -> Option<Value>) -> UserProbeOptions {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        tokio::spawn(fake_mpv(theirs, globals));
        let client = MpvClient::new(ours, MpvState::default());
        read_user_probe_options(&client).await
    }

    /// STR-3 review: what the user's configuration set of the live probe
    /// options is read from mpv, so a `--profile` or `--include` in mpvArgs
    /// (and mpv.conf) counts. The low-latency globals are what mpv 0.37 reports
    /// after `--profile=low-latency`; reading mpvArgs saw neither option there.
    #[tokio::test]
    async fn live_loads_keep_what_the_users_profile_set() {
        let live = PlayerSource {
            url: "http://h/live/1.ts".into(),
            kind: crate::model::PlayerKind::Direct,
            headers: None,
            title: "Live".into(),
            subtitle: None,
            poster_url: None,
            item_ref: None,
            episode_id: None,
            resume_seconds: None,
            is_live: true,
            is_radio: false,
        };

        let low_latency = probe_options_of(|name| match name {
            "demuxer-lavf-analyzeduration" => Some(json!(0.1)),
            "demuxer-lavf-o" => Some(json!({"fflags": "+nobuffer"})),
            _ => None,
        })
        .await;
        let opts = loadfile_options(&live, low_latency);
        assert!(
            !opts.contains_key("demuxer-lavf-analyzeduration"),
            "{opts:?}"
        );
        // Appended for the file, so fflags=+nobuffer stays in the list.
        assert!(!opts.contains_key("demuxer-lavf-o"), "{opts:?}");
        assert_eq!(opts["demuxer-lavf-o-append"], json!("fpsprobesize=0"));

        let defaults = probe_options_of(|name| match name {
            "demuxer-lavf-analyzeduration" => Some(json!(0.0)),
            "demuxer-lavf-o" => Some(json!({})),
            _ => None,
        })
        .await;
        assert_eq!(defaults, UserProbeOptions::default());
        let opts = loadfile_options(&live, defaults);
        assert_eq!(opts["demuxer-lavf-analyzeduration"], json!("2"));
        assert_eq!(opts["demuxer-lavf-o-append"], json!("fpsprobesize=0"));

        // An mpv that can't report them gets neither.
        let unknown = probe_options_of(|_| None).await;
        let opts = loadfile_options(&live, unknown);
        assert!(
            !opts.contains_key("demuxer-lavf-analyzeduration"),
            "{opts:?}"
        );
        assert!(!opts.contains_key("demuxer-lavf-o-append"), "{opts:?}");
    }
}
