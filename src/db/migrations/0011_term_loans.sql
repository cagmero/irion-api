-- Migration 0011: TERM loan columns
ALTER TABLE loans ADD COLUMN maturity_round bigint;
ALTER TABLE loans ADD COLUMN accrued_interest bigint NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN late_fee_bps integer;
ALTER TABLE loans ADD COLUMN late_fee_applied boolean NOT NULL DEFAULT false;
