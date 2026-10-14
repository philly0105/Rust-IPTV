-- 0016: watch log behind the stats page (Run 2 C7, B8).
-- One row per client-local day and item: the seconds watched that day, plus
-- the latest title and poster snapshot so the top lists render without the
-- catalog and survive a refresh that drops the item. Episodes count under
-- their series ref. `stats.record` adds seconds to the row; rows older than
-- 90 days are pruned at init and on the first record of a UTC day. Removing a
-- source removes its rows through the cascade.
-- The primary key starts with `day`, so the per-day range scans of
-- `stats.summary` use it; `idx_watch_log_item` serves the per-item reads
-- (backup export by source, totals per item).

CREATE TABLE IF NOT EXISTS watch_log (
  day           TEXT NOT NULL,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL CHECK (content_type IN ('live', 'radio', 'movie', 'series')),
  item_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  poster_url    TEXT,
  seconds       INTEGER NOT NULL DEFAULT 0,
  last_at       TEXT NOT NULL,
  PRIMARY KEY (day, source_id, content_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_watch_log_item ON watch_log(source_id, content_type, item_id);
