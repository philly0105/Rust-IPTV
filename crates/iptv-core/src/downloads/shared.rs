//! Types, constants and helpers the download engine's parts share: sample
//! windows for fingerprints, `app_state` keys for mirror and connection-limit
//! records, and [`resolve`], which turns any copy of a title into the URL
//! its bytes come from right now.

use crate::error::{CoreError, CoreResult};
use crate::model::{
    ConnectionLimitMode, ContentType, CopyRef, ItemRef, RequestHeaders, SourceKind,
};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use std::sync::Arc;

/// Bytes in one fingerprint sample window.
pub const SAMPLE_LEN: i64 = 64 * 1024;
/// Bytes a mirror's first range overlaps what another connection already
/// wrote, so the junction can be compared.
pub const OVERLAP: i64 = 64 * 1024;
/// `app_state` key prefix of [`MirrorRecord`]s.
pub const MIRROR_KEY_PREFIX: &str = "dl_mirror:";
/// `app_state` key prefix of [`LimitRecord`]s.
pub const LIMIT_KEY_PREFIX: &str = "dl_conn_limit:";
/// Smallest file mirrors and fingerprints apply to.
pub const MIN_MIRROR_TOTAL: i64 = 8 * 1024 * 1024;

/// Start offsets of the three sample windows:
/// `[0, align_down(total / 2, SAMPLE_LEN), total - SAMPLE_LEN]`. The caller
/// guarantees `total >= MIN_MIRROR_TOTAL`.
pub fn sample_offsets(total: i64) -> [i64; 3] {
    [0, (total / 2) / SAMPLE_LEN * SAMPLE_LEN, total - SAMPLE_LEN]
}

/// `dl_mirror:<sourceId>:<first 16 hex digits of sha256(contentType "\0"
/// itemId "\0" episodeId-or-empty)>`. The source id stays readable so a
/// source delete can drop its records by prefix.
pub fn mirror_key(copy: &CopyRef) -> String {
    let r = &copy.item_ref;
    let mut h = Sha256::new();
    h.update(r.content_type.as_str().as_bytes());
    h.update([0]);
    h.update(r.item_id.as_bytes());
    h.update([0]);
    h.update(copy.episode_id.as_deref().unwrap_or("").as_bytes());
    let digest = hex::encode(h.finalize());
    format!("{MIRROR_KEY_PREFIX}{}:{}", r.source_id, &digest[..16])
}

/// `dl_conn_limit:<sourceId>`.
pub fn limit_key(source_id: &str) -> String {
    format!("{LIMIT_KEY_PREFIX}{source_id}")
}

/// The `app_state` record under `key`. A value that no longer parses reads
/// as `None`, so a format change costs a re-check, not an error.
pub fn read_record<T: DeserializeOwned>(conn: &Connection, key: &str) -> CoreResult<Option<T>> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM app_state WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(value.and_then(|v| serde_json::from_str(&v).ok()))
}

/// Writes (or replaces) the `app_state` record under `key`.
pub fn write_record<T: Serialize>(conn: &Connection, key: &str, record: &T) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, serde_json::to_string(record)?],
    )?;
    Ok(())
}

/// Drops the `app_state` record under `key`, if any.
pub fn delete_record(conn: &Connection, key: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM app_state WHERE key = ?1", [key])?;
    Ok(())
}

/// A resolved copy: where its bytes come from right now. `Debug` masks the
/// credentials Xtream and Stalker URLs carry.
#[derive(Clone)]
pub struct Endpoint {
    pub copy: CopyRef,
    pub kind: SourceKind,
    pub url: String,
    pub headers: RequestHeaders,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("copy", &self.copy)
            .field("kind", &self.kind)
            .field("url", &crate::logging::redact_url(&self.url))
            .field("headers", &self.headers)
            .finish()
    }
}

/// Resolves a copy's stream URL the way `transfer::refresh_url` does:
/// - Xtream: `xtream::service::stream_url`.
/// - Stalker: `stalker::playback::stream_url`.
/// - M3U: the catalog row's `url` for a movie (the entry's headers over the
///   playlist's), `m3u::series::stream_url` for an episode.
/// - Live, Radio, an unknown source kind or a removed source:
///   `Err(CoreError::unsupported | not_found)`. So is a URL that is not
///   http(s).
/// - Headers: the source's (`PlayerSource.headers.unwrap_or_default()`).
///
/// Never persists anything.
pub async fn resolve(state: &Arc<AppState>, copy: &CopyRef) -> CoreResult<Endpoint> {
    let r = &copy.item_ref;
    if matches!(r.content_type, ContentType::Live | ContentType::Radio) {
        return Err(CoreError::Unsupported(
            "only movies and episodes have copies to download from".into(),
        ));
    }
    let sid = r.source_id.clone();
    let kind = state
        .db_call(move |c| {
            Ok(
                c.query_row("SELECT kind FROM sources WHERE id = ?1", [&sid], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?,
            )
        })
        .await?
        .ok_or_else(|| CoreError::not_found(format!("source {} not found", r.source_id)))?;
    let kind = SourceKind::from_str(&kind)
        .map_err(|_| CoreError::Unsupported(format!("unknown source kind \"{kind}\"")))?;
    let episode = copy.episode_id.as_deref();
    let (url, headers) = match kind {
        SourceKind::Xtream => {
            let src = crate::xtream::service::stream_url(state, r, episode).await?;
            (src.url, src.headers.unwrap_or_default())
        }
        SourceKind::Stalker => {
            let src = crate::stalker::playback::stream_url(state, r, episode).await?;
            (src.url, src.headers.unwrap_or_default())
        }
        SourceKind::M3u if r.content_type == ContentType::Series => {
            let src = crate::m3u::series::stream_url(state, r, episode).await?;
            (src.url, src.headers.unwrap_or_default())
        }
        SourceKind::M3u => m3u_movie(state, r).await?,
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(CoreError::Unsupported(
            "this copy does not stream over HTTP, so it cannot be downloaded".into(),
        ));
    }
    Ok(Endpoint {
        copy: copy.clone(),
        kind,
        url,
        headers,
    })
}

/// An M3U movie's playlist link, with the entry's headers over the
/// playlist's, field by field.
async fn m3u_movie(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<(String, RequestHeaders)> {
    let key = r.clone();
    let row = state
        .db_call(move |c| crate::catalog::get_named(c, &key))
        .await?
        .ok_or_else(|| {
            CoreError::not_found("This movie is no longer in the playlist. Refresh the source.")
        })?
        .row;
    let url = row
        .url
        .clone()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .ok_or_else(|| CoreError::not_found("This movie has no stream link in the playlist."))?;
    let base = crate::sources::get(state, &r.source_id)
        .await
        .ok()
        .and_then(|s| s.m3u)
        .map(|m| m.headers)
        .unwrap_or_default();
    let own = row.headers().unwrap_or_default();
    let pick = |a: Option<String>, b: Option<String>| {
        a.filter(|v| !v.trim().is_empty())
            .or_else(|| b.filter(|v| !v.trim().is_empty()))
    };
    Ok((
        url,
        RequestHeaders {
            user_agent: pick(own.user_agent, base.user_agent),
            referrer: pick(own.referrer, base.referrer),
            origin: pick(own.origin, base.origin),
        },
    ))
}

/// Size and three sample hashes of one copy's bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub total: i64,
    /// ETag or Last-Modified of the first sample's answer.
    pub validator: Option<String>,
    /// Lowercase hex SHA-256 of each 64 KiB window ([`sample_offsets`]).
    pub samples: [String; 3],
    /// RFC 3339.
    pub checked_at: String,
}

/// How another copy compared with a record's copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// Same total and all three samples equal.
    Identical,
    Differs,
    /// Not identical, but close enough for `downloadAllowEquivalent`.
    Equivalent,
    /// Could not be checked (no ranges, refused, failed).
    Unavailable,
}

/// One comparison in a [`MirrorRecord`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictEntry {
    pub copy: CopyRef,
    pub verdict: Verdict,
    pub total: Option<i64>,
    pub validator: Option<String>,
    /// RFC 3339.
    pub checked_at: String,
}

/// `app_state` value under [`mirror_key`] of `copy`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorRecord {
    /// 1.
    pub version: u32,
    pub copy: CopyRef,
    pub fingerprint: Option<Fingerprint>,
    /// At most 50; the newest `checked_at` wins per copy.
    pub verdicts: Vec<VerdictEntry>,
}

/// How one probe step ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeOutcome {
    /// The panel kept every connection open.
    Accepted,
    /// The panel refused the extra connection.
    Refused,
    /// The panel accepted the extra connection and ended the oldest.
    KickedOldest,
    /// The probe stopped early (the transfer ended, playback started).
    Aborted,
}

/// One step of a connection-limit probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStep {
    /// RFC 3339.
    pub at: String,
    pub connections: i64,
    pub outcome: ProbeOutcome,
}

/// `app_state` value under [`limit_key`] of a source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitRecord {
    /// 1.
    pub version: u32,
    /// Most concurrent connections the panel kept open.
    pub limit: i64,
    /// The account's `max_connections` when probed.
    pub reported: Option<i64>,
    /// How the round ended.
    pub mode: ConnectionLimitMode,
    /// RFC 3339.
    pub probed_at: String,
    /// RFC 3339; `probed_at` plus 7 days.
    pub next_probe_at: String,
    /// The last 20 steps.
    pub history: Vec<ProbeStep>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ItemRef;

    #[test]
    fn sample_offsets_align_the_middle_window() {
        let total = MIN_MIRROR_TOTAL + 12_345;
        let [a, b, c] = sample_offsets(total);
        assert_eq!(a, 0);
        assert_eq!(b % SAMPLE_LEN, 0);
        assert!(b <= total / 2 && total / 2 - b < SAMPLE_LEN);
        assert_eq!(c, total - SAMPLE_LEN);
        assert_eq!(
            sample_offsets(MIN_MIRROR_TOTAL),
            [0, MIN_MIRROR_TOTAL / 2, MIN_MIRROR_TOTAL - SAMPLE_LEN]
        );
    }

    #[test]
    fn keys_follow_the_contract() {
        assert_eq!(limit_key("xt-a"), "dl_conn_limit:xt-a");
        let movie = CopyRef::new(ItemRef::new("xt_a", ContentType::Movie, "77"), None);
        let key = mirror_key(&movie);
        let mut h = Sha256::new();
        h.update(b"movie\x0077\x00");
        let want = hex::encode(h.finalize());
        assert_eq!(key, format!("dl_mirror:xt_a:{}", &want[..16]));
        assert!(key.starts_with(MIRROR_KEY_PREFIX));
        // The episode, the type and the source all change the key.
        let ep = |e: &str| {
            mirror_key(&CopyRef::new(
                ItemRef::new("xt_a", ContentType::Series, "77"),
                Some(e.into()),
            ))
        };
        assert_ne!(ep("1"), ep("2"));
        assert_ne!(ep("1"), key);
        let other = CopyRef::new(ItemRef::new("xt_b", ContentType::Movie, "77"), None);
        assert!(mirror_key(&other).starts_with("dl_mirror:xt_b:"));
        assert_eq!(
            mirror_key(&other).rsplit(':').next(),
            key.rsplit(':').next(),
            "the hash covers the item, not the source"
        );
    }

    #[test]
    fn records_round_trip_in_camel_case() {
        let copy = CopyRef::new(ItemRef::new("a", ContentType::Movie, "1"), None);
        let fp = Fingerprint {
            total: MIN_MIRROR_TOTAL,
            validator: Some("\"etag\"".into()),
            samples: ["a".into(), "b".into(), "c".into()],
            checked_at: "2026-11-17T08:00:00Z".into(),
        };
        let rec = MirrorRecord {
            version: 1,
            copy: copy.clone(),
            fingerprint: Some(fp),
            verdicts: vec![VerdictEntry {
                copy,
                verdict: Verdict::Identical,
                total: Some(MIN_MIRROR_TOTAL),
                validator: None,
                checked_at: "2026-11-17T08:00:00Z".into(),
            }],
        };
        let v = serde_json::to_value(&rec).unwrap();
        assert_eq!(v["fingerprint"]["checkedAt"], "2026-11-17T08:00:00Z");
        assert_eq!(v["verdicts"][0]["verdict"], "identical");
        assert_eq!(serde_json::from_value::<MirrorRecord>(v).unwrap(), rec);
        let lim = LimitRecord {
            version: 1,
            limit: 2,
            reported: Some(1),
            mode: ConnectionLimitMode::KickOldest,
            probed_at: "2026-11-17T08:00:00Z".into(),
            next_probe_at: "2026-11-24T08:00:00Z".into(),
            history: vec![ProbeStep {
                at: "2026-11-17T08:00:00Z".into(),
                connections: 3,
                outcome: ProbeOutcome::KickedOldest,
            }],
        };
        let v = serde_json::to_value(&lim).unwrap();
        assert_eq!(v["nextProbeAt"], "2026-11-24T08:00:00Z");
        assert_eq!(v["history"][0]["outcome"], "kickedOldest");
        assert_eq!(serde_json::from_value::<LimitRecord>(v).unwrap(), lim);
    }

    #[test]
    fn records_store_in_app_state() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)",
        )
        .unwrap();
        let key = limit_key("s");
        assert_eq!(read_record::<LimitRecord>(&conn, &key).unwrap(), None);
        let mut rec = LimitRecord {
            version: 1,
            limit: 2,
            reported: None,
            mode: ConnectionLimitMode::Refuse,
            probed_at: "x".into(),
            next_probe_at: "y".into(),
            history: vec![],
        };
        write_record(&conn, &key, &rec).unwrap();
        rec.limit = 3;
        write_record(&conn, &key, &rec).unwrap();
        assert_eq!(read_record::<LimitRecord>(&conn, &key).unwrap(), Some(rec));
        conn.execute("UPDATE app_state SET value = '{' WHERE key = ?1", [&key])
            .unwrap();
        assert_eq!(read_record::<LimitRecord>(&conn, &key).unwrap(), None);
        delete_record(&conn, &key).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn endpoint_debug_masks_credentials() {
        let ep = Endpoint {
            copy: CopyRef::new(ItemRef::new("a", ContentType::Movie, "1"), None),
            kind: SourceKind::Xtream,
            url: "http://h.example/movie/user1/pass1/1.mp4".into(),
            headers: RequestHeaders::default(),
        };
        let s = format!("{ep:?}");
        assert!(!s.contains("pass1"), "{s}");
    }
}
