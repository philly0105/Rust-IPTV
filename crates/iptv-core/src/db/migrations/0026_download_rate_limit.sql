-- NULL follows the global default; zero explicitly means unlimited.
ALTER TABLE downloads ADD COLUMN rate_limit_bps INTEGER
    CHECK (rate_limit_bps IS NULL OR rate_limit_bps BETWEEN 0 AND 1073741824);
