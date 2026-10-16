-- 0011: parental controls (contract C2, B3-parental-core).
--
-- parental_config is a single row. pin_hash / pin_salt are NULL while no PIN
-- is set (controls off). The PIN itself is never stored: pin_hash is
-- "pbkdf2-sha256$<iterations>$<hex>" over a random salt (hex in pin_salt).
-- failed_attempts and lockout_until keep the wrong-PIN lockout across a
-- restart. The session unlock is in memory only, never in this table.
CREATE TABLE IF NOT EXISTS parental_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash        TEXT,
  pin_salt        TEXT,
  mode            TEXT NOT NULL DEFAULT 'hide' CHECK (mode IN ('hide', 'ask')),
  auto_adult      INTEGER NOT NULL DEFAULT 1 CHECK (auto_adult IN (0, 1)),
  unlock_minutes  INTEGER NOT NULL DEFAULT 15 CHECK (unlock_minutes BETWEEN 0 AND 720),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockout_until   TEXT,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO parental_config(id) VALUES (1);

-- One row per locked category or item. WITHOUT ROWID makes the primary key
-- the table itself: the hide-mode filters probe it by
-- (source_id, content_type, kind, target_id), and the per-source checks
-- ("any item lock for this source and type?") read a key prefix. Removing a
-- source removes its locks.
CREATE TABLE IF NOT EXISTS parental_locks (
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('live', 'radio', 'movie', 'series')),
  kind         TEXT NOT NULL CHECK (kind IN ('category', 'item')),
  target_id    TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (source_id, content_type, kind, target_id)
) WITHOUT ROWID;
