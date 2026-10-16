-- 0005: classified code of a source's last import error (C10).
-- Snake_case `RpcErrorCode` name (`network`, `auth`, ...) written next to
-- `last_error`; NULL when there is no error or it predates this column.
-- Additive: older rows keep working, and the schema_migrations version makes
-- it run once.
ALTER TABLE sources ADD COLUMN last_error_code TEXT;
