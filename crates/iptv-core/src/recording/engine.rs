//! Recording engines: a headless mpv with `--stream-record`, or a direct
//! HTTP copy for plain TS/HTTP streams when mpv is not available.
//!
//! An engine writes one part file and returns when the stream ends, fails,
//! the stop time passes, or the stop signal fires. Retrying with a new part
//! is the caller's job ([`super::run`]).

use crate::error::{CoreError, CoreResult};
use crate::model::{PlayerKind, PlayerSource, SourceKind};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

/// `AppState.extensions` key of a forced engine (tests).
const FORCED_KEY: &str = "recording_forced_engine";

/// Which program writes the recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Engine {
    Mpv(PathBuf),
    Http,
}

impl Engine {
    pub fn name(&self) -> &'static str {
        match self {
            Engine::Mpv(_) => "mpv",
            Engine::Http => "http",
        }
    }
}

/// Engine override for tests: `Some(Engine::Http)` records over HTTP even
/// when mpv is installed.
#[derive(Debug, Clone)]
pub struct ForcedEngine(pub Option<Engine>);

/// Forces an engine for every later recording (tests only need this).
pub fn force_engine(state: &AppState, engine: Option<Engine>) {
    state.set_ext(FORCED_KEY, Arc::new(ForcedEngine(engine)));
}

/// The mpv the player would use, when one is found.
pub fn mpv_path(state: &AppState) -> Option<PathBuf> {
    if let Some(forced) = state.ext::<ForcedEngine>(FORCED_KEY) {
        return match &forced.0 {
            Some(Engine::Mpv(p)) => Some(p.clone()),
            _ => None,
        };
    }
    crate::player::detect(&state.settings_snapshot())
        .mpv_path
        .map(PathBuf::from)
}

/// True for a stream the HTTP copy can record: an http(s) URL that is not
/// an HLS or DASH manifest.
pub fn is_plain_http(source: &PlayerSource) -> bool {
    let url = source.url.trim();
    let lower = url.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or("");
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && !matches!(source.kind, PlayerKind::Hls | PlayerKind::Dash)
        && !path.ends_with(".m3u8")
        && !path.ends_with(".m3u")
        && !path.ends_with(".mpd")
}

/// An Xtream live URL can be asked for as MPEG-TS instead of HLS
/// (`.../live/u/p/1.m3u8` -> `.../live/u/p/1.ts`), which the HTTP copy can
/// record.
pub fn xtream_ts_variant(source: &PlayerSource, kind: SourceKind) -> Option<PlayerSource> {
    if kind != SourceKind::Xtream {
        return None;
    }
    let (base, query) = match source.url.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (source.url.as_str(), None),
    };
    let stem = base.strip_suffix(".m3u8")?;
    if !stem.contains("/live/") {
        return None;
    }
    let mut out = source.clone();
    out.url = match query {
        Some(q) => format!("{stem}.ts?{q}"),
        None => format!("{stem}.ts"),
    };
    out.kind = PlayerKind::Direct;
    Some(out)
}

/// Message for a stream no engine can record.
pub const ENGINE_MISSING_MESSAGE: &str = "Recording this stream needs mpv. Install mpv or set its path in Settings > Player, then schedule the recording again.";

/// Picks the engine for `source`: mpv when found, else the HTTP copy for
/// plain streams (an Xtream HLS URL is swapped for its TS variant), else
/// `engine_missing`. Returns the source to record.
pub fn choose(
    state: &AppState,
    source: PlayerSource,
    kind: SourceKind,
) -> CoreResult<(Engine, PlayerSource)> {
    let forced = state
        .ext::<ForcedEngine>(FORCED_KEY)
        .and_then(|f| f.0.clone());
    if let Some(Engine::Http) = forced {
        return Ok((
            Engine::Http,
            xtream_ts_variant(&source, kind).unwrap_or(source),
        ));
    }
    if let Some(mpv) = mpv_path(state) {
        return Ok((Engine::Mpv(mpv), source));
    }
    if is_plain_http(&source) {
        return Ok((Engine::Http, source));
    }
    if let Some(ts) = xtream_ts_variant(&source, kind) {
        return Ok((Engine::Http, ts));
    }
    Err(CoreError::EngineMissing(ENGINE_MISSING_MESSAGE.into()))
}

/// Server mode: the fetch guard the stream proxy and downloads use
/// ([`crate::http::check_fetch`], trusting only the source's own
/// `host:port`), so a browser client cannot make the server record from
/// `file:`, `udp:`, `rtsp:` or a private address. mpv does not go through
/// the guarded resolver, so a host name is also resolved now and refused
/// when any of its addresses is not public (unless it is the source's own
/// host or the server allows private addresses). No-op on the desktop.
pub async fn check_server_target(state: &AppState, url: &str, source_id: &str) -> CoreResult<()> {
    let Some(mode) = crate::http::server_mode(state) else {
        return Ok(());
    };
    let trusted = crate::http::source_authority(state, source_id)
        .await
        .ok()
        .flatten();
    crate::http::check_fetch(state, url, trusted.as_ref()).await?;
    if mode.guard.allow_private {
        return Ok(());
    }
    let parsed = url::Url::parse(url.trim())
        .map_err(|_| CoreError::Invalid("The address is not a valid URL.".into()))?;
    let Some(auth) = crate::http::Authority::of(&parsed) else {
        return Ok(());
    };
    if trusted.as_ref() == Some(&auth) || !matches!(parsed.host(), Some(url::Host::Domain(_))) {
        return Ok(());
    }
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((auth.host.as_str(), auth.port))
        .await
        .map(Iterator::collect)
        .unwrap_or_default();
    if addrs.is_empty() || addrs.iter().any(|a| !crate::http::is_public_ip(a.ip())) {
        return Err(CoreError::Invalid(format!(
            "Refusing to record from {auth}: it does not resolve only to public addresses."
        )));
    }
    Ok(())
}

/// How one part ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartEnd {
    /// The stop signal fired or the stop time passed.
    pub stopped: bool,
    /// Why the stream ended early, when it did.
    pub error: Option<String>,
}

/// Arguments for the headless recording mpv. The URL is validated by the
/// caller; `--` keeps it from being read as an option.
pub fn mpv_args(source: &PlayerSource, path: &Path, pipe: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--no-config".to_string(),
        "--no-terminal".to_string(),
        "--really-quiet".to_string(),
        "--idle=no".to_string(),
        "--keep-open=no".to_string(),
        "--force-window=no".to_string(),
        "--vo=null".to_string(),
        "--ao=null".to_string(),
        "--hwdec=no".to_string(),
        "--network-timeout=20".to_string(),
        format!("--stream-record={}", path.display()),
    ];
    if let Some(pipe) = pipe {
        args.push(format!("--input-ipc-server={pipe}"));
    }
    if let Some(h) = &source.headers {
        if let Some(ua) = h
            .user_agent
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            args.push(format!("--user-agent={ua}"));
        }
        if let Some(r) = h
            .referrer
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            args.push(format!("--referrer={r}"));
        }
    }
    if let Some(fields) = crate::player::args::mpv_header_fields(source.headers.as_ref()) {
        args.push(format!("--http-header-fields={fields}"));
    }
    args.push("--".to_string());
    args.push(source.url.trim().to_string());
    args
}

/// What a non-success answer to the stream request means, in words the
/// user can act on.
pub fn status_message(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        404 | 410 => super::STREAM_NOT_FOUND_MESSAGE,
        408 | 504 => super::STREAM_NO_ANSWER_MESSAGE,
        429 | 500..=599 => super::STREAM_SERVER_ERROR_MESSAGE,
        _ => super::STREAM_REJECTED_MESSAGE,
    }
}

/// Free space below this on the recordings disk reads as a full disk.
const LOW_DISK_BYTES: u64 = 32 * 1024 * 1024;

/// Free bytes on the disk holding `dir` (`None` when unknown).
#[cfg(windows)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            dir: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free = 0u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; `free` is a
    // valid out pointer and the other two may be null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
}

/// True for a write error that means the disk is full.
fn disk_full(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::StorageFull
}

/// Why a part that wrote nothing (or almost nothing) failed, when the disk,
/// the address or the provider is the cause: checks the free space of
/// `dir`, then asks for the stream once with the recording's client and
/// headers. `None` keeps the engine's own message (the address answers
/// with something that looks like a stream).
pub async fn diagnose(
    state: &Arc<AppState>,
    source: &PlayerSource,
    source_id: &str,
    dir: &Path,
) -> Option<&'static str> {
    if free_bytes(dir).is_some_and(|f| f < LOW_DISK_BYTES) {
        return Some(super::DISK_FULL_MESSAGE);
    }
    let url = source.url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    if crate::http::is_server_mode(state) {
        let trusted = crate::http::source_authority(state, source_id)
            .await
            .ok()
            .flatten();
        crate::http::check_fetch(state, url, trusted.as_ref())
            .await
            .ok()?;
    }
    let client = crate::http::source_client(state, source_id).await;
    let req = crate::http::apply_source_headers(
        client.get(url),
        &source.headers.clone().unwrap_or_default(),
    );
    match crate::http::send(req).await {
        Ok(resp) if resp.status().is_success() => {
            is_web_page(&resp).then_some(super::NOT_A_STREAM_MESSAGE)
        }
        Ok(resp) => Some(status_message(resp.status())),
        Err(CoreError::Timeout(_) | CoreError::Network(_)) => Some(super::STREAM_NO_ANSWER_MESSAGE),
        Err(_) => None,
    }
}

fn content_type(resp: &reqwest::Response) -> String {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_web_page(resp: &reqwest::Response) -> bool {
    content_type(resp).starts_with("text/html")
}

/// Waits for the stop signal (or for its sender to go away).
async fn stop_signal(stop: &mut watch::Receiver<bool>) {
    loop {
        if *stop.borrow_and_update() {
            return;
        }
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// Records `source` into `path` until `until` or the stop signal.
pub async fn record_part(
    state: &Arc<AppState>,
    engine: &Engine,
    source: &PlayerSource,
    source_id: &str,
    path: &Path,
    until: Instant,
    stop: &mut watch::Receiver<bool>,
) -> PartEnd {
    match engine {
        Engine::Mpv(mpv) => run_mpv(mpv, source, path, until, stop).await,
        Engine::Http => run_http(state, source, source_id, path, until, stop).await,
    }
}

/// Unique IPC pipe name for one recording mpv.
#[cfg(windows)]
fn pipe_name() -> String {
    format!(
        r"\\.\pipe\tsrust-iptv-rec-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    )
}

async fn run_mpv(
    mpv: &Path,
    source: &PlayerSource,
    path: &Path,
    until: Instant,
    stop: &mut watch::Receiver<bool>,
) -> PartEnd {
    #[cfg(windows)]
    let pipe = Some(pipe_name());
    #[cfg(not(windows))]
    let pipe: Option<String> = None;
    let args = mpv_args(source, path, pipe.as_deref());
    let mut cmd = tokio::process::Command::new(mpv);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(dir) = mpv.parent().filter(|d| !d.as_os_str().is_empty()) {
        cmd.current_dir(dir);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("could not start mpv ({}): {e}", mpv.display());
            return PartEnd {
                stopped: false,
                error: Some(crate::player::spawn_error(e, msg).to_string()),
            };
        }
    };
    #[cfg(windows)]
    if let Some(handle) = child.raw_handle() {
        if let Err(e) = crate::player::embedded::job_assign(handle) {
            tracing::warn!(error = %e, "could not tie the recording mpv to the app's lifetime");
        }
    }
    let status = tokio::select! {
        s = child.wait() => Some(s),
        _ = tokio::time::sleep_until(until) => None,
        _ = stop_signal(stop) => None,
    };
    match status {
        Some(Ok(s)) => PartEnd {
            stopped: false,
            error: Some(match s.code() {
                Some(0) => "the stream ended".to_string(),
                Some(code) => format!("The stream could not be read (mpv exit code {code})."),
                None => "The stream could not be read.".to_string(),
            }),
        },
        Some(Err(e)) => PartEnd {
            stopped: false,
            error: Some(format!("lost track of mpv: {e}")),
        },
        None => {
            quit_mpv(&mut child, pipe.as_deref()).await;
            PartEnd {
                stopped: true,
                error: None,
            }
        }
    }
}

/// Asks mpv to quit over IPC (so it closes the file cleanly), then kills it
/// after 3 s.
async fn quit_mpv(child: &mut tokio::process::Child, pipe: Option<&str>) {
    #[cfg(windows)]
    if let Some(pipe) = pipe {
        use tokio::io::AsyncWriteExt;
        if let Ok(mut client) = tokio::net::windows::named_pipe::ClientOptions::new().open(pipe) {
            let _ = client.write_all(b"{\"command\":[\"quit\"]}\n").await;
        }
    }
    #[cfg(not(windows))]
    let _ = pipe;
    if tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
}

/// Longest wait for the first or next chunk of a direct stream.
const HTTP_IDLE: Duration = Duration::from_secs(20);

async fn run_http(
    state: &Arc<AppState>,
    source: &PlayerSource,
    source_id: &str,
    path: &Path,
    until: Instant,
    stop: &mut watch::Receiver<bool>,
) -> PartEnd {
    let fail = |msg: String| PartEnd {
        stopped: false,
        error: Some(msg),
    };
    let stopped = || PartEnd {
        stopped: true,
        error: None,
    };
    let url = source.url.trim().to_string();
    if crate::http::is_server_mode(state) {
        let trusted = crate::http::source_authority(state, source_id)
            .await
            .ok()
            .flatten();
        if let Err(e) = crate::http::check_fetch(state, &url, trusted.as_ref()).await {
            return fail(e.to_string());
        }
    }
    let host = url::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "the server".into());
    let client = crate::http::source_client(state, source_id).await;
    let req = crate::http::apply_source_headers(
        client.get(&url),
        &source.headers.clone().unwrap_or_default(),
    );
    let resp = tokio::select! {
        r = tokio::time::timeout(HTTP_IDLE, req.send()) => match r {
            Ok(Ok(r)) => r,
            // A redirect the server-mode guard refused says so; anything
            // else is a provider that cannot be reached.
            Ok(Err(e)) => return fail(match crate::http::transport_error(&host, e) {
                CoreError::Invalid(m) => m,
                _ => super::STREAM_NO_ANSWER_MESSAGE.to_string(),
            }),
            Err(_) => return fail(super::STREAM_NO_ANSWER_MESSAGE.to_string()),
        },
        _ = tokio::time::sleep_until(until) => return stopped(),
        _ = stop_signal(stop) => return stopped(),
    };
    if !resp.status().is_success() {
        return fail(status_message(resp.status()).to_string());
    }
    if is_web_page(&resp) {
        return fail(super::NOT_A_STREAM_MESSAGE.to_string());
    }
    let ct = content_type(&resp);
    if ct.contains("mpegurl") || ct.starts_with("text/") || ct.contains("dash+xml") {
        return fail(ENGINE_MISSING_MESSAGE.to_string());
    }
    let mut file = match tokio::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .await
    {
        Ok(f) => f,
        Err(e) if disk_full(&e) => return fail(super::DISK_FULL_MESSAGE.to_string()),
        Err(e) => return fail(format!("could not write {}: {e}", path.display())),
    };
    let mut body = resp.bytes_stream();
    use tokio::io::AsyncWriteExt;
    let end = loop {
        let chunk = tokio::select! {
            c = crate::http::next_body_chunk(&mut body, &host, HTTP_IDLE) => c,
            _ = tokio::time::sleep_until(until) => break stopped(),
            _ = stop_signal(stop) => break stopped(),
        };
        match chunk {
            Ok(Some(bytes)) => {
                if let Err(e) = file.write_all(&bytes).await {
                    break fail(if disk_full(&e) {
                        super::DISK_FULL_MESSAGE.to_string()
                    } else {
                        format!("could not write {}: {e}", path.display())
                    });
                }
            }
            Ok(None) => break fail("the stream ended".to_string()),
            Err(e) => break fail(crate::error::RpcError::from(e).message),
        }
    };
    let _ = file.flush().await;
    end
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RequestHeaders;

    fn src(url: &str, kind: PlayerKind) -> PlayerSource {
        PlayerSource {
            url: url.into(),
            kind,
            headers: None,
            title: "t".into(),
            subtitle: None,
            poster_url: None,
            item_ref: None,
            episode_id: None,
            resume_seconds: None,
            is_live: true,
            is_radio: false,
        }
    }

    #[test]
    fn plain_http_excludes_manifests() {
        assert!(is_plain_http(&src(
            "http://h/live/1.ts",
            PlayerKind::Direct
        )));
        assert!(is_plain_http(&src(
            "https://h/stream?id=1",
            PlayerKind::Direct
        )));
        assert!(!is_plain_http(&src("http://h/x.m3u8", PlayerKind::Direct)));
        assert!(!is_plain_http(&src(
            "http://h/x.M3U8?t=1",
            PlayerKind::Direct
        )));
        assert!(!is_plain_http(&src("http://h/x", PlayerKind::Hls)));
        assert!(!is_plain_http(&src("http://h/x.mpd", PlayerKind::Direct)));
        assert!(!is_plain_http(&src("rtmp://h/x", PlayerKind::Direct)));
    }

    #[test]
    fn xtream_hls_swaps_to_ts_only_for_live_xtream() {
        let s = src("http://h/live/u/p/7.m3u8", PlayerKind::Hls);
        let ts = xtream_ts_variant(&s, SourceKind::Xtream).unwrap();
        assert_eq!(ts.url, "http://h/live/u/p/7.ts");
        assert_eq!(ts.kind, PlayerKind::Direct);
        assert!(xtream_ts_variant(&s, SourceKind::M3u).is_none());
        assert!(xtream_ts_variant(
            &src("http://h/movie/u/p/7.m3u8", PlayerKind::Hls),
            SourceKind::Xtream
        )
        .is_none());
    }

    #[test]
    fn http_statuses_map_to_actionable_messages() {
        use reqwest::StatusCode as S;
        assert_eq!(
            status_message(S::NOT_FOUND),
            super::super::STREAM_NOT_FOUND_MESSAGE
        );
        assert_eq!(
            status_message(S::GONE),
            super::super::STREAM_NOT_FOUND_MESSAGE
        );
        for s in [S::UNAUTHORIZED, S::FORBIDDEN, S::BAD_REQUEST] {
            assert_eq!(status_message(s), super::super::STREAM_REJECTED_MESSAGE);
        }
        for s in [S::TOO_MANY_REQUESTS, S::SERVICE_UNAVAILABLE, S::BAD_GATEWAY] {
            assert_eq!(status_message(s), super::super::STREAM_SERVER_ERROR_MESSAGE);
        }
        assert_eq!(
            status_message(S::GATEWAY_TIMEOUT),
            super::super::STREAM_NO_ANSWER_MESSAGE
        );
        assert!(disk_full(&std::io::Error::from(
            std::io::ErrorKind::StorageFull
        )));
        assert!(!disk_full(&std::io::Error::from(
            std::io::ErrorKind::PermissionDenied
        )));
    }

    #[test]
    fn mpv_args_are_headless_and_end_with_the_url() {
        let mut s = src("http://h/live/1.ts", PlayerKind::Direct);
        s.headers = Some(RequestHeaders {
            user_agent: Some("UA/1".into()),
            referrer: Some("http://r/".into()),
            origin: Some("http://o".into()),
        });
        let args = mpv_args(&s, Path::new("C:/rec/a.ts"), Some(r"\\.\pipe\x"));
        for want in [
            "--vo=null",
            "--ao=null",
            "--idle=no",
            "--no-config",
            "--user-agent=UA/1",
            "--referrer=http://r/",
        ] {
            assert!(args.iter().any(|a| a == want), "missing {want}: {args:?}");
        }
        assert!(args.iter().any(|a| a.starts_with("--stream-record=")));
        assert!(args
            .iter()
            .any(|a| a.starts_with("--http-header-fields=Origin:")));
        assert_eq!(&args[args.len() - 2..], ["--", "http://h/live/1.ts"]);
    }
}
