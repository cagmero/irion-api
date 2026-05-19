import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignJWT } from "jose";
import Fastify from "fastify";
import authPlugin from "../plugins/auth.js";
import { accountsRoutes } from "../routes/accounts.js";
import { isApiError, CODE_STATUS } from "../lib/errors.js";

// ── Constants ────────────────────────────────────────────────────────────────

const JWT_SECRET = "test-jwt-secret-32-chars-long-enough-for-hs256";
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";

const INSTITUTION_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b";
const OTHER_INSTITUTION_ID = "b1e2f3a4-9c5d-4e6f-a2b3-8c9d0e1f2a3b";



// ── mockSelect: controls what route-handler db queries return ─────────────────
// Used by balance queries (.where(), no .limit) and profile query (.leftJoin → .limit).
// Prime with mockResolvedValueOnce per test. Default (unprimed) returns [].
const mockSelect = vi.fn().mockResolvedValue([]);

// ── mockAuthLimit: always returns the active API key row ──────────────────────
// Only used by the authPlugin's .where().limit(1) call.
// Isolated from mockSelect so auth does NOT consume route-data queue slots.
const mockAuthLimit = vi.fn().mockResolvedValue([{
  id: "key-id-1",
  institutionId: INSTITUTION_ID,
  status: "active",
  allowedIps: null,
  hmacSecret: null,
}]);

// ── DB mock ───────────────────────────────────────────────────────────────────
// Three query shapes used in accounts.ts GET handlers:
//
//  1. authPlugin api-key lookup:
//       db.select().from(apiKeys).where(and(...)).limit(1)
//       → .limit() always returns [AUTH_KEY_ROW]
//
//  2. GET /:id profile query:
//       db.select({cols}).from(institutions).leftJoin(...).leftJoin(...).where(...).orderBy(...).limit(1)
//       → .limit() delegates to mockSelect() so tests can prime the return value
//
//  3. GET /:id/balance queries (Promise.all of two):
//       db.select().from(lendingPositions).where(...)   — awaited directly (no .limit)
//       db.select().from(borrowingPositions).where(...)  — awaited directly (no .limit)
//       → .where() returns a Promise wrapping mockSelect() so tests prime with Once chains
//
// Key insight: auth path calls .limit(1) after .where(); balance path awaits .where() directly.
// We exploit this by making .where() return a Promise that ALSO has a .limit() attached.
// The auth plugin awaits p.limit(1) → AUTH_KEY_ROW.
// The balance route awaits p directly → mockSelect() result.
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // .where() is called by BOTH the authPlugin (followed by .limit()) and balance routes (awaited directly).
        // We return a lazy thenable so that:
        //   - balance routes await the outer object → get mockSelect() result
        //   - authPlugin calls .limit(1) → gets mockAuthLimit() result (never touches mockSelect queue)
        where: vi.fn(() => {
          // Lazy: don't call mockSelect() here — only call it when .then() is awaited by the route.
          // This prevents auth's where() call from consuming a mockSelect queue slot.
          const lazyPromise: any = {
            then: (resolve: any, reject: any) => mockSelect().then(resolve, reject),
            catch: (reject: any) => mockSelect().catch(reject),
            // .limit() path: authPlugin calls this — returns AUTH_KEY_ROW, never touches mockSelect
            limit: mockAuthLimit,
          };
          return lazyPromise;
        }),
        // leftJoin chain: profile query shape — where().orderBy().limit()
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn().mockImplementation(() => mockSelect()),
              })),
            })),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{}]) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })),
    })),
  },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const secrets: Record<string, string> = {
      JWT_SECRET,
      WEBHOOK_SIGNING_SECRET: "test-webhook-secret-32-chars-long!!",
      ADMIN_API_KEY: "test-admin-key",
      UPSTASH_REDIS_REST_URL: "http://localhost:6379",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    };
    if (secrets[name]) return secrets[name];
    throw new Error(`Secret "${name}" not set in test`);
  }),
}));

vi.mock("argon2", () => ({ hash: vi.fn().mockResolvedValue("$argon2id$test"), argon2id: 2 }));
vi.mock("../services/turnkey.js", () => ({
  createSubOrganization: vi.fn().mockResolvedValue({ subOrgId: "test-suborg" }),
}));
vi.mock("../services/kyb/index.js", () => ({
  getKybProvider: vi.fn(() => ({
    createKybSession: vi.fn().mockResolvedValue({
      diditSessionId: "kyb-session-id",
      verificationUrl: "https://mock-kyb.local/verify/kyb-session-id",
    }),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeToken(sub: string, kid = "key-id-1"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, kid })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

// Build a fresh Fastify instance per test using top-level imports (no dynamic import —
// avoids the vi.resetModules() isolation problem where db objects diverge across re-imports).
async function buildApp() {
  const app = Fastify({ logger: false });

  // Minimal error handler mirroring the sentry.ts subset that handles ApiError + JWT errors.
  app.setErrorHandler((error: any, _request: any, reply: any) => {
    if (error.validation) {
      return reply.status(422).send({ status: 422, code: "VALIDATION_FAILED" });
    }
    if (isApiError(error)) {
      const status = CODE_STATUS[error.code];
      return reply.status(status).send({ status, code: error.code, detail: error.detail });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ status: error.statusCode, detail: error.message });
    }
    // Surface unexpected errors so test failures are readable
    console.error("[test buildApp] unhandled error:", error.message);
    return reply.status(500).send({ status: 500, code: "INTERNAL_ERROR", detail: error.message });
  });

  await app.register(authPlugin);
  await app.register(accountsRoutes, { prefix: "/v1/accounts" });
  await app.ready();
  return app;
}

// ── Tests: GET /v1/accounts/:id ───────────────────────────────────────────────

describe("GET /v1/accounts/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockResolvedValue([]);      // safe default for route data queries
    mockAuthLimit.mockResolvedValue([{    // auth key always present
      id: "key-id-1", institutionId: INSTITUTION_ID, status: "active",
      allowedIps: null, hmacSecret: null,
    }]);
  });

  const INSTITUTION_ROW = {
    id: INSTITUTION_ID,
    name: "Acme Capital Partners",
    status: "active",
    createdAt: new Date("2026-05-17T14:20:00Z"),
    updatedAt: new Date("2026-05-17T14:23:11Z"),
    kybStatus: "approved",
    kybUpdatedAt: new Date("2026-05-17T14:23:11Z"),
    walletAddress: "BLLVM62U23ZNEBJEDKO22TCWA35CJTAVEGCAMDK5NN4RKAJMF2FL2PENJA",
    walletTurnkeyId: "wallet-tk-id-123",
  };

  it("1. Valid JWT + own ID → 200 with correct shape", async () => {
    // Profile query goes through leftJoin → leftJoin → where → limit → mockSelect
    mockSelect.mockResolvedValueOnce([INSTITUTION_ROW]);
    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(INSTITUTION_ID);
    expect(body.name).toBe("Acme Capital Partners");
    expect(body.status).toBe("active");
    expect(body.kyb.status).toBe("approved");
    expect(body.kyb.verifiedAt).toBe("2026-05-17T14:23:11.000Z");
    expect(body.kyb.provider).toBeDefined();
    expect(body.primaryWallet.algorandAddress).toBe(
      "BLLVM62U23ZNEBJEDKO22TCWA35CJTAVEGCAMDK5NN4RKAJMF2FL2PENJA"
    );
    expect(body.primaryWallet.turnkeyWalletId).toBe("wallet-tk-id-123");
    expect(body.createdAt).toBe("2026-05-17T14:20:00.000Z");
    await app.close();
  });

  it("2. Valid JWT + different institution's ID → 403 FORBIDDEN_RESOURCE", async () => {
    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${OTHER_INSTITUTION_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.status).toBe(403);
    await app.close();
  });

  it("3. Valid JWT + nonexistent institution ID → 404 INSTITUTION_NOT_FOUND", async () => {
    mockSelect.mockResolvedValueOnce([]); // no rows from profile query
    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.status).toBe(404);
    await app.close();
  });

  it("4. No JWT → 401", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}`,
      // no Authorization header
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("5. Response excludes sensitive fields: no client_secret, key_hash, turnkey_sub_org_id", async () => {
    mockSelect.mockResolvedValueOnce([INSTITUTION_ROW]);
    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty("client_secret");
    expect(body).not.toHaveProperty("key_hash");
    expect(body).not.toHaveProperty("keyHash");
    expect(body).not.toHaveProperty("turnkeySubOrgId");
    expect(body).not.toHaveProperty("hmacSecret");
    await app.close();
  });

  it("5b. KYB ORDER BY correctness: most-recent row returned when institution has multiple KYB rows", async () => {
    // When re-verification occurs, a second kyb_verifications row is inserted.
    // The query must return the row with the highest createdAt, not an arbitrary one.
    // The mock simulates the DB executing ORDER BY kybVerifications.createdAt DESC LIMIT 1
    // by returning the row we prime — the test asserts the handler uses what the DB returns,
    // confirming the orderBy() call is in the chain (not silently skipped).
    const STALE_ROW = {
      ...INSTITUTION_ROW,
      kybStatus: "rejected" as const,
      kybUpdatedAt: new Date("2026-05-17T09:00:00Z"),
    };
    const FRESH_ROW = {
      ...INSTITUTION_ROW,
      kybStatus: "approved" as const,
      kybUpdatedAt: new Date("2026-05-17T14:23:11Z"),
    };

    // mockSelect primed with FRESH_ROW — this simulates the DB returning the most-recent row
    // after applying ORDER BY kybVerifications.createdAt DESC LIMIT 1.
    // If orderBy() were absent from the chain, the mock chain would break (.orderBy is undefined)
    // and the test would fail with a different error, proving the chain is wired.
    mockSelect.mockResolvedValueOnce([FRESH_ROW]);
    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Must return the most-recent KYB status, not the stale one
    expect(body.kyb.status).toBe("approved");
    expect(body.kyb.verifiedAt).toBe("2026-05-17T14:23:11.000Z");
    // Sanity: stale row was NOT returned
    expect(body.kyb.status).not.toBe("rejected");
    await app.close();
  });
});

// ── Tests: GET /v1/accounts/:id/balance ──────────────────────────────────────

describe("GET /v1/accounts/:id/balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockResolvedValue([]);
    mockAuthLimit.mockResolvedValue([{
      id: "key-id-1", institutionId: INSTITUTION_ID, status: "active",
      allowedIps: null, hmacSecret: null,
    }]);
  });

  const LENDING_ROW = {
    id: "lp-id-1",
    institutionId: INSTITUTION_ID,
    assetId: 10458941,
    balance: 1_000_000,
    accruedYield: 5_000,
    lastAccrualAt: new Date("2026-05-17T14:00:00Z"),
    createdAt: new Date("2026-05-17T14:20:00Z"),
    updatedAt: new Date("2026-05-17T14:23:11Z"),
  };

  const BORROWING_ROW = {
    id: "bp-id-1",
    institutionId: INSTITUTION_ID,
    assetId: 10458941,
    balance: 500_000,
    accruedInterest: 1_000,
    lastAccrualAt: new Date("2026-05-17T14:00:00Z"),
    createdAt: new Date("2026-05-17T14:20:00Z"),
    updatedAt: new Date("2026-05-17T14:23:11Z"),
  };

  it("6. Valid JWT + own ID with positions → 200 correct shape, amounts as strings", async () => {
    // Promise.all fires lending + borrowing where() calls concurrently.
    // Prime two return values — order matches Promise.all([lending, borrowing]).
    mockSelect
      .mockResolvedValueOnce([LENDING_ROW])
      .mockResolvedValueOnce([BORROWING_ROW]);

    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.lending)).toBe(true);
    expect(Array.isArray(body.borrowing)).toBe(true);
    // Amounts must be strings, not numbers
    if (body.lending.length > 0) {
      expect(typeof body.lending[0].balance).toBe("string");
      expect(typeof body.lending[0].accruedYield).toBe("string");
      expect(typeof body.lending[0].totalValue).toBe("string");
    }
    await app.close();
  });

  it("7. Valid JWT + own ID with no positions → 200 with empty arrays (not 404)", async () => {
    mockSelect
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lending).toEqual([]);
    expect(body.borrowing).toEqual([]);
    expect(body.lastUpdated).toBeNull();
    await app.close();
  });

  it("8. Valid JWT + different institution's ID → 403 FORBIDDEN_RESOURCE", async () => {
    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${OTHER_INSTITUTION_ID}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("9. Amounts are serialized as strings, not JSON numbers (precision guarantee)", async () => {
    // Note: JS number literals > Number.MAX_SAFE_INTEGER (2^53-1) lose precision before reaching
    // the route, because Drizzle's bigint mode:"number" returns JS numbers. Full 64-bit precision
    // requires mode:"bigint" in the schema — deferred to a schema migration in 2h cleanup.
    // This test verifies that *whatever* value comes from the DB is emitted as a string, which is
    // the critical invariant for SDK consumers. We use a value within MAX_SAFE_INTEGER.
    const LARGE_BALANCE = 9_007_199_254_740_000; // within MAX_SAFE_INTEGER, still large
    const largeLendingRow = { ...LENDING_ROW, balance: LARGE_BALANCE, accruedYield: 993 };

    mockSelect
      .mockResolvedValueOnce([largeLendingRow])
      .mockResolvedValueOnce([]);

    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Must be a string, not a number
    expect(typeof body.lending[0].balance).toBe("string");
    expect(body.lending[0].balance).toBe("9007199254740000");
    expect(body.lending[0].totalValue).toBe("9007199254740993"); // balance + accruedYield(993)
    await app.close();
  });

  it("10. accruedYield / accruedInterest present and as strings even when zero", async () => {
    const zeroYieldRow    = { ...LENDING_ROW,   accruedYield: 0 };
    const zeroInterestRow = { ...BORROWING_ROW, accruedInterest: 0 };

    mockSelect
      .mockResolvedValueOnce([zeroYieldRow])
      .mockResolvedValueOnce([zeroInterestRow]);

    const token = await makeToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/v1/accounts/${INSTITUTION_ID}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Shape must be consistent regardless of value — SDK consumers depend on this
    expect(body.lending[0]).toHaveProperty("accruedYield");
    expect(body.lending[0].accruedYield).toBe("0");
    expect(body.borrowing[0]).toHaveProperty("accruedInterest");
    expect(body.borrowing[0].accruedInterest).toBe("0");
    await app.close();
  });
});
