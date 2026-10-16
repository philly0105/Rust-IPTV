-- 0007: one programme per (feed, channel, start) (B8-parsers D20, B9-D37).
-- A feed that lists the same slot twice used to store both rows; the guide
-- queries kept the first by start (epg/query.rs `tidy`). The store now
-- writes with INSERT OR IGNORE against this index, so the first row in feed
-- order wins, matching what the queries showed. Duplicates across different
-- feeds are still resolved at query time.
--
-- The stored guide is a cache, so the upgrade drops it instead of removing
-- duplicates row by row: deduping a multi-million-row guide took 15 s or
-- more before the window showed (review round 3). The table is dropped and
-- recreated with its 0001 schema and indexes, because a plain DELETE visits
-- every row (SQLite skips its truncate path for a table with a foreign
-- key), while DROP TABLE of a child table only frees its pages. 0003's
-- epg_url index is not recreated: 0008 drops it. Clearing each feed's fetch
-- state (last fetch time, ETag) makes the next scheduler pass download every
-- guide again. The feeds and their channel lists stay. Databases that
-- already ran the earlier form of this migration have the same table and
-- indexes and are not touched again.
DROP TABLE epg_programs;
CREATE TABLE epg_programs (epg_url TEXT NOT NULL REFERENCES epg_sources(url) ON DELETE CASCADE, channel_id TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT, icon TEXT);  -- start/stop unix seconds UTC
CREATE INDEX idx_epg_programs_chan ON epg_programs(channel_id, start);
CREATE INDEX idx_epg_programs_stop ON epg_programs(stop);
CREATE UNIQUE INDEX idx_epg_programs_slot
    ON epg_programs(epg_url, channel_id, start);
UPDATE epg_sources SET last_fetch_at = NULL, etag = NULL, program_count = 0;
