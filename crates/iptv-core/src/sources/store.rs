//! SQL for the `sources` table (rows <-> [`Source`]).

use crate::catalog;
use crate::db::{now_rfc3339, to_rfc3339};
use crate::error::{CoreError, CoreResult, RpcErrorCode};
use crate::model::{
    EpgLinks, M3uSourceConfig, Source, SourceKind, StalkerSourceConfig, XtreamSourceConfig,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};

const SELECT_SOURCE: &str = "SELECT s.id, s.kind, s.name, s.position, s.auto_refresh, s.created_at, s.updated_at, s.last_refresh_at, s.last_error, s.config_json, s.epg_json, COALESCE(sc.channel_count, 0), COALESCE(sc.movie_count, 0), COALESCE(sc.series_count, 0), (SELECT count(*) FROM items i WHERE i.source_id = s.id AND i.content_type = 'radio'), s.last_error_code FROM sources s LEFT JOIN source_counts sc ON sc.source_id = s.id";

/// Kind-specific configuration of a source.
#[derive(Debug, Clone, PartialEq)]
pub enum SourceConfig {
    M3u(M3uSourceConfig),
    Xtream(XtreamSourceConfig),
    Stalker(StalkerSourceConfig),
}

impl SourceConfig {
    pub fn kind(&self) -> SourceKind {
        match self {
            Self::M3u(_) => SourceKind::M3u,
            Self::Xtream(_) => SourceKind::Xtream,
            Self::Stalker(_) => SourceKind::Stalker,
        }
    }

    pub fn to_json(&self) -> CoreResult<String> {
        Ok(match self {
            Self::M3u(c) => serde_json::to_string(c)?,
            Self::Xtream(c) => serde_json::to_string(c)?,
            Self::Stalker(c) => serde_json::to_string(c)?,
        })
    }
}

fn read_source(r: &Row<'_>) -> rusqlite::Result<(Source, String)> {
    let kind: String = r.get(1)?;
    let kind = kind.parse::<SourceKind>().unwrap_or(SourceKind::M3u);
    let created: String = r.get(5)?;
    let epg_json: String = r.get(10)?;
    let epg: EpgLinks = serde_json::from_str(&epg_json).unwrap_or_default();
    Ok((
        Source {
            id: r.get(0)?,
            kind,
            name: r.get(2)?,
            position: r.get(3)?,
            auto_refresh: r.get(4)?,
            created_at: to_rfc3339(&created),
            updated_at: r.get::<_, Option<String>>(6)?.map(|s| to_rfc3339(&s)),
            last_refresh_at: r.get::<_, Option<String>>(7)?.map(|s| to_rfc3339(&s)),
            last_error: r.get(8)?,
            // A code is only meaningful next to its message.
            last_error_code: match r.get::<_, Option<String>>(8)? {
                Some(_) => r
                    .get::<_, Option<String>>(15)?
                    .as_deref()
                    .and_then(RpcErrorCode::parse),
                None => None,
            },
            channel_count: r.get(11)?,
            radio_count: r.get(14)?,
            movie_count: r.get(12)?,
            series_count: r.get(13)?,
            epg,
            m3u: None,
            xtream: None,
            stalker: None,
        },
        r.get(9)?,
    ))
}

fn attach_config(mut s: Source, config_json: &str) -> Source {
    match s.kind {
        SourceKind::M3u => match serde_json::from_str(config_json) {
            Ok(c) => s.m3u = Some(c),
            Err(err) => tracing::warn!(source_id = %s.id, %err, "unreadable m3u config"),
        },
        SourceKind::Xtream => match serde_json::from_str(config_json) {
            Ok(c) => s.xtream = Some(c),
            Err(err) => tracing::warn!(source_id = %s.id, %err, "unreadable xtream config"),
        },
        SourceKind::Stalker => match serde_json::from_str(config_json) {
            Ok(c) => s.stalker = Some(c),
            Err(err) => tracing::warn!(source_id = %s.id, %err, "unreadable stalker config"),
        },
    }
    s
}

/// Every source ordered by position.
pub fn list(conn: &Connection) -> CoreResult<Vec<Source>> {
    let sql = format!("{SELECT_SOURCE} ORDER BY s.position, s.created_at, s.id");
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map([], read_source)?;
    let mut out = Vec::new();
    for row in rows {
        let (s, cfg) = row?;
        out.push(attach_config(s, &cfg));
    }
    Ok(out)
}

/// One source, or `None`.
pub fn find(conn: &Connection, id: &str) -> CoreResult<Option<Source>> {
    let sql = format!("{SELECT_SOURCE} WHERE s.id = ?1");
    let mut stmt = conn.prepare_cached(&sql)?;
    Ok(stmt
        .query_row([id], read_source)
        .optional()?
        .map(|(s, cfg)| attach_config(s, &cfg)))
}

/// One source, or NotFound.
pub fn get(conn: &Connection, id: &str) -> CoreResult<Source> {
    find(conn, id)?.ok_or_else(|| CoreError::NotFound(format!("source {id} not found")))
}

/// Inserts a new source at the end of the list. `raw_text` is pasted m3u
/// text with the data dir: it is stored in `m3u_raw` in the same transaction,
/// inline up to `m3u::RAW_INLINE_MAX` and otherwise in the playlist cache
/// (`raw = ''`, see `m3u::place_raw_text`), with its sha256 either way.
pub fn insert(
    conn: &mut Connection,
    id: &str,
    name: &str,
    auto_refresh: bool,
    config: &SourceConfig,
    raw_text: Option<(&std::path::Path, &str)>,
) -> CoreResult<()> {
    // The cache file is written before the transaction so the write lock is
    // not held during a large write; it is removed again if the insert fails.
    let raw = match raw_text {
        Some((data_dir, text)) => {
            use sha2::{Digest, Sha256};
            let sha = hex::encode(Sha256::digest(text.as_bytes()));
            Some((
                crate::m3u::place_raw_text(data_dir, id, text)?,
                sha,
                data_dir,
            ))
        }
        None => None,
    };
    let result = insert_rows(conn, id, name, auto_refresh, config, raw.as_ref());
    if let (Err(_), Some(("", _, data_dir))) = (&result, &raw) {
        let _ = std::fs::remove_file(crate::m3u::cached_playlist_path(data_dir, id));
    }
    result
}

fn insert_rows(
    conn: &mut Connection,
    id: &str,
    name: &str,
    auto_refresh: bool,
    config: &SourceConfig,
    raw: Option<&(&str, String, &std::path::Path)>,
) -> CoreResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM sources",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO sources (id, kind, name, position, auto_refresh, created_at, config_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, config.kind().as_str(), name, position, auto_refresh, now_rfc3339(), config.to_json()?],
    )?;
    if let Some((text, sha, _)) = raw {
        tx.execute(
            "INSERT INTO m3u_raw (source_id, raw, sha256, fetched_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, text, sha, now_rfc3339()],
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO source_counts (source_id) VALUES (?1)",
        [id],
    )?;
    tx.commit()?;
    Ok(())
}

/// Records the outcome of an import: `None` clears `last_error` /
/// `last_error_code`, stamps `last_refresh_at` and refreshes the counts;
/// `Some(message)` stores the message without a code (callers that know the
/// code use [`record_import_error`]) and keeps the catalog.
pub fn record_import(conn: &Connection, id: &str, error: Option<&str>) -> CoreResult<()> {
    match error {
        None => {
            conn.execute(
                "UPDATE sources SET last_refresh_at = ?2, last_error = NULL, last_error_code = NULL WHERE id = ?1",
                params![id, now_rfc3339()],
            )?;
            catalog::update_counts(conn, id)?;
        }
        Some(msg) => {
            // Redacted here too: importers outside `sources` record errors
            // directly, and lastError is shown and exported.
            conn.execute(
                "UPDATE sources SET last_error = ?2, last_error_code = NULL WHERE id = ?1",
                params![id, crate::logging::redact_text(msg)],
            )?;
        }
    }
    Ok(())
}

/// Records a failed import with its classified code (C10); the catalog and
/// `last_refresh_at` are kept.
pub fn record_import_error(
    conn: &Connection,
    id: &str,
    msg: &str,
    code: RpcErrorCode,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE sources SET last_error = ?2, last_error_code = ?3 WHERE id = ?1",
        params![id, crate::logging::redact_text(msg), code.as_str()],
    )?;
    Ok(())
}

/// Moves `id` to `position` (clamped) and renumbers every source 0..n.
pub fn move_to(conn: &mut Connection, id: &str, position: i64) -> CoreResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM sources ORDER BY position, created_at, id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let Some(cur) = ids.iter().position(|x| x == id) else {
        return Err(CoreError::NotFound(format!("source {id} not found")));
    };
    let moved = ids.remove(cur);
    let at = position.clamp(0, ids.len() as i64) as usize;
    ids.insert(at, moved);
    renumber(&tx, &ids)?;
    tx.commit()?;
    Ok(())
}

/// Puts `ids` first in the given order; sources not listed keep their
/// relative order after them. Unknown ids are ignored.
pub fn reorder(conn: &mut Connection, ids: &[String]) -> CoreResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM sources ORDER BY position, created_at, id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut order: Vec<String> = Vec::with_capacity(existing.len());
    for id in ids {
        if existing.contains(id) && !order.contains(id) {
            order.push(id.clone());
        }
    }
    for id in existing {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    renumber(&tx, &order)?;
    tx.commit()?;
    Ok(())
}

fn renumber(conn: &Connection, ids: &[String]) -> CoreResult<()> {
    let mut stmt =
        conn.prepare_cached("UPDATE sources SET position = ?2 WHERE id = ?1 AND position <> ?2")?;
    for (i, id) in ids.iter().enumerate() {
        stmt.execute(params![id, i as i64])?;
    }
    Ok(())
}

/// Deletes a source; catalog, raw playlist, favorites, recent, positions and
/// EPG mappings cascade. Also drops per-source keys in `app_state` (cached
/// stalker session, user state parked by a backup import).
pub fn delete(conn: &mut Connection, id: &str) -> CoreResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let n = tx.execute("DELETE FROM sources WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(CoreError::NotFound(format!("source {id} not found")));
    }
    forget_session(&tx, id)?;
    tx.execute(
        "DELETE FROM app_state WHERE key = 'backup_pending:' || ?1",
        [id],
    )?;
    tx.commit()?;
    Ok(())
}

/// Drops the cached stalker session (`app_state` key `stalker_token:<id>`),
/// so the next portal call handshakes again with the current config.
pub fn forget_session(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM app_state WHERE key = 'stalker_token:' || ?1",
        [id],
    )?;
    Ok(())
}
