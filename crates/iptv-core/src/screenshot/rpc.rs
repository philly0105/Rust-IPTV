//! `screenshot.*` RPC commands (Run 3 contract C6), all desktop-only: in
//! server mode every command answers `unsupported` before its arguments are
//! looked at (the web UI downloads the frame instead).

use super::ImageFormat;
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::Deserialize;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &[
    "screenshot.save",
    "screenshot.mpv",
    "screenshot.open",
    "screenshot.reveal",
];

/// [`crate::rpc::app::ensure_desktop`] with a message about screenshots.
fn ensure_desktop(state: &AppState) -> Result<(), RpcError> {
    crate::rpc::app::ensure_desktop(state).map_err(|_| {
        RpcError::unsupported("Screenshots are saved to a folder only in the desktop app.")
    })
}

/// `screenshot.save` args. No `Debug`: the image data is never logged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs {
    data_base64: String,
    format: ImageFormat,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MpvArgs {
    #[serde(default)]
    title: Option<String>,
    /// Defaults to true: the frame as the user sees it.
    #[serde(default)]
    with_subtitles: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenArgs {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevealArgs {
    #[serde(default)]
    path: Option<String>,
}

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("screenshot.save", |state, a: SaveArgs| async move {
        ensure_desktop(&state)?;
        Ok::<_, RpcError>(super::save(&state, a.data_base64, a.format, a.title).await?)
    });

    r.add("screenshot.mpv", |state, a: MpvArgs| async move {
        ensure_desktop(&state)?;
        let with_subtitles = a.with_subtitles.unwrap_or(true);
        Ok::<_, RpcError>(super::mpv(&state, a.title.as_deref(), with_subtitles).await?)
    });

    r.add("screenshot.open", |state, a: OpenArgs| async move {
        ensure_desktop(&state)?;
        let path = super::validate_open_path(&state, &a.path)?;
        crate::rpc::app::open_with_os(&path)
    });

    r.add("screenshot.reveal", |state, a: RevealArgs| async move {
        ensure_desktop(&state)?;
        super::reveal(&state, a.path.as_deref()).await?;
        Ok::<_, RpcError>(())
    });
}
