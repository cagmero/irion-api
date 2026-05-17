import { fastifyPlugin as fp } from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { db } from "../db/index.js";
import { idempotencyKeys } from "../db/schema.js";
import { problemDetails, type ErrorCode } from "../lib/errors.js";
import { getSecret } from "../lib/secrets.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const CACHE_TTL_SECONDS = IDEMPOTENCY_TTL_SECONDS;
const MAX_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 100;

let redisClient: ReturnType<typeof Redis.fromEnv> | null = null;

function getRedis(): ReturnType<typeof Redis.fromEnv> {
  if (!redisClient) {
    redisClient = new Redis({
      url: getSecret("UPSTASH_REDIS_REST_URL"),
      token: getSecret("UPSTASH_REDIS_REST_TOKEN"),
    });
  }
  return redisClient;
}

function hashBody(body: Buffer): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface CachedIdempotency {
  status: number;
  body: unknown;
  bodyHash: string;
  headers?: Record<string, string>;
}

export default fp(async function idempotencyPlugin(app: FastifyInstance) {
  app.decorate("idempotency", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!["POST", "PUT", "DELETE"].includes(request.method)) return;

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;

    if (!idempotencyKey) {
      return reply.status(400).send(
        problemDetails(request, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required for POST, PUT, and DELETE requests")
      );
    }

    if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      return reply.status(400).send(
        problemDetails(request, "IDEMPOTENCY_KEY_TOO_LONG", `Idempotency-Key exceeds maximum length of ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`)
      );
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
      const existing = await redis.get<CachedIdempotency>(cacheKey);
      
      if (!existing || (existing as any).inProgress) {
        // Still in progress - return 409
        return reply
          .status(409)
          .header("Retry-After", "1")
          .send(problemDetails(request, "IDEMPOTENCY_IN_PROGRESS", "Another request with this idempotency key is in progress. Retry after 1 second."));
      }

      // Winner completed - check body hash
      if (!existing.bodyHash || !constantTimeEqual(existing.bodyHash, currentBodyHash)) {
        return reply.status(422).send(
          problemDetails(request, "IDEMPOTENCY_MISMATCH", "Idempotency key reused with different request body")
        );
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
    let capturedBody: unknown = null;
    let capturedHeaders: Record<string, string> = {};

    const originalSend = reply.send.bind(reply);
    reply.send = function (payload?: unknown) {
      capturedStatus = reply.statusCode;
      if (typeof payload === "string") {
        try {
          capturedBody = JSON.parse(payload);
        } catch {
          capturedBody = payload;
        }
      } else {
        capturedBody = payload;
      }

      const contentType = reply.getHeader("content-type");
      if (contentType) capturedHeaders["content-type"] = String(contentType);

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

        db.insert(idempotencyKeys)
          .values(dbRecord)
          .catch((err: unknown) => request.log.error({ err }, "failed to write idempotency key to DB"));

        redis.setex(cacheKey, CACHE_TTL_SECONDS, {
          status: capturedStatus,
          body: capturedBody,
          bodyHash: currentBodyHash,
          headers: capturedHeaders,
        }).catch((err: unknown) => request.log.error({ err }, "failed to write idempotency key to Redis"));
      }

      return originalSend(payload);
    };
  });
});

declare module "fastify" {
  export interface FastifyInstance {
    idempotency: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}