-- 0022: live channel quality (the Live TV quality filter).
--
-- The picture quality a live channel's provider name marks
-- (live::matcher::quality), stored with each item so readers filter on a
-- column instead of reading names: -1 not computed yet, 0 no quality tag,
-- 1 SD, 2 HD, 3 FHD, 4 UHD (catalog::quality). CatalogWriter stores it for
-- live rows and 0 for every other type. Rows written before this migration
-- start at -1; catalog::quality::backfill (started by catalog::init at boot)
-- computes the live ones, and readers treat -1 as untagged until then. The
-- matcher is Rust, so nothing here calls an app SQL function.
ALTER TABLE items ADD COLUMN quality INTEGER NOT NULL DEFAULT -1;

-- items_rank copies it (the search's word-prefix pass filters on items_rank
-- alone), through the same triggers, now carrying the column. Both tables
-- start at -1, so the existing rows already agree.
ALTER TABLE items_rank ADD COLUMN quality INTEGER NOT NULL DEFAULT -1;
DROP TRIGGER IF EXISTS items_rank_ai;
CREATE TRIGGER items_rank_ai AFTER INSERT ON items
  WHEN NOT EXISTS (SELECT 1 FROM fts_suspend WHERE source_id = new.source_id)
  BEGIN
    INSERT INTO items_rank (id, source_id, content_type, category_id, non_english, title_len, position, quality)
      VALUES (new.rowid, new.source_id, new.content_type, new.category_id, new.non_english, length(new.title), new.position, new.quality);
  END;
DROP TRIGGER IF EXISTS items_rank_au;
CREATE TRIGGER items_rank_au AFTER UPDATE OF source_id, content_type, category_id, non_english, title, position, quality ON items
  BEGIN
    UPDATE items_rank SET source_id = new.source_id, content_type = new.content_type, category_id = new.category_id,
      non_english = new.non_english, title_len = length(new.title), position = new.position, quality = new.quality
    WHERE id = new.rowid;
  END;

-- Live pages and counts (category, position and name order) and the guide
-- search's channel walk stay index-only with the filter on: quality is the
-- last column of the indexes they read. The other columns are unchanged
-- (0018, 0019). The rating, year and added indexes serve movies and series,
-- which are never filtered.
--
-- The order matters: without statistics SQLite counts through the covering
-- index created last when several cost the same, so the narrow
-- idx_items_cat goes last (then idx_items_pos when a count also needs the
-- rating), never the wide idx_items_title. CatalogWriter's bulk rebuild
-- keeps this order.
DROP INDEX IF EXISTS idx_items_title;
CREATE INDEX idx_items_title ON items(source_id, content_type, title COLLATE NOCASE, position, category_id, non_english, rating, year, quality);
DROP INDEX IF EXISTS idx_items_guide;
CREATE INDEX idx_items_guide ON items(source_id, content_type, epg_channel_id, title, number, category_id, quality)
  WHERE content_type IN ('live', 'radio');
DROP INDEX IF EXISTS idx_items_pos;
CREATE INDEX idx_items_pos ON items(source_id, content_type, position, category_id, non_english, rating, year, quality);
DROP INDEX IF EXISTS idx_items_cat;
CREATE INDEX idx_items_cat ON items(source_id, content_type, category_id, position, non_english, year, quality);
