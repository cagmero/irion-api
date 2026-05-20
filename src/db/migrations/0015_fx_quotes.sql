-- Migration 0015: Add wallet_id, used, price_impact_bps, fee_amount to fx_quotes
ALTER TABLE fx_quotes ADD COLUMN wallet_id uuid REFERENCES wallets(id);
ALTER TABLE fx_quotes ADD COLUMN used boolean NOT NULL DEFAULT false;
ALTER TABLE fx_quotes ADD COLUMN price_impact_bps integer;
ALTER TABLE fx_quotes ADD COLUMN fee_amount bigint;
