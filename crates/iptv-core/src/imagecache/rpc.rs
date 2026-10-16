//! `images.*` RPC commands (Run 3 contract C2).
//!
//! `images.stats` reports the cache size (evicting first when a lowered cap
//! left it over), `images.clear` empties it. Both take no arguments and
//! return [`super::ImageCacheStats`]. There is no change event: `images.clear`
//! and a cap change refetch `images.stats` in the UI.

use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use std::sync::Arc;

type S = Arc<AppState>;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &["images.stats", "images.clear"];

pub fn register(r: &mut RpcRouter) {
    r.add("images.stats", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::stats(&s).await?)
    });
    r.add("images.clear", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::clear(&s).await?)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::RpcErrorCode;
    use crate::events::NoopSink;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn registers_the_contract_and_answers_on_an_empty_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        let mut r = RpcRouter::new();
        register(&mut r);
        let mut expected = COMMANDS.to_vec();
        expected.sort_unstable();
        assert_eq!(
            r.names(),
            expected,
            "COMMANDS lists exactly what register adds"
        );
        let empty = json!({"bytes": 0, "files": 0, "maxBytes": 500u64 * 1024 * 1024});
        for cmd in COMMANDS {
            for args in [Value::Null, json!({})] {
                let out = r.dispatch(state.clone(), cmd, args).await.unwrap();
                assert_eq!(out, empty, "{cmd}");
            }
            let err = r
                .dispatch(state.clone(), cmd, json!([1]))
                .await
                .unwrap_err();
            assert_eq!(err.code, RpcErrorCode::Invalid, "{cmd}");
        }
        state.settings.write().image_cache_max_mb = 50;
        let out = r
            .dispatch(state.clone(), "images.stats", Value::Null)
            .await
            .unwrap();
        assert_eq!(out["maxBytes"], json!(50u64 * 1024 * 1024));
    }
}
