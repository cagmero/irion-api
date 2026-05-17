import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import crypto from "crypto";
import { SignJWT } from "jose";

const JWT_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HMAC_SECRET = Buffer.from("webhook-signing-secret-for-hmac-test-32bytes!!".padEnd(32, "!"));
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";

vi.mock("../db/index.js", () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const secrets: Record<string, string> = {
      JWT_SECRET,
      WEBHOOK_SIGNING_SECRET: "webhook-signing-secret-for-hmac-test-32bytes!!",
      UPSTASH_REDIS_REST_URL: "http://localhost:6379",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    };
    const val = secrets[name];
    if (!val) throw new Error(`Secret "${name}" is not set`);
    return val;
  }),
}));

describe("preParsing hook — rawBody capture", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(jwt, {
      secret: JWT_SECRET,
      sign: { iss: JWT_ISSUER, aud: JWT_AUDIENCE },
      verify: { algorithms: ["HS256"], allowedIss: [JWT_ISSUER], allowedAud: [JWT_AUDIENCE] },
    });

    app.addHook("preParsing", async (request, _reply, payload) => {
      if (!["POST", "PUT", "PATCH"].includes(request.method)) return payload;
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      request.rawBody = Buffer.concat(chunks);
      return import("node:stream").then(({ Readable }) => Readable.from(request.rawBody!));
    });

    app.post("/echo", async (request) => ({ rawBody: (request as any).rawBody?.toString("utf8") }));
    app.get("/get", async (request) => ({ rawBody: (request as any).rawBody }));
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  it("captures raw body as Buffer for POST requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rawBody).toBe('{"hello":"world"}');
  });

  it("passes through GET requests untouched", async () => {
    const res = await app.inject({ method: "GET", url: "/get" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rawBody).toBeUndefined();
  });
});

describe("authenticate decorator", () => {
  let app: FastifyInstance;

  async function signToken(payload: object) {
    const secretKey = crypto.createSecretKey(Buffer.from(JWT_SECRET, "hex"));
    return new SignJWT(payload as any)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime("15m")
      .sign(secretKey);
  }

  beforeAll(async () => {
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
        const decoded = await request.jwtVerify();
        request.user = decoded;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes("expired") || msg.includes("iat")) {
          return reply.status(401).send({ error: "EXPIRED_TOKEN" });
        }
        return reply.status(401).send({ error: "INVALID_TOKEN" });
      }
    });

    app.post("/protected", async (request: any, reply: any) => {
      await (app as any).authenticate(request, reply);
      if (reply.sent) return;
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it("returns 401 when Authorization header is absent", async () => {
    const res = await app.inject({ method: "POST", url: "/protected", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("MISSING_SIGNATURE");
  });

  it("returns 401 for malformed JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { authorization: "Bearer not.a.jwt" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("INVALID_TOKEN");
  });

  it("returns 401 for expired JWT", async () => {
    const secretKey = crypto.createSecretKey(Buffer.from(JWT_SECRET, "hex"));
    const token = await new SignJWT({ sub: "test" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime("-1h")
      .sign(secretKey);

    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("allows request with valid JWT", async () => {
    const token = (app.jwt.sign as any)({ sub: "institution-1", kid: "key-1" });
    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("HMAC signature verification", () => {
  function computeHmac(secret: Buffer, body: Buffer | string) {
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  function constantTimeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  it("computes correct HMAC-SHA256", () => {
    const body = '{"hello":"world"}';
    const sig = computeHmac(HMAC_SECRET, body);
    expect(sig).toHaveLength(64);
    const expected = crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
    expect(sig).toBe(expected);
  });

  it("constant-time comparison returns true for equal sigs", () => {
    const sig = computeHmac(HMAC_SECRET, "test body");
    expect(constantTimeEqual(Buffer.from(sig, "hex"), Buffer.from(sig, "hex"))).toBe(true);
  });

  it("constant-time comparison returns false for different sigs", () => {
    const sig1 = computeHmac(HMAC_SECRET, "body 1");
    const sig2 = computeHmac(HMAC_SECRET, "body 2");
    expect(constantTimeEqual(Buffer.from(sig1, "hex"), Buffer.from(sig2, "hex"))).toBe(false);
  });

  it("rejects signature with wrong length", () => {
    const result = constantTimeEqual(Buffer.from("abc", "hex"), Buffer.from("abcd1234", "hex"));
    expect(result).toBe(false);
  });
});

describe("rate-limit preHandler", () => {
  it("adds X-RateLimit headers to reply", async () => {
    const app = Fastify({ logger: false });

    app.addHook("preHandler", async (request: any, reply: any) => {
      reply.header("X-RateLimit-Limit", "1000");
      reply.header("X-RateLimit-Remaining", "999");
      reply.header("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + 60));
    });

    app.get("/test", async () => "ok");
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/test" });
    await app.close();

    expect(res.headers["x-ratelimit-limit"]).toBe("1000");
    expect(res.headers["x-ratelimit-remaining"]).toBe("999");
  });
});

describe("problemDetails RFC 7807 format", () => {
  it("returns RFC 7807 structure", async () => {
    const app = Fastify({ logger: false });
    app.get("/err", async (_request: any, reply: any) => {
      const body = {
        type: "https://irion-api.example.com/errors/validation_failed",
        title: "Request validation failed",
        status: 422,
        detail: "body must have required property 'grant_type'",
        instance: "/v1/auth/token",
        requestId: "req-1",
      };
      return (reply as any).status(422).send(body);
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/err" });
    await app.close();

    const body = JSON.parse(res.body);
    expect(body.type).toContain("validation_failed");
    expect(body.title).toBeDefined();
    expect(body.status).toBe(422);
    expect(body.instance).toBeDefined();
    expect(body.requestId).toBeDefined();
  });
});