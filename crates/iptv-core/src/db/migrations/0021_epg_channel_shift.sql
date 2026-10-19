-- 0021: guide time shift per channel (epg.setChannelShift, the mapping dialog).
--
-- One row per channel with its own shift, in minutes; it replaces the
-- channel's tvg-shift, and the source's shift (sources.epg_json
-- `shiftMinutes`) still adds to it (epg::query::item_shift). Keyed like
-- epg_channel_map, by the stable catalog id rather than a foreign key to
-- items, so a refresh keeps it; the m3u remapper moves it with the other
-- user tables, and removing the source removes it through the cascade.
CREATE TABLE IF NOT EXISTS epg_channel_shift (
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  shift_minutes INTEGER NOT NULL,
  PRIMARY KEY (source_id, content_type, item_id)
);
