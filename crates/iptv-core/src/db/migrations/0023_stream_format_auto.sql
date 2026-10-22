-- 0023: settings.streamFormat gains "auto", the new default (xtream.md).
--
-- The settings document stores every field, so an install that never touched
-- the stream format has the old default "m3u8" saved, and nothing tells it
-- apart from a user who picked HLS. Both move to "auto" once, here; anyone who
-- wants HLS picks it again in Settings > Playback, and that choice then stays.
-- A document SQLite can't parse is left for load_settings to handle as before.
UPDATE settings SET json = json_set(json, '$.streamFormat', 'auto')
 WHERE json_valid(json) AND json_extract(json, '$.streamFormat') = 'm3u8';
