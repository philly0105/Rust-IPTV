//! Fixture generators and the in-process mock spawner (SPEC C14).
//!
//! - [`spawn_mock`] starts the `iptv-mock` router on a free loopback port.
//! - [`m3u_text`] / [`write_m3u`] and [`write_xmltv`] produce large inputs for
//!   parser and performance tests; the writers stream, so memory stays flat.
//! - [`sample_m3u`] / [`sample_xmltv`] are `fixtures/sample.m3u` and
//!   `fixtures/sample.xml` (URLs rooted at `http://127.0.0.1:7290`).
//! - [`backup_manifest_v1`] is a C15 manifest with `{mock}` placeholders;
//!   `fixtures/backup-v1.json` is the same text with `{mock}` replaced by
//!   `http://127.0.0.1:7290`.
//!
//! Generated playlists and guides use the same channel ids: entry `i` of
//! [`m3u_text`] has `tvg-id` `gen-{i % 400:04}.tv`, which [`write_xmltv`]
//! defines.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

use serde_json::{json, Value};

pub use iptv_mock::files::{video_byte, video_bytes, FLAKY_DROP_AFTER, NOLEN_LEN, VIDEO_BIN_LEN};
pub use iptv_mock::gen::DEFAULT_BASE;
pub use iptv_mock::stalker::{
    MAC as STALKER_MAC, TOKEN as STALKER_TOKEN, VOD_SERIES_ID as STALKER_VOD_SERIES_ID,
};
pub use iptv_mock::xtream::{PASSWORD as XTREAM_PASSWORD, USERNAME as XTREAM_USERNAME};

/// Placeholder for the mock base URL inside [`backup_manifest_v1`].
pub const MOCK_PLACEHOLDER: &str = "{mock}";

/// Handle to an in-process mock server. Dropping it shuts the server down.
pub struct MockHandle {
    pub port: u16,
    /// `http://127.0.0.1:<port>`
    pub base: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl MockHandle {
    /// `base` + `path` (`path` starts with `/`).
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// Xtream server URL as a user would enter it (`{base}/xtream`).
    pub fn xtream_url(&self) -> String {
        self.url("/xtream")
    }

    /// Stalker portal URL (`{base}/stalker/portal.php`).
    pub fn stalker_portal_url(&self) -> String {
        self.url("/stalker/portal.php")
    }
}

impl Drop for MockHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// Starts the mock router on a free loopback port. Requires a tokio runtime.
/// Payload URLs (stream links, logos, create_link) point at this server.
pub async fn spawn_mock() -> MockHandle {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock listener");
    let port = listener.local_addr().expect("mock local addr").port();
    let base = format!("http://127.0.0.1:{port}");
    let app = iptv_mock::router_with_base(base.clone());
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    MockHandle {
        port,
        base,
        shutdown: Some(tx),
    }
}

/// M3U playlist text with `channels` entries across `groups` groups.
/// URLs are rooted at [`DEFAULT_BASE`].
pub fn m3u_text(channels: usize, groups: usize) -> String {
    iptv_mock::gen::M3uGen::new(DEFAULT_BASE, channels, groups).collect()
}

/// Streams the [`m3u_text`] playlist to `path`.
pub fn write_m3u(path: &Path, channels: usize, groups: usize) -> io::Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    for chunk in iptv_mock::gen::M3uGen::new(DEFAULT_BASE, channels, groups) {
        w.write_all(chunk.as_bytes())?;
    }
    w.flush()
}

/// Streams an XMLTV file of at least `megabytes` MiB to `path`: 400 channels
/// (`gen-0000.tv` .. `gen-0399.tv`), programmes starting yesterday.
pub fn write_xmltv(path: &Path, megabytes: usize) -> io::Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    let from = iptv_mock::catalog::now();
    for chunk in iptv_mock::gen::XmltvGen::new(DEFAULT_BASE, megabytes * iptv_mock::gen::MIB, from)
    {
        w.write_all(chunk.as_bytes())?;
    }
    w.flush()
}

/// Contents of `fixtures/sample.m3u`.
pub fn sample_m3u() -> &'static str {
    include_str!("../../../fixtures/sample.m3u")
}

/// Contents of `fixtures/sample.xml`.
pub fn sample_xmltv() -> &'static str {
    include_str!("../../../fixtures/sample.xml")
}

/// A v1 playlist backup manifest (C15) with one m3u, one Xtream and one
/// Stalker entry, each carrying favorites, recently viewed, hidden groups or
/// categories and (Xtream) playback positions. Every URL starts with
/// `{mock}`; callers replace it with a mock base.
pub fn backup_manifest_v1() -> String {
    let raw = iptv_mock::gen::sample_m3u(MOCK_PLACEHOLDER);
    let m = MOCK_PLACEHOLDER;
    let live = |id: u32| format!("{m}/xtream/live/demo/secret/{id}.m3u8");
    let manifest: Value = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "exportedAt": "2026-10-01T12:00:00.000Z",
        "includeSecrets": true,
        "settings": { "epgUrls": [format!("{m}/xmltv/sample.xml")] },
        "playlists": [
            {
                "portalType": "m3u",
                "exportedId": "m3u-sample",
                "title": "Mock Sample M3U",
                "autoRefresh": false,
                "position": 0,
                "source": {
                    "kind": "url",
                    "rawM3u": raw,
                    "url": format!("{m}/m3u/sample.m3u"),
                    "userAgent": "IPTVMockAgent/1.0",
                    "referrer": "http://referer.mock/"
                },
                "userState": {
                    "favorites": [live(101), live(113), live(125)],
                    "recentlyViewed": [
                        {
                            "source": "m3u",
                            "id": live(102),
                            "url": live(102),
                            "name": "BBC News",
                            "title": "BBC News",
                            "tvg_id": "bbcnews.uk",
                            "group_title": "News",
                            "category_id": "live",
                            "added_at": "2026-09-30T20:15:00.000Z"
                        },
                        {
                            "source": "m3u",
                            "id": live(114),
                            "url": live(114),
                            "name": "Sky Sports F1",
                            "title": "Sky Sports F1",
                            "group_title": "Sports",
                            "category_id": "live",
                            "added_at": "2026-09-29T18:00:00.000Z"
                        }
                    ],
                    "hiddenGroupTitles": ["Music"]
                }
            },
            {
                "portalType": "xtream",
                "exportedId": "xtream-demo",
                "title": "Mock Xtream",
                "autoRefresh": false,
                "position": 1,
                "connection": {
                    "serverUrl": format!("{m}/xtream"),
                    "username": "demo",
                    "password": "secret"
                },
                "userState": {
                    "hiddenCategories": [
                        { "categoryType": "live", "xtreamId": 3 },
                        { "categoryType": "movies", "xtreamId": 11 }
                    ],
                    "favorites": [
                        { "contentType": "live", "xtreamId": 101, "addedAt": "2026-09-20T10:00:00.000Z", "position": 0 },
                        { "contentType": "movie", "xtreamId": 201, "addedAt": "2026-09-21T10:00:00.000Z", "position": 1 },
                        { "contentType": "series", "xtreamId": 301, "addedAt": "2026-09-22T10:00:00.000Z", "position": 2 }
                    ],
                    "recentlyViewed": [
                        { "contentType": "live", "xtreamId": 102, "viewedAt": "2026-09-30T21:00:00.000Z" },
                        { "contentType": "movie", "xtreamId": 203, "viewedAt": "2026-09-30T19:00:00.000Z" },
                        { "contentType": "series", "xtreamId": 302, "viewedAt": "2026-09-29T19:00:00.000Z" }
                    ],
                    "playbackPositions": [
                        {
                            "contentXtreamId": 203,
                            "contentType": "vod",
                            "positionSeconds": 30,
                            "durationSeconds": 60,
                            "updatedAt": "2026-09-30T19:30:00.000Z"
                        },
                        {
                            "contentXtreamId": 3002,
                            "contentType": "episode",
                            "seriesXtreamId": 301,
                            "seasonNumber": 1,
                            "episodeNumber": 2,
                            "positionSeconds": 12,
                            "durationSeconds": 60,
                            "updatedAt": "2026-09-29T19:40:00.000Z"
                        }
                    ],
                    "sourcePins": []
                }
            },
            {
                "portalType": "stalker",
                "exportedId": "stalker-mag",
                "title": "Mock Stalker",
                "autoRefresh": false,
                "position": 2,
                "connection": {
                    "portalUrl": format!("{m}/stalker/portal.php"),
                    "macAddress": "00:1A:79:00:00:01",
                    "isFullStalkerPortal": false
                },
                "userState": {
                    "favorites": [
                        {
                            "id": "1001",
                            "name": "BBC One",
                            "type": "itv",
                            "category_id": "itv",
                            "logo": format!("{m}/img/logo/bbc1.uk.svg"),
                            "cmd": "ffmpeg http://localhost/ch/1001_",
                            "added": "2026-09-20T10:00:00.000Z"
                        },
                        {
                            "id": "5001",
                            "name": iptv_mock::catalog::MOVIES[0].name,
                            "type": "vod",
                            "category_id": "vod",
                            "cmd": "/media/5001.mpg",
                            "added": "2026-09-21T10:00:00.000Z"
                        }
                    ],
                    "recentlyViewed": [
                        {
                            "id": "1002",
                            "name": "BBC News",
                            "type": "itv",
                            "category_id": "itv",
                            "logo": format!("{m}/img/logo/bbcnews.uk.svg"),
                            "cmd": "ffmpeg http://localhost/ch/1002_",
                            "added": "2026-09-30T21:05:00.000Z"
                        },
                        {
                            "id": "7001",
                            "name": iptv_mock::catalog::SERIES[0].name,
                            "type": "series",
                            "category_id": "series",
                            "cmd": "/media/series/7001.mpg",
                            "added": "2026-09-29T20:00:00.000Z"
                        }
                    ]
                }
            }
        ]
    });
    let mut out = serde_json::to_string_pretty(&manifest).expect("manifest serializes");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_mock_serves_health_and_shuts_down() {
        let m = spawn_mock().await;
        assert!(m.port > 0);
        assert!(m.base.starts_with("http://127.0.0.1:"));
        let body = reqwest::get(m.url("/health"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(body.contains("\"ok\":true"));
        let base = m.base.clone();
        drop(m);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(reqwest::get(format!("{base}/health")).await.is_err());
    }

    #[tokio::test]
    async fn spawned_mock_links_use_its_port() {
        let m = spawn_mock().await;
        let text = reqwest::get(m.url("/m3u/sample.m3u"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(text.contains(&format!("{}/xtream/live/demo/secret/101.m3u8", m.base)));
    }

    #[test]
    fn m3u_text_counts() {
        let t = m3u_text(1_000, 7);
        assert!(t.starts_with("#EXTM3U"));
        assert_eq!(t.matches("#EXTINF").count(), 1_000);
        let groups: std::collections::HashSet<&str> = t
            .lines()
            .filter_map(|l| l.split("group-title=\"").nth(1))
            .filter_map(|r| r.split('"').next())
            .collect();
        assert_eq!(groups.len(), 7);
        assert!(t.contains("radio=\"true\""));
        assert!(t.contains(".mp4"));
        assert!(t.contains("catchup="));
    }

    #[test]
    fn write_m3u_streams_50k() {
        let dir = std::env::temp_dir().join(format!("iptv-fixtures-m3u-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("large.m3u");
        write_m3u(&path, 50_000, 20).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("#EXTINF").count(), 50_000);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_xmltv_hits_target() {
        let dir = std::env::temp_dir().join(format!("iptv-fixtures-xml-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("large.xml");
        write_xmltv(&path, 4).unwrap();
        let len = std::fs::metadata(&path).unwrap().len() as usize;
        assert!(len >= 4 * iptv_mock::gen::MIB, "len {len}");
        assert!(len < 5 * iptv_mock::gen::MIB, "len {len}");
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("<channel id=").count(), 400);
        assert!(text.contains("<![CDATA["));
        assert!(text.contains("&amp;"));
        assert!(text.trim_end().ends_with("</tv>"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn manifest_shape() {
        let text = backup_manifest_v1();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["kind"], "iptvnator-playlist-backup");
        assert_eq!(v["version"], 1);
        let kinds: Vec<&str> = v["playlists"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["portalType"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["m3u", "xtream", "stalker"]);
        assert!(!text.contains("127.0.0.1"));
        assert!(v["playlists"][0]["source"]["rawM3u"]
            .as_str()
            .unwrap()
            .contains("{mock}/xtream/live"));
    }

    #[test]
    fn samples_are_the_fixture_files() {
        assert_eq!(sample_m3u(), iptv_mock::gen::sample_m3u(DEFAULT_BASE));
        assert_eq!(
            sample_xmltv(),
            iptv_mock::gen::sample_xmltv(DEFAULT_BASE, iptv_mock::catalog::EPOCH)
        );
        assert_eq!(sample_m3u().matches("#EXTINF").count(), 25);
    }

    /// `fixtures/backup-v1.json` matches the generator. Regenerate with
    /// `UPDATE_FIXTURES=1 cargo test -p iptv-fixtures`.
    #[test]
    fn backup_fixture_in_sync() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/backup-v1.json");
        let expected = backup_manifest_v1().replace(MOCK_PLACEHOLDER, DEFAULT_BASE);
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::write(&path, &expected).unwrap();
        }
        let actual = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            actual, expected,
            "run UPDATE_FIXTURES=1 cargo test -p iptv-mock -p iptv-fixtures"
        );
    }
}
