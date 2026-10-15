-- 0017: image cache index (Run 3 C2, B1).
-- One row per cached image file under `data_dir/image-cache/<first 2 hex>/<key>`.
-- `key` is the sha256 hex of the normalised absolute URL (no fragment), so the
-- file name is derived from the row and never stored. `bytes` is the file size;
-- the module keeps the running total in memory (from SUM(bytes) at init) and
-- evicts the least recently accessed rows (`idx_image_cache_lru`) once it
-- passes `settings.imageCacheMaxMb`. `last_access` is written at most once a
-- minute per key, so hits stay read-only.
-- IF NOT EXISTS: the module re-runs this file at init, which repairs a data dir
-- migrated while slot 0017 was still a comment-only placeholder.

CREATE TABLE IF NOT EXISTS image_cache (
  key          TEXT PRIMARY KEY,        -- sha256 hex of the normalised absolute URL
  url          TEXT NOT NULL,
  content_type TEXT NOT NULL,           -- image/* only
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,        -- unix seconds
  last_access  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_cache_lru ON image_cache(last_access);
