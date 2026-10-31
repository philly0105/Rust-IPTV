//! Global search ranks word-prefix matches on `items_rank` (migration 0020)
//! with a per-list top-N over one materialized match set. These tests pin
//! it on the bundled SQLite:
//!
//! - [`catalog::search_groups`] answers exactly what the previous statement
//!   (a `ROW_NUMBER()` window over `items` joined to `items_fts`, kept here
//!   as [`reference`]) answers with the rowid as its last tie key: the same
//!   rows in the same order, per list, over queries, list layouts, source
//!   scopes, limits, English-only (stored and pending), the Live TV
//!   quality filter and parental hide mode, before and after hidden
//!   categories, hidden channels, item and category locks and adult
//!   category names are set. Two sources hold the same channel list (same
//!   ids, titles and positions), so ties are real.
//! - The plan: the match set is materialized once, `items_fts` drives the
//!   join and every row comes from `items_rank` and `items` by rowid.
//! - `items_rank` equals `items` after each kind of write.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::quality::{self, QualityFilter};
use iptv_core::catalog::{
    self, fts_query, language, replace_catalog, CatalogWriter, CategoryRow, ItemRow,
};
use iptv_core::live::matcher::Quality;
use iptv_core::model::ContentType;
use iptv_core::parental::Hide;
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use support::*;

const LIVE: ContentType = ContentType::Live;
const RADIO: ContentType = ContentType::Radio;
const MOVIE: ContentType = ContentType::Movie;
const SERIES: ContentType = ContentType::Series;

const CHANNELS: usize = 1_500;
const MOVIES: usize = 3_000;
const SHOWS: usize = 800;

const LIVE_GROUPS: [&str; 8] = [
    "UK | News",
    "US | Sports",
    "FR | Sport",
    "XXX Adult",
    "DE | Kids",
    "Movies",
    "Кино",
    "UK | Entertainment",
];
const CHANNEL_NAMES: [&str; 10] = [
    "News 24",
    "Sky Sports",
    "Sky News",
    "The Family",
    "Arena",
    "Weather Now",
    "Thriller Max",
    "Music Hits",
    "Первый канал",
    "A Plus",
];
const WORDS: [&str; 12] = [
    "Amber", "Atlas", "Blue", "Bridge", "Thunder", "Theory", "Orchard", "Sky", "News", "Dawn",
    "Frost", "River",
];
const TAGS: [&str; 6] = ["EN", "FR", "DE", "UK", "", "IT"];
/// Quality markers ending channel names, the empty one for untagged names.
const MARKS: [&str; 6] = ["", "HD", "FHD", "SD", "4K", "720p"];

/// Live TV quality filters for the matrix: HD and up with untagged channels
/// kept (a `NOT BETWEEN` condition), Full HD and up with them hidden (`>=`).
const HD_UP: Option<QualityFilter> = Some(QualityFilter {
    min: Quality::Hd,
    hide_untagged: false,
});
const FHD_TAGGED: Option<QualityFilter> = Some(QualityFilter {
    min: Quality::Fhd,
    hide_untagged: true,
});

fn cats(prefix: &str, names: &[&str]) -> Vec<CategoryRow> {
    names
        .iter()
        .enumerate()
        .map(|(i, n)| CategoryRow {
            category_id: format!("{prefix}{i}"),
            name: (*n).into(),
            position: i as i64,
        })
        .collect()
}

fn vod_cats() -> Vec<CategoryRow> {
    cats(
        "v",
        &[
            "EN | Action",
            "FR | Films",
            "Adult XXX",
            "Drama",
            "Фильмы",
            "UK | Comedy",
        ],
    )
}

/// The same list for every M3U source: identical ids, titles and positions.
fn channel(source: &str, i: usize) -> ItemRow {
    let tag = TAGS[(i / 7) % TAGS.len()];
    let name = CHANNEL_NAMES[i % CHANNEL_NAMES.len()];
    let mark = MARKS[(i / 3) % MARKS.len()];
    let title = if i.is_multiple_of(3) {
        // Titles that repeat inside a list (different positions).
        format!("{tag} {name} {mark}").trim().to_string()
    } else {
        format!("{tag} {name} {} {mark}", i % 40).trim().to_string()
    };
    ItemRow {
        source_id: source.into(),
        content_type: LIVE,
        item_id: format!("c{i}"),
        category_id: format!("g{}", i % LIVE_GROUPS.len()),
        title,
        url: Some(format!("http://stream.example/{i}.ts")),
        position: i as i64,
        ..Default::default()
    }
}

fn radio(source: &str, i: usize) -> ItemRow {
    ItemRow {
        source_id: source.into(),
        content_type: RADIO,
        item_id: format!("r{i}"),
        category_id: "g0".into(),
        title: format!("The Radio {} {i}", WORDS[i % WORDS.len()]),
        is_radio: true,
        position: i as i64,
        ..Default::default()
    }
}

fn vod(ct: ContentType, i: usize) -> ItemRow {
    let n = WORDS.len();
    let the = if i.is_multiple_of(3) { "The " } else { "" };
    let title = if i.is_multiple_of(11) {
        format!("Фильм {} {i}", WORDS[i % n])
    } else {
        format!(
            "{} {the}{} {} ({})",
            TAGS[(i / 5) % TAGS.len()],
            WORDS[i % n],
            WORDS[(i / n) % n],
            1990 + i % 30
        )
        .trim()
        .to_string()
    };
    ItemRow {
        source_id: "v".into(),
        content_type: ct,
        item_id: format!("{}{i}", ct.as_str()),
        category_id: format!("v{}", i % 6),
        title,
        position: (i % 900) as i64,
        ..Default::default()
    }
}

/// m1 and m2: the same channel list; v: movies and series.
fn write_fixture(c: &mut Connection) {
    for s in ["m1", "m2"] {
        replace_catalog(
            c,
            s,
            LIVE,
            &cats("g", &LIVE_GROUPS),
            &mut (0..CHANNELS).map(|i| channel(s, i)),
        )
        .unwrap();
        replace_catalog(
            c,
            s,
            RADIO,
            &cats("g", &LIVE_GROUPS[..1]),
            &mut (0..40).map(|i| radio(s, i)),
        )
        .unwrap();
    }
    replace_catalog(
        c,
        "v",
        MOVIE,
        &vod_cats(),
        &mut (0..MOVIES).map(|i| vod(MOVIE, i)),
    )
    .unwrap();
    replace_catalog(
        c,
        "v",
        SERIES,
        &vod_cats(),
        &mut (0..SHOWS).map(|i| vod(SERIES, i)),
    )
    .unwrap();
}

/// Hidden categories, hidden channels, item and category locks.
fn set_filters(c: &Connection) {
    c.execute_batch(
        "UPDATE categories SET hidden = 1 WHERE (source_id = 'm1' AND category_id = 'g1') OR (source_id = 'v' AND content_type = 'series' AND category_id = 'v3');
         INSERT INTO channel_edits (source_id, content_type, item_id, hidden, original_name, updated_at)
           SELECT source_id, content_type, item_id, 1, title, '2026-10-16' FROM items WHERE source_id = 'm2' AND content_type = 'live' AND position % 5 = 0;
         INSERT INTO parental_locks (source_id, content_type, kind, target_id, name, created_at) VALUES
           ('m1', 'live', 'category', 'g4', 'Kids', '2026-10-16'),
           ('v', 'movie', 'category', 'v0', 'Action', '2026-10-16');
         INSERT INTO parental_locks (source_id, content_type, kind, target_id, name, created_at)
           SELECT source_id, content_type, 'item', item_id, title, '2026-10-16' FROM items WHERE (source_id = 'v' AND position % 13 = 0) OR (source_id = 'm2' AND position % 17 = 1);",
    )
    .unwrap();
}

type Key = (String, String, String);

const SELECT_KEY: &str = "SELECT i.source_id, i.content_type, i.item_id";
const CATEGORY_JOIN: &str = " LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id";

/// The filters `search_groups` builds (English-only, the Live TV quality
/// filter, hide mode, hidden channels, hidden categories) and the scope,
/// with the arguments after `?1`.
fn filters(
    c: &Connection,
    source: Option<&str>,
    types: &[ContentType],
    english: bool,
    quality: Option<QualityFilter>,
    hide: Option<Hide>,
) -> (String, String, Vec<SqlValue>, bool) {
    let english = if english {
        language::english_only_joined(c).unwrap()
    } else {
        ""
    };
    let ranking_join = english == language::ENGLISH_ONLY_SQL;
    let mut filter = english.to_string();
    if types.contains(&LIVE) {
        filter.push_str(&quality::mixed_clause(quality, "i"));
    }
    if let Some(h) = hide {
        filter.push_str(&iptv_core::parental::filter::item_set(c, h).unwrap());
    }
    if types.iter().any(|t| matches!(*t, LIVE | RADIO)) {
        filter.push_str(&iptv_core::channeledit::item_set(c, source).unwrap());
    }
    let mut args: Vec<SqlValue> = Vec::new();
    let ph: Vec<String> = types
        .iter()
        .map(|t| {
            args.push(t.as_str().to_string().into());
            format!("?{}", args.len() + 1)
        })
        .collect();
    let mut scope = format!(" AND i.content_type IN ({})", ph.join(", "));
    let mut hidden_scope = String::new();
    if let Some(s) = source {
        args.push(s.to_string().into());
        scope.push_str(&format!(" AND i.source_id = ?{}", args.len() + 1));
        hidden_scope = format!(" AND source_id = ?{}", args.len() + 1);
    }
    // Hidden categories: always applied (a no-op when there are none).
    filter.push_str(&format!(
        " AND NOT (i.category_id IN (SELECT category_id FROM categories WHERE hidden <> 0{hidden_scope}) AND EXISTS (SELECT 1 FROM categories hc WHERE hc.source_id = i.source_id AND hc.content_type = i.content_type AND hc.category_id = i.category_id AND hc.hidden <> 0))"
    ));
    (scope, filter, args, ranking_join)
}

fn group_case(groups: &[&[ContentType]]) -> String {
    let arms: String = groups
        .iter()
        .enumerate()
        .flat_map(|(g, ts)| {
            ts.iter()
                .map(move |t| format!(" WHEN '{}' THEN {g}", t.as_str()))
        })
        .collect();
    format!("CASE i.content_type{arms} END")
}

/// The word-prefix statement as it was before `items_rank`: one
/// `ROW_NUMBER()` window over every match on `items`, with the rowid added
/// as the last order key (the tie order it gave).
fn reference_sql(
    c: &Connection,
    source: Option<&str>,
    groups: &[&[ContentType]],
    limit: usize,
    english: bool,
    quality: Option<QualityFilter>,
    hide: Option<Hide>,
) -> (String, Vec<SqlValue>) {
    let types: Vec<ContentType> = groups.iter().flat_map(|g| g.iter().copied()).collect();
    let (scope, filter, args, ranking_join) = filters(c, source, &types, english, quality, hide);
    let group = group_case(groups);
    let inner_join = if ranking_join { CATEGORY_JOIN } else { "" };
    let sql = format!(
        "{SELECT_KEY}, g.search_group FROM (SELECT i.rowid AS rid, {group} AS search_group, ROW_NUMBER() OVER (PARTITION BY {group} ORDER BY items_fts.rank, length(i.title), i.position, i.rowid) AS search_rank FROM items i{inner_join} JOIN items_fts ON items_fts.rowid = i.rowid WHERE items_fts MATCH ?1{scope}{filter}) g CROSS JOIN items i ON i.rowid = g.rid{CATEGORY_JOIN} WHERE g.search_rank <= {limit} ORDER BY g.search_group, g.search_rank"
    );
    (sql, args)
}

/// The new statement's shape (as `search_groups` builds it), for the plan.
fn new_sql(
    c: &Connection,
    source: Option<&str>,
    groups: &[&[ContentType]],
    limit: usize,
) -> (String, Vec<SqlValue>) {
    let types: Vec<ContentType> = groups.iter().flat_map(|g| g.iter().copied()).collect();
    let (scope, filter, args, _) = filters(c, source, &types, false, None, None);
    let group = group_case(groups);
    let tops: Vec<String> = groups
        .iter()
        .enumerate()
        .filter(|(_, ts)| !ts.is_empty())
        .map(|(g, _)| format!("SELECT * FROM (SELECT rid, grp, r, l, p FROM m WHERE grp = {g} ORDER BY r, l, p, rid LIMIT {limit})"))
        .collect();
    let sql = format!(
        "WITH m AS MATERIALIZED (SELECT i.rowid AS rid, {group} AS grp, items_fts.rank AS r, i.title_len AS l, i.position AS p FROM items_fts CROSS JOIN items_rank i ON i.rowid = items_fts.rowid WHERE items_fts MATCH ?1{scope}{filter}) {SELECT_KEY}, t.grp FROM ({}) t CROSS JOIN items i ON i.rowid = t.rid{CATEGORY_JOIN} ORDER BY t.grp, t.r, t.l, t.p, t.rid",
        tops.join(" UNION ALL ")
    );
    (sql, args)
}

fn rows(c: &Connection, sql: &str, q: &str, args: &[SqlValue], lists: usize) -> Vec<Vec<Key>> {
    let mut all: Vec<SqlValue> = vec![fts_query(q).unwrap().into()];
    all.extend(args.iter().cloned());
    let mut out = vec![Vec::new(); lists];
    let mut stmt = c.prepare(sql).unwrap();
    let mut r = stmt.query(rusqlite::params_from_iter(all.iter())).unwrap();
    while let Some(row) = r.next().unwrap() {
        let g: i64 = row.get(3).unwrap();
        out[g as usize].push((
            row.get(0).unwrap(),
            row.get(1).unwrap(),
            row.get(2).unwrap(),
        ));
    }
    out
}

fn keys(lists: Vec<Vec<catalog::NamedRow>>) -> Vec<Vec<Key>> {
    lists
        .into_iter()
        .map(|l| {
            l.into_iter()
                .map(|n| {
                    (
                        n.row.source_id,
                        n.row.content_type.as_str().to_string(),
                        n.row.item_id,
                    )
                })
                .collect()
        })
        .collect()
}

const QUERIES: [&str; 9] = [
    "th",
    "the",
    "a",
    "news",
    "sky",
    "sky sports",
    "1",
    "the thunder",
    "zzzz",
];

/// Compares `search_groups` with the reference over the whole matrix, under
/// each of `modes` (English-only, the quality filter). Returns the number of
/// compared calls and of tied neighbours seen.
fn compare_all(
    c: &Connection,
    label: &str,
    modes: &[(bool, Option<QualityFilter>)],
) -> (usize, usize) {
    let layouts: [&[&[ContentType]]; 6] = [
        &[&[LIVE, RADIO], &[MOVIE], &[SERIES]],
        &[&[LIVE, RADIO]],
        &[&[MOVIE]],
        &[&[SERIES]],
        &[&[LIVE, RADIO], &[], &[SERIES]],
        &[&[LIVE, RADIO, MOVIE, SERIES]],
    ];
    let mut compared = 0;
    let mut ties = 0;
    for q in QUERIES {
        for groups in layouts {
            for source in [None, Some("m1"), Some("m2"), Some("v")] {
                for limit in [7, 61, 1001] {
                    for &(english, quality) in modes {
                        for hide in [None, Some(Hide { auto_adult: true })] {
                            let got = catalog::search_groups(
                                c, q, source, groups, limit, english, quality, hide, true,
                            );
                            let got = keys(got.unwrap());
                            let (sql, args) =
                                reference_sql(c, source, groups, limit, english, quality, hide);
                            let want = rows(c, &sql, q, &args, groups.len());
                            assert_eq!(
                                got, want,
                                "{label}: {q:?} {groups:?} {source:?} limit {limit} english {english} quality {quality:?} hide {hide:?}"
                            );
                            // Ties: one channel from both M3U sources, side by side.
                            for list in &got {
                                ties += list
                                    .windows(2)
                                    .filter(|w| {
                                        w[0].0 != w[1].0 && w[0].2 == w[1].2 && w[0].1 == w[1].1
                                    })
                                    .count();
                            }
                            compared += 1;
                        }
                    }
                }
            }
        }
    }
    (compared, ties)
}

#[tokio::test]
async fn search_ranks_like_the_window_statement_with_every_filter() {
    let env = env().await;
    for s in ["m1", "m2", "v"] {
        bare_source(&env.state, s).await;
    }
    env.state
        .db_call(|c| {
            write_fixture(c);
            assert_items_rank(c);

            let (n, ties) = compare_all(c, "plain", &[(false, None), (true, None)]);
            assert!(ties > 50, "the duplicate source gives tied rows ({ties})");
            eprintln!("l4_search_rank: plain: {n} calls equal, {ties} tied neighbours");

            set_filters(c);
            let modes = [(false, None), (true, None), (false, HD_UP)];
            let (n, ties) = compare_all(c, "filtered", &modes);
            eprintln!("l4_search_rank: filtered: {n} calls equal, {ties} tied neighbours");

            // The quality filter drops live rows only: radio stations and
            // movies match as before.
            let groups: &[&[ContentType]] = &[&[LIVE, RADIO], &[MOVIE]];
            let mut counts = Vec::new();
            for quality in [None, FHD_TAGGED] {
                let lists = catalog::search_groups(
                    c, "sky", None, groups, 1001, false, quality, None, true,
                )?;
                let live = lists[0]
                    .iter()
                    .filter(|n| n.row.content_type == LIVE)
                    .count();
                counts.push((live, lists[0].len() - live, lists[1].len()));
            }
            let (all, tagged) = (counts[0], counts[1]);
            assert!(tagged.0 < all.0, "live rows dropped: {counts:?}");
            assert_eq!(
                (tagged.1, tagged.2),
                (all.1, all.2),
                "radio and movies kept"
            );

            // A catalog whose stored verdicts are pending: the per-row
            // English-only rule (it needs the category name) keeps the old
            // statement shape, and still answers the same, with the quality
            // filter too.
            c.execute(
                "INSERT INTO english_pending (source_id, content_type) VALUES ('v', 'movie')",
                [],
            )?;
            let modes = [(true, None), (true, FHD_TAGGED)];
            let (n, _) = compare_all(c, "pending", &modes);
            eprintln!("l4_search_rank: pending English-only: {n} calls equal");
            c.execute("DELETE FROM english_pending", [])?;

            // The plan: one materialized match set, FTS as the outer loop,
            // items_rank and items by rowid, never scanned.
            let groups: &[&[ContentType]] = &[&[LIVE, RADIO], &[MOVIE], &[SERIES]];
            for source in [None, Some("v")] {
                let (sql, args) = new_sql(c, source, groups, 61);
                let mut all: Vec<SqlValue> = vec![fts_query("th").unwrap().into()];
                all.extend(args.iter().cloned());
                let got =
                    catalog::search_groups(c, "th", source, groups, 61, false, None, None, true)?;
                let want = keys(got);
                assert_eq!(
                    rows(c, &sql, "th", &args, 3),
                    want,
                    "the test's copy of the statement"
                );
                let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let plan: Vec<String> = stmt
                    .query_map(rusqlite::params_from_iter(all.iter()), |r| {
                        r.get::<_, String>(3)
                    })?
                    .collect::<Result<_, _>>()?;
                let plan = plan.join(" | ");
                eprintln!("l4_search_rank: plan ({source:?}): {plan}");
                let at = |needle: &str| {
                    plan.find(needle)
                        .unwrap_or_else(|| panic!("{needle:?} missing from the plan: {plan}"))
                };
                let materialize = at("MATERIALIZE m");
                let fts = at("SCAN items_fts VIRTUAL TABLE");
                let rank = at("SEARCH i USING INTEGER PRIMARY KEY");
                assert!(
                    materialize < fts && fts < rank,
                    "FTS drives the match set: {plan}"
                );
                assert!(
                    !plan.contains("SCAN i ")
                        && !plan.ends_with("SCAN i")
                        && !plan.contains("SCAN items_rank"),
                    "no table scan: {plan}"
                );
            }
            Ok(())
        })
        .await
        .unwrap();
}

/// `items_rank` equals `items` after each kind of write.
#[tokio::test]
async fn items_rank_follows_every_write() {
    let env = env().await;
    for s in ["m1", "m2", "v"] {
        bare_source(&env.state, s).await;
    }
    env.state
        .db_call(|c| {
            write_fixture(c);
            assert_items_rank(c);

            // A refresh with fewer rows, duplicate ids and new titles.
            let mut rows = (0..CHANNELS / 2)
                .chain(0..100)
                .map(|i| ItemRow {
                    title: format!("Renamed {i}"),
                    ..channel("m1", i)
                });
            replace_catalog(c, "m1", LIVE, &cats("g", &LIVE_GROUPS), &mut rows)?;
            assert_items_rank(c);

            // A rewrite dropped without commit.
            {
                let tx = c.transaction()?;
                let mut w = CatalogWriter::begin(&tx, "v", &[MOVIE], None)?;
                for i in 0..50 {
                    w.insert(&vod(MOVIE, i + 10_000))?;
                }
            }
            assert_items_rank(c);

            // A rewrite of two types at once, categories declared, so some
            // verdicts are set on insert and others corrected in finish.
            {
                let tx = c.transaction()?;
                {
                    let mut w = CatalogWriter::begin(&tx, "m2", &[LIVE, RADIO], None)?;
                    w.declare_categories(LIVE, &cats("g", &LIVE_GROUPS[..4]));
                    for i in 0..CHANNELS {
                        w.insert(&channel("m2", i))?;
                    }
                    for i in 0..20 {
                        w.insert(&radio("m2", i))?;
                    }
                    w.finish(&[
                        (LIVE, cats("g", &LIVE_GROUPS)),
                        (RADIO, cats("g", &LIVE_GROUPS[..1])),
                    ])?;
                }
                tx.commit()?;
            }
            assert_items_rank(c);

            // The background English-only backfill of a pending catalog.
            c.execute("UPDATE items SET non_english = 0 WHERE source_id = 'v'", [])?;
            c.execute(
                "INSERT INTO english_pending (source_id, content_type) VALUES ('v', 'movie'), ('v', 'series')",
                [],
            )?;
            assert_eq!(language::backfill_pending(c)?, 2);
            let hidden: i64 = c.query_row(
                "SELECT count(*) FROM items_rank WHERE source_id = 'v' AND non_english = 1",
                [],
                |r| r.get(0),
            )?;
            assert!(hidden > 0, "the backfill hid some rows");
            assert_items_rank(c);

            // Writes outside the writer: an insert, an update, a delete.
            c.execute(
                "INSERT INTO items (source_id, content_type, item_id, category_id, title, position) VALUES ('v', 'movie', 'direct', 'v1', 'The Direct Insert', 5)",
                [],
            )?;
            c.execute(
                "UPDATE items SET title = 'Moved', position = 99, category_id = 'v2' WHERE source_id = 'v' AND item_id = 'movie1'",
                [],
            )?;
            c.execute("DELETE FROM items WHERE source_id = 'v' AND item_id = 'movie2'", [])?;
            assert_items_rank(c);

            // A source delete (FK cascade).
            c.execute("DELETE FROM sources WHERE id = 'm2'", [])?;
            assert_items_rank(c);
            let left: i64 = c.query_row(
                "SELECT count(*) FROM items_rank WHERE source_id = 'm2'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(left, 0);
            Ok(())
        })
        .await
        .unwrap();
}
