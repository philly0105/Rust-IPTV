//! VOD browsing filters (Run 2 contract C4): year range and "Hide watched"
//! for `catalog.movies` / `catalog.series`, and the year facets behind the
//! decade chips (`catalog.yearFacets`). See `docs/architecture/vod-browsing.md`.
//!
//! [`vod_filter_sql`] is appended by [`super::query_named`] to both the count
//! and the page statement, so `total` always counts the filtered set.
//!
//! - Year bounds compare `items.year`; a NULL year fails every comparison, so
//!   titles without a year drop out as soon as either bound is set.
//! - "Hide watched" drops titles with an item-level watched row
//!   (`playback_positions.episode_id = ''` and `watched = 1`, the definition
//!   shared with [`crate::userstate::watched`]). It is one non-correlated
//!   `i.rowid NOT IN (...)` set built once per statement from the watched
//!   rows (few, whatever the catalog size) joined to `items` by primary key,
//!   like the parental hide filter: the rowid is in every index, so a
//!   `count(*)` over 50k titles stays an index-only scan.
//!
//! Stalker portals page VOD live (nothing in `items`), so their facets are
//! empty and the UI filters loaded pages itself (fixed decade chips).

use super::english_scoped;
use crate::error::{CoreError, CoreResult, RpcError};
use crate::model::ContentType;
use crate::parental::{self, Hide};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;
use std::sync::Arc;

/// Years a filter bound may name; facets outside it are left out too (a
/// provider's `0` or `20210` is junk, and no chip could select it).
pub const YEAR_RANGE: RangeInclusive<i32> = 1900..=2100;

/// Year range and watched filter of one VOD query; the default is empty.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VodFilter {
    pub year_from: Option<i32>,
    pub year_to: Option<i32>,
    pub hide_watched: bool,
}

impl VodFilter {
    /// True when the filter adds nothing to a query.
    pub fn is_empty(&self) -> bool {
        self.year_from.is_none() && self.year_to.is_none() && !self.hide_watched
    }
}

/// Years 1900..=2100 and `year_from <= year_to`, else invalid.
pub fn validate(f: &VodFilter) -> CoreResult<()> {
    for (name, v) in [("yearFrom", f.year_from), ("yearTo", f.year_to)] {
        if let Some(y) = v {
            if !YEAR_RANGE.contains(&y) {
                return Err(CoreError::Invalid(format!(
                    "{name} must be a year from {} to {}, got {y}",
                    YEAR_RANGE.start(),
                    YEAR_RANGE.end()
                )));
            }
        }
    }
    if let (Some(from), Some(to)) = (f.year_from, f.year_to) {
        if from > to {
            return Err(CoreError::Invalid(format!(
                "yearFrom ({from}) must not be after yearTo ({to})"
            )));
        }
    }
    Ok(())
}

/// Rowids of items with an item-level watched row, for an `i.rowid NOT IN`.
const WATCHED_ROWIDS: &str = "SELECT it.rowid FROM playback_positions p JOIN items it ON it.source_id = p.source_id AND it.content_type = p.content_type AND it.item_id = p.item_id WHERE p.episode_id = '' AND p.watched = 1";

/// Appends " AND ..." for an `items i` alias, pushing bound values onto
/// `args`. Empty string when the filter is empty.
///
/// A single bound is closed with the end of [`YEAR_RANGE`], so a junk year
/// (`0`, `20210`) drops out like a missing one, as it does from the facets.
pub fn vod_filter_sql(f: &VodFilter, args: &mut Vec<SqlValue>) -> String {
    vod_filter_sql_on(f, "i.year", args)
}

/// [`vod_filter_sql`] comparing `year_col` (`i.year`, or `+i.year` in a page
/// statement sorted by another key, which keeps the year range off the index
/// choice so the sort's index answers the page without a temp b-tree).
pub fn vod_filter_sql_on(f: &VodFilter, year_col: &str, args: &mut Vec<SqlValue>) -> String {
    let mut sql = String::new();
    if f.year_from.is_some() || f.year_to.is_some() {
        let from = f.year_from.unwrap_or(*YEAR_RANGE.start());
        let to = f.year_to.unwrap_or(*YEAR_RANGE.end());
        args.push(i64::from(from).into());
        sql.push_str(&format!(" AND {year_col} >= ?{}", args.len()));
        args.push(i64::from(to).into());
        sql.push_str(&format!(" AND {year_col} <= ?{}", args.len()));
    }
    if f.hide_watched {
        sql.push_str(" AND i.rowid NOT IN (");
        sql.push_str(WATCHED_ROWIDS);
        sql.push(')');
    }
    sql
}

/// Years present (count per year, newest first). Hidden categories excluded.
pub fn year_facets(
    conn: &Connection,
    source_id: &str,
    ct: ContentType,
    category_id: Option<&str>,
) -> CoreResult<Vec<(i32, i64)>> {
    year_facets_filtered(conn, source_id, ct, category_id, false, None, false)
}

/// [`year_facets`] over the set the grid shows: `english_only` drops titles
/// that are clearly in another language, `hide` parentally locked ones and
/// `hide_watched` titles with an item-level watched row, exactly as
/// `catalog.movies` / `catalog.series` do. Without a category, titles in
/// hidden categories are left out.
pub fn year_facets_filtered(
    conn: &Connection,
    source_id: &str,
    ct: ContentType,
    category_id: Option<&str>,
    english_only: bool,
    hide: Option<Hide>,
    hide_watched: bool,
) -> CoreResult<Vec<(i32, i64)>> {
    let mut args: Vec<SqlValue> = vec![
        source_id.to_string().into(),
        ct.as_str().to_string().into(),
        i64::from(*YEAR_RANGE.start()).into(),
        i64::from(*YEAR_RANGE.end()).into(),
    ];
    let mut where_sql = String::from("i.source_id = ?1 AND i.content_type = ?2");
    let mut year_key = "i.year";
    match category_id {
        Some(cat) => {
            // `+` keeps the year (range and grouping) off the index choice:
            // without table statistics SQLite took idx_items_year for it and
            // walked every title of the source (about 40-80 ms on 100k)
            // instead of the category's few hundred through idx_items_cat,
            // which holds the year since migration 0018.
            year_key = "+i.year";
            args.push(cat.to_string().into());
            where_sql.push_str(&format!(
                " AND +i.year BETWEEN ?3 AND ?4 AND i.category_id = ?{}",
                args.len()
            ));
        }
        None => {
            // All titles: idx_items_year walks them in year order (no sort
            // for the GROUP BY) and holds every filter column.
            where_sql.push_str(" AND i.year BETWEEN ?3 AND ?4");
            // Same rows as `query_named`'s hidden-category filter, and like
            // it only when a category is hidden.
            if super::has_hidden_categories(conn, source_id, ct)? {
                where_sql.push_str(
                    " AND i.category_id NOT IN (SELECT category_id FROM categories WHERE source_id = ?1 AND content_type = ?2 AND hidden <> 0)",
                );
            }
        }
    }
    where_sql.push_str(english_scoped(conn, english_only, source_id, ct)?);
    if let Some(h) = hide {
        where_sql.push_str(&parental::filter::scoped(
            conn, source_id, ct, h, "?1", "?2",
        )?);
    }
    // The same NOT IN set `vod_filter_sql` appends for "Hide watched".
    where_sql.push_str(&vod_filter_sql(
        &VodFilter {
            hide_watched,
            ..VodFilter::default()
        },
        &mut args,
    ));
    let sql = format!(
        "SELECT i.year, count(*) FROM items i WHERE {where_sql} GROUP BY {year_key} ORDER BY {year_key} DESC"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (year, n) = row?;
        // BETWEEN already bounds it; the conversion cannot fail.
        if let Ok(y) = i32::try_from(year) {
            out.push((y, n));
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YearFacetsArgs {
    source_id: String,
    content_type: ContentType,
    #[serde(default)]
    category_id: Option<String>,
    /// Counts only titles "Hide watched" keeps in the grid.
    #[serde(default)]
    hide_watched: bool,
}

/// One `catalog.yearFacets` entry.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct YearFacet {
    pub year: i32,
    pub count: i64,
}

async fn year_facets_rpc(
    state: Arc<AppState>,
    a: YearFacetsArgs,
) -> Result<Vec<YearFacet>, RpcError> {
    if !matches!(a.content_type, ContentType::Movie | ContentType::Series) {
        return Err(RpcError::invalid(
            "catalog.yearFacets supports contentType 'movie' or 'series'",
        ));
    }
    let english = state.settings_snapshot().english_only;
    let hide = crate::parental::hide_filter(&state).await?;
    let ct = a.content_type;
    let rows = state
        .db_call(move |c| {
            year_facets_filtered(
                c,
                &a.source_id,
                ct,
                a.category_id.as_deref().filter(|s| !s.is_empty()),
                english,
                hide,
                a.hide_watched,
            )
        })
        .await?;
    Ok(rows
        .into_iter()
        .map(|(year, count)| YearFacet { year, count })
        .collect())
}

/// Registers `catalog.yearFacets`.
pub fn register(r: &mut RpcRouter) {
    r.add("catalog.yearFacets", year_facets_rpc);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(year_from: Option<i32>, year_to: Option<i32>, hide_watched: bool) -> VodFilter {
        VodFilter {
            year_from,
            year_to,
            hide_watched,
        }
    }

    #[test]
    fn validate_accepts_bounds_and_rejects_bad_ranges() {
        assert!(validate(&VodFilter::default()).is_ok());
        assert!(validate(&f(Some(1900), Some(2100), true)).is_ok());
        assert!(validate(&f(Some(1990), Some(1990), false)).is_ok());
        assert!(validate(&f(Some(1990), None, false)).is_ok());
        assert!(validate(&f(None, Some(1999), false)).is_ok());
        for bad in [
            f(Some(1899), None, false),
            f(None, Some(2101), false),
            f(Some(2000), Some(1999), false),
            f(Some(-5), None, false),
        ] {
            assert!(
                matches!(validate(&bad), Err(CoreError::Invalid(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn empty_filter_adds_no_sql_or_args() {
        let mut args: Vec<SqlValue> = vec![SqlValue::from("s1".to_string())];
        assert_eq!(vod_filter_sql(&VodFilter::default(), &mut args), "");
        assert_eq!(args.len(), 1);
        assert!(VodFilter::default().is_empty());
    }

    #[test]
    fn bounds_are_numbered_after_existing_args() {
        let mut args: Vec<SqlValue> = vec![
            SqlValue::from("s1".to_string()),
            SqlValue::from("movie".to_string()),
        ];
        let sql = vod_filter_sql(&f(Some(1990), Some(1999), true), &mut args);
        assert!(
            sql.starts_with(" AND i.year >= ?3 AND i.year <= ?4"),
            "{sql}"
        );
        assert!(sql.contains("i.rowid NOT IN ("), "{sql}");
        assert_eq!(
            args,
            vec![
                SqlValue::from("s1".to_string()),
                SqlValue::from("movie".to_string()),
                SqlValue::Integer(1990),
                SqlValue::Integer(1999),
            ]
        );
    }

    #[test]
    fn one_bound_is_closed_with_the_year_range() {
        let mut args: Vec<SqlValue> = vec![];
        let sql = vod_filter_sql(&f(None, Some(1992), false), &mut args);
        assert_eq!(sql, " AND i.year >= ?1 AND i.year <= ?2");
        assert_eq!(args, vec![SqlValue::Integer(1900), SqlValue::Integer(1992)]);
        let mut args: Vec<SqlValue> = vec![];
        vod_filter_sql(&f(Some(2001), None, false), &mut args);
        assert_eq!(args, vec![SqlValue::Integer(2001), SqlValue::Integer(2100)]);
    }

    #[test]
    fn page_statements_can_keep_the_year_off_the_index_choice() {
        let mut args: Vec<SqlValue> = vec![];
        let sql = vod_filter_sql_on(&f(Some(2020), Some(2029), false), "+i.year", &mut args);
        assert_eq!(sql, " AND +i.year >= ?1 AND +i.year <= ?2");
        assert_eq!(args, vec![SqlValue::Integer(2020), SqlValue::Integer(2029)]);
    }
}
