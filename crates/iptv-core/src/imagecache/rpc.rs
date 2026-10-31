//! `images.*` RPC commands (Run 3 contract C2).
//!
//! `images.stats` reports the cache size (evicting first when a lowered cap
//! left it over), `images.clear` empties it. Both take no arguments and
//! return [`super::ImageCacheStats`]. There is no change event: `images.clear`
//! and a cap change refetch `images.stats` in the UI.
//!
//! `images.warm` takes `{items: [{url, sourceId?, w?}]}`, the pictures the UI's
//! fetch gate has queued, and answers `null` once the ones not cached are
//! queued for fetching ([`super::warm`]). Items past [`super::WARM_MAX_ITEMS`]
//! and items that fail (a bad URL, a guard refusal) are dropped silently:
//! each picture's own request reports its failure.

use super::WarmItem;
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::Deserialize;
use std::sync::Arc;

type S = Arc<AppState>;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &["images.stats", "images.clear", "images.warm"];

/// `images.warm`: the pictures to fetch ahead of their requests.
#[derive(Debug, Deserialize)]
pub struct WarmArgs {
    pub items: Vec<WarmItem>,
}

pub fn register(r: &mut RpcRouter) {
    r.add("images.stats", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::stats(&s).await?)
    });
    r.add("images.clear", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::clear(&s).await?)
    });
    r.add("images.warm", |s: S, a: WarmArgs| async move {
        super::warm(&s, a.items).await;
        Ok::<(), RpcError>(())
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
        for cmd in ["images.stats", "images.clear"] {
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

    #[tokio::test]
    async fn warm_takes_items_and_drops_the_ones_it_cannot_use() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        let mut r = RpcRouter::new();
        register(&mut r);
        // Bad addresses are the pictures' own requests to report.
        let items = json!({"items": [
            {"url": "not a url"},
            {"url": "ftp://example.com/a.png", "sourceId": "s1", "w": 192},
            {"url": ""}
        ]});
        for args in [json!({"items": []}), items] {
            let out = r.dispatch(state.clone(), "images.warm", args).await;
            assert_eq!(out.unwrap(), Value::Null);
        }
        for bad in [
            Value::Null,
            json!({}),
            json!({"items": [{"w": 64}]}),
            json!({"items": [{"url": "http://example.com/a.png", "w": -1}]}),
        ] {
            let err = r
                .dispatch(state.clone(), "images.warm", bad.clone())
                .await
                .unwrap_err();
            assert_eq!(err.code, RpcErrorCode::Invalid, "{bad}");
        }
    }
}
