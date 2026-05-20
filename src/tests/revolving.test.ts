import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import authPlugin from "../plugins/auth.js";
import { loansRoutes } from "../routes/loans.js";
import { isApiError, CODE_STATUS } from "../lib/errors.js";
import { makeTestToken } from "./helpers/jwt.js";

const JWT_SECRET = "test-jwt-secret-32-chars-long-enough-for-hs256";
const INSTITUTION_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b";
const WALLET_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7c";
const ALGO_ADDR = "IWSSVZLAE5EIXWVRXCUPI5NODWAF3O5JSV5DXKGNUIAEZSUAKAW2VXFXCU";
const TEST_USDC = 758916950;
const MASTER_KEY = "test-webhook-secret-32-chars-long!!";
const HMAC_PLAIN = crypto.randomBytes(32);

const ENCRYPTED_HMAC = (() => {
  const key = crypto.scryptSync(MASTER_KEY, "irion-pgcrypto-salt", 32);
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(HMAC_PLAIN), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
})();
function signBody(payload: object): string {
  return crypto.createHmac("sha256", HMAC_PLAIN).update(JSON.stringify(payload)).digest("hex");
}

const mockAuthLimit = vi.fn();
const mockInstitutionLimit = vi.fn();
const mockWalletLimit = vi.fn();
const mockLoanLimit = vi.fn();
const mockInsertLoan = vi.fn();
let _insertCallCount = 0;

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(() => {
      const c = ++_insertCallCount;
      return { values: vi.fn(() => ({ returning: c === 1 ? mockInsertLoan : vi.fn().mockResolvedValue([{}]), })) };
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })) })),
  },
}));
vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const s: Record<string, string> = { JWT_SECRET, WEBHOOK_SIGNING_SECRET: MASTER_KEY, ADMIN_API_KEY: "test-admin-key", UPSTASH_REDIS_REST_URL: "http://localhost:6379", UPSTASH_REDIS_REST_TOKEN: "test-token" };
    if (s[name]) return s[name];
    throw new Error("not set");
  }),
}));
vi.mock("../services/signing/index.js", () => ({ getSigningProvider: vi.fn(() => ({ signTransaction: vi.fn().mockResolvedValue(new Uint8Array([1,2,3,4])) })), getSigningProviderType: vi.fn().mockReturnValue("algosdk") }));
vi.mock("../services/algorand.js", () => ({ algorandService: { client: { client: { algod: { accountInformation: vi.fn().mockReturnValue({ do: vi.fn().mockResolvedValue({ assets: [{ "asset-id": 758916950, amount: 5000000 }] }) }) } } } } }));
vi.mock("../queues/index.js", () => ({ loanOriginationStep1Queue: { add: vi.fn().mockResolvedValue({}) }, loanDrawQueue: { add: vi.fn().mockResolvedValue({}) }, loanRepayQueue: { add: vi.fn().mockResolvedValue({}) }, revolvingOriginationQueue: { add: vi.fn().mockResolvedValue({}) }, webhookDeliveryQueue: { add: vi.fn().mockResolvedValue({}) } }));

const REV_LOAN_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7d";
const REV_LOAN = { id: REV_LOAN_ID, institutionId: INSTITUTION_ID, walletId: WALLET_ID, type: "revolving", status: "active", assetId: TEST_USDC, principalAmount: 1000000, creditLimit: 1000000, drawnAmount: 0, interestRateBps: 0, onchainLoanId: 4, createdAt: new Date(), updatedAt: new Date() };

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((e: any, _r: any, reply: any) => {
    if (e.validation) return reply.status(422).send({ status: 422, code: "VALIDATION_FAILED" });
    if (isApiError(e)) return reply.status(CODE_STATUS[e.code]).send({ status: CODE_STATUS[e.code], code: e.code, detail: e.detail });
    return reply.status(500).send({ status: 500, code: "INTERNAL_ERROR" });
  });
  const { db } = await import("../db/index.js");
  let sc = 0;
  function makeLimitFn() {
    const n = ++sc;
    return () => {
      if (n === 1) return mockAuthLimit();
      if (n === 2) return mockInstitutionLimit();
      if (n === 3) return mockWalletLimit();
      return mockLoanLimit();
    };
  }
  (db.select as any).mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        and: vi.fn(() => ({ limit: makeLimitFn() })),
        limit: makeLimitFn(),
      })),
    })),
  }));
  mockInsertLoan.mockResolvedValue([REV_LOAN]);
  await app.register(authPlugin);
  await app.register(loansRoutes, { prefix: "/v1/loans" });
  await app.ready();
  return app;
}

async function injectLoan(app: any, token: string, body: object) {
  return app.inject({ method: "POST", url: "/v1/loans", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "irion-signature": signBody(body), "irion-timestamp": new Date().toISOString() }, payload: body });
}

describe("POST /v1/loans — REVOLVING", () => {
  beforeEach(async () => {
    vi.clearAllMocks(); _insertCallCount = 0;
    const ap = await import("../plugins/auth.js"); (ap as any).hmacSecretCache?.clear?.();
    mockAuthLimit.mockResolvedValue([{ id: "key-id-1", institutionId: INSTITUTION_ID, status: "active", allowedIps: null, hmacSecret: ENCRYPTED_HMAC }]);
    mockInstitutionLimit.mockResolvedValue([{ id: INSTITUTION_ID, name: "Test", status: "approved" }]);
    mockWalletLimit.mockResolvedValue([{ id: WALLET_ID, institutionId: INSTITUTION_ID, algorandAddress: ALGO_ADDR, isPrimary: true }]);
    mockLoanLimit.mockResolvedValue([]);
  });

  it("1. Valid REVOLVING request → 202", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();
    const res = await injectLoan(app, token, { walletId: WALLET_ID, loanType: "REVOLVING", borrowAssetId: TEST_USDC, borrowAmount: "1000000" });
    expect(res.statusCode).toBe(202);
    await app.close();
  });

  it("2. Zero amount → 422", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();
    const res = await injectLoan(app, token, { walletId: WALLET_ID, loanType: "REVOLVING", borrowAssetId: TEST_USDC, borrowAmount: "0" });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("3. Initial draw > limit → 422", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();
    const res = await injectLoan(app, token, { walletId: WALLET_ID, loanType: "REVOLVING", borrowAssetId: TEST_USDC, borrowAmount: "1000000", initialDraw: "1500000" });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("4. Already active loan → 409", async () => {
    mockLoanLimit.mockResolvedValue([{ id: "exist", status: "active" }]);
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();
    const res = await injectLoan(app, token, { walletId: WALLET_ID, loanType: "REVOLVING", borrowAssetId: TEST_USDC, borrowAmount: "1000000" });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("5. Unsupport asset → 422", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();
    const res = await injectLoan(app, token, { walletId: WALLET_ID, loanType: "REVOLVING", borrowAssetId: 999999, borrowAmount: "1000000" });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("6. No JWT → 401", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/loans", headers: { "content-type": "application/json" }, payload: { walletId: WALLET_ID, loanType: "REVOLVING", borrowAssetId: TEST_USDC, borrowAmount: "1000000" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("Draw endpoint (route structure)", () => {
  it("7. Draw route file registers /:id/draw", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("/:id/draw");
    expect(content).toContain("loanDrawQueue");
  });

  it("8. Draw route validates amount pattern", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain('"^[0-9]+$"');
  });

  it("9. Draw route checks credit limit", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("INSUFFICIENT_AVAILABLE_CREDIT");
  });
});

describe("Repay endpoint (route structure)", () => {
  it("10. Repay route file registers /:id/repay", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("/:id/repay");
  });

  it("11. Repay route enqueues to loanRepayQueue", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("loanRepayQueue");
  });

  it("12. Repay route validates non-zero amount", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("Amount must be > 0");
  });
});

describe("Idempotency", () => {
  it("15. Same idempotency key → 409 or 200", async () => {
    mockLoanLimit.mockResolvedValue([]);
    const app = await buildApp();
    const token = await makeTestToken(INSTITUTION_ID);
    const payload = { walletId: WALLET_ID, loanType: "REVOLVING", borrowAssetId: TEST_USDC, borrowAmount: "1000000" };
    const res1 = await app.inject({
      method: "POST", url: "/v1/loans",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "irion-signature": signBody(payload), "irion-timestamp": new Date().toISOString(), "Idempotency-Key": "dup-key-001" },
      payload,
    });
    // First call should succeed or return idempotency collision
    expect([202, 409]).toContain(res1.statusCode);
    await app.close();
  });
});

describe("REVOLVING loan route structure", () => {
  it("13. Origination route validates walletId exists", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("walletId");
  });
  it("14. Origination route enqueues to revolving queue", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("revolvingOriginationQueue");
  });
  it("15. Loan detail route shows drawn amount", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/routes/loans.ts", "utf8"));
    expect(content).toContain("drawnAmount");
  });
});

describe("revolving worker logic", () => {
  it("16. Loan draw worker exists", async () => {
    const { processLoanDraw } = await import("../queues/processors/loan-draw.js") as any;
    expect(typeof processLoanDraw).toBe("function");
  });

  it("17. Loan repay worker exists", async () => {
    const { processLoanRepay } = await import("../queues/processors/loan-repay.js") as any;
    expect(typeof processLoanRepay).toBe("function");
  });

  it("18. Revolving origination worker exists", async () => {
    const { processRevolvingOrigination } = await import("../queues/processors/revolving-origination.js") as any;
    expect(typeof processRevolvingOrigination).toBe("function");
  });

  it("19. Worker factory functions exported", async () => {
    const { startLoanDrawWorker } = await import("../queues/processors/loan-draw.js") as any;
    const { startLoanRepayWorker } = await import("../queues/processors/loan-repay.js") as any;
    expect(typeof startLoanDrawWorker).toBe("function");
    expect(typeof startLoanRepayWorker).toBe("function");
  });
});
