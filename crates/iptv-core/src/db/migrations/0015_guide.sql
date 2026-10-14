-- Run 2 C5: guide programme search and series recording rules.
--
-- The FTS table is an external-content index over epg_programs. This
-- migration leaves it empty (a full build over a large guide would make
-- the upgrade slow); epg::search rebuilds it after each committed refresh,
-- after epg.clearAll, and once at startup, and falls back to a bounded
-- scan until then.
CREATE VIRTUAL TABLE epg_programs_fts USING fts5(
  title,
  content='epg_programs',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE recording_rules (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('live','radio')),
  item_id      TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  title        TEXT NOT NULL,            -- as picked from the guide
  title_key    TEXT NOT NULL,            -- recording::scheduler::title_key(title)
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE (source_id, content_type, item_id, title_key)
);

CREATE TABLE recording_rule_skips (
  rule_id  TEXT NOT NULL REFERENCES recording_rules(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, start_at)
);

ALTER TABLE recordings ADD COLUMN rule_id TEXT;   -- NULL for manual recordings
