-- 0008: drop the epg_programs(epg_url) index (B9-core-D40).
-- 0007's unique idx_epg_programs_slot (epg_url, channel_id, start) leads with
-- epg_url, so it serves every `WHERE epg_url = ?` delete, the staging rename
-- and the epg_sources cascade that 0003's index was added for. Keeping both
-- only costs write time and memory during guide ingest.
DROP INDEX IF EXISTS idx_epg_programs_url;
