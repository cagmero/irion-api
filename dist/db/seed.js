"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_1 = __importDefault(require("postgres"));
const crypto_1 = __importDefault(require("crypto"));
const argon2 = __importStar(require("argon2"));
const dotenv = __importStar(require("dotenv"));
const postgres_js_1 = require("drizzle-orm/postgres-js");
const schema = __importStar(require("./schema"));
dotenv.config({ path: "./.env.local" });
if (process.env.NODE_ENV === "production") {
    console.log("SEED_SKIPPED: seed.ts is not safe to run in production.");
    process.exit(0);
}
async function pgcryptoEncrypt(plaintext, masterKey) {
    const key = crypto_1.default.scryptSync(masterKey, "irion-pgcrypto-salt", 32);
    const iv = crypto_1.default.randomBytes(16);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
}
async function run() {
    const db = (0, postgres_js_1.drizzle)((0, postgres_1.default)(process.env.DATABASE_URL, { max: 1 }), { schema });
    const TEST_INSTITUTION_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b";
    const TEST_WALLET_ID = "d4f8a2c3-1b5e-4f7a-9c3d-2e6b8a4f1c3d";
    const IUSDC_ASSET_ID = parseInt(process.env.IUSDC_ASSET_ID || "758916950", 10);
    const WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || "default-webhook-secret";
    const plaintextHmacSecret = crypto_1.default.randomBytes(32);
    const encryptedHmacSecret = await pgcryptoEncrypt(plaintextHmacSecret, WEBHOOK_SIGNING_SECRET);
    const apiKeyPlain = "iri_test_sk_1a2b3c4d5e6f7g8h9i0j";
    const apiKeyPrefix = "iri_test_";
    const apiKeyHash = await argon2.hash(apiKeyPlain, { type: argon2.argon2id });
    const walletAddress = "7LMFMNBOMYZGN4X52HLKHL4JHW5R2CDZODKLLTW5WR5I6LKIBDBSHN4TY";
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    console.log("Seeding test data...");
    await db.insert(schema.institutions).values({
        id: TEST_INSTITUTION_ID,
        name: "Irion Test Institution (DO NOT USE IN PROD)",
        status: "active",
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.apiKeys).values({
        id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        institutionId: TEST_INSTITUTION_ID,
        keyPrefix: apiKeyPrefix,
        keyHash: apiKeyHash,
        hmacSecret: encryptedHmacSecret,
        allowedIps: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.wallets).values({
        id: TEST_WALLET_ID,
        institutionId: TEST_INSTITUTION_ID,
        label: "Test Primary Wallet",
        isPrimary: true,
        turnkeyWalletId: "00000000-0000-0000-0000-000000000000",
        turnkeyAddress: walletAddress,
        status: "active",
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.webhooks).values({
        id: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
        institutionId: TEST_INSTITUTION_ID,
        url: "https://webhook.site/test-irion",
        secret: encryptedHmacSecret,
        events: ["deposit.initiated", "withdrawal.initiated", "loan.originated", "kyb.approved", "kyb.rejected"],
        isActive: true,
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.lendingPositions).values({
        id: "e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b",
        institutionId: TEST_INSTITUTION_ID,
        assetId: IUSDC_ASSET_ID,
        balance: 1_000_000,
        accruedYield: 5_000,
        lastAccrualAt: now,
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.borrowingPositions).values({
        id: "a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9c0d",
        institutionId: TEST_INSTITUTION_ID,
        assetId: IUSDC_ASSET_ID,
        balance: 500_000,
        accruedInterest: 1_000,
        lastAccrualAt: now,
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    const testLoanId = "b9c0d1e2-f3a4-4b5c-6d7e-8f9a0b1c2d3e";
    await db.insert(schema.loans).values({
        id: testLoanId,
        institutionId: TEST_INSTITUTION_ID,
        clientRequestId: "loan-test-001",
        type: "overcollateralized",
        status: "active",
        assetId: IUSDC_ASSET_ID,
        principalAmount: 500_000,
        borrowedAmount: 500_000,
        outstandingBalance: 500_000,
        collateralAssetId: IUSDC_ASSET_ID,
        collateralAmount: 1_000_000,
        interestRateBps: 500,
        ltvRatioBps: 5000,
        termDays: 90,
        installmentsPaid: 0,
        onchainLoanId: 1,
        nextPaymentDueAt: thirtyDaysFromNow,
        originatedAt: now,
        maturesAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.loanDraws).values({
        id: "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
        loanId: testLoanId,
        clientRequestId: "draw-test-001",
        amount: 500_000,
        status: "completed",
        txHash: "TESTTXDRAWHASH123456789",
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.loanRepayments).values({
        id: "f3a4b5c6-d7e8-4f9a-0b1c-2d3e4f5a6b7c",
        loanId: testLoanId,
        clientRequestId: "repay-test-001",
        amount: 50_000,
        status: "completed",
        txHash: "TESTTXREPAYHASH123456789",
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.creditProfiles).values({
        id: "c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f",
        institutionId: TEST_INSTITUTION_ID,
        repaymentScore: 85,
        volumeScore: 72,
        tenureScore: 60,
        concentrationRisk: 15,
        compositeScore: 73,
        lastUpdated: now,
    }).onConflictDoNothing();
    console.log("Seed complete.");
    console.log("\n=== TEST CREDENTIALS ===");
    console.log(`TEST_INSTITUTION_ID=${TEST_INSTITUTION_ID}`);
    console.log(`TEST_API_KEY=${apiKeyPlain}`);
    console.log(`TEST_HMAC_SECRET=${plaintextHmacSecret.toString("hex")}`);
    console.log(`TEST_WALLET_ID=${TEST_WALLET_ID}`);
    console.log(`TEST_LOAN_ID=${testLoanId}`);
    console.log(`IUSDC_ASSET_ID=${IUSDC_ASSET_ID}`);
    console.log("\nStore TEST_API_KEY and TEST_HMAC_SECRET in .env.test for manual testing.");
    process.exit(0);
}
run().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map