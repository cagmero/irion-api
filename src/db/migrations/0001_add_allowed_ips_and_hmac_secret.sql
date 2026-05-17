-- Migration: 0001_add_allowed_ips
-- Add per-API-key IP allowlist and HMAC secret (encrypted with WEBHOOK_SIGNING_SECRET)

ALTER TABLE api_keys ADD COLUMN allowed_ips text[] DEFAULT NULL;
COMMENT ON COLUMN api_keys.allowed_ips IS 'NULL = no IP restriction. Populated array = strict IP allowlist.';

CREATE INDEX IF NOT EXISTS idx_api_keys_allowed_ips ON api_keys USING GIN(allowed_ips) WHERE allowed_ips IS NOT NULL;

ALTER TABLE api_keys ADD COLUMN hmac_secret bytea DEFAULT NULL;
COMMENT ON COLUMN api_keys.hmac_secret IS 'Per-key HMAC secret, pgcrypto-encrypted with WEBHOOK_SIGNING_SECRET. Used for request signing.';