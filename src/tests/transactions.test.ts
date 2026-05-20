import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import authPlugin from "../plugins/auth.js";
import { transactionsRoutes } from "../routes/transactions.js";
import { isApiError, CODE_STATUS } from "../lib/errors.js";
import { makeTestToken } from "./helpers/jwt.js";

const INSTITUTION_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b";
const JWT_SECRET = "test-jwt-secret-32-chars-long-enough-for-hs256";
const MASTER_KEY = "test-webhook-secret-32-chars-long!!";

function encryptHmac(plain: Buffer, master: string): Buffer {
  const key = crypto.scryptSync(master, "irion-pgcrypto-salt", 32);
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

const HMAC_PLAIN = crypto.randomBytes(32);
const ENCRYPTED_HMAC = encryptHmac(HMAC_PLAIN, MASTER_KEY);

const mockAuthLimit = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
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
    };
    if (s[name]) return s[name];
    throw new Error(`Secret "${name}" not set`);
  }),
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error: any, _req: any, reply: any) => {
    if (isApiError(error)) {
      const status = CODE_STATUS[error.code];
      return reply.status(status).send({ status, code: error.code, detail: error.detail });
    }
    return reply.status(500).send({ status: 500, code: "INTERNAL_ERROR", detail: error.message });
  });

  const { db } = await import("../db/index.js");
  let callCount = 0;
  (db.select as any).mockImplementation(() => ({
    from: vi.fn(() => {
      const qb: any = {
        where: vi.fn(() => {
          callCount++;
          if (callCount === 1) {
            // Auth plugin call
            return { limit: vi.fn().mockResolvedValue([{ id: "key-id-1", institutionId: INSTITUTION_ID, status: "active", allowedIps: null, hmacSecret: ENCRYPTED_HMAC }]) };
          }
          // Return a thenable query builder for non-auth calls
          const innerQb: any = {
            limit: vi.fn().mockResolvedValue([]),
            orderBy: vi.fn().mockResolvedValue([]),
          };
          // Make innerQb directly awaitable (for .where() without .limit())
          innerQb.then = (resolve: any) => resolve([]);
          return innerQb;
        }),
      };
      // Make qb directly awaitable (for .from() without .where())
      qb.then = (resolve: any) => resolve([]);
      return qb;
    }),
  }));

  await app.register(authPlugin);
  await app.register(transactionsRoutes, { prefix: "/v1/transactions" });
  await app.ready();
  return app;
}

describe("GET /v1/transactions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuthLimit.mockResolvedValue([{ id: "key-id-1", institutionId: INSTITUTION_ID, status: "active", allowedIps: null, hmacSecret: ENCRYPTED_HMAC }]);
  });

  it("Returns paginated transaction list → 200", async () => {
    const token = await makeTestToken(INSTITUTION_ID);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/transactions?limit=10&offset=0",
      headers: { authorization: `Bearer ${token}` },
    });

    if (res.statusCode !== 200) console.log("[tx body]", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toBeDefined();
    expect(body.total).toBeDefined();
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    await app.close();
  });

  it("No JWT → 401", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/transactions",
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
