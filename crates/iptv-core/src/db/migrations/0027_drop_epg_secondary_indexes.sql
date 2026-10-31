-- 0027: drop the epg_programs(channel_id, start) and epg_programs(stop)
-- indexes.
--
-- Every guide read (grid, now/next, the feed pick), the store's deletes and
-- the epg_sources cascade use 0007's unique idx_epg_programs_slot
-- (epg_url, channel_id, start). The two dropped indexes served only the
-- "does this channel have programmes" probe, which now probes the slot
-- index once per feed, and the guide search's fallback scan, which read
-- every programme still to end in random order through the stop index and
-- is faster as a table scan. Each refresh paid for both on every programme
-- it deleted and inserted: about 45% of the swap, 26 MB per 600k programmes
-- on disk, and part of the WAL each refresh writes.
DROP INDEX IF EXISTS idx_epg_programs_chan;
DROP INDEX IF EXISTS idx_epg_programs_stop;
