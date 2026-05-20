-- Migration 0013: Add wallet-specific columns to transfers table
-- Dual-population strategy:
--   to_wallet_id: populated for internal transfers (2f.1)
--   destination_address: populated for both internal (derived from to-wallet address) and external payouts (2f.2)
--   to_wallet_id = NULL for external payouts (2f.2)
ALTER TABLE transfers ADD COLUMN from_wallet_id uuid REFERENCES wallets(id);
ALTER TABLE transfers ADD COLUMN to_wallet_id uuid REFERENCES wallets(id);
ALTER TABLE transfers ADD COLUMN memo varchar(255);
