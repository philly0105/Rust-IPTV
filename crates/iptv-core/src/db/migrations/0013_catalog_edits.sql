-- 0013: channel edits (Run 2 contract C2, B1-catalog-core) and the items
-- year index (contract C4).
--
-- One row per edited live or radio channel: hidden, renamed, or both. Rows
-- are keyed by the stable catalog id (m3u: sha256-based item_id(url, name);
-- Xtream: stream id; Stalker: portal id), never by a foreign key to `items`:
-- every refresh deletes and reinserts the source's items, and edits must
-- survive that. Removing the source removes its edits through the cascade.
--
-- `name` is the custom name (NULL = the provider name). `original_name` is
-- the provider name when the row was last written, for the hidden-channels
-- list once the provider drops or renames the channel. A row that ends with
-- `hidden = 0 AND name IS NULL` is deleted by the writer, so every row is a
-- live edit. `updated_at` is RFC 3339 UTC with milliseconds, like userstate.
CREATE TABLE IF NOT EXISTS channel_edits (
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL CHECK (content_type IN ('live','radio')),
  item_id       TEXT NOT NULL,
  hidden        INTEGER NOT NULL DEFAULT 0,
  name          TEXT,
  original_name TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source_id, content_type, item_id)
);

-- The readers' cost rule: one indexed EXISTS per call decides whether a
-- source has hidden channels (or renames) before any extra SQL is added.
CREATE INDEX IF NOT EXISTS idx_channel_edits_hidden ON channel_edits(source_id, content_type) WHERE hidden = 1;
CREATE INDEX IF NOT EXISTS idx_channel_edits_named ON channel_edits(source_id, content_type) WHERE name IS NOT NULL;

-- vod: the year filter and decade facets of catalog.movies / catalog.series (C4).
CREATE INDEX IF NOT EXISTS idx_items_year ON items(source_id, content_type, year);
