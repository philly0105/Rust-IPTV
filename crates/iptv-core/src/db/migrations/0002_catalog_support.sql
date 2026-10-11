-- 0002: catalog support (B1).
-- Cached per-source item counts, refreshed by catalog::update_counts after every
-- catalog write, so sources.list never counts 100k-row catalogs on read.
CREATE TABLE source_counts (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  channel_count INTEGER NOT NULL DEFAULT 0,
  movie_count INTEGER NOT NULL DEFAULT 0,
  series_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Multi-source VOD resolution (catalog.sameTitle) looks movies up by base title.
CREATE INDEX idx_items_title_base ON items(content_type, title_base COLLATE NOCASE) WHERE title_base IS NOT NULL;
-- Ordered list positions per source (sources.list).
CREATE INDEX idx_sources_position ON sources(position);
-- Bulk catalog writes (catalog::CatalogWriter) suspend the per-row FTS triggers
-- for one source inside their transaction and index the rows in one
-- INSERT ... SELECT instead (about 6x faster for 50k items). The row only ever
-- exists inside that write transaction.
CREATE TABLE fts_suspend (source_id TEXT PRIMARY KEY) WITHOUT ROWID;
DROP TRIGGER items_ai;
DROP TRIGGER items_ad;
CREATE TRIGGER items_ai AFTER INSERT ON items
  WHEN NOT EXISTS (SELECT 1 FROM fts_suspend WHERE source_id = new.source_id)
  BEGIN INSERT INTO items_fts(rowid, title) VALUES (new.rowid, new.title); END;
CREATE TRIGGER items_ad AFTER DELETE ON items
  WHEN NOT EXISTS (SELECT 1 FROM fts_suspend WHERE source_id = old.source_id)
  BEGIN INSERT INTO items_fts(items_fts, rowid, title) VALUES ('delete', old.rowid, old.title); END;
