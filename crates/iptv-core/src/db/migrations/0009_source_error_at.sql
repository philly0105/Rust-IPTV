-- 0009: when a source's last import error was recorded (RFC 3339).
-- Written next to `last_error`; NULL when there is no error or it predates
-- this column. Additive, like 0005.
ALTER TABLE sources ADD COLUMN last_error_at TEXT;
