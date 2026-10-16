//! Loop 3 (core-serve, L3-perf-core-6 / L3-perf-desktop-6): `epg.grid` and
//! `epg.nowNext` take `withDescription` (default true). With `false` every
//! programme comes back without its description (half the bytes of a guide
//! page or a Live list page); everything else is unchanged.

use iptv_core::epg;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

const URL: &str = "http://guide.example/full.xml";
const H: i64 = 3600;

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    base: i64,
}

/// Item `s|live|1` shows `news.us`: 'before' [base-1h, base) and 'now'
/// [base, base+1h) (on air), 'next' [base+1h, base+2h); every programme has a
/// description, a category and an icon.
async fn setup() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(16);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let base = chrono::Utc::now().timestamp() - H / 2;
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}')",
                [],
            )?;
            c.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id)
                 VALUES ('s', 'live', '1', 'c', 'News', 'news.us')",
                [],
            )?;
            c.execute(
                "INSERT INTO epg_sources(url, origin, status) VALUES (?1, 'settings', 'ok')",
                [URL],
            )?;
            c.execute(
                "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, 'news.us', 'News')",
                [URL],
            )?;
            for (start, title) in [(base - H, "before"), (base, "now"), (base + H, "next")] {
                c.execute(
                    "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title, description, category, icon)
                     VALUES (?1, 'news.us', ?2, ?3, ?4, ?5, 'News', 'http://img.example/i.png')",
                    params![URL, start, start + H, title, format!("About {title}: a long synopsis.")],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    epg::rpc::register(&mut router);
    Env {
        _tmp: tmp,
        state,
        router,
        base,
    }
}

fn item() -> Value {
    json!({ "sourceId": "s", "contentType": "live", "itemId": "1" })
}

impl Env {
    async fn call(&self, method: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), method, args)
            .await
            .unwrap()
    }

    async fn grid(&self, with_description: Option<bool>) -> Value {
        let mut args = json!({
            "refs": [item()],
            "from": epg::query::to_rfc3339(self.base - H),
            "to": epg::query::to_rfc3339(self.base + 2 * H),
        });
        if let Some(w) = with_description {
            args["withDescription"] = json!(w);
        }
        self.call("epg.grid", args).await
    }

    async fn now_next(&self, with_description: Option<bool>) -> Value {
        let mut args = json!({ "refs": [item()] });
        if let Some(w) = with_description {
            args["withDescription"] = json!(w);
        }
        self.call("epg.nowNext", args).await
    }
}

/// The value with every `description` field removed.
fn without_descriptions(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| k.as_str() != "description")
                .map(|(k, v)| (k.clone(), without_descriptions(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(without_descriptions).collect()),
        other => other.clone(),
    }
}

#[tokio::test]
async fn grid_leaves_descriptions_out_only_when_asked() {
    let env = setup().await;
    let full = env.grid(None).await;
    assert_eq!(env.grid(Some(true)).await, full, "true is the default");
    let list = full["s|live|1"].as_array().unwrap();
    let titles: Vec<_> = list.iter().map(|p| p["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["before", "now", "next"]);
    assert_eq!(list[1]["description"], "About now: a long synopsis.");

    let brief = env.grid(Some(false)).await;
    assert_eq!(brief, without_descriptions(&full), "only descriptions go");
    let first = &brief["s|live|1"][0];
    assert!(first.get("description").is_none(), "{first}");
    assert_eq!(first["category"], "News");
    assert_eq!(first["icon"], "http://img.example/i.png");
    assert!(brief.to_string().len() < full.to_string().len());
}

#[tokio::test]
async fn now_next_leaves_descriptions_out_only_when_asked() {
    let env = setup().await;
    let full = env.now_next(None).await;
    assert_eq!(env.now_next(Some(true)).await, full, "true is the default");
    assert_eq!(full["s|live|1"]["now"]["title"], "now");
    assert_eq!(
        full["s|live|1"]["next"]["description"],
        "About next: a long synopsis."
    );

    let brief = env.now_next(Some(false)).await;
    assert_eq!(brief, without_descriptions(&full), "only descriptions go");
    assert_eq!(brief["s|live|1"]["now"]["title"], "now");
    assert!(brief["s|live|1"]["now"].get("description").is_none());

    // epg.programs (the guide's selected programme, the ribbon) keeps them.
    let programs = env
        .call(
            "epg.programs",
            json!({
                "ref": item(),
                "from": epg::query::to_rfc3339(env.base),
                "to": epg::query::to_rfc3339(env.base + 1),
            }),
        )
        .await;
    assert_eq!(programs[0]["description"], "About now: a long synopsis.");
}

#[tokio::test]
async fn a_bad_with_description_is_refused() {
    let env = setup().await;
    let err = env
        .router
        .dispatch(
            env.state.clone(),
            "epg.grid",
            json!({
                "refs": [item()],
                "from": epg::query::to_rfc3339(env.base),
                "to": epg::query::to_rfc3339(env.base + H),
                "withDescription": "no",
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::error::RpcErrorCode::Invalid, "{err:?}");
}
