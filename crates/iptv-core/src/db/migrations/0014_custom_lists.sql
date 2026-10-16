-- 0014: custom channel lists (Run 2 contract C3, B2-lists-core).
--
-- A custom list is a user-named, user-ordered set of live and radio channels
-- that may mix several sources. `name` is trimmed and 1..=60 characters,
-- unique without regard to case. `position` is the list's place in the Live
-- sidebar and on the dashboard; `on_dashboard` shows it as a rail there.
-- `created_at` / `updated_at` are RFC 3339 UTC with milliseconds.
CREATE TABLE IF NOT EXISTS custom_lists (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL,
  on_dashboard INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_lists_name ON custom_lists(name COLLATE NOCASE);

-- One row per channel in a list. Keyed by the stable catalog id, never by a
-- foreign key to `items`: every refresh deletes and reinserts the source's
-- items, and a list must keep a channel the provider dropped (it is shown
-- greyed out from the `title` / `logo_url` snapshot). Removing the list or
-- the source removes its rows through the cascades.
CREATE TABLE IF NOT EXISTS custom_list_items (
  list_id      TEXT NOT NULL REFERENCES custom_lists(id) ON DELETE CASCADE,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('live','radio')),
  item_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  logo_url     TEXT,
  position     INTEGER NOT NULL,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (list_id, source_id, content_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_custom_list_items_order ON custom_list_items(list_id, position);
CREATE INDEX IF NOT EXISTS idx_custom_list_items_ref ON custom_list_items(source_id, content_type, item_id);
