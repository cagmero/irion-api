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
const vitest_1 = require("vitest");
const fastify_1 = __importDefault(require("fastify"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const crypto_1 = __importDefault(require("crypto"));
const JWT_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRedis = {
    _cache: {},
    get: vitest_1.vi.fn((key) => Promise.resolve(mockRedis._cache[key] ?? null)),
    set: vitest_1.vi.fn((key, value, _opts) => {
        if (mockRedis._cache[key])
            return Promise.resolve(null);
        mockRedis._cache[key] = JSON.parse(value);
        return Promise.resolve("OK");
    }),
    setex: vitest_1.vi.fn((key, _ttl, value) => {
        mockRedis._cache[key] = value;
        return Promise.resolve("OK");
    }),
    clear: () => { mockRedis._cache = {}; },
};
vitest_1.vi.mock("../db/index.js", () => ({
    db: {
        insert: vitest_1.vi.fn().mockReturnValue({ values: vitest_1.vi.fn().mockResolvedValue(undefined), catch: vitest_1.vi.fn() }),
    },
}));
vitest_1.vi.mock("../lib/secrets.js", () => ({
    getSecret: vitest_1.vi.fn((name) => {
        const secrets = {
            JWT_SECRET,
            WEBHOOK_SIGNING_SECRET: "webhook-signing-secret-for-hmac-test-32bytes!!",
            UPSTASH_REDIS_REST_URL: "http://localhost:6379",
            UPSTASH_REDIS_REST_TOKEN: "test-token",
        };
        return secrets[name] || "mock-secret";
    }),
}));
vitest_1.vi.mock("@upstash/redis", () => ({
    Redis: vitest_1.vi.fn(() => mockRedis),
}));
(0, vitest_1.describe)("idempotency plugin - contract tests", () => {
    let app;
    (0, vitest_1.beforeEach)(async () => {
        mockRedis.clear();
        vitest_1.vi.clearAllMocks();
        app = (0, fastify_1.default)({ logger: false });
        await app.register(jwt_1.default, {
            secret: JWT_SECRET,
            sign: { iss: JWT_ISSUER, aud: JWT_AUDIENCE },
            verify: { algorithms: ["HS256"], allowedIss: [JWT_ISSUER], allowedAud: [JWT_AUDIENCE] },
        });
        app.decorate("authenticate", async (request, reply) => {
            const authHeader = request.headers?.authorization;
            if (!authHeader?.startsWith("Bearer ")) {
                return reply.status(401).send({ error: "MISSING_SIGNATURE" });
            }
            try {
                await request.jwtVerify();
                request.institutionId = "test-institution-id";
            }
            catch {
                return reply.status(401).send({ error: "INVALID_TOKEN" });
            }
        });
        const { default: idempotencyPlugin } = await Promise.resolve().then(() => __importStar(require("../plugins/idempotency.js")));
        await app.register(idempotencyPlugin);
        app.post("/token", { preHandler: [app.authenticate, app.idempotency] }, async () => {
            return { accessToken: "mock-token-123", expiresIn: 3600 };
        });
        app.post("/data", { preHandler: [app.authenticate, app.idempotency] }, async (request) => {
            return { received: request.body };
        });
        app.get("/gettest", async () => ({ ok: true }));
        app.delete("/deletetest", { preHandler: [app.idempotency] }, async () => ({ deleted: true }));
        await app.ready();
    });
    (0, vitest_1.afterEach)(async () => { await app.close(); });
    // 1. POST without Idempotency-Key returns 400 MISSING_IDEMPOTENCY_KEY
    (0, vitest_1.it)("POST without Idempotency-Key returns 400 MISSING_IDEMPOTENCY_KEY", async () => {
        const token = app.jwt.sign;
        const res = await app.inject({
            method: "POST",
            url: "/token",
            headers: { authorization: `Bearer ${token({ sub: "test", kid: "key" })}` },
            payload: {},
        });
        (0, vitest_1.expect)(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.type).toContain("missing_idempotency_key");
    });
    // 2. First POST with Idempotency-Key succeeds
    (0, vitest_1.it)("first POST with Idempotency-Key succeeds and returns token (200)", async () => {
        const token = app.jwt.sign;
        const res = await app.inject({
            method: "POST",
            url: "/token",
            headers: {
                authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
                "Idempotency-Key": "test-key-abc",
            },
            payload: {},
        });
        (0, vitest_1.expect)(res.statusCode).toBe(200);
        (0, vitest_1.expect)(res.headers["x-idempotent-response"]).toBeUndefined();
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.accessToken).toBe("mock-token-123");
    });
    // 3. Second identical POST returns same token + X-Idempotent-Response: true
    (0, vitest_1.it)("second identical POST returns same token + X-Idempotent-Response header", async () => {
        const token = app.jwt.sign;
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
        (0, vitest_1.expect)(res.statusCode).toBe(200);
        (0, vitest_1.expect)(res.headers["x-idempotent-response"]).toBe("true");
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.accessToken).toBe("mock-token-123");
    });
    // 4. Same key + different body returns 422 IDEMPOTENCY_MISMATCH
    (0, vitest_1.it)("same key + different body returns 422 IDEMPOTENCY_MISMATCH", async () => {
        const token = app.jwt.sign;
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
        (0, vitest_1.expect)(res.statusCode).toBe(422);
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.type).toContain("idempotency_mismatch");
    });
    // 5. Concurrent requests: loser returns 409 IDEMPOTENCY_IN_PROGRESS
    (0, vitest_1.it)("concurrent requests: loser returns 409 IDEMPOTENCY_IN_PROGRESS", async () => {
        // Pre-populate Redis with an in-progress request (simulating concurrent access)
        mockRedis._cache["idempotency:test-institution-id:concurrent-key"] = {
            status: 0,
            body: null,
            bodyHash: "",
            inProgress: true,
        };
        const token = app.jwt.sign;
        const res = await app.inject({
            method: "POST",
            url: "/token",
            headers: {
                authorization: `Bearer ${token({ sub: "test", kid: "key" })}`,
                "Idempotency-Key": "concurrent-key",
            },
            payload: {},
        });
        (0, vitest_1.expect)(res.statusCode).toBe(409);
        (0, vitest_1.expect)(res.headers["retry-after"]).toBe("1");
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.type).toContain("idempotency_in_progress");
    });
    // 6. Skips idempotency for GET requests
    (0, vitest_1.it)("skips idempotency for GET requests", async () => {
        const res = await app.inject({ method: "GET", url: "/gettest" });
        (0, vitest_1.expect)(res.statusCode).toBe(200);
    });
    // 7. DELETE requires Idempotency-Key
    (0, vitest_1.it)("DELETE without Idempotency-Key returns 400", async () => {
        const res = await app.inject({ method: "DELETE", url: "/deletetest" });
        (0, vitest_1.expect)(res.statusCode).toBe(400);
    });
    // 8. Idempotency-Key > 255 chars returns 400
    (0, vitest_1.it)("Idempotency-Key > 255 chars returns 400 IDEMPOTENCY_KEY_TOO_LONG", async () => {
        const token = app.jwt.sign;
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
        (0, vitest_1.expect)(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.type).toContain("idempotency_key_too_long");
    });
    // 9. constant-time comparison returns false for different hashes
    (0, vitest_1.it)("constant-time comparison returns false for different hashes", () => {
        function constantTimeEqual(a, b) {
            if (a.length !== b.length)
                return false;
            return crypto_1.default.timingSafeEqual(Buffer.from(a), Buffer.from(b));
        }
        const hash1 = "a".repeat(64);
        const hash2 = "b".repeat(64);
        (0, vitest_1.expect)(constantTimeEqual(hash1, hash2)).toBe(false);
    });
});
//# sourceMappingURL=idempotency.test.js.map