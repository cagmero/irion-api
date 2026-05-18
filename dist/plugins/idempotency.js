"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = require("fastify-plugin");
const crypto_1 = __importDefault(require("crypto"));
const redis_1 = require("@upstash/redis");
const index_js_1 = require("../db/index.js");
const schema_js_1 = require("../db/schema.js");
const errors_js_1 = require("../lib/errors.js");
const secrets_js_1 = require("../lib/secrets.js");
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const CACHE_TTL_SECONDS = IDEMPOTENCY_TTL_SECONDS;
const MAX_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 100;
let redisClient = null;
function getRedis() {
    if (!redisClient) {
        redisClient = new redis_1.Redis({
            url: (0, secrets_js_1.getSecret)("UPSTASH_REDIS_REST_URL"),
            token: (0, secrets_js_1.getSecret)("UPSTASH_REDIS_REST_TOKEN"),
        });
    }
    return redisClient;
}
function hashBody(body) {
    return crypto_1.default.createHash("sha256").update(body).digest("hex");
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
exports.default = (0, fastify_plugin_1.fastifyPlugin)(async function idempotencyPlugin(app) {
    app.decorate("idempotency", async (request, reply) => {
        if (!["POST", "PUT", "DELETE"].includes(request.method))
            return;
        const idempotencyKey = request.headers["idempotency-key"];
        if (!idempotencyKey) {
            return reply.status(400).send((0, errors_js_1.problemDetails)(request, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required for POST, PUT, and DELETE requests"));
        }
        if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
            return reply.status(400).send((0, errors_js_1.problemDetails)(request, "IDEMPOTENCY_KEY_TOO_LONG", `Idempotency-Key exceeds maximum length of ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`));
        }
        const institutionId = request.institutionId;
        if (!institutionId) {
            request.log.warn("idempotency plugin called without institutionId — skipping");
            return;
        }
        const requestPath = request.url;
        const requestMethod = request.method;
        const cacheKey = `idempotency:${institutionId}:${idempotencyKey}`;
        const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body) ?? "");
        const currentBodyHash = hashBody(rawBody);
        const redis = getRedis();
        // Try to claim the key atomically with SET NX EX
        const claimResult = await redis.set(cacheKey, JSON.stringify({
            status: 0,
            body: null,
            bodyHash: currentBodyHash,
            inProgress: true,
        }), {
            nx: true,
            ex: IDEMPOTENCY_TTL_SECONDS,
        });
        if (claimResult !== "OK") {
            // Another request holds the lock - check if it's in progress or completed
            const existing = await redis.get(cacheKey);
            if (!existing || existing.inProgress) {
                // Still in progress - return 409
                return reply
                    .status(409)
                    .header("Retry-After", "1")
                    .send((0, errors_js_1.problemDetails)(request, "IDEMPOTENCY_IN_PROGRESS", "Another request with this idempotency key is in progress. Retry after 1 second."));
            }
            // Winner completed - check body hash
            if (!existing.bodyHash || !constantTimeEqual(existing.bodyHash, currentBodyHash)) {
                return reply.status(422).send((0, errors_js_1.problemDetails)(request, "IDEMPOTENCY_MISMATCH", "Idempotency key reused with different request body"));
            }
            // Replay winner's response
            const storedHeaders = existing.headers ?? {};
            reply
                .status(existing.status)
                .header("X-Idempotent-Response", "true");
            for (const [k, v] of Object.entries(storedHeaders)) {
                if (k.toLowerCase() !== "content-type") {
                    reply.header(k, v);
                }
            }
            return reply.send(existing.body ?? null);
        }
        // We claimed the key - we're the winner, proceed with request
        let capturedStatus = 0;
        let capturedBody = null;
        let capturedHeaders = {};
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload) {
            capturedStatus = reply.statusCode;
            if (typeof payload === "string") {
                try {
                    capturedBody = JSON.parse(payload);
                }
                catch {
                    capturedBody = payload;
                }
            }
            else {
                capturedBody = payload;
            }
            const contentType = reply.getHeader("content-type");
            if (contentType)
                capturedHeaders["content-type"] = String(contentType);
            if (capturedStatus >= 200 && capturedStatus < 500) {
                const dbRecord = {
                    key: cacheKey,
                    institutionId,
                    requestPath,
                    requestMethod,
                    requestBodyHash: currentBodyHash,
                    responseBody: capturedBody,
                    responseStatus: capturedStatus,
                    responseHeaders: capturedHeaders,
                    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000),
                };
                index_js_1.db.insert(schema_js_1.idempotencyKeys)
                    .values(dbRecord)
                    .catch((err) => request.log.error({ err }, "failed to write idempotency key to DB"));
                redis.setex(cacheKey, CACHE_TTL_SECONDS, {
                    status: capturedStatus,
                    body: capturedBody,
                    bodyHash: currentBodyHash,
                    headers: capturedHeaders,
                }).catch((err) => request.log.error({ err }, "failed to write idempotency key to Redis"));
            }
            return originalSend(payload);
        };
    });
});
//# sourceMappingURL=idempotency.js.map