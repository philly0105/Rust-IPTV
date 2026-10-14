//! `stats.*` RPC commands (Run 2 contract C7).
//!
//! Each handler runs the synchronous function of the same name in the parent
//! module through [`AppState::db_call`]. There is no change event: the stats
//! page refetches on focus and on an interval, and `stats.clear` invalidates
//! its own cache.

use super::{prune_mark, utc_today, Record, WatchStats};
use crate::error::RpcError;
use crate::model::ItemRef;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::Deserialize;
use std::sync::Arc;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &["stats.record", "stats.summary", "stats.clear"];

/// `stats.record`: seconds watched of one item on one client-local day.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub title: String,
    #[serde(default)]
    pub poster_url: Option<String>,
    pub seconds: i64,
    pub day: String,
}

/// `stats.summary`: the range (7 or 30 days) ending at the client's `today`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryArgs {
    pub days: u32,
    pub today: String,
    #[serde(default)]
    pub top: Option<i64>,
}

type S = Arc<AppState>;

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("stats.record", |s: S, a: RecordArgs| async move {
        let today = utc_today();
        let mark = prune_mark(&s);
        let prune = mark.due(today);
        s.db_call(move |c| {
            let rec = Record {
                item_ref: &a.item_ref,
                title: &a.title,
                poster_url: a.poster_url.as_deref(),
                seconds: a.seconds,
                day: &a.day,
            };
            // Validate first, so a bad call never prunes or writes.
            super::validate_record(&rec, today)?;
            if prune {
                super::prune(c, today)?;
            }
            super::record(c, &rec, today)
        })
        .await?;
        if prune {
            mark.set(today);
        }
        Ok::<(), RpcError>(())
    });
    r.add("stats.summary", |s: S, a: SummaryArgs| async move {
        // Check the arguments before the parental lookup, so a bad call is
        // `invalid` whatever the parental state.
        super::validate_summary(a.days, &a.today, a.top)?;
        let hide = crate::parental::hide_filter(&s).await?;
        let v = s
            .db_call(move |c| super::summary(c, a.days, &a.today, a.top, hide))
            .await?;
        Ok::<WatchStats, RpcError>(v)
    });
    r.add("stats.clear", |s: S, _: ()| async move {
        s.db_call(|c| super::clear(c)).await?;
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
    async fn registers_the_contract_and_rejects_bad_args() {
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

        for args in [Value::Null, json!({})] {
            r.dispatch(state.clone(), "stats.clear", args)
                .await
                .unwrap();
        }
        let today = super::super::fmt_day(utc_today());
        let live = json!({"sourceId": "s1", "contentType": "live", "itemId": "7"});
        for (cmd, bad) in [
            ("stats.record", Value::Null),
            (
                "stats.record",
                json!({"ref": live, "title": "BBC", "seconds": 1.5, "day": today}),
            ),
            (
                "stats.record",
                json!({"ref": live, "title": "BBC", "seconds": "30", "day": today}),
            ),
            (
                "stats.record",
                json!({"ref": {"sourceId": "s1"}, "title": "BBC", "seconds": 30, "day": today}),
            ),
            ("stats.summary", json!({"days": 14, "today": today})),
            ("stats.summary", json!({"days": 7})),
            ("stats.summary", json!({"days": "7", "today": today})),
        ] {
            let e = r
                .dispatch(state.clone(), cmd, bad.clone())
                .await
                .unwrap_err();
            assert_eq!(e.code, RpcErrorCode::Invalid, "{cmd} {bad}: {e:?}");
        }
    }
}
