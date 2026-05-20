import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Redis } from "@upstash/redis";
import { getSecret } from "../lib/secrets.js";
import { problemDetails } from "../lib/errors.js";

// Config from env vars
const RATE_LIMIT_PUBLIC_MAX = parseInt(process.env.RATE_LIMIT_PUBLIC_MAX || "100", 10);
const RATE_LIMIT_PUBLIC_WINDOW_MS = parseInt(process.env.RATE_LIMIT_PUBLIC_WINDOW_MS || "60000", 10);
const RATE_LIMIT_AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX || "500", 10);
const RATE_LIMIT_AUTH_WINDOW_MS = parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS || "60000", 10);
const TRUST_PROXY_HOPS = parseInt(process.env.TRUST_PROXY_HOPS || "1", 10);

const RATE_LIMIT_PUBLIC_WINDOW_SEC = Math.ceil(RATE_LIMIT_PUBLIC_WINDOW_MS / 1000);
const RATE_LIMIT_AUTH_WINDOW_SEC = Math.ceil(RATE_LIMIT_AUTH_WINDOW_MS / 1000);

// Skip rate limiting in test environment (checked at runtime)
function shouldSkipRateLimit(): boolean {
  return process.env.NODE_ENV === "test" || process.env.DISABLE_RATE_LIMIT === "true";
}

// Cache for tier limits (stub for future per-institution override support)
const tierCache = new Map<string, { limit: number; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      url: getSecret("UPSTASH_REDIS_REST_URL"),
      token: getSecret("UPSTASH_REDIS_REST_TOKEN"),
    });
  }
  return redisClient;
}

function getClientIp(request: FastifyRequest): string {
  // Respect X-Forwarded-For when request came through trusted proxy
  const forwardedFor = request.headers["x-forwarded-for"];
  if (forwardedFor && TRUST_PROXY_HOPS > 0) {
    const ips = (forwardedFor as string).split(",").map((ip) => ip.trim());
    // Take the first-hop IP that isn't from the client
    const trustedIp = ips.length > 0 ? ips[0] : null;
    if (trustedIp && trustedIp !== request.ip) {
      return trustedIp;
    }
  }
  return request.ip ?? "unknown";
}

function getRateLimitTier(request: FastifyRequest): "public" | "auth" {
  // Read tier from route config, default to "auth"
  const routeConfig = request.routeOptions?.config as { rateLimitTier?: string } | undefined;
  return (routeConfig?.rateLimitTier as "public" | "auth") ?? "auth";
}

async function rateLimitRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Skip rate limiting in test / demo environments
  if (shouldSkipRateLimit()) return;

  const tier = getRateLimitTier(request);
  const isPublicTier = tier === "public";
  
  const key = isPublicTier
    ? `ratelimit:ip:${getClientIp(request)}`
    : `ratelimit:institution:${request.institutionId ?? "unknown"}`;

  const limit = isPublicTier ? RATE_LIMIT_PUBLIC_MAX : RATE_LIMIT_AUTH_MAX;
  const windowSec = isPublicTier ? RATE_LIMIT_PUBLIC_WINDOW_SEC : RATE_LIMIT_AUTH_WINDOW_SEC;

  try {
    const redis = getRedis();
    const current = await redis.incr(key);
    
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    const remaining = Math.max(0, limit - current);
    const resetTimestamp = Math.ceil(Date.now() / 1000) + windowSec;

    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("X-RateLimit-Reset", String(resetTimestamp));

    if (current > limit) {
      reply.header("Retry-After", String(windowSec));
      return reply
        .status(429)
        .send(problemDetails(request, "RATE_LIMITED", `Rate limit exceeded. Retry after ${windowSec} seconds`));
    }
  } catch {
    // Redis unavailable (e.g. rate limit exceeded on Upstash free tier).
    // Allow request through without rate limiting.
  }
}

export async function setupRateLimiter(app: FastifyInstance) {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    await rateLimitRequest(request, reply);
  });
}