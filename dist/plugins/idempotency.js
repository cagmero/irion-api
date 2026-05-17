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
        const cacheKey = `idempotency:${institutionId}:${idempotencyKey}`;
        const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body) ?? "");
        const currentBodyHash = hashBody(rawBody);
        const cached = await getRedis().get(cacheKey);
        if (cached) {
            if (!constantTimeEqual(cached.bodyHash, currentBodyHash)) {
                return reply.status(422).send((0, errors_js_1.problemDetails)(request, "IDEMPOTENCY_MISMATCH", "Idempotency key reused with different request body"));
            }
            reply
                .status(cached.status)
                .header("X-Idempotent-Response", "true")
                .send(cached.body ?? null);
            return reply;
        }
        const replyInterceptor = (payload, statusCode) => {
            const bodyToStore = typeof payload === "string" && payload.startsWith("{")
                ? JSON.parse(payload)
                : typeof payload === "object" && payload !== null
                    ? payload
                    : null;
            const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);
            index_js_1.db.insert(schema_js_1.idempotencyKeys)
                .values({
                key: cacheKey,
                institutionId,
                requestPath,
                responseBody: bodyToStore,
                responseStatus: statusCode,
                expiresAt,
            })
                .catch((err) => request.log.error({ err }, "failed to write idempotency key to DB"));
            getRedis().setex(cacheKey, CACHE_TTL_SECONDS, {
                status: statusCode,
                body: bodyToStore,
                bodyHash: currentBodyHash,
            }).catch((err) => request.log.error({ err }, "failed to write idempotency key to Redis"));
        };
        const originalSend = reply.send;
        reply.send = function (payload) {
            const statusCode = reply.statusCode;
            if (statusCode >= 200 && statusCode < 500) {
                replyInterceptor(payload, statusCode);
            }
            return originalSend.call(this, payload);
        };
    });
});
//# sourceMappingURL=idempotency.js.map