-- 0025: archive programme length for downloads that can play during transfer.
ALTER TABLE downloads ADD COLUMN duration_seconds INTEGER;
