-- Migration 0003: Allow NULL institution_id in audit_log
-- Required so anonymous auth failures (no matching API key) can be logged
-- without hitting a FK violation on the sentinel UUID.

ALTER TABLE audit_log
  ALTER COLUMN institution_id DROP NOT NULL;
