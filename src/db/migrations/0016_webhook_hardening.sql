-- Migration 0016: Webhook hardening — DLQ columns, signing key version
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS dlq_at timestamp;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS next_retry_at timestamp;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS signing_key_version integer NOT NULL DEFAULT 1;
