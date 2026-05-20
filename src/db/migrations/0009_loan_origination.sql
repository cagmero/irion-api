-- Migration 0009: Loan origination columns + status enum values
-- Adds wallet_id, tx_hash, release_tx_hash, collateral_ratio_bps to loans
-- Adds state machine values for the two-step origination flow

ALTER TABLE loans ADD COLUMN wallet_id uuid REFERENCES wallets(id);
ALTER TABLE loans ADD COLUMN tx_hash varchar(255);
ALTER TABLE loans ADD COLUMN vault_id integer;
ALTER TABLE loans ADD COLUMN release_tx_hash varchar(255);
ALTER TABLE loans ADD COLUMN collateral_ratio_bps integer;

ALTER TYPE loan_status_enum ADD VALUE 'submitted' AFTER 'pending';
ALTER TYPE loan_status_enum ADD VALUE 'collateral_locked' AFTER 'submitted';
ALTER TYPE loan_status_enum ADD VALUE 'failed_compensating' AFTER 'liquidated';
ALTER TYPE loan_status_enum ADD VALUE 'failed_released' AFTER 'failed_compensating';
