-- Migration 0004: Add turnkey_sub_org_id to institutions
-- Required by POST /v1/accounts/:id/wallets to call Turnkey createWallet.
-- NULL for existing rows (seed institution, any pre-migration provisioned institutions).
-- Populated by POST /v1/accounts for all new institutions going forward.

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS turnkey_sub_org_id varchar(255);
