//! Sources (B1): a pasted or uploaded playlist takes new text in place
//! (`sources.update {patch: {text}}`), and the next refresh re-imports it
//! under the same source id with its user state.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::sources::{self, SourcePatch};
use rusqlite::params;
use support::*;

fn playlist(token: &str, channels: usize) -> String {
    let mut s = String::from("#EXTM3U\n");
    for i in 0..channels {
        s.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"ch{i}.example\" group-title=\"News\",Channel {i}\nhttp://s.example/{token}/{i}.ts\n"
        ));
    }
    s
}

async fn item_id(env: &Env, source_id: &str, title: &str) -> String {
    let (sid, title) = (source_id.to_string(), title.to_string());
    env.state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT item_id FROM items WHERE source_id = ?1 AND title = ?2",
                params![sid, title],
                |r| r.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap()
}

async fn favorites(env: &Env, source_id: &str) -> Vec<String> {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            let mut st = c.prepare("SELECT item_id FROM favorites WHERE source_id = ?1")?;
            let rows = st
                .query_map(params![sid], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

fn text_patch(text: &str) -> SourcePatch {
    SourcePatch {
        text: Some(text.into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn new_text_replaces_the_playlist_and_keeps_favorites() {
    let env = env().await;
    let src = add_text(&env.state, "Pasted", &playlist("tok1", 3)).await;
    assert_eq!(src.channel_count, 3);
    let ch1 = item_id(&env, &src.id, "Channel 1").await;
    let (sid, item) = (src.id.clone(), ch1.clone());
    env.state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO favorites (source_id, content_type, item_id, snapshot_json) VALUES (?1, 'live', ?2, '{}')",
                params![sid, item],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    // New text with rotated stream URLs and one more channel.
    let updated = sources::update(&env.state, &src.id, text_patch(&playlist("tok2", 4)))
        .await
        .unwrap();
    assert_eq!(updated.id, src.id);
    assert_eq!(updated.channel_count, 3, "update stores the text only");

    let again = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(again.id, src.id);
    assert_eq!(again.channel_count, 4);
    let new_ch1 = item_id(&env, &src.id, "Channel 1").await;
    assert_ne!(new_ch1, ch1, "the item id follows the stream URL");
    assert_eq!(favorites(&env, &src.id).await, vec![new_ch1]);

    let raw = iptv_core::m3u::rpc::raw(
        env.state.clone(),
        iptv_core::m3u::rpc::RawArgs {
            source_id: src.id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(raw.text, playlist("tok2", 4));
}

#[tokio::test]
async fn new_text_is_refused_for_other_sources_and_for_non_playlists() {
    let env = env().await;
    let src = add_text(&env.state, "Pasted", &playlist("tok1", 2)).await;

    let err = sources::update(&env.state, &src.id, text_patch("   "))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("paste the playlist"), "{err}");
    let err = sources::update(&env.state, &src.id, text_patch("just some words"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not an M3U playlist"), "{err}");
    // The stored text is unchanged after a refused update.
    let raw = iptv_core::m3u::rpc::raw(
        env.state.clone(),
        iptv_core::m3u::rpc::RawArgs {
            source_id: src.id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(raw.text, playlist("tok1", 2));

    let stub = stub(&playlist("tok1", 2)).await;
    let url = sources::add(env.state.clone(), url_args(&stub.url(), false))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let err = sources::update(&env.state, &url.id, text_patch(&playlist("tok2", 2)))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("pasted or uploaded"), "{err}");
}
