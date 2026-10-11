-- 0004: watched flag on playback positions (B2).
-- `userstate.setWatched` marks an item or episode watched (1) without losing
-- its row; `positions.continueWatching` skips watched rows.
ALTER TABLE playback_positions ADD COLUMN watched INTEGER NOT NULL DEFAULT 0;
