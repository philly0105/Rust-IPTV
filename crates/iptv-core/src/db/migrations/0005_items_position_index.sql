-- 0005: list order index for unfiltered catalog pages.
-- `catalog.channels` / `catalog.query` without a category order by
-- `i.position` within one source and content type. idx_items_cat leads with
-- category_id, so those pages sorted the whole catalog in a temp B-tree on
-- every request (about 0.2-0.4 s per page at 200k channels). With this index
-- SQLite walks rows in list order and stops at LIMIT + OFFSET.
CREATE INDEX IF NOT EXISTS idx_items_pos ON items(source_id, content_type, position);
