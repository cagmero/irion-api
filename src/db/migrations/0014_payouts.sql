-- Migration 0014: Payouts VIEW
DROP VIEW IF EXISTS payouts;
CREATE VIEW payouts AS
  SELECT * FROM transfers
  WHERE to_wallet_id IS NULL AND type = 'onchain';
