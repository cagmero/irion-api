import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import crypto from "crypto";

const JWT_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";

vi.mock("../db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined), catch: vi.fn() }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
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

vi.mock("@upstash/redis", () => {
  const mockRedis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    setex: vi.fn().mockResolvedValue("OK"),
  };
  return { Redis: vi.fn(() => mockRedis) };
});

describe("idempotency plugin", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
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

    // Add routes BEFORE ready
    app.post("/test", { preHandler: [app.authenticate, app.idempotency] }, async (request: any) => {
      return { success: true, receivedBody: request.body };
    });

    app.get("/gettest", async () => ({ ok: true }));

    app.delete("/deletetest", { preHandler: [app.idempotency] }, async () => ({ deleted: true }));

    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  it("rejects POST without Idempotency-Key header (400 MISSING_IDEMPOTENCY_KEY)", async () => {
    const token = (app.jwt.sign as any);
    const res = await app.inject({
      method: "POST",
      url: "/test",
      headers: { authorization: `Bearer ${token({ sub: "test", kid: "key" })}` },
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toContain("missing_idempotency_key");
  });

  it("rejects Idempotency-Key longer than 255 chars (400 IDEMPOTENCY_KEY_TOO_LONG)", async () => {
    const longKey = "a".repeat(256);
    const token = (app.jwt.sign as any);
    const res = await app.inject({
      method: "POST",
      url: "/test",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": longKey,
      },
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toContain("idempotency_key_too_long");
  });

  it("allows POST with valid Idempotency-Key (200)", async () => {
    const token = (app.jwt.sign as any);
    const res = await app.inject({
      method: "POST",
      url: "/test",
      headers: {
        authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
        "Idempotency-Key": "unique-key-123",
      },
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-idempotent-response"]).toBeUndefined();
  });

  it("skips idempotency for GET requests", async () => {
    const res = await app.inject({ method: "GET", url: "/gettest" });
    expect(res.statusCode).toBe(200);
  });

  it("skips idempotency for DELETE requests with preHandler (requires Idempotency-Key)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/deletetest" });
    expect(res.statusCode).toBe(400);
  });
});

describe("idempotency body hash", () => {
  function hashBody(body: Buffer): string {
    return crypto.createHash("sha256").update(body).digest("hex");
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

it("computes correct SHA256 hash", () => {
    const hash = hashBody(Buffer.from('{"hello":"world"}'));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("constant-time comparison returns true for equal hashes", () => {
    const hash1 = hashBody(Buffer.from("test"));
    const hash2 = hashBody(Buffer.from("test"));
    expect(constantTimeEqual(hash1, hash2)).toBe(true);
  });

  it("constant-time comparison returns false for different hashes", () => {
    const hash1 = hashBody(Buffer.from("test1"));
    const hash2 = hashBody(Buffer.from("test2"));
    expect(constantTimeEqual(hash1, hash2)).toBe(false);
  });
});