-- 0018: catalog query speed (loop 2).
--
-- English-only (`englishOnly`) reads a verdict stored with each item instead
-- of testing every row's title and category on each call: 1 when the item is
-- clearly in another language (catalog::language). CatalogWriter writes it;
-- rows written before this migration start at 0 and their (source, type)
-- pairs wait in english_pending until catalog::language::backfill_pending
-- (started by catalog::init at boot) or the next rewrite of that catalog
-- computes them. Readers fall back to the per-row rule for a pending pair.
ALTER TABLE items ADD COLUMN non_english INTEGER NOT NULL DEFAULT 0;
CREATE TABLE english_pending (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  PRIMARY KEY (source_id, content_type)
) WITHOUT ROWID;
INSERT OR IGNORE INTO english_pending (source_id, content_type)
  SELECT DISTINCT source_id, content_type FROM items;

-- Only a title change re-indexes a row's search entry; writing the verdict
-- (or any other column) leaves items_fts alone.
DROP TRIGGER IF EXISTS items_au;
CREATE TRIGGER items_au AFTER UPDATE OF title ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
  INSERT INTO items_fts(rowid, title) VALUES (new.rowid, new.title);
END;

-- Page and count shapes of one source and type, answered from an index in
-- order and without reading table rows: the sort key, then position (the
-- tie-break of every sort), then the category (category pages, the hidden-
-- category filter) and the verdict. Rating, year and added sort descending
-- by default, NULLs last, which is the natural order of a DESC index.
-- idx_items_cat also holds the year for a category's year facets.
--
-- The sort indexes (idx_items_title, _pos, _year, _rating, _added_src) are
-- built by 0019, which widened them; this file only drops the older ones.
-- It created them too until 2026-10-19, so an upgrade from schema 17 built
-- each one twice (DB-6). Migrations are tracked by version only, so a
-- database that already ran this file is not affected.
DROP INDEX IF EXISTS idx_items_cat;
CREATE INDEX idx_items_cat ON items(source_id, content_type, category_id, position, non_english, year);
DROP INDEX IF EXISTS idx_items_title;
DROP INDEX IF EXISTS idx_items_pos;
DROP INDEX IF EXISTS idx_items_year;
