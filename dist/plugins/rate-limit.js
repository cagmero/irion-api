"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupRateLimiter = setupRateLimiter;
const redis_1 = require("@upstash/redis");
const secrets_js_1 = require("../lib/secrets.js");
const errors_js_1 = require("../lib/errors.js");
const index_js_1 = require("../db/index.js");
const schema_js_1 = require("../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
const PUBLIC_ROUTES = new Set(["/health", "/v1/auth/token"]);
const PUBLIC_RATE_LIMIT = 1000;
const AUTH_RATE_LIMIT = 500;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const RATE_LIMIT_WINDOW_SEC = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
const CACHE_TTL_MS = 60_000;
const tierCache = new Map();
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
function getClientIp(request) {
    return (request.ip ??
        request.headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
        "unknown");
}
async function getRateLimitForInstitution(institutionId) {
    const cached = tierCache.get(institutionId);
    if (cached && cached.expiresAt > Date.now())
        return cached.limit;
    const [keyRecord] = await index_js_1.db
        .select({ status: schema_js_1.apiKeys.status })
        .from(schema_js_1.apiKeys)
        .where((0, drizzle_orm_1.eq)(schema_js_1.apiKeys.institutionId, institutionId))
        .limit(1);
    const limit = keyRecord ? AUTH_RATE_LIMIT : 0;
    tierCache.set(institutionId, { limit, expiresAt: Date.now() + CACHE_TTL_MS });
    return limit;
}
async function rateLimitRequest(request, reply) {
    const path = request.url;
    const isPublicRoute = PUBLIC_ROUTES.has(path) || path.startsWith("/docs");
    const key = isPublicRoute
        ? `ratelimit:ip:${getClientIp(request)}`
        : `ratelimit:institution:${request.institutionId ?? "unknown"}`;
    // For non-public routes, only check DB-based rate limits if institutionId is set
    const institutionId = request.institutionId;
    const limit = isPublicRoute || !institutionId
        ? PUBLIC_RATE_LIMIT
        : await getRateLimitForInstitution(institutionId);
    if (!limit)
        return;
    const current = await getRedis().incr(key);
    if (current === 1) {
        await getRedis().expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    const remaining = Math.max(0, limit - current);
    const retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + RATE_LIMIT_WINDOW_SEC));
    if (current > limit) {
        reply.header("Retry-After", String(retryAfter));
        return reply.status(429).send((0, errors_js_1.problemDetails)(request, "RATE_LIMITED", `Rate limit exceeded. Retry after ${retryAfter} seconds`));
    }
}
async function setupRateLimiter(app) {
    app.addHook("preHandler", async (request, reply) => {
        await rateLimitRequest(request, reply);
    });
}
//# sourceMappingURL=rate-limit.js.map