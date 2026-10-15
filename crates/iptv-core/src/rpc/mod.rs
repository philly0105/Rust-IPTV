//! RPC router (SPEC C1).
//!
//! Every command is `"<module>.<verb>"` (C4). Modules expose
//! `pub fn register(r: &mut RpcRouter)` at `crate::<module>::rpc::register` and,
//! when they need a background runtime, `pub async fn init(state)`.
//! The Tauri `rpc` command and the server's `POST /api/rpc/{cmd}` both call
//! [`RpcRouter::dispatch`].

pub mod app;

use crate::error::{CoreResult, RpcError};
use crate::state::AppState;
use futures::future::BoxFuture;
use futures::FutureExt;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

/// Result of a dispatched command: JSON value or `RpcError`.
pub type RpcResult = Result<serde_json::Value, RpcError>;

/// Type-erased handler.
pub type Handler =
    Arc<dyn Fn(Arc<AppState>, serde_json::Value) -> BoxFuture<'static, RpcResult> + Send + Sync>;

/// Name -> handler table.
#[derive(Default, Clone)]
pub struct RpcRouter {
    handlers: HashMap<&'static str, Handler>,
}

/// Deserializes args. `null` / missing args also try `{}` (structs whose fields
/// are all optional with `#[serde(default)]`), and `{}` also tries `null`
/// (handlers taking `()`).
fn parse_args<A: DeserializeOwned>(name: &str, args: serde_json::Value) -> Result<A, RpcError> {
    let fallback = match &args {
        serde_json::Value::Null => Some(serde_json::Value::Object(Default::default())),
        serde_json::Value::Object(m) if m.is_empty() => Some(serde_json::Value::Null),
        _ => None,
    };
    match serde_json::from_value::<A>(args) {
        Ok(a) => Ok(a),
        Err(first) => match fallback.map(serde_json::from_value::<A>) {
            Some(Ok(a)) => Ok(a),
            _ => Err(RpcError::invalid(format!(
                "invalid arguments for {name}: {first}"
            ))),
        },
    }
}

impl RpcRouter {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// Registers a typed handler. Args deserialize from the JSON payload (see
    /// [`parse_args`] for `null` handling); the result serializes to JSON.
    /// Registering the same name twice panics: names are a contract.
    pub fn add<A, R, F, Fut>(&mut self, name: &'static str, f: F)
    where
        A: DeserializeOwned + Send + 'static,
        R: Serialize + 'static,
        F: Fn(Arc<AppState>, A) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, RpcError>> + Send + 'static,
    {
        let f = Arc::new(f);
        let handler: Handler = Arc::new(move |state, args| {
            let f = Arc::clone(&f);
            async move {
                let parsed: A = parse_args(name, args)?;
                let out = f(state, parsed).await?;
                serde_json::to_value(out).map_err(|e| {
                    RpcError::internal(format!("failed to encode result of {name}: {e}"))
                })
            }
            .boxed()
        });
        if self.handlers.insert(name, handler).is_some() {
            panic!("rpc command registered twice: {name}");
        }
    }

    /// Runs a command. Unknown names return `NotFound`; a panicking handler
    /// returns `Internal` instead of tearing down the caller. Args are never logged.
    pub async fn dispatch(
        &self,
        state: Arc<AppState>,
        cmd: &str,
        args: serde_json::Value,
    ) -> RpcResult {
        let Some(handler) = self.handlers.get(cmd).cloned() else {
            tracing::warn!(cmd, "unknown rpc command");
            return Err(RpcError::not_found(format!("unknown command: {cmd}")));
        };
        let started = Instant::now();
        let result = match AssertUnwindSafe(handler(state, args)).catch_unwind().await {
            Ok(r) => r,
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "handler panicked".to_string());
                tracing::error!(cmd, panic = %msg, "rpc handler panicked");
                Err(RpcError::internal(format!("{cmd} failed unexpectedly")))
            }
        };
        let ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(_) => tracing::debug!(cmd, ms, "rpc ok"),
            Err(e) => tracing::warn!(cmd, ms, code = ?e.code, message = %e.message, "rpc error"),
        }
        result
    }

    /// Registered command names, sorted.
    pub fn names(&self) -> Vec<&'static str> {
        let mut v: Vec<_> = self.handlers.keys().copied().collect();
        v.sort_unstable();
        v
    }

    /// True when `name` is registered.
    pub fn contains(&self, name: &str) -> bool {
        self.handlers.contains_key(name)
    }
}

/// Registers each name as a placeholder that answers `unsupported`
/// ("`<name>` is not implemented yet") for any args. Wave 0 of a run uses it
/// so every new command is in the router (and in the `RPC_COMMANDS` parity
/// test) before its module lands. A builder replaces a stub by dropping the
/// name from the list and registering the real handler with [`RpcRouter::add`]
/// (registering both panics, like any duplicate name).
pub fn add_stubs(r: &mut RpcRouter, names: &[&'static str]) {
    for &name in names {
        r.add(name, move |_state, _args: serde_json::Value| async move {
            Err::<(), _>(RpcError::unsupported(format!(
                "{name} is not implemented yet"
            )))
        });
    }
}

/// Builds the full router: every C4 command of every module.
pub fn build_router() -> RpcRouter {
    let mut r = RpcRouter::new();
    app::register(&mut r);
    crate::sources::rpc::register(&mut r);
    crate::catalog::rpc::register(&mut r);
    crate::m3u::rpc::register(&mut r);
    crate::userstate::rpc::register(&mut r);
    crate::settings::rpc::register(&mut r);
    crate::backup::rpc::register(&mut r);
    crate::xtream::rpc::register(&mut r);
    crate::stalker::rpc::register(&mut r);
    crate::epg::rpc::register(&mut r);
    crate::downloads::rpc::register(&mut r);
    crate::tmdb::rpc::register(&mut r);
    crate::remote::rpc::register(&mut r);
    crate::player::rpc::register(&mut r);
    // failover:
    crate::live::rpc::register(&mut r);
    // account:
    crate::account::rpc::register(&mut r);
    // guide:
    crate::catchup::rpc::register(&mut r);
    // recording:
    crate::recording::rpc::register(&mut r);
    // parental:
    crate::parental::rpc::register(&mut r);
    // watchlist:
    crate::watchlist::rpc::register(&mut r);
    // channeledit: hide and rename channels (Run 2 C2).
    crate::channeledit::rpc::register(&mut r);
    // lists: custom channel lists (Run 2 C3).
    crate::lists::rpc::register(&mut r);
    // stats: watch statistics (Run 2 C7).
    crate::stats::rpc::register(&mut r);
    // imagecache: disk image cache stats and clear (Run 3 C2).
    crate::imagecache::rpc::register(&mut r);
    // screenshot: player frames to Pictures\Tsrust IPTV (Run 3 C6).
    crate::screenshot::rpc::register(&mut r);
    r
}

/// Starts module runtimes after `AppState::new`. A failing module is logged
/// and skipped so one broken subsystem does not block boot.
///
/// Order matters: the importers (m3u, xtream, stalker) register before
/// `sources` schedules the startup refresh, and `backup` runs after them so
/// pending restores find their importer.
pub async fn init_all(state: Arc<AppState>) -> CoreResult<()> {
    run_init("m3u", crate::m3u::init(state.clone())).await;
    run_init("xtream", crate::xtream::init(state.clone())).await;
    run_init("stalker", crate::stalker::init(state.clone())).await;
    run_init("sources", crate::sources::init(state.clone())).await;
    run_init("catalog", crate::catalog::init(state.clone())).await;
    run_init("userstate", crate::userstate::init(state.clone())).await;
    run_init("settings", crate::settings::init(state.clone())).await;
    run_init("backup", crate::backup::init(state.clone())).await;
    run_init("epg", crate::epg::init(state.clone())).await;
    run_init("downloads", crate::downloads::init(state.clone())).await;
    run_init("tmdb", crate::tmdb::init(state.clone())).await;
    run_init("remote", crate::remote::init(state.clone())).await;
    // recording:
    run_init("recording", crate::recording::init(state.clone())).await;
    // parental:
    run_init("parental", crate::parental::init(state.clone())).await;
    // watchlist:
    run_init("watchlist", crate::watchlist::init(state.clone())).await;
    // lists: nothing runs in the background; `sources::remove` calls
    // `lists::forget_source`, which emits `lists.changed` after the cascade.
    run_init("lists", crate::lists::init(state.clone())).await;
    // stats: prunes watch log rows older than 90 days.
    run_init("stats", crate::stats::init(state.clone())).await;
    // imagecache: loads the running byte total and reconciles rows and files
    // in the background.
    run_init("imagecache", crate::imagecache::init(state.clone())).await;
    run_init("player", crate::player::init(state)).await;
    tracing::info!("module init complete");
    Ok(())
}

/// Awaits one module init and logs (but does not propagate) its failure.
pub async fn run_init(module: &str, fut: impl Future<Output = CoreResult<()>>) {
    if let Err(err) = fut.await {
        tracing::error!(module, error = %err, "module init failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::RpcErrorCode;
    use crate::events::NoopSink;
    use serde::Deserialize;

    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "camelCase")]
    struct Opt {
        source_id: Option<String>,
    }

    async fn state() -> (tempfile::TempDir, Arc<AppState>) {
        let tmp = tempfile::tempdir().unwrap();
        let s = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        (tmp, s)
    }

    #[tokio::test]
    async fn dispatch_handles_null_args_unknown_and_panics() {
        let (_tmp, s) = state().await;
        let mut r = build_router();
        r.add("test.opt", |_s, a: Opt| async move { Ok(a.source_id) });
        r.add("test.panic", |_s, _a: ()| async move {
            if true {
                panic!("boom");
            }
            Ok(())
        });

        let v = r
            .dispatch(s.clone(), "app.ping", serde_json::Value::Null)
            .await
            .unwrap();
        assert_eq!(v, serde_json::json!({"ok": true}));
        let v = r
            .dispatch(s.clone(), "app.ping", serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(v["ok"], true);
        let v = r
            .dispatch(s.clone(), "test.opt", serde_json::Value::Null)
            .await
            .unwrap();
        assert!(v.is_null());
        let v = r
            .dispatch(s.clone(), "test.opt", serde_json::json!({"sourceId": "a"}))
            .await
            .unwrap();
        assert_eq!(v, "a");

        let e = r
            .dispatch(s.clone(), "nope.nope", serde_json::Value::Null)
            .await
            .unwrap_err();
        assert_eq!(e.code, RpcErrorCode::NotFound);
        let e = r
            .dispatch(s.clone(), "test.opt", serde_json::json!({"sourceId": 5}))
            .await
            .unwrap_err();
        assert_eq!(e.code, RpcErrorCode::Invalid);
        let e = r
            .dispatch(s.clone(), "test.panic", serde_json::Value::Null)
            .await
            .unwrap_err();
        assert_eq!(e.code, RpcErrorCode::Internal);

        let info = r
            .dispatch(s, "app.info", serde_json::Value::Null)
            .await
            .unwrap();
        assert_eq!(info["isDesktop"], false);
        assert!(info["version"].is_string());
        assert!(r.names().contains(&"app.openPath"));
    }

    /// Extracts the string literals of `RPC_COMMANDS` from `src/api/rpc.ts`.
    fn ts_rpc_commands() -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/api/rpc.ts");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let start = text
            .find("export const RPC_COMMANDS = [")
            .expect("RPC_COMMANDS not found in rpc.ts");
        let body = &text[start..];
        let body =
            &body[body.find('[').unwrap() + 1..body.find("] as const").expect("RPC_COMMANDS end")];
        body.split(',')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    #[test]
    fn router_registers_exactly_the_c4_catalog() {
        let names: Vec<String> = build_router()
            .names()
            .iter()
            .map(|s| s.to_string())
            .collect();

        // Every module's own command list is registered.
        let module_lists: [&[&str]; 13] = [
            crate::downloads::rpc::COMMANDS,
            crate::player::rpc::COMMANDS,
            &crate::remote::rpc::COMMANDS,
            &crate::stalker::rpc::COMMANDS,
            &crate::tmdb::rpc::COMMANDS,
            crate::xtream::rpc::COMMANDS,
            // parental:
            crate::parental::rpc::COMMANDS,
            // watchlist:
            crate::watchlist::rpc::COMMANDS,
            // channeledit, lists, stats (Run 2):
            crate::channeledit::rpc::COMMANDS,
            crate::lists::rpc::COMMANDS,
            crate::stats::rpc::COMMANDS,
            // imagecache, screenshot (Run 3):
            crate::imagecache::rpc::COMMANDS,
            crate::screenshot::rpc::COMMANDS,
        ];
        for list in module_lists {
            for c in list {
                assert!(names.iter().any(|n| n == c), "{c} is not registered");
            }
        }

        // guide:
        for c in crate::catchup::rpc::COMMANDS {
            assert!(names.iter().any(|n| n == c), "{c} is not registered");
        }

        // The router and the TypeScript RpcMap list are the same set.
        let mut ts = ts_rpc_commands();
        ts.sort();
        let dup = ts.windows(2).find(|w| w[0] == w[1]);
        assert!(dup.is_none(), "duplicate in RPC_COMMANDS: {dup:?}");
        let missing_in_rust: Vec<_> = ts.iter().filter(|c| !names.contains(c)).collect();
        let missing_in_ts: Vec<_> = names.iter().filter(|c| !ts.contains(c)).collect();
        assert!(
            missing_in_rust.is_empty() && missing_in_ts.is_empty(),
            "rpc catalog mismatch: not registered in Rust {missing_in_rust:?}; not in RPC_COMMANDS {missing_in_ts:?}"
        );
        assert_eq!(names.len(), ts.len());
    }

    #[tokio::test]
    async fn init_all_registers_importers_and_survives_failures() {
        let (_tmp, s) = state().await;
        init_all(s.clone()).await.unwrap();
        for kind in [
            crate::model::SourceKind::M3u,
            crate::model::SourceKind::Xtream,
            crate::model::SourceKind::Stalker,
        ] {
            assert!(
                crate::sources::importer(&s, kind).is_some(),
                "{kind:?} importer missing"
            );
        }
        crate::player::kill_embedded(&s);
    }

    #[tokio::test]
    async fn stubs_answer_unsupported_for_any_args() {
        let (_tmp, s) = state().await;
        let mut r = RpcRouter::new();
        add_stubs(&mut r, &["test.later", "test.alsoLater"]);
        assert_eq!(r.names(), ["test.alsoLater", "test.later"]);
        for args in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"id": 5, "refs": []}),
            serde_json::json!([1, 2]),
        ] {
            let e = r.dispatch(s.clone(), "test.later", args).await.unwrap_err();
            assert_eq!(e.code, RpcErrorCode::Unsupported);
            assert_eq!(e.message, "test.later is not implemented yet");
        }
    }

    /// Every Run 2 command is in the router from wave 0 on (as a stub until
    /// its module lands).
    #[test]
    fn run2_commands_are_registered() {
        let r = build_router();
        for c in [
            "catalog.yearFacets",
            "positions.watchedContains",
            "epg.search",
            "recordings.rules",
            "recordings.addRule",
            "recordings.setRuleEnabled",
            "recordings.removeRule",
            "mpv.addSubtitle",
        ]
        .iter()
        .chain(crate::channeledit::rpc::COMMANDS)
        .chain(crate::lists::rpc::COMMANDS)
        .chain(crate::stats::rpc::COMMANDS)
        {
            assert!(r.contains(c), "{c} is not registered");
        }
    }

    /// Every Run 3 command is in the router from wave 0 on (as a stub until
    /// its module lands), under exactly the contract's names.
    #[test]
    fn run3_commands_are_registered() {
        let sorted = |list: &[&'static str]| {
            let mut v = list.to_vec();
            v.sort_unstable();
            v
        };
        assert_eq!(
            sorted(crate::imagecache::rpc::COMMANDS),
            ["images.clear", "images.stats"]
        );
        assert_eq!(
            sorted(crate::screenshot::rpc::COMMANDS),
            [
                "screenshot.mpv",
                "screenshot.open",
                "screenshot.reveal",
                "screenshot.save"
            ]
        );
        let r = build_router();
        for c in crate::imagecache::rpc::COMMANDS
            .iter()
            .chain(crate::screenshot::rpc::COMMANDS)
        {
            assert!(r.contains(c), "{c} is not registered");
        }
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn add_stubs_rejects_a_registered_name() {
        let mut r = build_router();
        add_stubs(&mut r, &["app.ping"]);
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn duplicate_names_panic() {
        let mut r = build_router();
        app::register(&mut r);
    }
}
