//! Manifest v1 export (C15).

use super::{load_sources, ExportResult, BACKUP_KIND, BACKUP_VERSION};
use crate::error::CoreResult;
use crate::model::{ContentType, M3uOrigin, Source, SourceKind};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

/// Builds the export for `backup.export`.
pub async fn export(state: &AppState, include_secrets: bool) -> CoreResult<ExportResult> {
    let epg_urls = state.settings_snapshot().epg_urls;
    let manifest = state
        .db_call(move |c| build_manifest(c, &epg_urls, include_secrets))
        .await?;
    let json = serde_json::to_string_pretty(&manifest)?;
    let date = chrono::Utc::now().format("%Y-%m-%d");
    tracing::info!(
        playlists = manifest["playlists"].as_array().map_or(0, Vec::len),
        include_secrets,
        "backup exported"
    );
    Ok(ExportResult {
        json,
        file_name: format!("tsrust-iptv-backup-{date}.json"),
    })
}

/// The manifest as JSON (one entry per source, in `sources.list` order).
pub fn build_manifest(
    conn: &Connection,
    epg_urls: &[String],
    include_secrets: bool,
) -> CoreResult<Value> {
    let mut playlists = Vec::new();
    for s in load_sources(conn)? {
        let entry = match s.kind {
            SourceKind::M3u => m3u_entry(conn, &s)?,
            SourceKind::Xtream => xtream_entry(conn, &s, include_secrets)?,
            SourceKind::Stalker => stalker_entry(conn, &s, include_secrets)?,
        };
        playlists.push(entry);
    }
    let mut m = Map::new();
    m.insert("kind".into(), json!(BACKUP_KIND));
    m.insert("version".into(), json!(BACKUP_VERSION));
    m.insert("exportedAt".into(), json!(crate::userstate::now_ts()));
    m.insert("includeSecrets".into(), json!(include_secrets));
    let urls: Vec<&String> = epg_urls.iter().filter(|u| !u.trim().is_empty()).collect();
    if !urls.is_empty() {
        m.insert("settings".into(), json!({ "epgUrls": urls }));
    }
    m.insert("playlists".into(), Value::Array(playlists));
    Ok(Value::Object(m))
}

fn base(s: &Source, portal_type: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("portalType".into(), json!(portal_type));
    m.insert("exportedId".into(), json!(s.id));
    m.insert("title".into(), json!(s.name));
    m.insert("autoRefresh".into(), json!(s.auto_refresh));
    m.insert("position".into(), json!(s.position));
    m
}

/// Inserts `key: value` only when the value is a non-empty string.
fn put_str(m: &mut Map<String, Value>, key: &str, v: Option<&str>) {
    if let Some(v) = v.map(str::trim).filter(|v| !v.is_empty()) {
        m.insert(key.into(), json!(v));
    }
}

fn xtream_num(id: &str) -> Option<i64> {
    id.trim().parse::<i64>().ok()
}

fn ts(v: &str) -> String {
    crate::userstate::normalize_ts_str(v).unwrap_or_else(|| v.to_string())
}

// ---------------------------------------------------------------------------
// m3u
// ---------------------------------------------------------------------------

fn m3u_entry(conn: &Connection, s: &Source) -> CoreResult<Value> {
    let cfg = s.m3u.clone();
    let raw: String = conn
        .query_row(
            "SELECT raw FROM m3u_raw WHERE source_id = ?1",
            [&s.id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    if raw.is_empty() {
        tracing::warn!(source_id = %s.id, "m3u source has no stored playlist text; exported entry will be empty");
    }

    let mut source = Map::new();
    let kind = match cfg.as_ref().map(|c| c.origin) {
        Some(M3uOrigin::Url) if cfg.as_ref().and_then(|c| c.url.as_deref()).is_some() => "url",
        Some(M3uOrigin::File) => "file",
        _ => "text",
    };
    source.insert("kind".into(), json!(kind));
    source.insert("rawM3u".into(), json!(raw));
    if let Some(c) = &cfg {
        put_str(&mut source, "url", c.url.as_deref());
        put_str(&mut source, "userAgent", c.headers.user_agent.as_deref());
        put_str(&mut source, "referrer", c.headers.referrer.as_deref());
        put_str(&mut source, "origin", c.headers.origin.as_deref());
        put_str(&mut source, "filePathHint", c.file_path.as_deref());
    }

    // Favorites are channel URLs (the old app's `favorites: string[]`).
    let mut favorites: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT i.url FROM favorites f
             JOIN items i ON i.source_id = f.source_id AND i.content_type = f.content_type AND i.item_id = f.item_id
             WHERE f.source_id = ?1 AND i.url IS NOT NULL AND i.url <> ''
             ORDER BY f.position ASC, f.added_at ASC",
        )?;
        let rows = stmt.query_map([&s.id], |r| r.get::<_, String>(0))?;
        let mut seen = std::collections::HashSet::new();
        for url in rows {
            let url = url?;
            if seen.insert(url.clone()) {
                favorites.push(url);
            }
        }
    }

    // M3uRecentlyViewedItem[]
    let mut recent = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT r.item_id, r.viewed_at, i.url, i.title, i.logo_url, i.epg_channel_id, c.name
             FROM recent r
             JOIN items i ON i.source_id = r.source_id AND i.content_type = r.content_type AND i.item_id = r.item_id
             LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id
             WHERE r.source_id = ?1 AND i.url IS NOT NULL AND i.url <> ''
             ORDER BY r.viewed_at DESC",
        )?;
        let rows = stmt.query_map([&s.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?;
        for row in rows {
            let (id, viewed_at, url, title, logo, tvg_id, group) = row?;
            let mut m = Map::new();
            m.insert("source".into(), json!("m3u"));
            m.insert("id".into(), json!(id));
            m.insert("url".into(), json!(url));
            m.insert("title".into(), json!(title));
            m.insert("category_id".into(), json!("live"));
            m.insert("added_at".into(), json!(ts(&viewed_at)));
            put_str(&mut m, "poster_url", logo.as_deref());
            put_str(&mut m, "tvg_id", tvg_id.as_deref());
            put_str(&mut m, "group_title", group.as_deref());
            recent.push(Value::Object(m));
        }
    }

    let hidden: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT name FROM categories WHERE source_id = ?1 AND hidden = 1 ORDER BY name",
        )?;
        let rows = stmt.query_map([&s.id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };

    let mut m = base(s, "m3u");
    m.insert("source".into(), Value::Object(source));
    m.insert(
        "userState".into(),
        json!({ "favorites": favorites, "recentlyViewed": recent, "hiddenGroupTitles": hidden }),
    );
    Ok(Value::Object(m))
}

// ---------------------------------------------------------------------------
// xtream
// ---------------------------------------------------------------------------

fn xtream_type(ct: &str) -> Option<&'static str> {
    match ct {
        "live" => Some("live"),
        "movie" => Some("movie"),
        "series" => Some("series"),
        _ => None,
    }
}

fn xtream_entry(conn: &Connection, s: &Source, include_secrets: bool) -> CoreResult<Value> {
    let cfg = s.xtream.as_ref();
    let mut connection = Map::new();
    connection.insert(
        "serverUrl".into(),
        json!(cfg.map(|c| c.server_url.as_str()).unwrap_or("")),
    );
    connection.insert(
        "username".into(),
        json!(cfg.map(|c| c.username.as_str()).unwrap_or("")),
    );
    if include_secrets {
        put_str(
            &mut connection,
            "password",
            cfg.map(|c| c.password.as_str()),
        );
    }

    let mut hidden = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT content_type, category_id FROM categories WHERE source_id = ?1 AND hidden = 1
             ORDER BY content_type, position",
        )?;
        let rows = stmt.query_map([&s.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (ct, id) = row?;
            let category_type = match ct.as_str() {
                "live" => "live",
                "movie" => "movies",
                "series" => "series",
                _ => continue,
            };
            if let Some(n) = xtream_num(&id) {
                hidden.push(json!({ "categoryType": category_type, "xtreamId": n }));
            }
        }
    }

    let mut favorites = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT content_type, item_id, added_at, position FROM favorites WHERE source_id = ?1
             ORDER BY position ASC, added_at ASC",
        )?;
        let rows = stmt.query_map([&s.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (ct, id, added_at, position) = row?;
            if let (Some(t), Some(n)) = (xtream_type(&ct), xtream_num(&id)) {
                favorites.push(json!({ "contentType": t, "xtreamId": n, "addedAt": ts(&added_at), "position": position }));
            }
        }
    }

    let mut recent = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT content_type, item_id, viewed_at FROM recent WHERE source_id = ?1 ORDER BY viewed_at DESC",
        )?;
        let rows = stmt.query_map([&s.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (ct, id, viewed_at) = row?;
            if let (Some(t), Some(n)) = (xtream_type(&ct), xtream_num(&id)) {
                recent.push(json!({ "contentType": t, "xtreamId": n, "viewedAt": ts(&viewed_at) }));
            }
        }
    }

    let mut positions = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json
             FROM playback_positions WHERE source_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([&s.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?;
        for row in rows {
            let (ct, item, ep, pos, dur, updated_at, snap) = row?;
            let mut m = Map::new();
            match (ct.as_str(), ep.is_empty()) {
                ("movie", true) => {
                    let Some(n) = xtream_num(&item) else { continue };
                    m.insert("contentXtreamId".into(), json!(n));
                    m.insert("contentType".into(), json!("vod"));
                }
                ("series", false) => {
                    let (Some(e), Some(sid)) = (xtream_num(&ep), xtream_num(&item)) else {
                        continue;
                    };
                    m.insert("contentXtreamId".into(), json!(e));
                    m.insert("contentType".into(), json!("episode"));
                    m.insert("seriesXtreamId".into(), json!(sid));
                    // Season/episode numbers travel in the snapshot (see import).
                    let extra: Value = snap
                        .as_deref()
                        .and_then(|j| serde_json::from_str(j).ok())
                        .unwrap_or(Value::Null);
                    for k in ["seasonNumber", "episodeNumber"] {
                        if let Some(n) = extra.get(k).and_then(Value::as_i64) {
                            m.insert(k.into(), json!(n));
                        }
                    }
                }
                _ => continue,
            }
            m.insert("positionSeconds".into(), json!(pos));
            if let Some(d) = dur {
                m.insert("durationSeconds".into(), json!(d));
            }
            m.insert("playlistId".into(), json!(s.id));
            m.insert("updatedAt".into(), json!(ts(&updated_at)));
            positions.push(Value::Object(m));
        }
    }

    let mut pins = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT match_key, item_id, updated_at FROM vod_source_pins WHERE source_id = ?1 ORDER BY match_key",
        )?;
        let rows = stmt.query_map([&s.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (key, item, updated_at) = row?;
            if let Some(n) = xtream_num(&item) {
                pins.push(json!({ "matchKey": key, "contentId": n, "updatedAt": ts(&updated_at) }));
            }
        }
    }

    let mut m = base(s, "xtream");
    m.insert("connection".into(), Value::Object(connection));
    m.insert(
        "userState".into(),
        json!({
            "hiddenCategories": hidden,
            "favorites": favorites,
            "recentlyViewed": recent,
            "playbackPositions": positions,
            "sourcePins": pins,
        }),
    );
    Ok(Value::Object(m))
}

// ---------------------------------------------------------------------------
// stalker
// ---------------------------------------------------------------------------

/// Stalker portal type name for a content type.
pub(crate) fn stalker_type(ct: ContentType) -> &'static str {
    match ct {
        ContentType::Live => "itv",
        ContentType::Radio => "radio",
        ContentType::Movie => "vod",
        ContentType::Series => "series",
    }
}

fn stalker_entry(conn: &Connection, s: &Source, include_secrets: bool) -> CoreResult<Value> {
    let mut connection = Map::new();
    if let Some(c) = &s.stalker {
        connection.insert("portalUrl".into(), json!(c.portal_url));
        connection.insert("macAddress".into(), json!(c.mac_address));
        connection.insert("isFullStalkerPortal".into(), json!(c.is_full_portal));
        put_str(&mut connection, "username", c.username.as_deref());
        put_str(
            &mut connection,
            "userAgent",
            c.headers.user_agent.as_deref(),
        );
        put_str(&mut connection, "referrer", c.headers.referrer.as_deref());
        put_str(&mut connection, "origin", c.headers.origin.as_deref());
        put_str(
            &mut connection,
            "stalkerSerialNumber",
            c.serial_number.as_deref(),
        );
        put_str(&mut connection, "stalkerDeviceId1", c.device_id1.as_deref());
        put_str(&mut connection, "stalkerDeviceId2", c.device_id2.as_deref());
        if include_secrets {
            put_str(&mut connection, "password", c.password.as_deref());
            put_str(
                &mut connection,
                "stalkerSignature1",
                c.signature1.as_deref(),
            );
            put_str(
                &mut connection,
                "stalkerSignature2",
                c.signature2.as_deref(),
            );
        }
    } else {
        connection.insert("portalUrl".into(), json!(""));
        connection.insert("macAddress".into(), json!(""));
    }

    let favorites = stalker_items(
        conn,
        "SELECT content_type, item_id, added_at, snapshot_json FROM favorites WHERE source_id = ?1
         ORDER BY position ASC, added_at ASC",
        &s.id,
    )?;
    let recent = stalker_items(
        conn,
        "SELECT content_type, item_id, viewed_at, snapshot_json FROM recent WHERE source_id = ?1
         ORDER BY viewed_at DESC",
        &s.id,
    )?;

    let mut m = base(s, "stalker");
    m.insert("connection".into(), Value::Object(connection));
    m.insert(
        "userState".into(),
        json!({ "favorites": favorites, "recentlyViewed": recent }),
    );
    Ok(Value::Object(m))
}

/// Rebuilds `StalkerPortalItem`s: the original portal object when the row
/// came from a backup (kept under `portalItem` in the snapshot), else a
/// minimal one from the snapshot.
fn stalker_items(conn: &Connection, sql: &str, source_id: &str) -> CoreResult<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![source_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (ct, id, at, snap) = row?;
        let ct: ContentType = ct.parse().unwrap_or(ContentType::Live);
        let snap: Value = serde_json::from_str(&snap).unwrap_or(Value::Null);
        let mut item = match snap.get("portalItem") {
            Some(Value::Object(o)) => o.clone(),
            _ => Map::new(),
        };
        let title = snap
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        item.entry("id").or_insert_with(|| json!(id));
        item.entry("name").or_insert_with(|| json!(title));
        item.entry("title").or_insert_with(|| json!(title));
        item.entry("type")
            .or_insert_with(|| json!(stalker_type(ct)));
        item.entry("category_id")
            .or_insert_with(|| json!(stalker_type(ct)));
        if let Some(p) = snap.get("posterUrl").and_then(Value::as_str) {
            item.entry("logo").or_insert_with(|| json!(p));
            item.entry("cover").or_insert_with(|| json!(p));
        }
        item.insert("added_at".into(), json!(ts(&at)));
        out.push(Value::Object(item));
    }
    Ok(out)
}
