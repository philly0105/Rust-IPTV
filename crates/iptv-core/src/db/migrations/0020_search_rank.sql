-- 0020: search ranking speed (loop 4).
--
-- The columns the global search ranks and filters every FTS match by, one
-- narrow row per items rowid: the ranking pass reads these (about 60 bytes)
-- instead of the item's wide row (URLs, JSON), so a broad prefix with 56k
-- matches reads a 15 MB table that stays in the page cache rather than the
-- whole items table. Kept in step like items_fts: per-row triggers, which
-- skip a source in fts_suspend (CatalogWriter deletes and refills the rows
-- of a rewritten catalog with one statement each), and an update trigger
-- for the copied columns.
CREATE TABLE items_rank (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  category_id TEXT NOT NULL,
  non_english INTEGER NOT NULL,
  title_len INTEGER NOT NULL,
  position INTEGER NOT NULL
);
INSERT INTO items_rank (id, source_id, content_type, category_id, non_english, title_len, position)
  SELECT rowid, source_id, content_type, category_id, non_english, length(title), position FROM items ORDER BY rowid;
CREATE TRIGGER items_rank_ai AFTER INSERT ON items
  WHEN NOT EXISTS (SELECT 1 FROM fts_suspend WHERE source_id = new.source_id)
  BEGIN
    INSERT INTO items_rank (id, source_id, content_type, category_id, non_english, title_len, position)
      VALUES (new.rowid, new.source_id, new.content_type, new.category_id, new.non_english, length(new.title), new.position);
  END;
CREATE TRIGGER items_rank_ad AFTER DELETE ON items
  WHEN NOT EXISTS (SELECT 1 FROM fts_suspend WHERE source_id = old.source_id)
  BEGIN DELETE FROM items_rank WHERE id = old.rowid; END;
CREATE TRIGGER items_rank_au AFTER UPDATE OF source_id, content_type, category_id, non_english, title, position ON items
  BEGIN
    UPDATE items_rank SET source_id = new.source_id, content_type = new.content_type, category_id = new.category_id,
      non_english = new.non_english, title_len = length(new.title), position = new.position
    WHERE id = new.rowid;
  END;
