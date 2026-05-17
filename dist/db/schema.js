"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLog = exports.idempotencyKeys = exports.webhookDeliveries = exports.webhooks = exports.payouts = exports.transfers = exports.fxQuotes = exports.loanRepayments = exports.loanDraws = exports.loans = exports.borrowingPositions = exports.lendingPositions = exports.withdrawals = exports.deposits = exports.creditProfiles = exports.wallets = exports.kybVerifications = exports.apiKeys = exports.institutions = exports.webhookDeliveryStatusEnum = exports.transferTypeEnum = exports.loanStatusEnum = exports.loanTypeEnum = exports.transactionStatusEnum = exports.walletStatusEnum = exports.kybStatusEnum = exports.apiKeyStatusEnum = exports.institutionStatusEnum = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
// Custom type for bytea (used for pgcrypto)
const bytea = (0, pg_core_1.customType)({
    dataType() {
        return "bytea";
    },
    toDriver(val) {
        return val;
    },
    fromDriver(val) {
        return val;
    },
});
// Enums
exports.institutionStatusEnum = (0, pg_core_1.pgEnum)("institution_status_enum", ["pending", "active", "suspended"]);
exports.apiKeyStatusEnum = (0, pg_core_1.pgEnum)("api_key_status_enum", ["active", "revoked"]);
exports.kybStatusEnum = (0, pg_core_1.pgEnum)("kyb_status_enum", ["initiated", "approved", "rejected"]);
exports.walletStatusEnum = (0, pg_core_1.pgEnum)("wallet_status_enum", ["active", "inactive"]);
exports.transactionStatusEnum = (0, pg_core_1.pgEnum)("transaction_status_enum", ["pending", "completed", "failed"]);
exports.loanTypeEnum = (0, pg_core_1.pgEnum)("loan_type_enum", ["installment", "revolving", "term", "overcollateralized"]);
exports.loanStatusEnum = (0, pg_core_1.pgEnum)("loan_status_enum", ["pending", "active", "overdue", "repaid", "defaulted", "liquidated"]);
exports.transferTypeEnum = (0, pg_core_1.pgEnum)("transfer_type_enum", ["internal", "onchain", "fx"]);
exports.webhookDeliveryStatusEnum = (0, pg_core_1.pgEnum)("webhook_delivery_status_enum", ["pending", "delivered", "failed"]);
// 1. institutions
exports.institutions = (0, pg_core_1.pgTable)("institutions", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    name: (0, pg_core_1.varchar)("name", { length: 255 }).notNull(),
    status: (0, exports.institutionStatusEnum)("status").notNull().default("pending"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
});
// 2. api_keys
exports.apiKeys = (0, pg_core_1.pgTable)("api_keys", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    keyPrefix: (0, pg_core_1.varchar)("key_prefix", { length: 32 }).notNull(),
    keyHash: (0, pg_core_1.varchar)("key_hash", { length: 255 }).notNull(),
    hmacSecret: bytea("hmac_secret"),
    allowedIps: (0, pg_core_1.text)("allowed_ips").array(),
    status: (0, exports.apiKeyStatusEnum)("status").notNull().default("active"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    prefixIdx: (0, pg_core_1.index)("idx_api_keys_prefix").on(table.keyPrefix),
    allowedIpsIdx: (0, pg_core_1.index)("idx_api_keys_allowed_ips").on(table.allowedIps),
}));
// 3. kyb_verifications
exports.kybVerifications = (0, pg_core_1.pgTable)("kyb_verifications", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    diditSessionId: (0, pg_core_1.varchar)("didit_session_id", { length: 255 }).notNull().unique(),
    status: (0, exports.kybStatusEnum)("status").notNull().default("initiated"),
    details: (0, pg_core_1.jsonb)("details"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_kyb_institution").on(table.institutionId),
}));
// 4. wallets
exports.wallets = (0, pg_core_1.pgTable)("wallets", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    label: (0, pg_core_1.varchar)("label", { length: 255 }).notNull(),
    isPrimary: (0, pg_core_1.boolean)("is_primary").notNull().default(false),
    turnkeyWalletId: (0, pg_core_1.varchar)("turnkey_wallet_id", { length: 255 }).notNull(),
    turnkeyAddress: (0, pg_core_1.varchar)("turnkey_address", { length: 255 }).notNull(),
    status: (0, exports.walletStatusEnum)("status").notNull().default("active"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    addressIdx: (0, pg_core_1.index)("idx_wallets_address").on(table.turnkeyAddress),
    primaryInstIdx: (0, pg_core_1.uniqueIndex)("idx_wallets_one_primary_per_institution")
        .on(table.institutionId)
        .where((0, drizzle_orm_1.sql) `is_primary = true`),
}));
// 5. credit_profiles
exports.creditProfiles = (0, pg_core_1.pgTable)("credit_profiles", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .unique()
        .references(() => exports.institutions.id),
    repaymentScore: (0, pg_core_1.integer)("repayment_score").notNull().default(0),
    volumeScore: (0, pg_core_1.integer)("volume_score").notNull().default(0),
    tenureScore: (0, pg_core_1.integer)("tenure_score").notNull().default(0),
    concentrationRisk: (0, pg_core_1.integer)("concentration_risk").notNull().default(0),
    compositeScore: (0, pg_core_1.integer)("composite_score").notNull().default(0),
    lastUpdated: (0, pg_core_1.timestamp)("last_updated").notNull().defaultNow(),
});
// 6. deposits
exports.deposits = (0, pg_core_1.pgTable)("deposits", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    clientRequestId: (0, pg_core_1.varchar)("client_request_id", { length: 255 }),
    assetId: (0, pg_core_1.integer)("asset_id").notNull(),
    amount: (0, pg_core_1.bigint)("amount", { mode: "number" }).notNull(),
    status: (0, exports.transactionStatusEnum)("status").notNull().default("pending"),
    txHash: (0, pg_core_1.varchar)("tx_hash", { length: 255 }),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_deposits_institution").on(table.institutionId),
    txHashIdx: (0, pg_core_1.index)("idx_deposits_tx_hash").on(table.txHash),
}));
// 7. withdrawals
exports.withdrawals = (0, pg_core_1.pgTable)("withdrawals", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    clientRequestId: (0, pg_core_1.varchar)("client_request_id", { length: 255 }),
    assetId: (0, pg_core_1.integer)("asset_id").notNull(),
    amount: (0, pg_core_1.bigint)("amount", { mode: "number" }).notNull(),
    status: (0, exports.transactionStatusEnum)("status").notNull().default("pending"),
    txHash: (0, pg_core_1.varchar)("tx_hash", { length: 255 }),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_withdrawals_institution").on(table.institutionId),
    txHashIdx: (0, pg_core_1.index)("idx_withdrawals_tx_hash").on(table.txHash),
}));
// 8. lending_positions
exports.lendingPositions = (0, pg_core_1.pgTable)("lending_positions", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    assetId: (0, pg_core_1.integer)("asset_id").notNull(),
    balance: (0, pg_core_1.bigint)("balance", { mode: "number" }).notNull().default(0), // lp_token_balance
    accruedYield: (0, pg_core_1.bigint)("accrued_yield", { mode: "number" }).notNull().default(0),
    lastAccrualAt: (0, pg_core_1.timestamp)("last_accrual_at"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    compoundIdx: (0, pg_core_1.uniqueIndex)("idx_lending_pos_compound").on(table.institutionId, table.assetId),
}));
// 9. borrowing_positions
exports.borrowingPositions = (0, pg_core_1.pgTable)("borrowing_positions", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    assetId: (0, pg_core_1.integer)("asset_id").notNull(),
    balance: (0, pg_core_1.bigint)("balance", { mode: "number" }).notNull().default(0), // outstanding_borrow_balance
    accruedInterest: (0, pg_core_1.bigint)("accrued_interest", { mode: "number" }).notNull().default(0),
    lastAccrualAt: (0, pg_core_1.timestamp)("last_accrual_at"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    compoundIdx: (0, pg_core_1.uniqueIndex)("idx_borrowing_pos_compound").on(table.institutionId, table.assetId),
}));
// 10. loans
exports.loans = (0, pg_core_1.pgTable)("loans", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    clientRequestId: (0, pg_core_1.varchar)("client_request_id", { length: 255 }),
    type: (0, exports.loanTypeEnum)("type").notNull(),
    status: (0, exports.loanStatusEnum)("status").notNull().default("pending"),
    assetId: (0, pg_core_1.integer)("asset_id").notNull(),
    principalAmount: (0, pg_core_1.bigint)("principal_amount", { mode: "number" }).notNull(),
    borrowedAmount: (0, pg_core_1.bigint)("borrowed_amount", { mode: "number" }).notNull().default(0),
    outstandingBalance: (0, pg_core_1.bigint)("outstanding_balance", { mode: "number" }).notNull().default(0),
    collateralAssetId: (0, pg_core_1.integer)("collateral_asset_id"),
    collateralAmount: (0, pg_core_1.bigint)("collateral_amount", { mode: "number" }),
    interestRateBps: (0, pg_core_1.integer)("interest_rate_bps").notNull(),
    ltvRatioBps: (0, pg_core_1.integer)("ltv_ratio_bps"),
    termDays: (0, pg_core_1.integer)("term_days"),
    installmentCount: (0, pg_core_1.integer)("installment_count"),
    installmentsPaid: (0, pg_core_1.integer)("installments_paid").default(0),
    onchainLoanId: (0, pg_core_1.bigint)("onchain_loan_id", { mode: "number" }),
    nextPaymentDueAt: (0, pg_core_1.timestamp)("next_payment_due_at"),
    originatedAt: (0, pg_core_1.timestamp)("originated_at"),
    maturesAt: (0, pg_core_1.timestamp)("matures_at"),
    defaultedAt: (0, pg_core_1.timestamp)("defaulted_at"),
    repaidAt: (0, pg_core_1.timestamp)("repaid_at"),
    liquidatedAt: (0, pg_core_1.timestamp)("liquidated_at"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    instStatusIdx: (0, pg_core_1.index)("idx_loans_institution_status").on(table.institutionId, table.status),
    nextPaymentIdx: (0, pg_core_1.index)("idx_loans_next_payment_due").on(table.nextPaymentDueAt),
    onchainIdIdx: (0, pg_core_1.index)("idx_loans_onchain_id").on(table.onchainLoanId),
}));
// 11. loan_draws
exports.loanDraws = (0, pg_core_1.pgTable)("loan_draws", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    loanId: (0, pg_core_1.uuid)("loan_id")
        .notNull()
        .references(() => exports.loans.id),
    clientRequestId: (0, pg_core_1.varchar)("client_request_id", { length: 255 }),
    amount: (0, pg_core_1.bigint)("amount", { mode: "number" }).notNull(),
    status: (0, exports.transactionStatusEnum)("status").notNull().default("pending"),
    txHash: (0, pg_core_1.varchar)("tx_hash", { length: 255 }),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    loanIdx: (0, pg_core_1.index)("idx_loan_draws_loan").on(table.loanId),
    txHashIdx: (0, pg_core_1.index)("idx_loan_draws_tx_hash").on(table.txHash),
}));
// 12. loan_repayments
exports.loanRepayments = (0, pg_core_1.pgTable)("loan_repayments", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    loanId: (0, pg_core_1.uuid)("loan_id")
        .notNull()
        .references(() => exports.loans.id),
    clientRequestId: (0, pg_core_1.varchar)("client_request_id", { length: 255 }),
    amount: (0, pg_core_1.bigint)("amount", { mode: "number" }).notNull(),
    status: (0, exports.transactionStatusEnum)("status").notNull().default("pending"),
    txHash: (0, pg_core_1.varchar)("tx_hash", { length: 255 }),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    loanIdx: (0, pg_core_1.index)("idx_loan_repayments_loan").on(table.loanId),
    txHashIdx: (0, pg_core_1.index)("idx_loan_repayments_tx_hash").on(table.txHash),
}));
// 14. fx_quotes (defined before transfers so transfers can reference it)
exports.fxQuotes = (0, pg_core_1.pgTable)("fx_quotes", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    fromAssetId: (0, pg_core_1.integer)("from_asset_id").notNull(),
    toAssetId: (0, pg_core_1.integer)("to_asset_id").notNull(),
    fromAmount: (0, pg_core_1.bigint)("from_amount", { mode: "number" }).notNull(),
    toAmount: (0, pg_core_1.bigint)("to_amount", { mode: "number" }).notNull(),
    exchangeRate: (0, pg_core_1.decimal)("exchange_rate", { precision: 20, scale: 6 }).notNull(),
    expiresAt: (0, pg_core_1.timestamp)("expires_at").notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_fx_quotes_institution").on(table.institutionId),
}));
// 13. transfers
exports.transfers = (0, pg_core_1.pgTable)("transfers", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    clientRequestId: (0, pg_core_1.varchar)("client_request_id", { length: 255 }),
    type: (0, exports.transferTypeEnum)("type").notNull(),
    assetId: (0, pg_core_1.integer)("asset_id").notNull(),
    amount: (0, pg_core_1.bigint)("amount", { mode: "number" }).notNull(),
    destinationAddress: (0, pg_core_1.varchar)("destination_address", { length: 255 }).notNull(),
    status: (0, exports.transactionStatusEnum)("status").notNull().default("pending"),
    txHash: (0, pg_core_1.varchar)("tx_hash", { length: 255 }),
    fxQuoteId: (0, pg_core_1.uuid)("fx_quote_id").references(() => exports.fxQuotes.id),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_transfers_institution").on(table.institutionId),
    txHashIdx: (0, pg_core_1.index)("idx_transfers_tx_hash").on(table.txHash),
}));
// 15. payouts
exports.payouts = (0, pg_core_1.pgTable)("payouts", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    clientRequestId: (0, pg_core_1.varchar)("client_request_id", { length: 255 }),
    amount: (0, pg_core_1.bigint)("amount", { mode: "number" }).notNull(),
    destinationBankDetails: bytea("destination_bank_details").notNull(), // encrypted
    status: (0, exports.transactionStatusEnum)("status").notNull().default("pending"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_payouts_institution").on(table.institutionId),
}));
// 16. webhooks
exports.webhooks = (0, pg_core_1.pgTable)("webhooks", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    url: (0, pg_core_1.varchar)("url", { length: 1024 }).notNull(),
    secret: bytea("secret").notNull(), // encrypted
    events: (0, pg_core_1.text)("events").array().notNull(),
    isActive: (0, pg_core_1.boolean)("is_active").notNull().default(true),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_webhooks_institution").on(table.institutionId),
}));
// 17. webhook_deliveries
exports.webhookDeliveries = (0, pg_core_1.pgTable)("webhook_deliveries", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    webhookId: (0, pg_core_1.uuid)("webhook_id")
        .notNull()
        .references(() => exports.webhooks.id),
    eventType: (0, pg_core_1.varchar)("event_type", { length: 255 }).notNull(),
    payload: (0, pg_core_1.jsonb)("payload").notNull(),
    status: (0, exports.webhookDeliveryStatusEnum)("status").notNull().default("pending"),
    attempts: (0, pg_core_1.integer)("attempts").notNull().default(0),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
}, (table) => ({
    webhookIdx: (0, pg_core_1.index)("idx_webhook_deliveries_webhook").on(table.webhookId),
    statusCreatedIdx: (0, pg_core_1.index)("idx_webhook_deliveries_status_created").on(table.status, table.createdAt),
}));
// 18. idempotency_keys
exports.idempotencyKeys = (0, pg_core_1.pgTable)("idempotency_keys", {
    key: (0, pg_core_1.varchar)("key", { length: 255 }).primaryKey(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    requestPath: (0, pg_core_1.varchar)("request_path", { length: 255 }).notNull(),
    responseBody: (0, pg_core_1.jsonb)("response_body"),
    responseStatus: (0, pg_core_1.integer)("response_status"),
    expiresAt: (0, pg_core_1.timestamp)("expires_at").notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
}, (table) => ({
    expiresAtIdx: (0, pg_core_1.index)("idx_idempotency_expires_at").on(table.expiresAt),
}));
// 19. audit_log
exports.auditLog = (0, pg_core_1.pgTable)("audit_log", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    institutionId: (0, pg_core_1.uuid)("institution_id")
        .notNull()
        .references(() => exports.institutions.id),
    action: (0, pg_core_1.varchar)("action", { length: 255 }).notNull(),
    details: (0, pg_core_1.jsonb)("details"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
}, (table) => ({
    institutionIdx: (0, pg_core_1.index)("idx_audit_log_institution").on(table.institutionId),
    actionCreatedIdx: (0, pg_core_1.index)("idx_audit_log_action_created").on(table.action, table.createdAt),
}));
//# sourceMappingURL=schema.js.map