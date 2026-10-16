-- 0012: My List, a user-ordered watchlist of movies and series (B5, C3).
-- One row per item. The title, subtitle and poster are a snapshot taken when
-- the item was added, so the list renders without the catalog and survives a
-- refresh that drops the item. `position` is the user's order (ascending);
-- new rows take MIN(position) - 1, so the newest add sits on top until the
-- user reorders. Removing a source removes its rows through the cascade.
-- Watched state is not stored here: `watchlist.list` reads it from
-- `playback_positions` (the item-level row, episode_id = '').

CREATE TABLE IF NOT EXISTS watchlist (
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL CHECK (content_type IN ('movie', 'series')),
  item_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  poster_url    TEXT,
  added_at      TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, content_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_order ON watchlist(position, added_at DESC);
