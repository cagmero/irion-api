-- Migration 0008: Add signing provider columns to wallets table
--
-- Supports switching from Turnkey (HSM) to algosdk (in-process) signing.
-- algosdk provider stores encrypted private key material locally.
-- Turnkey provider remains available for future HSM-backed mainnet deployment.
--
-- Columns added:
--   - signing_provider: 'turnkey' (default) or 'algosdk'
--   - encrypted_sk_ciphertext: AES-256-GCM encrypted private key (base64)
--   - encrypted_sk_iv: Initialization vector (base64)
--   - encrypted_sk_auth_tag: Authentication tag (base64)
--   - encryption_key_version: For future key rotation support

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS signing_provider varchar(20) NOT NULL DEFAULT 'turnkey';

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS encrypted_sk_ciphertext varchar(255);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS encrypted_sk_iv varchar(44);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS encrypted_sk_auth_tag varchar(44);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS encryption_key_version integer;

COMMENT ON COLUMN wallets.signing_provider IS
  'Signing provider: turnkey (HSM-backed, default) or algosdk (in-process)';

COMMENT ON COLUMN wallets.encrypted_sk_ciphertext IS
  'AES-256-GCM encrypted Ed25519 private key (base64). Only populated for algosdk provider.';

COMMENT ON COLUMN wallets.encrypted_sk_iv IS
  'Initialization vector for private key encryption (base64). Only populated for algosdk provider.';

COMMENT ON COLUMN wallets.encrypted_sk_auth_tag IS
  'GCM authentication tag for private key encryption (base64). Only populated for algosdk provider.';

COMMENT ON COLUMN wallets.encryption_key_version IS
  'Version number for key rotation. Increment when master key is rotated.';