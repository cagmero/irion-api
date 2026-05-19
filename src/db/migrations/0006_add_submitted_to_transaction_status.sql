-- Migration 0006: Add 'submitted' to transaction_status_enum
--
-- Lifecycle: pending → submitted → completed | failed
--   pending   = deposit record created, signing not yet attempted
--   submitted = signed txns sent to algod, awaiting on-chain confirmation
--   completed = confirmed on-chain (BullMQ worker confirmed)
--   failed    = signing error, algod rejection, or confirmation timeout exhausted
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- Supabase/PG executes each migration file in its own session so this is safe.

ALTER TYPE transaction_status_enum ADD VALUE IF NOT EXISTS 'submitted' AFTER 'pending';
