//! `downloads.*` and `myvideos.*` RPC commands (SPEC C4).

use super::StartRequest;
use crate::error::RpcError;
use crate::model::{ItemRef, RequestHeaders};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Every command this module registers, in C4 order.
pub const COMMANDS: &[&str] = &[
    "downloads.list",
    "downloads.get",
    "downloads.start",
    "downloads.pause",
    "downloads.resume",
    "downloads.cancel",
    "downloads.retry",
    "downloads.remove",
    "downloads.reveal",
    "downloads.setDir",
    "downloads.dir",
    "downloads.setPosition",
    "downloads.prioritize",
    "myvideos.list",
    "myvideos.playSource",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub episode_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    pub url: String,
    #[serde(default)]
    pub headers: Option<RequestHeaders>,
    #[serde(default)]
    pub poster_url: Option<String>,
    #[serde(default)]
    pub file_name_hint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveArgs {
    pub id: i64,
    #[serde(default)]
    pub delete_file: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDirArgs {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPositionArgs {
    pub id: i64,
    /// Seconds; fractional values from the player are rounded.
    pub position_seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirResult {
    pub path: String,
}

type S = Arc<AppState>;

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("downloads.list", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::list(&s).await?)
    });
    r.add("downloads.get", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::get(&s, a.id).await?)
    });
    r.add("downloads.start", |s: S, a: StartArgs| async move {
        let req = StartRequest {
            item_ref: Some(a.item_ref),
            episode_id: a.episode_id,
            title: a.title,
            subtitle: a.subtitle,
            url: a.url,
            headers: a.headers,
            poster_url: a.poster_url,
            file_name_hint: a.file_name_hint,
        };
        Ok::<_, RpcError>(super::start(&s, req).await?)
    });
    r.add("downloads.pause", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::pause(&s, a.id).await?)
    });
    r.add("downloads.resume", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::resume(&s, a.id).await?)
    });
    r.add("downloads.cancel", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::cancel(&s, a.id).await?)
    });
    r.add("downloads.retry", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::retry(&s, a.id).await?)
    });
    r.add("downloads.remove", |s: S, a: RemoveArgs| async move {
        Ok::<_, RpcError>(super::remove(&s, a.id, a.delete_file).await?)
    });
    r.add("downloads.reveal", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::reveal(&s, a.id).await?)
    });
    r.add("downloads.setDir", |s: S, a: SetDirArgs| async move {
        Ok::<_, RpcError>(super::set_dir(&s, &a.path).await?)
    });
    r.add("downloads.dir", |s: S, _: ()| async move {
        Ok::<_, RpcError>(DirResult {
            path: super::dir(&s).to_string_lossy().into_owned(),
        })
    });
    r.add(
        "downloads.setPosition",
        |s: S, a: SetPositionArgs| async move {
            if !a.position_seconds.is_finite() {
                return Err(RpcError::invalid("positionSeconds must be a number"));
            }
            let secs = a.position_seconds.round().max(0.0) as i64;
            Ok(super::set_position(&s, a.id, secs).await?)
        },
    );
    r.add("downloads.prioritize", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::prioritize(&s, a.id).await?)
    });
    r.add("myvideos.list", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::list_completed(&s).await?)
    });
    r.add("myvideos.playSource", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::play_source(&s, a.id).await?)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_every_c4_command() {
        let mut r = RpcRouter::new();
        register(&mut r);
        for name in COMMANDS {
            assert!(r.contains(name), "{name} not registered");
        }
        assert_eq!(r.names().len(), COMMANDS.len());
    }
}
