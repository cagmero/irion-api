-- Migration 0007: Add opted_in_assets to wallets table
--
-- Tracks which Algorand ASA IDs the wallet has opted into.
-- Populated during POST /v1/accounts/:id/wallets — the wallet creation endpoint
-- automatically opts the wallet into all SUPPORTED_DEPOSIT_ASSETS (e.g. TEST_USDC 758916950).
--
-- Type: integer[] (array of ASA IDs) — NOT jsonb, as these are plain integers.
-- Default: empty array (NOT NULL) — avoids NULL checks in application code.
--
-- Idempotency: the opt-in logic skips assets already in this array, preventing
-- duplicate opt-in transactions on retry.

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS opted_in_assets integer[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN wallets.opted_in_assets IS
  'Algorand ASA IDs this wallet has opted into. Populated during wallet creation. Used to skip duplicate opt-in txns.';
