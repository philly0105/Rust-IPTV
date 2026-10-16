-- 0006: catalog list pages in playlist order (catalog.channels without a
-- category, catalog.allLiveChannels, neighbors) read rows in index order
-- instead of sorting the whole source on every page (50k-channel lists).
CREATE INDEX IF NOT EXISTS idx_items_pos ON items(source_id, content_type, position);
