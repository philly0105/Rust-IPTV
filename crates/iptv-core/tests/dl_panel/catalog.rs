//! Sources and catalog rows for panels, written the way an import writes
//! them, so the app's own lookups find them: `catalog::same_title` (base
//! title, NOCASE, compatible year), `xtream::service::stream_url` (the
//! row's container extension), the account limit the download manager
//! reads (`account_status:<sourceId>`).
//!
//! These helpers own the catalogs of the sources they write: each call
//! rewrites the source's rows of that type through `catalog::replace_catalog`
//! (the import path, which fills `title_base` and the search index), keeping
//! the rows already there.

use super::Panel;
use iptv_core::catalog::{self, CategoryRow, ItemRow};
use iptv_core::model::{ContentType, ItemRef};
use iptv_core::AppState;
use std::sync::Arc;

/// Credentials of every panel source (panels accept any).
pub const USERNAME: &str = "u";
pub const PASSWORD: &str = "p";

/// The one category the helpers file rows under.
const CATEGORY: &str = "dl";

/// Inserts an Xtream source `id` on `panel` (`serverUrl` = `panel.base`,
/// username `u`, password `p`) and caches its account status through the
/// app's own account check, so `max_connections` is whatever
/// [`Panel::set_reported`] says at this moment (0: unlimited). Call
/// `set_reported` first. Returns `id`.
pub async fn add_xtream_source(state: &Arc<AppState>, id: &str, panel: &Panel) -> String {
    let cfg = serde_json::json!({
        "serverUrl": panel.base,
        "username": USERNAME,
        "password": PASSWORD,
    })
    .to_string();
    let (sid, name) = (id.to_string(), format!("Panel {id}"));
    state
        .db_write(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', ?2, ?3)",
                rusqlite::params![sid, name, cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap_or_else(|e| panic!("dl_panel: could not add source {id}: {e}"));
    let status = iptv_core::account::status(state, id, true)
        .await
        .unwrap_or_else(|e| panic!("dl_panel: account check of {id} failed: {e}"))
        .unwrap_or_else(|| panic!("dl_panel: source {id} has no account status"));
    assert!(
        status.error.is_none(),
        "dl_panel: account check of {id} failed: {:?}",
        status.error
    );
    id.to_string()
}

/// A movie row `item_id` on `source` (the panel serves it as file
/// `item_id` at [`Panel::movie_url`]). `title` may carry a year or tags
/// ("EN - Heat (1995) [4K]"); `title_base` is derived from it as on import.
pub async fn add_movie(
    state: &Arc<AppState>,
    source: &str,
    item_id: u32,
    title: &str,
    year: Option<i32>,
    ext: &str,
) {
    let row = ItemRow {
        source_id: source.to_string(),
        content_type: ContentType::Movie,
        item_id: item_id.to_string(),
        category_id: CATEGORY.into(),
        title: title.to_string(),
        year: year.map(i64::from),
        container_extension: Some(ext.trim_start_matches('.').to_string()),
        ..ItemRow::default()
    };
    put(state, row).await;
}

/// A series row `series_id` on `source`. Its episodes come from the panel's
/// `get_series_info` ([`Panel::series`]).
pub async fn add_series(state: &Arc<AppState>, source: &str, series_id: u32, title: &str) {
    let row = ItemRow {
        source_id: source.to_string(),
        content_type: ContentType::Series,
        item_id: series_id.to_string(),
        category_id: CATEGORY.into(),
        title: title.to_string(),
        ..ItemRow::default()
    };
    put(state, row).await;
}

/// The reference of movie `item_id` on `source`.
pub fn movie_ref(source: &str, item_id: u32) -> ItemRef {
    ItemRef::new(source, ContentType::Movie, item_id.to_string())
}

/// The reference of series `series_id` on `source`.
pub fn series_ref(source: &str, series_id: u32) -> ItemRef {
    ItemRef::new(source, ContentType::Series, series_id.to_string())
}

/// Rewrites `row`'s source and type with `row` added (or replacing the row
/// with the same id), the other rows kept in order.
async fn put(state: &Arc<AppState>, row: ItemRow) {
    let what = format!(
        "{} {} on {}",
        row.content_type.as_str(),
        row.item_id,
        row.source_id
    );
    state
        .db_write(move |c| {
            let ct = row.content_type;
            let ids: Vec<String> = {
                let mut st = c.prepare(
                    "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = ?2 ORDER BY position",
                )?;
                let ids = st
                    .query_map(rusqlite::params![row.source_id, ct.as_str()], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                ids
            };
            let mut rows = Vec::with_capacity(ids.len() + 1);
            for id in ids.iter().filter(|id| **id != row.item_id) {
                let r = ItemRef::new(row.source_id.clone(), ct, id.clone());
                rows.extend(catalog::get(c, &r)?);
            }
            let source = row.source_id.clone();
            rows.push(row);
            for (i, r) in rows.iter_mut().enumerate() {
                r.position = i as i64;
            }
            let categories = [CategoryRow {
                category_id: CATEGORY.into(),
                name: "Downloads".into(),
                position: 0,
            }];
            catalog::replace_catalog(c, &source, ct, &categories, &mut rows.into_iter())?;
            Ok(())
        })
        .await
        .unwrap_or_else(|e| panic!("dl_panel: could not write {what}: {e}"));
}
