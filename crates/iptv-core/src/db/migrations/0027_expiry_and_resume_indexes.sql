-- 0027: two small indexes for reads that scanned a whole table.
--
-- The boot purge of expired TMDB rows (tmdb::init) filtered on expires_at,
-- the last column, after payload_json: every row's overflow chain was read
-- to reach it, so the DELETE read the whole cache (37 MB for 3,000 detail
-- and 3,000 search rows: 9.3 ms warm, about 1 s cold on eMMC, against
-- 0.15 ms with this index). It now touches only the expired rows (R4-2).
CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdb_cache(expires_at);

-- Continue watching (userstate::continue_watching_filtered) reads the
-- unwatched rows newest first and stops at its limit, instead of ranking
-- every position row with a window function. Watched rows are kept for
-- good (C13), so that cost grew with the whole viewing history: 4.7 ms at
-- 4,283 rows, against 0.83 ms for the newest-row query alone and 0.13 ms
-- with it on this index (R4-3).
CREATE INDEX IF NOT EXISTS idx_positions_resume ON playback_positions(updated_at DESC) WHERE watched = 0;
