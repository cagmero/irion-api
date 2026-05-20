import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  bigint,
  jsonb,
  boolean,
  decimal,
  text,
  customType,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── PRECISION NOTE ────────────────────────────────────────────────────────────
// All financial amount columns use bigint({ mode: "bigint" }) — Drizzle returns
// these as JS `bigint`, which preserves integer precision up to 2^63-1 (the int8
// max). Route handlers serialize amounts as strings for JSON transport.
// Migration completed in Phase 2h.2a.
// ─────────────────────────────────────────────────────────────────────────────

// Custom type for bytea (used for pgcrypto)
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(val: Buffer): Buffer {
    return val;
  },
  fromDriver(val: Buffer): Buffer {
    return val;
  },
});

// Enums
export const institutionStatusEnum = pgEnum("institution_status_enum", ["pending", "active", "suspended"]);
export const apiKeyStatusEnum = pgEnum("api_key_status_enum", ["active", "revoked"]);
export const kybStatusEnum = pgEnum("kyb_status_enum", ["initiated", "approved", "rejected"]);
export const walletStatusEnum = pgEnum("wallet_status_enum", ["active", "inactive"]);
export const transactionStatusEnum = pgEnum("transaction_status_enum", ["pending", "submitted", "completed", "failed"]);
export const loanTypeEnum = pgEnum("loan_type_enum", ["installment", "revolving", "term", "overcollateralized"]);
export const loanStatusEnum = pgEnum("loan_status_enum", ["pending", "submitted", "collateral_locked", "active", "overdue", "repaid", "defaulted", "liquidated", "failed_compensating", "failed_released"]);
export const transferTypeEnum = pgEnum("transfer_type_enum", ["internal", "onchain", "fx"]);
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status_enum", ["pending", "delivered", "failed"]);

// 1. institutions
export const institutions = pgTable("institutions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  status: institutionStatusEnum("status").notNull().default("pending"),
  // Turnkey sub-organization ID — populated during POST /v1/accounts, required by POST /wallets.
  // NULL for the seed institution (which was created before this column was added) and any
  // institution whose Turnkey sub-org creation failed (status = 'suspended').
  turnkeySubOrgId: varchar("turnkey_sub_org_id", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 2. api_keys
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    keyPrefix: varchar("key_prefix", { length: 32 }).notNull(),
    keyHash: varchar("key_hash", { length: 255 }).notNull(),
    hmacSecret: bytea("hmac_secret"),
    allowedIps: text("allowed_ips").array(),
    status: apiKeyStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    prefixIdx: index("idx_api_keys_prefix").on(table.keyPrefix),
    allowedIpsIdx: index("idx_api_keys_allowed_ips").on(table.allowedIps),
  })
);

// 3. kyb_verifications
export const kybVerifications = pgTable(
  "kyb_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    diditSessionId: varchar("didit_session_id", { length: 255 }).notNull().unique(),
    status: kybStatusEnum("status").notNull().default("initiated"),
    details: jsonb("details"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_kyb_institution").on(table.institutionId),
  })
);

// 4. wallets
export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    label: varchar("label", { length: 255 }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    turnkeyWalletId: varchar("turnkey_wallet_id", { length: 255 }).notNull(),
    turnkeyAddress: varchar("turnkey_address", { length: 255 }).notNull(),  // 64-char hex Ed25519 pubkey (signWith key)
    algorandAddress: varchar("algorand_address", { length: 64 }),           // 58-char Base32 (public-facing identifier)
    optedInAssets: integer("opted_in_assets").array().notNull().default(sql`'{}'::integer[]`),  // ASA IDs opted into at creation
    // Signing provider columns (migration 0008)
    signingProvider: varchar("signing_provider", { length: 20 }).notNull().default("turnkey"),
    encryptedSkCiphertext: varchar("encrypted_sk_ciphertext", { length: 255 }),
    encryptedSkIv: varchar("encrypted_sk_iv", { length: 44 }),
    encryptedSkAuthTag: varchar("encrypted_sk_auth_tag", { length: 44 }),
    encryptionKeyVersion: integer("encryption_key_version"),
    status: walletStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    addressIdx: index("idx_wallets_address").on(table.turnkeyAddress),
    primaryInstIdx: uniqueIndex("idx_wallets_one_primary_per_institution")
      .on(table.institutionId)
      .where(sql`is_primary = true`),
  })
);

// 5. credit_profiles
export const creditProfiles = pgTable("credit_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  institutionId: uuid("institution_id")
    .notNull()
    .unique()
    .references(() => institutions.id),
  repaymentScore: integer("repayment_score").notNull().default(0),
  volumeScore: integer("volume_score").notNull().default(0),
  tenureScore: integer("tenure_score").notNull().default(0),
  concentrationRisk: integer("concentration_risk").notNull().default(0),
  compositeScore: integer("composite_score").notNull().default(0),
  lastUpdated: timestamp("last_updated").notNull().defaultNow(),
});

// 6. deposits
export const deposits = pgTable(
  "deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    clientRequestId: varchar("client_request_id", { length: 255 }),
    assetId: integer("asset_id").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(), // PRECISION
    status: transactionStatusEnum("status").notNull().default("pending"),
    txHash: varchar("tx_hash", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_deposits_institution").on(table.institutionId),
    txHashIdx: index("idx_deposits_tx_hash").on(table.txHash),
  })
);

// 7. withdrawals
export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    clientRequestId: varchar("client_request_id", { length: 255 }),
    assetId: integer("asset_id").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(), // PRECISION
    status: transactionStatusEnum("status").notNull().default("pending"),
    txHash: varchar("tx_hash", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_withdrawals_institution").on(table.institutionId),
    txHashIdx: index("idx_withdrawals_tx_hash").on(table.txHash),
  })
);

// 8. lending_positions
export const lendingPositions = pgTable(
  "lending_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    assetId: integer("asset_id").notNull(),
    balance: bigint("balance", { mode: "bigint" }).notNull().default(0), // PRECISION — lp_token_balance
    accruedYield: bigint("accrued_yield", { mode: "bigint" }).notNull().default(0), // PRECISION
    lastAccrualAt: timestamp("last_accrual_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    compoundIdx: uniqueIndex("idx_lending_pos_compound").on(table.institutionId, table.assetId),
  })
);

// 9. borrowing_positions
export const borrowingPositions = pgTable(
  "borrowing_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    assetId: integer("asset_id").notNull(),
    balance: bigint("balance", { mode: "bigint" }).notNull().default(0), // PRECISION — outstanding_borrow_balance
    accruedInterest: bigint("accrued_interest", { mode: "bigint" }).notNull().default(0), // PRECISION
    lastAccrualAt: timestamp("last_accrual_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    compoundIdx: uniqueIndex("idx_borrowing_pos_compound").on(table.institutionId, table.assetId),
  })
);

// 10. loans
export const loans = pgTable(
  "loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    walletId: uuid("wallet_id")
      .references(() => wallets.id),
    clientRequestId: varchar("client_request_id", { length: 255 }),
    type: loanTypeEnum("type").notNull(),
    status: loanStatusEnum("status").notNull().default("pending"),
    assetId: integer("asset_id").notNull(),
    principalAmount: bigint("principal_amount", { mode: "bigint" }).notNull(), // PRECISION
    borrowedAmount: bigint("borrowed_amount", { mode: "bigint" }).notNull().default(0), // PRECISION
    outstandingBalance: bigint("outstanding_balance", { mode: "bigint" }).notNull().default(0), // PRECISION
    collateralAssetId: integer("collateral_asset_id"),
    collateralAmount: bigint("collateral_amount", { mode: "bigint" }), // PRECISION
    collateralRatioBps: integer("collateral_ratio_bps"),
    creditLimit: bigint("credit_limit", { mode: "bigint" }),
    drawnAmount: bigint("drawn_amount", { mode: "bigint" }).notNull().default(0),
    accruedInterest: bigint("accrued_interest", { mode: "bigint" }).notNull().default(0),
    lateFeeBps: integer("late_fee_bps"),
    lateFeeApplied: boolean("late_fee_applied").notNull().default(false),
    interestRateBps: integer("interest_rate_bps").notNull(),
    ltvRatioBps: integer("ltv_ratio_bps"),
    termDays: integer("term_days"),
    installmentCount: integer("installment_count"),
    installmentsPaid: integer("installments_paid").default(0),
    installmentIntervalRounds: integer("installment_interval_rounds"),
    onchainLoanId: bigint("onchain_loan_id", { mode: "bigint" }), // PRECISION
    maturityRound: bigint("maturity_round", { mode: "bigint" }),
    txHash: varchar("tx_hash", { length: 255 }),
    vaultId: integer("vault_id"),
    releaseTxHash: varchar("release_tx_hash", { length: 255 }),
    nextPaymentDueAt: timestamp("next_payment_due_at"),
    originatedAt: timestamp("originated_at"),
    maturesAt: timestamp("matures_at"),
    defaultedAt: timestamp("defaulted_at"),
    repaidAt: timestamp("repaid_at"),
    liquidatedAt: timestamp("liquidated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    instStatusIdx: index("idx_loans_institution_status").on(table.institutionId, table.status),
    nextPaymentIdx: index("idx_loans_next_payment_due").on(table.nextPaymentDueAt),
    onchainIdIdx: index("idx_loans_onchain_id").on(table.onchainLoanId),
  })
);

// 11. loan_draws
export const loanDraws = pgTable(
  "loan_draws",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    clientRequestId: varchar("client_request_id", { length: 255 }),
    amount: bigint("amount", { mode: "bigint" }).notNull(), // PRECISION
    status: transactionStatusEnum("status").notNull().default("pending"),
    txHash: varchar("tx_hash", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    loanIdx: index("idx_loan_draws_loan").on(table.loanId),
    txHashIdx: index("idx_loan_draws_tx_hash").on(table.txHash),
  })
);

// 12. loan_repayments
export const loanRepayments = pgTable(
  "loan_repayments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    clientRequestId: varchar("client_request_id", { length: 255 }),
    amount: bigint("amount", { mode: "bigint" }).notNull(), // PRECISION
    status: transactionStatusEnum("status").notNull().default("pending"),
    txHash: varchar("tx_hash", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    loanIdx: index("idx_loan_repayments_loan").on(table.loanId),
    txHashIdx: index("idx_loan_repayments_tx_hash").on(table.txHash),
  })
);

// 13. installments
export const installments = pgTable(
  "installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    installmentIndex: integer("installment_index").notNull(),
    dueRound: bigint("due_round", { mode: "bigint" }).notNull(),
    principalPortion: bigint("principal_portion", { mode: "bigint" }).notNull(),
    interestPortion: bigint("interest_portion", { mode: "bigint" }).notNull(),
    totalAmount: bigint("total_amount", { mode: "bigint" }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    amountPaid: bigint("amount_paid", { mode: "bigint" }).notNull().default(0),
    paidAtRound: bigint("paid_at_round", { mode: "bigint" }),
    txHash: varchar("tx_hash", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    loanIndexIdx: index("idx_installments_loan_index").on(table.loanId, table.installmentIndex),
    uniqueLoanInst: uniqueIndex("idx_installments_loan_installment").on(table.loanId, table.installmentIndex),
  })
);

// 14. fx_quotes (defined before transfers so transfers can reference it)
export const fxQuotes = pgTable(
  "fx_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    fromAssetId: integer("from_asset_id").notNull(),
    toAssetId: integer("to_asset_id").notNull(),
    fromAmount: bigint("from_amount", { mode: "bigint" }).notNull(), // PRECISION
    toAmount: bigint("to_amount", { mode: "bigint" }).notNull(), // PRECISION
    exchangeRate: decimal("exchange_rate", { precision: 20, scale: 6 }).notNull(),
    walletId: uuid("wallet_id").references(() => wallets.id),
    used: boolean("used").notNull().default(false),
    priceImpactBps: integer("price_impact_bps"),
    feeAmount: bigint("fee_amount", { mode: "bigint" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_fx_quotes_institution").on(table.institutionId),
  })
);

// 13. transfers
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    clientRequestId: varchar("client_request_id", { length: 255 }),
    fromWalletId: uuid("from_wallet_id").references(() => wallets.id),
    toWalletId: uuid("to_wallet_id").references(() => wallets.id),
    type: transferTypeEnum("type").notNull(),
    assetId: integer("asset_id").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(), // PRECISION
    destinationAddress: varchar("destination_address", { length: 255 }).notNull(),
    memo: varchar("memo", { length: 255 }),
    status: transactionStatusEnum("status").notNull().default("pending"),
    txHash: varchar("tx_hash", { length: 255 }),
    fxQuoteId: uuid("fx_quote_id").references(() => fxQuotes.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_transfers_institution").on(table.institutionId),
    txHashIdx: index("idx_transfers_tx_hash").on(table.txHash),
  })
);

// 15. payouts
export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    clientRequestId: varchar("client_request_id", { length: 255 }),
    amount: bigint("amount", { mode: "bigint" }).notNull(), // PRECISION
    destinationBankDetails: bytea("destination_bank_details").notNull(), // encrypted
    status: transactionStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_payouts_institution").on(table.institutionId),
  })
);

// 16. webhooks
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    url: varchar("url", { length: 1024 }).notNull(),
    secret: bytea("secret").notNull(), // encrypted
    previousSecret: bytea("previous_secret"), // encrypted previous secret (rotation grace)
    previousSecretVersion: integer("previous_secret_version"),
    gracePeriodEndsAt: timestamp("grace_period_ends_at"),
    events: text("events").array().notNull(),
    description: varchar("description", { length: 255 }),
    isActive: boolean("is_active").notNull().default(true),
    signingKeyVersion: integer("signing_key_version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_webhooks_institution").on(table.institutionId),
  })
);

// 17. webhook_deliveries
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: varchar("last_error", { length: 1024 }),
    dlqAt: timestamp("dlq_at"),
    nextRetryAt: timestamp("next_retry_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    webhookIdx: index("idx_webhook_deliveries_webhook").on(table.webhookId),
    statusCreatedIdx: index("idx_webhook_deliveries_status_created").on(table.status, table.createdAt),
  })
);

// 18. idempotency_keys
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: varchar("key", { length: 255 }).primaryKey(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    requestPath: varchar("request_path", { length: 255 }).notNull(),
    requestMethod: varchar("request_method", { length: 10 }).notNull(),
    requestBodyHash: varchar("request_body_hash", { length: 64 }).notNull(),
    responseBody: jsonb("response_body"),
    responseStatus: integer("response_status").notNull(),
    responseHeaders: jsonb("response_headers"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index("idx_idempotency_expires_at").on(table.expiresAt),
    instPathIdx: index("idx_idempotency_inst_path").on(table.institutionId, table.requestPath),
  })
);

// 19. audit_log
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .references(() => institutions.id),     // nullable: anonymous auth-failure rows use NULL
    action: varchar("action", { length: 255 }).notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    institutionIdx: index("idx_audit_log_institution").on(table.institutionId),
    actionCreatedIdx: index("idx_audit_log_action_created").on(table.action, table.createdAt),
  })
);
