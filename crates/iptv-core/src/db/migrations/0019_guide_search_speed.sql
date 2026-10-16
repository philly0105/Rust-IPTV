-- 0019: guide search speed (loop 3).
--
-- The columns the guide search filters and orders each title-index hit by,
-- per programme rowid: a narrow row per hit instead of the programme's wide
-- one (with its description). epg::search::rebuild_index fills it in the
-- transaction that rebuilds epg_programs_fts and sets the index marker, and
-- the search reads it only while that marker holds the current version
-- (folded-2), so a database upgraded to 0019 rebuilds both at startup.
CREATE TABLE epg_search_rows (
  id INTEGER PRIMARY KEY,
  start INTEGER NOT NULL,
  stop INTEGER NOT NULL,
  feed INTEGER NOT NULL,
  channel_id TEXT NOT NULL
);

-- The guide search resolves every live and radio channel of a source to its
-- guide channel on each call: an index-only scan of the columns it needs
-- (the category for hide mode's category filter).
CREATE INDEX idx_items_guide ON items(source_id, content_type, epg_channel_id, title, number, category_id)
  WHERE content_type IN ('live', 'radio');

-- The catalog sort indexes also hold the rating and the year, so a movie or
-- series page with a minimum rating or a decade (written `+i.rating` /
-- `+i.year` in the page statement) walks its sort index without reading a
-- table row per entry. Before, a selective filter on a deep page read a row
-- for every title it passed (up to 140 ms on 100k movies); with both columns
-- every case measured stays near 12 ms or less.
DROP INDEX IF EXISTS idx_items_added_src;
CREATE INDEX idx_items_added_src ON items(source_id, content_type, added DESC, position, category_id, non_english, rating, year);
DROP INDEX IF EXISTS idx_items_title;
CREATE INDEX idx_items_title ON items(source_id, content_type, title COLLATE NOCASE, position, category_id, non_english, rating, year);
DROP INDEX IF EXISTS idx_items_pos;
CREATE INDEX idx_items_pos ON items(source_id, content_type, position, category_id, non_english, rating, year);
DROP INDEX IF EXISTS idx_items_rating;
CREATE INDEX idx_items_rating ON items(source_id, content_type, rating DESC, position, category_id, non_english, year);
DROP INDEX IF EXISTS idx_items_year;
CREATE INDEX idx_items_year ON items(source_id, content_type, year DESC, position, category_id, non_english, rating);
