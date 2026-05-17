-- Migration: 0002_add_idempotency_columns.sql
-- Adds missing columns to idempotency_keys table for full idempotency support
-- Run: pnpm db:migrate

ALTER TABLE idempotency_keys 
ADD COLUMN IF NOT EXISTS request_method VARCHAR(10) NOT NULL DEFAULT 'POST',
ADD COLUMN IF NOT EXISTS request_body_hash VARCHAR(64) NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS response_headers JSONB;

-- Backfill request_method from existing records (assume POST for existing)
UPDATE idempotency_keys SET request_method = 'POST' WHERE request_method IS NULL;

-- Backfill request_body_hash with empty string for existing records
UPDATE idempotency_keys SET request_body_hash = '' WHERE request_body_hash IS NULL;

-- Add composite index for faster lookups
CREATE INDEX IF NOT EXISTS idx_idempotency_inst_path 
ON idempotency_keys (institution_id, request_path);

-- Set NOT NULL constraints after backfill
ALTER TABLE idempotency_keys 
ALTER COLUMN request_method SET NOT NULL,
ALTER COLUMN request_body_hash SET NOT NULL;