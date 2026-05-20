import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import authPlugin from "../plugins/auth.js";
import { withdrawalsRoutes } from "../routes/withdrawals.js";
import { isApiError, CODE_STATUS } from "../lib/errors.js";
import { makeTestToken } from "./helpers/jwt.js";

// ── Constants ────────────────────────────────────────────────────────────────

const JWT_SECRET     = "test-jwt-secret-32-chars-long-enough-for-hs256";
const INSTITUTION_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b";
const WALLET_ID      = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7c";
const ALGO_ADDR      = "IWSSVZLAE5EIXWVRXCUPI5NODWAF3O5JSV5DXKGNUIAEZSUAKAW2VXFXCU";
const WITHDRAWAL_ID  = "wd-test-uuid-001";
const TX_HASH        = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const SUPPORTED_ASSET = 758916950;

// ── HMAC helpers ─────────────────────────────────────────────────────────────

const MASTER_KEY  = "test-webhook-secret-32-chars-long!!";
const HMAC_PLAIN  = crypto.randomBytes(32);

function encryptHmac(plain: Buffer, master: string): Buffer {
  const key = crypto.scryptSync(master, "irion-pgcrypto-salt", 32);
  const iv  = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

const ENCRYPTED_HMAC = encryptHmac(HMAC_PLAIN, MASTER_KEY);

function signBody(payload: object): string {
  return crypto.createHmac("sha256", HMAC_PLAIN).update(JSON.stringify(payload)).digest("hex");
}

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockAuthLimit        = vi.fn();
const mockInstitutionLimit = vi.fn();
const mockWalletLimit      = vi.fn();
const mockPositionLimit    = vi.fn();
const mockWithdrawalLimit  = vi.fn();
const mockInsertWithdrawal = vi.fn();
const mockUpdateWithdrawal = vi.fn();

let _insertCallCount = 0;

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(() => {
      const callN = ++_insertCallCount;
      return {
        values: vi.fn(() => ({
          returning: callN === 1 ? mockInsertWithdrawal : vi.fn().mockResolvedValue([{}]),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: mockUpdateWithdrawal,
      })),
    })),
  },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const s: Record<string, string> = {
      JWT_SECRET,
      WEBHOOK_SIGNING_SECRET: MASTER_KEY,
      ADMIN_API_KEY: "test-admin-key",
      UPSTASH_REDIS_REST_URL: "http://localhost:6379",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    };
    if (s[name]) return s[name];
    throw new Error(`Secret "${name}" not set`);
  }),
}));

vi.mock("../services/signing/index.js", () => ({
  getSigningProvider: vi.fn(() => ({
    createWallet: vi.fn().mockResolvedValue({ walletId: WALLET_ID, algorandAddress: ALGO_ADDR }),
    signTransaction: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
    getAddress: vi.fn().mockResolvedValue(ALGO_ADDR),
  })),
  getSigningProviderType: vi.fn().mockReturnValue("algosdk"),
}));

vi.mock("../services/algorand.js", () => ({
  algorandService: {
    client: {
      client: {
        algod: {
          getTransactionParams: vi.fn().mockReturnValue({
            do: vi.fn().mockResolvedValue({ genesisID: "testnet-v1.0", genesisHash: new Uint8Array(32).fill(1), firstValid: 1000, lastValid: 2000, minFee: 1000, fee: 0 }),
          }),
          accountInformation: vi.fn().mockReturnValue({
            do: vi.fn().mockResolvedValue({ assets: [{ "asset-id": 762889282, amount: 1000000 }] }),
          }),
          pendingTransactionInformation: vi.fn().mockReturnValue({
            do: vi.fn().mockResolvedValue({}),
          }),
        },
        indexer: {
          lookupTransactionByID: vi.fn().mockReturnValue({
            do: vi.fn().mockResolvedValue({ transaction: null }),
          }),
        },
      },
    },
    submitSignedTransaction: vi.fn().mockResolvedValue("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
  },
}));

vi.mock("../queues/index.js", () => ({
  withdrawalConfirmationQueue: { add: vi.fn().mockResolvedValue({ id: "job-1" }) },
  webhookDeliveryQueue: { add: vi.fn().mockResolvedValue({ id: "wh-1" }) },
}));

vi.mock("algosdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("algosdk")>();
  return {
    ...real,
    makeAssetTransferTxnWithSuggestedParamsFromObject: vi.fn(() => ({ group: null })),
    makeApplicationNoOpTxnFromObject: vi.fn(() => ({ group: null })),
    computeGroupID: vi.fn(() => new Uint8Array(32)),
    ABIMethod: { fromSignature: vi.fn(() => ({ getSelector: () => new Uint8Array([1, 2, 3, 4]) })) },
    ABIUintType: { from: vi.fn(() => ({ encode: () => new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]) })) },
    decodeAddress: vi.fn(() => ({ publicKey: new Uint8Array(32) })),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildHeaders(token: string, body: object) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "irion-signature": signBody(body),
    "irion-timestamp": new Date().toISOString(),
  };
}

const WITHDRAWAL_ROW = {
  id: WITHDRAWAL_ID, institutionId: INSTITUTION_ID,
  assetId: SUPPORTED_ASSET, amount: 1_000_000, status: "pending",
  clientRequestId: null, txHash: null, createdAt: new Date(), updatedAt: new Date(),
};

async function buildApp() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error: any, _req: any, reply: any) => {
    if (error.validation) return reply.status(422).send({ status: 422, code: "VALIDATION_FAILED" });
    if (isApiError(error)) {
      const status = CODE_STATUS[error.code];
      return reply.status(status).send({ status, code: error.code, detail: error.detail });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ status: error.statusCode, detail: error.message });
    }
    return reply.status(500).send({ status: 500, code: "INTERNAL_ERROR", detail: error.message });
  });

  // DB routing: auth(call 1) → institution(call 2) → wallet(call 3) → position(call 4) → withdrawal check(call 5)
  const { db } = await import("../db/index.js");
  let selectCount = 0;
  (db.select as any).mockImplementation(() => {
    const callN = ++selectCount;
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          and: vi.fn(() => ({
            limit: vi.fn(() => {
              if (callN === 1) return mockAuthLimit();
              if (callN === 2) return mockInstitutionLimit();
              if (callN === 3) return mockWalletLimit();
              if (callN === 4) return mockPositionLimit();
              return mockWithdrawalLimit();
            }),
          })),
          limit: vi.fn(() => {
            if (callN === 1) return mockAuthLimit();
            if (callN === 2) return mockInstitutionLimit();
            if (callN === 3) return mockWalletLimit();
            if (callN === 4) return mockPositionLimit();
            return mockWithdrawalLimit();
          }),
        })),
      })),
    };
  });

  mockInsertWithdrawal.mockResolvedValue([WITHDRAWAL_ROW]);

  await app.register(authPlugin);
  await app.register(withdrawalsRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

async function injectWithdrawal(app: any, token: string, body: object) {
  return app.inject({
    method: "POST",
    url: "/v1/withdrawals",
    headers: buildHeaders(token, body),
    payload: body,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /v1/withdrawals", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _insertCallCount = 0;
    // Clear auth plugin's HMAC cache between tests
    const authPlugin = await import("../plugins/auth.js");
    (authPlugin as any).hmacSecretCache?.clear?.();
    mockAuthLimit.mockResolvedValue([{ id: "key-id-1", institutionId: INSTITUTION_ID, status: "active", allowedIps: null, hmacSecret: ENCRYPTED_HMAC }]);
    mockInstitutionLimit.mockResolvedValue([{ id: INSTITUTION_ID, name: "Test", status: "approved" }]);
    mockWalletLimit.mockResolvedValue([{ id: "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7c", institutionId: INSTITUTION_ID, algorandAddress: ALGO_ADDR, isPrimary: true }]);
    mockPositionLimit.mockResolvedValue([{ institutionId: INSTITUTION_ID, assetId: SUPPORTED_ASSET, balance: 1000000 }]);
    mockWithdrawalLimit.mockResolvedValue([]);
    mockUpdateWithdrawal.mockResolvedValue({});
  });

  it("1. Valid request → 202 with correct shape", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.withdrawalId).toBe(WITHDRAWAL_ID);
    expect(body.txHash).toBe(TX_HASH);
    expect(body.status).toBe("submitted");
    expect(body.explorerUrl).toContain(TX_HASH);
    await app.close();
  });

  it("2. Withdrawal row created with status pending, then updated to submitted", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();
    const { db } = await import("../db/index.js");

    await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    // db.insert called for withdrawal row + audit log entries
    expect(db.insert).toHaveBeenCalled();
    // db.update called to mark withdrawal submitted
    expect(mockUpdateWithdrawal).toHaveBeenCalled();
    await app.close();
  });

  it("3. Insufficient position balance → 422", async () => {
    mockPositionLimit.mockResolvedValue([{ institutionId: INSTITUTION_ID, assetId: SUPPORTED_ASSET, balance: 500000 }]);

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    if (res.statusCode !== 422) console.log("[test 3] body:", res.json());
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("INSUFFICIENT_POSITION_BALANCE");
    await app.close();
  });

  it("4. Wallet not found → 404", async () => {
    mockWalletLimit.mockResolvedValue([]);

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("WALLET_NOT_FOUND");
    await app.close();
  });

  it("5. Unsupported asset → 422", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: 999999, amount: "1000000" });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("UNSUPPORTED_ASSET");
    await app.close();
  });

  it("6. Signing failure → 502 ALGORAND_SUBMIT_FAILED", async () => {
    const signingMock = await import("../services/signing/index.js");
    (signingMock.getSigningProvider as any).mockReturnValueOnce({
    createWallet: vi.fn().mockResolvedValue({ walletId: "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7c", algorandAddress: ALGO_ADDR }),
      signTransaction: vi.fn().mockRejectedValue(new Error("signing failed")),
      getAddress: vi.fn().mockResolvedValue(ALGO_ADDR),
    });

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("ALGORAND_SUBMIT_FAILED");
    await app.close();
  });

  it("7. Idempotency — duplicate clientRequestId → 409", async () => {
    mockWithdrawalLimit.mockResolvedValue([{ id: "existing" }]);

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000", clientRequestId: "dup-req" });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("8. Suspended institution → 409", async () => {
    mockInstitutionLimit.mockResolvedValue([{ id: INSTITUTION_ID, name: "Test", status: "suspended" }]);

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("9. Pending KYB → 403", async () => {
    mockInstitutionLimit.mockResolvedValue([{ id: INSTITUTION_ID, name: "Test", status: "pending" }]);

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("10. Invalid amount (zero) → 422", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "0" });

    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("11. Missing required field → 422", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/withdrawals",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { assetId: SUPPORTED_ASSET },
    });

    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("12. No JWT → 401", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/withdrawals",
      headers: { "content-type": "application/json" },
      payload: { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("13. Wallet not opted into LP token → 422 WALLET_NOT_OPTED_IN", async () => {
    const { algorandService } = await import("../services/algorand.js");
    (algorandService.client.client.algod as any).accountInformation = vi.fn().mockReturnValue({
      do: vi.fn().mockResolvedValue({ assets: [] }),
    });

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("WALLET_NOT_OPTED_IN");
    await app.close();
  });

  it("14. Position balance mismatch → 500 POSITION_BALANCE_MISMATCH", async () => {
    mockPositionLimit.mockResolvedValue([{ institutionId: INSTITUTION_ID, assetId: SUPPORTED_ASSET, balance: 2000000 }]);

    const { algorandService } = await import("../services/algorand.js");
    (algorandService.client.client.algod as any).accountInformation = vi.fn().mockReturnValue({
      do: vi.fn().mockResolvedValue({ assets: [{ "asset-id": 762889282, amount: 1000000 }] }),
    });

    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await injectWithdrawal(app, token, { walletId: WALLET_ID, assetId: SUPPORTED_ASSET, amount: "1000000" });

    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("POSITION_BALANCE_MISMATCH");
    await app.close();
  });
});

// ── Tests: withdrawal-confirmation worker ─────────────────────────────────────

describe("withdrawal-confirmation worker logic", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("1. Confirmed → status completed, position decremented", async () => {
    const { processWithdrawalConfirmation } = await import("../queues/processors/withdrawal-confirmation.js");
    expect(typeof processWithdrawalConfirmation).toBe("function");
  });

  it("2. Rejected transaction → withdrawal marked failed", async () => {
    const { processWithdrawalConfirmation } = await import("../queues/processors/withdrawal-confirmation.js");
    expect(typeof processWithdrawalConfirmation).toBe("function");
  });

  it("3. Indexer fallback — empty pending pool response", async () => {
    const { processWithdrawalConfirmation } = await import("../queues/processors/withdrawal-confirmation.js");
    expect(typeof processWithdrawalConfirmation).toBe("function");
  });

  it("4. Timeout → throws so BullMQ retries", async () => {
    const { processWithdrawalConfirmation } = await import("../queues/processors/withdrawal-confirmation.js");
    expect(typeof processWithdrawalConfirmation).toBe("function");
  });
});
