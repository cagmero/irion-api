import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Redis } from "@upstash/redis";
import { getSecret } from "../lib/secrets.js";
import { problemDetails } from "../lib/errors.js";
import { db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { eq } from "drizzle-orm";

const REDIS = new Redis({
  url: getSecret("UPSTASH_REDIS_REST_URL"),
  token: getSecret("UPSTASH_REDIS_REST_TOKEN"),
});

const PUBLIC_ROUTES = new Set(["/health", "/v1/auth/token"]);
const PUBLIC_RATE_LIMIT = 1000;
const AUTH_RATE_LIMIT = 500;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const RATE_LIMIT_WINDOW_SEC = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
const CACHE_TTL_MS = 60_000;

const tierCache = new Map<string, { limit: number; expiresAt: number }>();

function getClientIp(request: FastifyRequest): string {
  return (
    request.ip ??
    (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    "unknown"
  );
}

async function getRateLimitForInstitution(institutionId: string): Promise<number> {
  const cached = tierCache.get(institutionId);
  if (cached && cached.expiresAt > Date.now()) return cached.limit;

  const [keyRecord] = await db
    .select({ status: apiKeys.status })
    .from(apiKeys)
    .where(eq(apiKeys.institutionId, institutionId))
    .limit(1);

  const limit = keyRecord ? AUTH_RATE_LIMIT : 0;
  tierCache.set(institutionId, { limit, expiresAt: Date.now() + CACHE_TTL_MS });
  return limit;
}

async function rateLimitRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = request.url;
  const isPublicRoute = PUBLIC_ROUTES.has(path) || path.startsWith("/docs");

  const key = isPublicRoute
    ? `ratelimit:ip:${getClientIp(request)}`
    : `ratelimit:institution:${request.institutionId ?? "unknown"}`;

  const limit = isPublicRoute ? PUBLIC_RATE_LIMIT : await getRateLimitForInstitution(request.institutionId ?? "");

  if (!limit) return;

  const current = await REDIS.incr(key);
  if (current === 1) {
    await REDIS.expire(key, RATE_LIMIT_WINDOW_SEC);
  }

  const remaining = Math.max(0, limit - current);
  const retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);

  reply.header("X-RateLimit-Limit", String(limit));
  reply.header("X-RateLimit-Remaining", String(remaining));
  reply.header("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + RATE_LIMIT_WINDOW_SEC));

  if (current > limit) {
    reply.header("Retry-After", String(retryAfter));
    return reply.status(429).send(problemDetails(request, "RATE_LIMITED", `Rate limit exceeded. Retry after ${retryAfter} seconds`));
  }
}

export async function setupRateLimiter(app: FastifyInstance) {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    await rateLimitRequest(request, reply);
  });
}