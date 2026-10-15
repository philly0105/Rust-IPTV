//! `screenshot.*` RPC commands (Run 3 contract C6), all desktop-only: in
//! server mode every command answers `unsupported` before its arguments are
//! looked at (the web UI downloads the frame instead). Each handler therefore
//! takes the raw JSON and parses it only after [`ensure_desktop`], so a
//! malformed call is `unsupported` too, and a `screenshot.save` payload is
//! never decoded into its arguments.

use super::ImageFormat;
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

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

/// The args of `name`, parsed once the desktop check has passed. Missing
/// args (`null`) count as `{}`, as the router's own parsing does, so the
/// commands whose fields are all optional accept them.
fn parse<A: DeserializeOwned>(name: &str, args: Value) -> Result<A, RpcError> {
    let args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args
    };
    serde_json::from_value(args)
        .map_err(|e| RpcError::invalid(format!("invalid arguments for {name}: {e}")))
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
    r.add("screenshot.save", |state, args: Value| async move {
        ensure_desktop(&state)?;
        let a: SaveArgs = parse("screenshot.save", args)?;
        Ok::<_, RpcError>(super::save(&state, a.data_base64, a.format, a.title).await?)
    });

    r.add("screenshot.mpv", |state, args: Value| async move {
        ensure_desktop(&state)?;
        let a: MpvArgs = parse("screenshot.mpv", args)?;
        let with_subtitles = a.with_subtitles.unwrap_or(true);
        Ok::<_, RpcError>(super::mpv(&state, a.title.as_deref(), with_subtitles).await?)
    });

    r.add("screenshot.open", |state, args: Value| async move {
        ensure_desktop(&state)?;
        let a: OpenArgs = parse("screenshot.open", args)?;
        let path = super::validate_open_path(&state, &a.path)?;
        crate::rpc::app::open_with_os(&path)
    });

    r.add("screenshot.reveal", |state, args: Value| async move {
        ensure_desktop(&state)?;
        let a: RevealArgs = parse("screenshot.reveal", args)?;
        super::reveal(&state, a.path.as_deref()).await?;
        Ok::<_, RpcError>(())
    });
}
