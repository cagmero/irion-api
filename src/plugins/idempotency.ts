import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { db } from "../db/index.js";
import { idempotencyKeys } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { problemDetails } from "../lib/errors.js";
import { getSecret } from "../lib/secrets.js";

const REDIS = new Redis({
  url: getSecret("UPSTASH_REDIS_REST_URL"),
  token: getSecret("UPSTASH_REDIS_REST_TOKEN"),
});

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const CACHE_TTL_SECONDS = IDEMPOTENCY_TTL_SECONDS;

function hashBody(body: Buffer): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function idempotencyPlugin(app: FastifyInstance) {
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
    const cacheKey = `idempotency:${institutionId}:${idempotencyKey}`;

    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body) ?? "");
    const currentBodyHash = hashBody(rawBody);

    const cached = await REDIS.get<{ status: number; body: unknown; bodyHash: string }>(cacheKey);

    if (cached) {
      if (!constantTimeEqual(cached.bodyHash, currentBodyHash)) {
        return reply.status(422).send(
          problemDetails(request, "IDEMPOTENCY_MISMATCH", "Idempotency key reused with different request body")
        );
      }

      reply
        .status(cached.status)
        .header("X-Idempotent-Response", "true")
        .send(cached.body ?? null);
      return reply;
    }

    const replyInterceptor = (payload: unknown, statusCode: number) => {
      const bodyToStore =
        typeof payload === "string" && payload.startsWith("{")
          ? JSON.parse(payload)
          : typeof payload === "object" && payload !== null
          ? payload
          : null;

      const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);

      db.insert(idempotencyKeys)
        .values({
          key: cacheKey,
          institutionId,
          requestPath,
          responseBody: bodyToStore,
          responseStatus: statusCode,
          expiresAt,
        })
        .catch((err: unknown) => request.log.error({ err }, "failed to write idempotency key to DB"));

      REDIS.setex(cacheKey, CACHE_TTL_SECONDS, {
        status: statusCode,
        body: bodyToStore,
        bodyHash: currentBodyHash,
      }).catch((err: unknown) => request.log.error({ err }, "failed to write idempotency key to Redis"));
    };

    const originalSend = reply.send;
    reply.send = function (this: FastifyReply, payload?: unknown) {
      const statusCode = reply.statusCode;
      if (statusCode >= 200 && statusCode < 500) {
        replyInterceptor(payload, statusCode);
      }
      return originalSend.call(this, payload);
    };
  });
}

declare module "fastify" {
  export interface FastifyInstance {
    idempotency: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}