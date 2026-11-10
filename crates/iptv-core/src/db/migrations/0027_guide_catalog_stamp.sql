-- 0027: a stamp per (source, content type) that changes whenever the
-- catalog keys the guide search resolves change.
--
-- The guide search (epg::search) keeps, per source and channel type, every
-- distinct (epg_channel_id, title) pair of the catalog in memory, so a
-- search reads only the channels whose guide channels have hits instead of
-- every channel of the source. That list is only complete while the stamp
-- it was read with is still the stored one. The stamp is a random number,
-- not a counter, so no two catalog states share one.
--
-- Every write that adds, removes or re-keys an items row moves it:
-- - CatalogWriter (catalog/mod.rs) and sources::store::delete, which
--   suspend the per-row triggers for the source (fts_suspend), write it
--   themselves, once per transaction;
-- - any other insert or delete through items_ai / items_ad, which now carry
--   it next to their FTS statement, so a suspended write costs nothing more
--   per row;
-- - an update of the columns the key or the scope is made of, through
--   items_guide_au.
CREATE TABLE guide_catalog_stamp (
  source_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  PRIMARY KEY (source_id, content_type)
) WITHOUT ROWID;

-- Catalogs written before this migration get a stamp of their own.
INSERT INTO guide_catalog_stamp (source_id, content_type, stamp)
  SELECT id, 'live', random() FROM sources
  UNION ALL SELECT id, 'radio', random() FROM sources;

DROP TRIGGER IF EXISTS items_ai;
CREATE TRIGGER items_ai AFTER INSERT ON items
  WHEN NOT EXISTS (SELECT 1 FROM fts_suspend WHERE source_id = new.source_id)
  BEGIN
    INSERT INTO items_fts(rowid, title) VALUES (new.rowid, new.title);
    INSERT INTO guide_catalog_stamp (source_id, content_type, stamp) VALUES (new.source_id, new.content_type, random())
      ON CONFLICT (source_id, content_type) DO UPDATE SET stamp = excluded.stamp;
  END;
DROP TRIGGER IF EXISTS items_ad;
CREATE TRIGGER items_ad AFTER DELETE ON items
  WHEN NOT EXISTS (SELECT 1 FROM fts_suspend WHERE source_id = old.source_id)
  BEGIN
    INSERT INTO items_fts(items_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
    INSERT INTO guide_catalog_stamp (source_id, content_type, stamp) VALUES (old.source_id, old.content_type, random())
      ON CONFLICT (source_id, content_type) DO UPDATE SET stamp = excluded.stamp;
  END;
CREATE TRIGGER items_guide_au AFTER UPDATE OF source_id, content_type, epg_channel_id, title ON items
  BEGIN
    INSERT INTO guide_catalog_stamp (source_id, content_type, stamp) VALUES (old.source_id, old.content_type, random())
      ON CONFLICT (source_id, content_type) DO UPDATE SET stamp = excluded.stamp;
    INSERT INTO guide_catalog_stamp (source_id, content_type, stamp) VALUES (new.source_id, new.content_type, random())
      ON CONFLICT (source_id, content_type) DO UPDATE SET stamp = excluded.stamp;
  END;
