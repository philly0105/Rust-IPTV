//! `sourcePins.*` (SPEC C4): the preferred copy of a VOD title that several
//! sources carry ("Other sources" on a detail page), stored in
//! `vod_source_pins` (C3). A pin is keyed by the title's match key (the
//! normalized title base plus the year, built by `src/features/vod/lib/pins.ts`),
//! so there is one pin per title across every source. Backups export and
//! import the table (`backup::export`, `backup::import`).

use super::now_ts;
use crate::error::{CoreError, CoreResult, RpcError};
use crate::model::{ContentType, ItemRef};
use crate::rpc::RpcRouter;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Every `sourcePins.*` command.
pub const COMMANDS: &[&str] = &["sourcePins.get", "sourcePins.set", "sourcePins.clear"];

/// Longest match key accepted (bytes).
pub const MAX_KEY_LEN: usize = 512;

/// The copy a title is pinned to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePin {
    pub source_id: String,
    pub item_id: String,
    pub updated_at: String,
}

fn check_key(key: &str) -> CoreResult<()> {
    if key.trim().is_empty() || key.len() > MAX_KEY_LEN {
        return Err(CoreError::invalid(format!(
            "matchKey must hold 1 to {MAX_KEY_LEN} bytes"
        )));
    }
    Ok(())
}

/// The pin of `key`, if any.
pub fn get(conn: &Connection, key: &str) -> CoreResult<Option<SourcePin>> {
    check_key(key)?;
    Ok(conn
        .query_row(
            "SELECT source_id, item_id, updated_at FROM vod_source_pins WHERE match_key = ?1",
            [key],
            |r| {
                Ok(SourcePin {
                    source_id: r.get(0)?,
                    item_id: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Pins `key` to `item_ref` (a movie or series of an existing source),
/// replacing any earlier pin of the key.
pub fn set(conn: &Connection, key: &str, item_ref: &ItemRef) -> CoreResult<SourcePin> {
    check_key(key)?;
    if !matches!(item_ref.content_type, ContentType::Movie | ContentType::Series) {
        return Err(CoreError::invalid("only movies and series can be pinned"));
    }
    let known: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sources WHERE id = ?1",
            [&item_ref.source_id],
            |r| r.get(0),
        )
        .optional()?;
    if known.is_none() {
        return Err(CoreError::NotFound("the source no longer exists".into()));
    }
    let pin = SourcePin {
        source_id: item_ref.source_id.clone(),
        item_id: item_ref.item_id.clone(),
        updated_at: now_ts(),
    };
    conn.execute(
        "INSERT INTO vod_source_pins(match_key, source_id, item_id, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(match_key) DO UPDATE SET source_id = excluded.source_id, item_id = excluded.item_id, updated_at = excluded.updated_at",
        params![key, pin.source_id, pin.item_id, pin.updated_at],
    )?;
    Ok(pin)
}

/// Removes the pin of `key`; nothing to remove is not an error.
pub fn clear(conn: &Connection, key: &str) -> CoreResult<()> {
    check_key(key)?;
    conn.execute("DELETE FROM vod_source_pins WHERE match_key = ?1", [key])?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyArgs {
    match_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetArgs {
    match_key: String,
    #[serde(rename = "ref")]
    item_ref: ItemRef,
}

/// Registers every `sourcePins.*` command.
pub fn register(r: &mut RpcRouter) {
    r.add("sourcePins.get", |state, a: KeyArgs| async move {
        let pin = state.db_call(move |c| get(c, &a.match_key)).await?;
        Ok::<Option<SourcePin>, RpcError>(pin)
    });
    r.add("sourcePins.set", |state, a: SetArgs| async move {
        let pin = state
            .db_call(move |c| set(c, &a.match_key, &a.item_ref))
            .await?;
        Ok::<SourcePin, RpcError>(pin)
    });
    r.add("sourcePins.clear", |state, a: KeyArgs| async move {
        state.db_call(move |c| clear(c, &a.match_key)).await?;
        Ok::<(), RpcError>(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE sources (id TEXT PRIMARY KEY);
             CREATE TABLE vod_source_pins (match_key TEXT PRIMARY KEY, source_id TEXT NOT NULL, item_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
             INSERT INTO sources (id) VALUES ('a'), ('b');",
        )
        .unwrap();
        c
    }

    fn movie(source: &str, item: &str) -> ItemRef {
        ItemRef::new(source, ContentType::Movie, item)
    }

    #[test]
    fn set_replaces_get_reads_and_clear_removes() {
        let c = conn();
        assert_eq!(get(&c, "dune|2021").unwrap(), None);
        let first = set(&c, "dune|2021", &movie("a", "1")).unwrap();
        assert_eq!(get(&c, "dune|2021").unwrap(), Some(first));
        let second = set(&c, "dune|2021", &movie("b", "7")).unwrap();
        assert_eq!(second.source_id, "b");
        assert_eq!(get(&c, "dune|2021").unwrap(), Some(second));
        clear(&c, "dune|2021").unwrap();
        assert_eq!(get(&c, "dune|2021").unwrap(), None);
        clear(&c, "dune|2021").unwrap();
    }

    #[test]
    fn refuses_bad_keys_live_refs_and_unknown_sources() {
        let c = conn();
        assert!(matches!(get(&c, " "), Err(CoreError::Invalid(_))));
        let long = "x".repeat(MAX_KEY_LEN + 1);
        assert!(matches!(
            set(&c, &long, &movie("a", "1")),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            set(&c, "k", &ItemRef::new("a", ContentType::Live, "1")),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            set(&c, "k", &movie("gone", "1")),
            Err(CoreError::NotFound(_))
        ));
    }
}
