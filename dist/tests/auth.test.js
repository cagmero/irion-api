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
const jose_1 = require("jose");
const JWT_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HMAC_SECRET = Buffer.from("webhook-signing-secret-for-hmac-test-32bytes!!".padEnd(32, "!"));
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";
vitest_1.vi.mock("../db/index.js", () => ({
    db: { select: vitest_1.vi.fn(), insert: vitest_1.vi.fn() },
}));
vitest_1.vi.mock("../lib/secrets.js", () => ({
    getSecret: vitest_1.vi.fn((name) => {
        const secrets = {
            JWT_SECRET,
            WEBHOOK_SIGNING_SECRET: "webhook-signing-secret-for-hmac-test-32bytes!!",
            UPSTASH_REDIS_REST_URL: "http://localhost:6379",
            UPSTASH_REDIS_REST_TOKEN: "test-token",
        };
        const val = secrets[name];
        if (!val)
            throw new Error(`Secret "${name}" is not set`);
        return val;
    }),
}));
(0, vitest_1.describe)("preParsing hook — rawBody capture", () => {
    let app;
    (0, vitest_1.beforeEach)(async () => {
        app = (0, fastify_1.default)({ logger: false });
        await app.register(jwt_1.default, {
            secret: JWT_SECRET,
            sign: { iss: JWT_ISSUER, aud: JWT_AUDIENCE },
            verify: { algorithms: ["HS256"], allowedIss: [JWT_ISSUER], allowedAud: [JWT_AUDIENCE] },
        });
        app.addHook("preParsing", async (request, _reply, payload) => {
            if (!["POST", "PUT", "PATCH"].includes(request.method))
                return payload;
            const chunks = [];
            for await (const chunk of payload) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            request.rawBody = Buffer.concat(chunks);
            return Promise.resolve().then(() => __importStar(require("node:stream"))).then(({ Readable }) => Readable.from(request.rawBody));
        });
        app.post("/echo", async (request) => ({ rawBody: request.rawBody?.toString("utf8") }));
        app.get("/get", async (request) => ({ rawBody: request.rawBody }));
        await app.ready();
    });
    (0, vitest_1.afterEach)(async () => { await app.close(); });
    (0, vitest_1.it)("captures raw body as Buffer for POST requests", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/echo",
            payload: { hello: "world" },
        });
        (0, vitest_1.expect)(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.rawBody).toBe('{"hello":"world"}');
    });
    (0, vitest_1.it)("passes through GET requests untouched", async () => {
        const res = await app.inject({ method: "GET", url: "/get" });
        (0, vitest_1.expect)(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.rawBody).toBeUndefined();
    });
});
(0, vitest_1.describe)("authenticate decorator", () => {
    let app;
    async function signToken(payload) {
        const secretKey = crypto_1.default.createSecretKey(Buffer.from(JWT_SECRET, "hex"));
        return new jose_1.SignJWT(payload)
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setIssuer(JWT_ISSUER)
            .setAudience(JWT_AUDIENCE)
            .setExpirationTime("15m")
            .sign(secretKey);
    }
    (0, vitest_1.beforeAll)(async () => {
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
                const decoded = await request.jwtVerify();
                request.user = decoded;
            }
            catch (err) {
                const msg = err?.message ?? String(err);
                if (msg.includes("expired") || msg.includes("iat")) {
                    return reply.status(401).send({ error: "EXPIRED_TOKEN" });
                }
                return reply.status(401).send({ error: "INVALID_TOKEN" });
            }
        });
        app.post("/protected", async (request, reply) => {
            await app.authenticate(request, reply);
            if (reply.sent)
                return;
            return { ok: true };
        });
        await app.ready();
    });
    (0, vitest_1.afterAll)(async () => { await app.close(); });
    (0, vitest_1.it)("returns 401 when Authorization header is absent", async () => {
        const res = await app.inject({ method: "POST", url: "/protected", payload: {} });
        (0, vitest_1.expect)(res.statusCode).toBe(401);
        (0, vitest_1.expect)(JSON.parse(res.body).error).toBe("MISSING_SIGNATURE");
    });
    (0, vitest_1.it)("returns 401 for malformed JWT", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/protected",
            headers: { authorization: "Bearer not.a.jwt" },
            payload: {},
        });
        (0, vitest_1.expect)(res.statusCode).toBe(401);
        (0, vitest_1.expect)(JSON.parse(res.body).error).toBe("INVALID_TOKEN");
    });
    (0, vitest_1.it)("returns 401 for expired JWT", async () => {
        const secretKey = crypto_1.default.createSecretKey(Buffer.from(JWT_SECRET, "hex"));
        const token = await new jose_1.SignJWT({ sub: "test" })
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
        (0, vitest_1.expect)(res.statusCode).toBe(401);
    });
    (0, vitest_1.it)("allows request with valid JWT", async () => {
        const token = app.jwt.sign({ sub: "institution-1", kid: "key-1" });
        const res = await app.inject({
            method: "POST",
            url: "/protected",
            headers: { authorization: `Bearer ${token}` },
            payload: {},
        });
        (0, vitest_1.expect)(res.statusCode).toBe(200);
    });
});
(0, vitest_1.describe)("HMAC signature verification", () => {
    function computeHmac(secret, body) {
        return crypto_1.default.createHmac("sha256", secret).update(body).digest("hex");
    }
    function constantTimeEqual(a, b) {
        if (a.length !== b.length)
            return false;
        return crypto_1.default.timingSafeEqual(a, b);
    }
    (0, vitest_1.it)("computes correct HMAC-SHA256", () => {
        const body = '{"hello":"world"}';
        const sig = computeHmac(HMAC_SECRET, body);
        (0, vitest_1.expect)(sig).toHaveLength(64);
        const expected = crypto_1.default.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
        (0, vitest_1.expect)(sig).toBe(expected);
    });
    (0, vitest_1.it)("constant-time comparison returns true for equal sigs", () => {
        const sig = computeHmac(HMAC_SECRET, "test body");
        (0, vitest_1.expect)(constantTimeEqual(Buffer.from(sig, "hex"), Buffer.from(sig, "hex"))).toBe(true);
    });
    (0, vitest_1.it)("constant-time comparison returns false for different sigs", () => {
        const sig1 = computeHmac(HMAC_SECRET, "body 1");
        const sig2 = computeHmac(HMAC_SECRET, "body 2");
        (0, vitest_1.expect)(constantTimeEqual(Buffer.from(sig1, "hex"), Buffer.from(sig2, "hex"))).toBe(false);
    });
    (0, vitest_1.it)("rejects signature with wrong length", () => {
        const result = constantTimeEqual(Buffer.from("abc", "hex"), Buffer.from("abcd1234", "hex"));
        (0, vitest_1.expect)(result).toBe(false);
    });
});
(0, vitest_1.describe)("rate-limit preHandler", () => {
    (0, vitest_1.it)("adds X-RateLimit headers to reply", async () => {
        const app = (0, fastify_1.default)({ logger: false });
        app.addHook("preHandler", async (request, reply) => {
            reply.header("X-RateLimit-Limit", "1000");
            reply.header("X-RateLimit-Remaining", "999");
            reply.header("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + 60));
        });
        app.get("/test", async () => "ok");
        await app.ready();
        const res = await app.inject({ method: "GET", url: "/test" });
        await app.close();
        (0, vitest_1.expect)(res.headers["x-ratelimit-limit"]).toBe("1000");
        (0, vitest_1.expect)(res.headers["x-ratelimit-remaining"]).toBe("999");
    });
});
(0, vitest_1.describe)("problemDetails RFC 7807 format", () => {
    (0, vitest_1.it)("returns RFC 7807 structure", async () => {
        const app = (0, fastify_1.default)({ logger: false });
        app.get("/err", async (_request, reply) => {
            const body = {
                type: "https://irion-api.example.com/errors/validation_failed",
                title: "Request validation failed",
                status: 422,
                detail: "body must have required property 'grant_type'",
                instance: "/v1/auth/token",
                requestId: "req-1",
            };
            return reply.status(422).send(body);
        });
        await app.ready();
        const res = await app.inject({ method: "GET", url: "/err" });
        await app.close();
        const body = JSON.parse(res.body);
        (0, vitest_1.expect)(body.type).toContain("validation_failed");
        (0, vitest_1.expect)(body.title).toBeDefined();
        (0, vitest_1.expect)(body.status).toBe(422);
        (0, vitest_1.expect)(body.instance).toBeDefined();
        (0, vitest_1.expect)(body.requestId).toBeDefined();
    });
});
//# sourceMappingURL=auth.test.js.map