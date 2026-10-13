//! `live.alternates`: which channels count as the same channel, their order,
//! and the lookup's speed at 50k channels per source (failover slice).
//!
//! The perf bar follows `catalog_perf.rs`: one lookup answers in under
//! [`QUERY_BUDGET`] in both profiles, measured after a warm-up call.
//! Run (the real bar): `cargo test --release -p iptv-core --test live_alternates`

#[path = "m3u_support.rs"]
mod support;

use iptv_core::rpc::RpcRouter;
use iptv_core::RpcErrorCode;
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

const QUERY_BUDGET: Duration = Duration::from_millis(100);

fn live_router() -> RpcRouter {
    let mut r = router();
    iptv_core::live::rpc::register(&mut r);
    r
}

/// The `ref` of the channel titled `title` in a source.
async fn channel_ref(
    r: &RpcRouter,
    state: &Arc<iptv_core::AppState>,
    sid: &str,
    title: &str,
) -> Value {
    let page = r
        .dispatch(
            state.clone(),
            "catalog.channels",
            json!({"sourceId": sid, "query": {"limit": 1000}}),
        )
        .await
        .unwrap();
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == title)
        .unwrap_or_else(|| panic!("{title} not in {sid}"))["ref"]
        .clone()
}

fn names(v: &Value) -> Vec<(String, String)> {
    v["alternates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["sourceName"].as_str().unwrap().to_string(),
                a["channel"]["name"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

const ALPHA: &str = r#"#EXTM3U
#EXTINF:-1 tvg-id="skysports1.uk" group-title="Sports",UK: Sky Sports 1 HD
http://alpha.example/1.ts
#EXTINF:-1 tvg-id="skysports1.uk" group-title="Sports",UK: Sky Sports 1 +1
http://alpha.example/2.ts
#EXTINF:-1 tvg-id="" group-title="Sports",Sky Sports 2 HD
http://alpha.example/3.ts
#EXTINF:-1 tvg-id="cnn.us" group-title="News",US | CNN
http://alpha.example/4.ts
#EXTINF:-1 group-title="News",Sky Sports 1 (backup)
http://alpha.example/5.ts
#EXTINF:-1 tvg-id="none" group-title="News",Placeholder One
http://alpha.example/6.ts
"#;

const BETA: &str = r#"#EXTM3U
#EXTINF:-1 group-title="S",Sky Sports 1 FHD
http://beta.example/1.ts
#EXTINF:-1 group-title="S",Sky Sports 1 HD
http://beta.example/2.ts
#EXTINF:-1 tvg-id="sky-one-beta" group-title="S",SKYSPORTS ONE
http://beta.example/3.ts
#EXTINF:-1 group-title="S",DE: Sky Sports 1
http://beta.example/4.ts
#EXTINF:-1 group-title="S",Sky Sports 12
http://beta.example/5.ts
#EXTINF:-1 tvg-id="cnn.us" group-title="N",CNN HD
http://beta.example/6.ts
#EXTINF:-1 tvg-id="none" group-title="N",Placeholder Two
http://beta.example/7.ts
"#;

/// Same URL as Alpha's Sky Sports 1: retrying it is pointless.
const GAMMA: &str = r#"#EXTM3U
#EXTINF:-1 group-title="S",Sky Sports 1 HD
http://alpha.example/1.ts
#EXTINF:-1 group-title="S",Sky Sports 2
http://gamma.example/2.ts
"#;

#[tokio::test]
async fn finds_the_same_channel_and_ranks_it() {
    let env = env().await;
    let r = live_router();
    let a = add_text(&env.state, "Alpha", ALPHA).await;
    let b = add_text(&env.state, "Beta", BETA).await;
    let _g = add_text(&env.state, "Gamma", GAMMA).await;

    // Beta's oddly named copy is mapped by hand to Alpha's guide id.
    let one = channel_ref(&r, &env.state, &b.id, "SKYSPORTS ONE").await;
    let item_id = one["itemId"].as_str().unwrap().to_string();
    let bid = b.id.clone();
    env.state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO epg_channel_map (source_id, content_type, item_id, epg_channel_id) VALUES (?1, 'live', ?2, 'skysports1.uk')",
                rusqlite::params![bid, item_id],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let sky1 = channel_ref(&r, &env.state, &a.id, "UK: Sky Sports 1 HD").await;
    let v = r
        .dispatch(env.state.clone(), "live.alternates", json!({"ref": sky1}))
        .await
        .unwrap();
    assert_eq!(v["key"], "sky sports 1");
    assert_eq!(v["quality"], "hd");
    // Same tier (HD) first, then source order, then playlist order. Left out:
    // itself, the +1 feed that shares the guide id, the German feed, Sky
    // Sports 12, and Gamma's copy with the very same URL.
    assert_eq!(
        names(&v),
        vec![
            ("Beta".into(), "Sky Sports 1 HD".into()),
            ("Alpha".into(), "Sky Sports 1 (backup)".into()),
            ("Beta".into(), "Sky Sports 1 FHD".into()),
            ("Beta".into(), "SKYSPORTS ONE".into()),
        ]
    );
    let alts = v["alternates"].as_array().unwrap();
    assert_eq!(alts[0]["quality"], "hd");
    assert_eq!(alts[0]["matchedBy"], "name");
    assert_eq!(alts[0]["sourceKind"], "m3u");
    assert!(alts[1].get("quality").is_none(), "{}", alts[1]);
    assert_eq!(alts[2]["quality"], "fhd");
    assert_eq!(alts[3]["matchedBy"], "epg");
    assert_eq!(alts[0]["channel"]["ref"]["sourceId"], json!(b.id));

    // By guide id alone: "US | CNN" and "CNN HD" share `cnn.us`.
    let cnn = channel_ref(&r, &env.state, &a.id, "US | CNN").await;
    let v = r
        .dispatch(env.state.clone(), "live.alternates", json!({"ref": cnn}))
        .await
        .unwrap();
    assert_eq!(names(&v), vec![("Beta".into(), "CNN HD".into())]);
    assert_eq!(v["alternates"][0]["matchedBy"], "epg");

    // A placeholder guide id ("none") matches nothing.
    let ph = channel_ref(&r, &env.state, &a.id, "Placeholder One").await;
    let v = r
        .dispatch(env.state.clone(), "live.alternates", json!({"ref": ph}))
        .await
        .unwrap();
    assert!(names(&v).is_empty(), "{v}");

    // The +1 feed is its own channel.
    let plus1 = channel_ref(&r, &env.state, &a.id, "UK: Sky Sports 1 +1").await;
    let v = r
        .dispatch(env.state.clone(), "live.alternates", json!({"ref": plus1}))
        .await
        .unwrap();
    assert!(names(&v).is_empty(), "{v}");

    // Sky Sports 2 on Gamma (no quality) for Alpha's HD copy.
    let sky2 = channel_ref(&r, &env.state, &a.id, "Sky Sports 2 HD").await;
    let v = r
        .dispatch(env.state.clone(), "live.alternates", json!({"ref": sky2}))
        .await
        .unwrap();
    assert_eq!(names(&v), vec![("Gamma".into(), "Sky Sports 2".into())]);

    // Errors: unknown channel, VOD refs.
    let e = r
        .dispatch(
            env.state.clone(),
            "live.alternates",
            json!({"ref": {"sourceId": a.id, "contentType": "live", "itemId": "nope"}}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::NotFound);
    let e = r
        .dispatch(
            env.state.clone(),
            "live.alternates",
            json!({"ref": {"sourceId": a.id, "contentType": "movie", "itemId": "1"}}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Invalid);
}

/// Copies in a category the user hid are not alternates, whichever way they
/// match (guide id, hand-mapped guide id, name).
#[tokio::test]
async fn skips_channels_in_hidden_categories() {
    let env = env().await;
    let r = live_router();
    let a = add_text(&env.state, "Alpha", ALPHA).await;
    let b = add_text(&env.state, "Beta", BETA).await;

    let one = channel_ref(&r, &env.state, &b.id, "SKYSPORTS ONE").await;
    let item_id = one["itemId"].as_str().unwrap().to_string();
    let bid = b.id.clone();
    env.state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO epg_channel_map (source_id, content_type, item_id, epg_channel_id) VALUES (?1, 'live', ?2, 'skysports1.uk')",
                rusqlite::params![bid, item_id],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let sky1 = channel_ref(&r, &env.state, &a.id, "UK: Sky Sports 1 HD").await;
    let cnn = channel_ref(&r, &env.state, &a.id, "US | CNN").await;
    let lookup = |reference: Value| {
        let (r, state) = (&r, env.state.clone());
        async move {
            r.dispatch(state, "live.alternates", json!({"ref": reference}))
                .await
                .unwrap()
        }
    };
    assert_eq!(names(&lookup(sky1.clone()).await).len(), 4);
    assert_eq!(names(&lookup(cnn.clone()).await).len(), 1);

    // Hide both of Beta's groups.
    let bid = b.id.clone();
    env.state
        .db_call(move |c| {
            c.execute(
                "UPDATE categories SET hidden = 1 WHERE source_id = ?1 AND content_type = 'live'",
                rusqlite::params![bid],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        names(&lookup(sky1).await),
        vec![("Alpha".into(), "Sky Sports 1 (backup)".into())]
    );
    assert!(names(&lookup(cnn).await).is_empty());
}

const CHANNELS: usize = 50_000;
const BRANDS: [&str; 25] = [
    "Sky Sports",
    "Sky Cinema",
    "BBC",
    "ITV",
    "Channel",
    "Eurosport",
    "Discovery",
    "National Geographic",
    "Fox",
    "ESPN",
    "beIN Sports",
    "Canal+",
    "Rai",
    "Mediaset",
    "TVE",
    "RTL",
    "ProSieben",
    "Sat",
    "Nickelodeon",
    "Cartoon Network",
    "MTV",
    "Comedy Central",
    "History",
    "Animal Planet",
    "CNN",
];

/// 50k channels: `<brand> <n>` with this source's tag and quality markers;
/// guide ids only when `tvg` is set (the other source is matched by name).
fn gen(tag: &str, quality: &str, tvg: bool) -> String {
    let mut s = String::with_capacity(CHANNELS * 120);
    s.push_str("#EXTM3U\n");
    for i in 0..CHANNELS {
        let brand = BRANDS[i % BRANDS.len()];
        let n = i / BRANDS.len();
        let id = if tvg {
            format!(
                " tvg-id=\"{}{n}.uk\"",
                brand.to_lowercase().replace(' ', "")
            )
        } else {
            String::new()
        };
        let _ = write!(
            s,
            "#EXTINF:-1{id} group-title=\"Group {}\",{tag}{brand} {n}{quality}\nhttp://{}.example/{i}.ts\n",
            i % 200,
            tag.len() + quality.len()
        );
    }
    s
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lookup_on_three_50k_sources_stays_fast() {
    let env = env().await;
    let r = live_router();
    let a = add_text(&env.state, "A", &gen("UK: ", " HD", true)).await;
    let _b = add_text(&env.state, "B", &gen("", " FHD", false)).await;
    let _c = add_text(&env.state, "C", &gen("[UK] ", "", true)).await;
    assert_eq!(a.channel_count, CHANNELS as i64);

    // The name lookup goes through the FTS index, the guide id through its index.
    let plan: Vec<String> = env
        .state
        .db_call(|c| {
            let mut out = Vec::new();
            for sql in [
                "EXPLAIN QUERY PLAN SELECT i.item_id FROM items i WHERE i.content_type = 'live' AND i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH '\"sky sports 7\"')",
                "EXPLAIN QUERY PLAN SELECT i.item_id FROM items i WHERE i.epg_channel_id = 'x' AND i.content_type = 'live'",
            ] {
                let mut stmt = c.prepare(sql)?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(3))?;
                for row in rows {
                    out.push(row?);
                }
            }
            Ok(out)
        })
        .await
        .unwrap();
    assert!(
        plan.iter().any(|d| d.contains("VIRTUAL TABLE INDEX")),
        "{plan:?}"
    );
    assert!(plan.iter().any(|d| d.contains("idx_items_epg")), "{plan:?}");
    assert!(!plan.iter().any(|d| d == "SCAN i"), "full scan: {plan:?}");

    // Every brand once, plus a two-word one in the middle of the list.
    for (title, expect) in [
        ("UK: Sky Sports 7 HD", 2),
        ("UK: National Geographic 1000 HD", 2),
        ("UK: Canal+ 1999 HD", 2),
        ("UK: CNN 0 HD", 2),
    ] {
        let (sid, t) = (a.id.clone(), title.to_string());
        let item_id: String = env
            .state
            .db_call(move |c| {
                Ok(c.query_row(
                    "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = 'live' AND title = ?2",
                    rusqlite::params![sid, t],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        let reference = json!({"sourceId": a.id, "contentType": "live", "itemId": item_id});
        let warm = r
            .dispatch(
                env.state.clone(),
                "live.alternates",
                json!({"ref": reference}),
            )
            .await
            .unwrap();
        assert_eq!(
            warm["alternates"].as_array().unwrap().len(),
            expect,
            "{title}: {warm}"
        );
        let started = Instant::now();
        let v = r
            .dispatch(
                env.state.clone(),
                "live.alternates",
                json!({"ref": reference}),
            )
            .await
            .unwrap();
        let took = started.elapsed();
        eprintln!("live_alternates: {title} in {took:?}");
        assert_eq!(v, warm);
        assert!(
            took < QUERY_BUDGET,
            "{title} took {took:?} (budget {QUERY_BUDGET:?})"
        );
    }
}
