//! Loop 2 (core-data, M3U):
//! - L1-core-17: a gzip playlist served without `Content-Encoding` (as
//!   `application/octet-stream` / `application/x-gzip`) or stored as a
//!   `.m3u.gz` file is decompressed instead of rejected as video / binary data.
//! - L1-core-19: an unquoted `url-tvg=http://a/e.xml,http://b/e.xml` header
//!   keeps both guides.
//! - L1-core-11: the header `tvg-shift` is the default of entries without
//!   one, so the import stores it with every channel.

#[path = "m3u_support.rs"]
mod support;

use axum::routing::get;
use axum::Router;
use flate2::write::GzEncoder;
use flate2::Compression;
use iptv_core::m3u::body::{sniff, SNIFF_BYTES};
use iptv_core::m3u::parser::{decode_playlist_text, parse_str, M3uReader};
use iptv_core::sources;
use rusqlite::params;
use serde_json::json;
use std::io::Write;
use support::*;

fn gzip(text: &str) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(text.as_bytes()).unwrap();
    e.finish().unwrap()
}

/// `n` channels whose names and urls do not repeat much, so the gzip body
/// is well over [`SNIFF_BYTES`] for large `n`.
fn playlist(n: usize) -> String {
    let mut s = String::from("#EXTM3U url-tvg=\"http://epg.example/g.xml\"\n");
    for i in 0..n {
        let tag = format!("{:x}", (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        s.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"c{tag}.example\" group-title=\"G{}\",Channel {tag}\nhttp://s.example/live/{tag}.ts\n",
            i % 7
        ));
    }
    s
}

#[test]
fn reader_and_text_decoding_gunzip() {
    let text = playlist(40);
    let gz = gzip(&text);
    // Tiny buffers split the magic across reads.
    for cap in [1, 2, 3, 64, 8192] {
        let mut r = M3uReader::new(std::io::BufReader::with_capacity(cap, &gz[..]));
        let n = r.by_ref().count();
        assert!(r.take_io_error().is_none(), "cap {cap}");
        assert_eq!(n, 40, "cap {cap}");
        assert_eq!(r.header().epg_urls, ["http://epg.example/g.xml"]);
    }
    assert_eq!(decode_playlist_text(gz.clone()), text);
    // A gzip of a UTF-16 playlist is both decompressed and transcoded.
    let mut utf16 = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        utf16.extend(u.to_le_bytes());
    }
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(&utf16).unwrap();
    let gz16 = e.finish().unwrap();
    assert_eq!(M3uReader::new(&gz16[..]).count(), 40);
    assert_eq!(decode_playlist_text(gz16), text);
    // A stray 0x1F that is not gzip stays text.
    let (entries, _, _) = parse_str("\u{1f}#EXTINF:-1,A\nhttp://h/a\n");
    assert_eq!(entries.len(), 1);
    // Corrupt gzip is an I/O error, not an empty list.
    let mut bad = gz[..20].to_vec();
    bad.extend_from_slice(&[0xFF; 64]);
    let mut r = M3uReader::new(&bad[..]);
    assert_eq!(r.by_ref().count(), 0);
    assert!(r.take_io_error().is_some());
}

#[test]
fn sniff_judges_the_decompressed_head() {
    let big = gzip(&playlist(400));
    assert!(big.len() > SNIFF_BYTES, "{}", big.len());
    for ct in [
        Some("application/octet-stream"),
        Some("application/x-gzip"),
        Some("application/gzip"),
        None,
    ] {
        assert!(sniff(&big[..SNIFF_BYTES], ct, "h").is_none(), "{ct:?}");
        assert!(sniff(&gzip("#EXTM3U\n"), ct, "h").is_none(), "{ct:?}");
    }
    // A compressed web page is still a web page.
    let page = gzip("<!DOCTYPE html><html><body>Login</body></html>");
    let e = sniff(&page, Some("application/octet-stream"), "h").unwrap();
    assert!(e.to_string().contains("web page"), "{e}");
    // A gzip magic followed by garbage.
    let e = sniff(&[0x1F, 0x8B, 0, 0, 0], None, "h").unwrap();
    assert!(e.to_string().contains("compressed"), "{e}");
}

#[test]
fn unquoted_header_guides_keep_every_url() {
    let (_, h, _) =
        parse_str("#EXTM3U url-tvg=http://a/e.xml,http://b/e.xml x-tvg-url=http://c/e.xml\n");
    assert_eq!(
        h.epg_urls,
        ["http://a/e.xml", "http://b/e.xml", "http://c/e.xml"]
    );
    // Commas between header attributes do not end them.
    let (_, h, _) = parse_str("#EXTM3U url-tvg=\"http://a/e.xml\", tvg-shift=2\n");
    assert_eq!(h.epg_urls, ["http://a/e.xml"]);
    assert!(h.attrs.contains(&("tvg-shift".into(), "2".into())));
    // EXTINF still splits the name at the first comma after unquoted values.
    let (e, _, _) = parse_str("#EXTM3U\n#EXTINF:-1 tvg-chno=7,Name, Two\nhttp://h/a\n");
    assert_eq!(e[0].tvg_chno, Some(7));
    assert_eq!(e[0].name, "Name, Two");
}

#[test]
fn header_tvg_shift_is_the_entry_default() {
    let (e, _, _) = parse_str(
        "#EXTM3U tvg-shift=\"-1.5\"\n\
         #EXTINF:-1 tvg-id=\"a\",A\nhttp://h/a\n\
         #EXTINF:-1 tvg-id=\"b\" tvg-shift=\"2\",B\nhttp://h/b\n\
         http://h/bare\n",
    );
    let shifts: Vec<_> = e.iter().map(|e| e.tvg_shift.as_deref()).collect();
    assert_eq!(shifts, [Some("-1.5"), Some("2"), Some("-1.5")]);
    // No header shift: entries keep none.
    let (e, _, _) = parse_str("#EXTM3U\n#EXTINF:-1,A\nhttp://h/a\n");
    assert_eq!(e[0].tvg_shift, None);
}

/// The importer stores the header shift with each channel (`extraJson`),
/// where the guide queries read it.
#[tokio::test]
async fn import_stores_the_header_shift_per_channel() {
    let env = env().await;
    let src = add_text(
        &env.state,
        "S",
        "#EXTM3U tvg-shift=1\n\
         #EXTINF:-1 tvg-id=\"a\",A\nhttp://h/a\n\
         #EXTINF:-1 tvg-id=\"b\" tvg-shift=0,B\nhttp://h/b\n",
    )
    .await;
    let sid = src.id.clone();
    let extras: Vec<(String, String)> = env
        .state
        .db_call(move |c| {
            let mut st = c.prepare(
                "SELECT title, extra_json FROM items WHERE source_id = ?1 ORDER BY title",
            )?;
            let rows = st
                .query_map(params![sid], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap();
    let shift = |i: usize| {
        serde_json::from_str::<serde_json::Value>(&extras[i].1).unwrap()["tvgShift"].clone()
    };
    assert_eq!(extras.len(), 2);
    assert_eq!(shift(0), "1");
    assert_eq!(shift(1), "0");
}

/// Serves `body` as `/list.m3u` with `content_type` and no Content-Encoding.
async fn serve(
    body: Vec<u8>,
    content_type: &'static str,
) -> (String, tokio::sync::oneshot::Sender<()>) {
    let app = Router::new().route(
        "/list.m3u",
        get(move || {
            let body = body.clone();
            async move { ([("content-type", content_type)], body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    (format!("http://{addr}/list.m3u"), tx)
}

#[tokio::test]
async fn gzip_playlist_without_content_encoding_imports() {
    let env = env().await;
    for (n, ct) in [(400, "application/octet-stream"), (3, "application/x-gzip")] {
        let text = playlist(n);
        let (url, _stop) = serve(gzip(&text), ct).await;
        let src = sources::add(env.state.clone(), url_args(&url, false))
            .await
            .map_err(|e| e.error)
            .unwrap_or_else(|e| panic!("{ct}: {e}"));
        assert_eq!(src.channel_count, n as i64, "{ct}");
        let stored = sources::get(&env.state, &src.id).await.unwrap();
        assert_eq!(
            stored.epg.detected_urls,
            ["http://epg.example/g.xml"],
            "{ct}"
        );
        // The stored raw playlist is the text, not the compressed bytes.
        let raw = router()
            .dispatch(env.state.clone(), "m3u.raw", json!({ "sourceId": src.id }))
            .await
            .unwrap();
        assert_eq!(raw["text"].as_str().unwrap(), text, "{ct}");
    }
}

#[tokio::test]
async fn gzip_playlist_file_imports() {
    let env = env().await;
    let path = env.dir.path().join("list.m3u.gz");
    std::fs::write(&path, gzip(&playlist(50))).unwrap();
    let src = sources::add(env.state.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, 50);
}
