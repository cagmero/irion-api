DO $$ BEGIN
 CREATE TYPE "public"."api_key_status_enum" AS ENUM('active', 'revoked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."institution_status_enum" AS ENUM('pending', 'active', 'suspended');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."kyb_status_enum" AS ENUM('initiated', 'approved', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."loan_status_enum" AS ENUM('pending', 'active', 'overdue', 'repaid', 'defaulted', 'liquidated');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."loan_type_enum" AS ENUM('installment', 'revolving', 'term', 'overcollateralized');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."transaction_status_enum" AS ENUM('pending', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."transfer_type_enum" AS ENUM('internal', 'onchain', 'fx');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."wallet_status_enum" AS ENUM('active', 'inactive');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."webhook_delivery_status_enum" AS ENUM('pending', 'delivered', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"key_prefix" varchar(32) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"status" "api_key_status_enum" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"action" varchar(255) NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "borrowing_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"accrued_interest" bigint DEFAULT 0 NOT NULL,
	"last_accrual_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"repayment_score" integer DEFAULT 0 NOT NULL,
	"volume_score" integer DEFAULT 0 NOT NULL,
	"tenure_score" integer DEFAULT 0 NOT NULL,
	"concentration_risk" integer DEFAULT 0 NOT NULL,
	"composite_score" integer DEFAULT 0 NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_profiles_institution_id_unique" UNIQUE("institution_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"client_request_id" varchar(255),
	"asset_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"status" "transaction_status_enum" DEFAULT 'pending' NOT NULL,
	"tx_hash" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fx_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"from_asset_id" integer NOT NULL,
	"to_asset_id" integer NOT NULL,
	"from_amount" bigint NOT NULL,
	"to_amount" bigint NOT NULL,
	"exchange_rate" numeric(20, 6) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"request_path" varchar(255) NOT NULL,
	"response_body" jsonb,
	"response_status" integer,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" "institution_status_enum" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kyb_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"didit_session_id" varchar(255) NOT NULL,
	"status" "kyb_status_enum" DEFAULT 'initiated' NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kyb_verifications_didit_session_id_unique" UNIQUE("didit_session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lending_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"accrued_yield" bigint DEFAULT 0 NOT NULL,
	"last_accrual_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loan_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"client_request_id" varchar(255),
	"amount" bigint NOT NULL,
	"status" "transaction_status_enum" DEFAULT 'pending' NOT NULL,
	"tx_hash" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loan_repayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"client_request_id" varchar(255),
	"amount" bigint NOT NULL,
	"status" "transaction_status_enum" DEFAULT 'pending' NOT NULL,
	"tx_hash" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"client_request_id" varchar(255),
	"type" "loan_type_enum" NOT NULL,
	"status" "loan_status_enum" DEFAULT 'pending' NOT NULL,
	"asset_id" integer NOT NULL,
	"principal_amount" bigint NOT NULL,
	"borrowed_amount" bigint DEFAULT 0 NOT NULL,
	"outstanding_balance" bigint DEFAULT 0 NOT NULL,
	"collateral_asset_id" integer,
	"collateral_amount" bigint,
	"interest_rate_bps" integer NOT NULL,
	"ltv_ratio_bps" integer,
	"term_days" integer,
	"installment_count" integer,
	"installments_paid" integer DEFAULT 0,
	"onchain_loan_id" bigint,
	"next_payment_due_at" timestamp,
	"originated_at" timestamp,
	"matures_at" timestamp,
	"defaulted_at" timestamp,
	"repaid_at" timestamp,
	"liquidated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"client_request_id" varchar(255),
	"amount" bigint NOT NULL,
	"destination_bank_details" "bytea" NOT NULL,
	"status" "transaction_status_enum" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"client_request_id" varchar(255),
	"type" "transfer_type_enum" NOT NULL,
	"asset_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"destination_address" varchar(255) NOT NULL,
	"status" "transaction_status_enum" DEFAULT 'pending' NOT NULL,
	"tx_hash" varchar(255),
	"fx_quote_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"label" varchar(255) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"turnkey_wallet_id" varchar(255) NOT NULL,
	"turnkey_address" varchar(255) NOT NULL,
	"status" "wallet_status_enum" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status_enum" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"url" varchar(1024) NOT NULL,
	"secret" "bytea" NOT NULL,
	"events" text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"client_request_id" varchar(255),
	"asset_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"status" "transaction_status_enum" DEFAULT 'pending' NOT NULL,
	"tx_hash" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "borrowing_positions" ADD CONSTRAINT "borrowing_positions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposits" ADD CONSTRAINT "deposits_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kyb_verifications" ADD CONSTRAINT "kyb_verifications_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lending_positions" ADD CONSTRAINT "lending_positions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_draws" ADD CONSTRAINT "loan_draws_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loans" ADD CONSTRAINT "loans_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payouts" ADD CONSTRAINT "payouts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transfers" ADD CONSTRAINT "transfers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transfers" ADD CONSTRAINT "transfers_fx_quote_id_fx_quotes_id_fk" FOREIGN KEY ("fx_quote_id") REFERENCES "public"."fx_quotes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallets" ADD CONSTRAINT "wallets_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_prefix" ON "api_keys" ("key_prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_institution" ON "audit_log" ("institution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_action_created" ON "audit_log" ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_borrowing_pos_compound" ON "borrowing_positions" ("institution_id","asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deposits_institution" ON "deposits" ("institution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deposits_tx_hash" ON "deposits" ("tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fx_quotes_institution" ON "fx_quotes" ("institution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_idempotency_expires_at" ON "idempotency_keys" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kyb_institution" ON "kyb_verifications" ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_lending_pos_compound" ON "lending_positions" ("institution_id","asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loan_draws_loan" ON "loan_draws" ("loan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loan_draws_tx_hash" ON "loan_draws" ("tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loan_repayments_loan" ON "loan_repayments" ("loan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loan_repayments_tx_hash" ON "loan_repayments" ("tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loans_institution_status" ON "loans" ("institution_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loans_next_payment_due" ON "loans" ("next_payment_due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loans_onchain_id" ON "loans" ("onchain_loan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payouts_institution" ON "payouts" ("institution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transfers_institution" ON "transfers" ("institution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transfers_tx_hash" ON "transfers" ("tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wallets_address" ON "wallets" ("turnkey_address");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_wallets_one_primary_per_institution" ON "wallets" ("institution_id") WHERE is_primary = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook" ON "webhook_deliveries" ("webhook_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_status_created" ON "webhook_deliveries" ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_institution" ON "webhooks" ("institution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_withdrawals_institution" ON "withdrawals" ("institution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_withdrawals_tx_hash" ON "withdrawals" ("tx_hash");--> statement-breakpoint

-- ==========================================
-- Custom Postgres Triggers for updated_at
-- ==========================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_updated_at_institutions BEFORE UPDATE ON institutions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_api_keys BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_kyb_verifications BEFORE UPDATE ON kyb_verifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_wallets BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_deposits BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_withdrawals BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_lending_positions BEFORE UPDATE ON lending_positions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_borrowing_positions BEFORE UPDATE ON borrowing_positions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_loans BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_loan_draws BEFORE UPDATE ON loan_draws FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_loan_repayments BEFORE UPDATE ON loan_repayments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_transfers BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_payouts BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_fx_quotes BEFORE UPDATE ON fx_quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_webhooks BEFORE UPDATE ON webhooks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trigger_set_updated_at_webhook_deliveries BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();