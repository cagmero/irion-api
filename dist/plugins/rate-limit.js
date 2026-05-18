"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupRateLimiter = setupRateLimiter;
const redis_1 = require("@upstash/redis");
const secrets_js_1 = require("../lib/secrets.js");
const errors_js_1 = require("../lib/errors.js");
// Config from env vars
const RATE_LIMIT_PUBLIC_MAX = parseInt(process.env.RATE_LIMIT_PUBLIC_MAX || "100", 10);
const RATE_LIMIT_PUBLIC_WINDOW_MS = parseInt(process.env.RATE_LIMIT_PUBLIC_WINDOW_MS || "60000", 10);
const RATE_LIMIT_AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX || "500", 10);
const RATE_LIMIT_AUTH_WINDOW_MS = parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS || "60000", 10);
const TRUST_PROXY_HOPS = parseInt(process.env.TRUST_PROXY_HOPS || "1", 10);
const RATE_LIMIT_PUBLIC_WINDOW_SEC = Math.ceil(RATE_LIMIT_PUBLIC_WINDOW_MS / 1000);
const RATE_LIMIT_AUTH_WINDOW_SEC = Math.ceil(RATE_LIMIT_AUTH_WINDOW_MS / 1000);
// Skip rate limiting in test environment (checked at runtime)
function shouldSkipRateLimit() {
    return process.env.NODE_ENV === "test";
}
// Cache for tier limits (stub for future per-institution override support)
const tierCache = new Map();
const CACHE_TTL_MS = 60_000;
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
    // Respect X-Forwarded-For when request came through trusted proxy
    const forwardedFor = request.headers["x-forwarded-for"];
    if (forwardedFor && TRUST_PROXY_HOPS > 0) {
        const ips = forwardedFor.split(",").map((ip) => ip.trim());
        // Take the first-hop IP that isn't from the client
        const trustedIp = ips.length > 0 ? ips[0] : null;
        if (trustedIp && trustedIp !== request.ip) {
            return trustedIp;
        }
    }
    return request.ip ?? "unknown";
}
function getRateLimitTier(request) {
    // Read tier from route config, default to "auth"
    const routeConfig = request.routeOptions?.config;
    return routeConfig?.rateLimitTier ?? "auth";
}
async function rateLimitRequest(request, reply) {
    // Skip rate limiting in test environment
    if (shouldSkipRateLimit())
        return;
    const tier = getRateLimitTier(request);
    const isPublicTier = tier === "public";
    const key = isPublicTier
        ? `ratelimit:ip:${getClientIp(request)}`
        : `ratelimit:institution:${request.institutionId ?? "unknown"}`;
    const limit = isPublicTier ? RATE_LIMIT_PUBLIC_MAX : RATE_LIMIT_AUTH_MAX;
    const windowSec = isPublicTier ? RATE_LIMIT_PUBLIC_WINDOW_SEC : RATE_LIMIT_AUTH_WINDOW_SEC;
    const redis = getRedis();
    const current = await redis.incr(key);
    if (current === 1) {
        await redis.expire(key, windowSec);
    }
    const remaining = Math.max(0, limit - current);
    const resetTimestamp = Math.ceil(Date.now() / 1000) + windowSec;
    // Set headers on every response (informational)
    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("X-RateLimit-Reset", String(resetTimestamp));
    if (current > limit) {
        reply.header("Retry-After", String(windowSec));
        return reply
            .status(429)
            .send((0, errors_js_1.problemDetails)(request, "RATE_LIMITED", `Rate limit exceeded. Retry after ${windowSec} seconds`));
    }
}
async function setupRateLimiter(app) {
    app.addHook("preHandler", async (request, reply) => {
        await rateLimitRequest(request, reply);
    });
}
//# sourceMappingURL=rate-limit.js.map