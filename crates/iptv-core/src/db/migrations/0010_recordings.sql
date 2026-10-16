-- Guide reminders and scheduled recordings (recording slice).
-- Times are unix seconds of the guide time as shown (EPG offset applied).

CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  channel_name  TEXT NOT NULL,
  title         TEXT NOT NULL,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  fired_at      INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reminders_status_start ON reminders(status, start_at);
CREATE INDEX IF NOT EXISTS reminders_item ON reminders(source_id, content_type, item_id);

CREATE TABLE IF NOT EXISTS recordings (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  channel_name    TEXT NOT NULL,
  title           TEXT,
  kind            TEXT NOT NULL,
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL,
  padding_before  INTEGER NOT NULL DEFAULT 0,
  padding_after   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'scheduled',
  error_message   TEXT,
  parts_json      TEXT NOT NULL DEFAULT '[]',
  bytes           INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  ended_at        INTEGER,
  engine          TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS recordings_status_start ON recordings(status, start_at);
CREATE INDEX IF NOT EXISTS recordings_item ON recordings(source_id, content_type, item_id);
