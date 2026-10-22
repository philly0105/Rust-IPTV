-- 0024: category pages read their own range (CAT-1 in the speed pass).
--
-- A category page on the default sort (date added: every category grid,
-- the category rails of the movie and series landing pages and the "More
-- in" rail of a detail page) read the source's idx_items_added_src and
-- tested the category on each entry. Without statistics SQLite rates two
-- equalities on an ordered, covering index about as selective as three on
-- idx_items_cat, which can neither order nor cover that page. A category
-- smaller than a page, the last page of any category and a category of old
-- titles walked every title of the source (6.5-9.5 ms at 182k movies in
-- release). This index holds the category's titles in that order, with the
-- verdict, the rating and the year, so English-only, a rating floor and a
-- decade (written `+i.rating` / `+i.year`) stay index-only. A category's
-- count with a rating floor reads it too, and a small category sorted by
-- rating or year reads its range here and sorts it (catalog::query_named).
CREATE INDEX idx_items_cat_added ON items(source_id, content_type, category_id, added DESC, position, non_english, rating, year);

-- Without statistics SQLite counts through the covering index created last
-- when several cost the same (0022), so the narrow idx_items_cat is built
-- again after the new one. CatalogWriter's bulk rebuild keeps this order.
DROP INDEX IF EXISTS idx_items_cat;
CREATE INDEX idx_items_cat ON items(source_id, content_type, category_id, position, non_english, year, quality);
