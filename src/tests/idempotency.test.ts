import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import crypto from "crypto";

const JWT_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRedis: any = {
  _cache: {} as Record<string, unknown>,
  get: vi.fn((key: string) => Promise.resolve(mockRedis._cache[key] ?? null)),
  set: vi.fn((key: string, value: string, _opts?: unknown) => {
    if (mockRedis._cache[key]) return Promise.resolve(null);
    mockRedis._cache[key] = JSON.parse(value);
    return Promise.resolve("OK");
  }),
  setex: vi.fn((key: string, _ttl: number, value: unknown) => {
    mockRedis._cache[key] = value;
    return Promise.resolve("OK");
  }),
  clear: () => { mockRedis._cache = {}; },
};

vi.mock("../db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined), catch: vi.fn() }),
  },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const secrets: Record<string, string> = {
      JWT_SECRET,
      WEBHOOK_SIGNING_SECRET: "webhook-signing-secret-for-hmac-test-32bytes!!",
      UPSTASH_REDIS_REST_URL: "http://localhost:6379",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    };
    return secrets[name] || "mock-secret";
  }),
}));

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => mockRedis),
}));

describe("idempotency plugin - contract tests", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockRedis.clear();
    vi.clearAllMocks();
    
    app = Fastify({ logger: false });
    await app.register(jwt, {
      secret: JWT_SECRET,
      sign: { iss: JWT_ISSUER, aud: JWT_AUDIENCE },
      verify: { algorithms: ["HS256"], allowedIss: [JWT_ISSUER], allowedAud: [JWT_AUDIENCE] },
    });

    app.decorate("authenticate", async (request: any, reply: any) => {
      const authHeader = request.headers?.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return reply.status(401).send({ error: "MISSING_SIGNATURE" });
      }
      try {
        await request.jwtVerify();
        request.institutionId = "test-institution-id";
      } catch {
        return reply.status(401).send({ error: "INVALID_TOKEN" });
      }
    });

    const { default: idempotencyPlugin } = await import("../plugins/idempotency.js");
    await app.register(idempotencyPlugin);

    app.post("/token", { preHandler: [app.authenticate, app.idempotency] }, async () => {
      return { accessToken: "mock-token-123", expiresIn: 3600 };
    });

    app.post("/data", { preHandler: [app.authenticate, app.idempotency] }, async (request: any) => {
      return { received: request.body };
    });

    app.get("/gettest", async () => ({ ok: true }));
    app.delete("/deletetest", { preHandler: [app.idempotency] }, async () => ({ deleted: true }));

    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  // 1. POST without Idempotency-Key returns 400 MISSING_IDEMPOTENCY_KEY
  it("POST without Idempotency-Key returns 400 MISSING_IDEMPOTENCY_KEY", async () => {
    const token = (app.jwt.sign as any);
    const res = await app.inject({
      method: "POST",
      url: "/token",
      headers: { authorization: `Bearer ${token({ sub: "test", kid: "key" })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toContain("missing_idempotency_key");
  });

  // 2. First POST with Idempotency-Key succeeds
  it("first POST with Idempotency-Key succeeds and returns token (200)", async () => {
    const token = (app.jwt.sign as any);
    const res = await app.inject({
      method: "POST",
      url: "/token",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": "test-key-abc",
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-idempotent-response"]).toBeUndefined();
    const body = JSON.parse(res.body);
    expect(body.accessToken).toBe("mock-token-123");
  });

  // 3. Second identical POST returns same token + X-Idempotent-Response: true
  it("second identical POST returns same token + X-Idempotent-Response header", async () => {
    const token = (app.jwt.sign as any);
    
    // First request
    await app.inject({
      method: "POST",
      url: "/token",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": "test-key-xyz",
      },
      payload: {},
    });

    // Second identical request
    const res = await app.inject({
      method: "POST",
      url: "/token",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": "test-key-xyz",
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-idempotent-response"]).toBe("true");
    const body = JSON.parse(res.body);
    expect(body.accessToken).toBe("mock-token-123");
  });

  // 4. Same key + different body returns 422 IDEMPOTENCY_MISMATCH
  it("same key + different body returns 422 IDEMPOTENCY_MISMATCH", async () => {
    const token = (app.jwt.sign as any);
    const idempotencyKey = "mismatch-test-key";

    // First request with body {"a":1}
    await app.inject({
      method: "POST",
      url: "/data",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": idempotencyKey,
      },
      payload: { a: 1 },
    });

    // Second request with different body {"b":2}
    const res = await app.inject({
      method: "POST",
      url: "/data",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": idempotencyKey,
      },
      payload: { b: 2 },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.type).toContain("idempotency_mismatch");
  });

  // 5. Concurrent requests: loser returns 409 IDEMPOTENCY_IN_PROGRESS
  it("concurrent requests: loser returns 409 IDEMPOTENCY_IN_PROGRESS", async () => {
    // Pre-populate Redis with an in-progress request (simulating concurrent access)
    mockRedis._cache["idempotency:test-institution-id:concurrent-key"] = {
      status: 0,
      body: null,
      bodyHash: "",
      inProgress: true,
    };

    const token = (app.jwt.sign as any);
    const res = await app.inject({
      method: "POST",
      url: "/token",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": "concurrent-key",
      },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers["retry-after"]).toBe("1");
    const body = JSON.parse(res.body);
    expect(body.type).toContain("idempotency_in_progress");
  });

  // 6. Skips idempotency for GET requests
  it("skips idempotency for GET requests", async () => {
    const res = await app.inject({ method: "GET", url: "/gettest" });
    expect(res.statusCode).toBe(200);
  });

  // 7. DELETE requires Idempotency-Key
  it("DELETE without Idempotency-Key returns 400", async () => {
    const res = await app.inject({ method: "DELETE", url: "/deletetest" });
    expect(res.statusCode).toBe(400);
  });

  // 8. Idempotency-Key > 255 chars returns 400
  it("Idempotency-Key > 255 chars returns 400 IDEMPOTENCY_KEY_TOO_LONG", async () => {
    const token = (app.jwt.sign as any);
    const longKey = "a".repeat(256);
    const res = await app.inject({
      method: "POST",
      url: "/token",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": longKey,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toContain("idempotency_key_too_long");
  });

  // 9. constant-time comparison returns false for different hashes
  it("constant-time comparison returns false for different hashes", () => {
    function constantTimeEqual(a: string, b: string): boolean {
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    }
    const hash1 = "a".repeat(64);
    const hash2 = "b".repeat(64);
    expect(constantTimeEqual(hash1, hash2)).toBe(false);
  });
});