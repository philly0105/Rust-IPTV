-- The equivalent copy whose bytes a download row holds, as CopyRef JSON.
-- NULL means the row's own item. Cleared when the row starts over.
ALTER TABLE downloads ADD COLUMN origin_json TEXT;
