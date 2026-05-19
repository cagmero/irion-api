-- Migration 0005: Add algorand_address to wallets
-- Stores the Base32 Algorand address (58 chars) derived from the Turnkey Ed25519 public key.
-- Previously only turnkey_address (64-char hex) was stored; GET /accounts/:id was
-- returning the hex address instead of the Base32 address expected by API consumers.

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS algorand_address varchar(64);

-- Create index for address lookups
CREATE INDEX IF NOT EXISTS idx_wallets_algorand_address
  ON wallets (algorand_address)
  WHERE algorand_address IS NOT NULL;
