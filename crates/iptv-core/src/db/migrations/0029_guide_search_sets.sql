-- 0029: two sets of guide search tables, title indexes without sizes.
--
-- epg::search::rebuild_index used to empty and refill epg_programs_fts and
-- epg_search_rows in one write transaction: about 1.7 s of write lock on an
-- 885k-programme guide after every refresh, while favourites, positions and
-- settings waited. It now fills the set searches do not read, in short
-- transactions that let other writers in between them, and makes it the
-- current one by setting the epg_search_index marker: `ordered-1` names the
-- tables of 0019/0028, `ordered-1b` the ones created here.
--
-- Both title indexes are created with columnsize=0: the search asks them for
-- MATCH and rowids only, never for ranks or column sizes, and without the
-- per-row size records indexing takes about 0.2 s instead of 0.5 s on that
-- guide. The first set is created again for it, so the marker is removed and
-- the startup build fills it (in the background, searches scan until then).
DROP TABLE epg_programs_fts;
CREATE VIRTUAL TABLE epg_programs_fts USING fts5(
  title,
  content='epg_programs',
  content_rowid='rowid',
  columnsize=0,
  tokenize='unicode61 remove_diacritics 2'
);
DELETE FROM epg_search_rows;
DELETE FROM app_state WHERE key IN ('epg_search_index', 'epg_search_longest');

CREATE VIRTUAL TABLE epg_programs_fts_b USING fts5(
  title,
  content='epg_programs',
  content_rowid='rowid',
  columnsize=0,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE epg_search_rows_b (
  id INTEGER PRIMARY KEY,
  prog INTEGER NOT NULL,
  start INTEGER NOT NULL,
  stop INTEGER NOT NULL,
  feed INTEGER NOT NULL,
  channel_id TEXT NOT NULL
);
