-- 0003: EPG maintenance index (B1).
-- The EPG store replaces a feed's programmes with
-- `DELETE FROM epg_programs WHERE epg_url = ?` (and renames staging rows by
-- epg_url), and deleting an epg_sources row cascades into epg_programs by
-- epg_url. Without an index each of those scans every programme of every feed.
-- Lookups by channel already use idx_epg_programs_chan (channel_id, start).
CREATE INDEX IF NOT EXISTS idx_epg_programs_url ON epg_programs(epg_url);
