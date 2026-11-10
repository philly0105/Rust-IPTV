-- 0028: guide search rows in start order.
--
-- epg_search_rows (0019) was keyed by the programme rowid, and the title
-- index (epg_programs_fts) used the same rowids, so a search read every
-- matching programme in the window and sorted them to keep the first few:
-- 84k search rows for "news" on an 876k-programme guide, most of a search.
-- Now each search row has its own id, numbered in (start, feed, programme
-- rowid) order, with the programme rowid in `prog`, and the title index
-- uses those ids as its rowids: a search reads its hits in start order,
-- from a bound before its window, and stops once the result is settled.
-- The index never reads epg_programs through its content setting (only
-- MATCH and rowids are used), so its rowids need not be programme rowids.
--
-- epg::search::rebuild_index fills both in one transaction and sets the
-- marker to `ordered-1`; the marker is removed here, so the startup build
-- rebuilds them and search scans until then.
DROP TABLE epg_search_rows;
CREATE TABLE epg_search_rows (
  id INTEGER PRIMARY KEY,
  prog INTEGER NOT NULL,
  start INTEGER NOT NULL,
  stop INTEGER NOT NULL,
  feed INTEGER NOT NULL,
  channel_id TEXT NOT NULL
);
INSERT INTO epg_programs_fts(epg_programs_fts) VALUES('delete-all');
DELETE FROM app_state WHERE key IN ('epg_search_index', 'epg_search_longest');
