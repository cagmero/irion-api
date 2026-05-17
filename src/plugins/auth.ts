import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fastifyJwt from "@fastify/jwt";
import crypto from "crypto";
import { getSecret } from "../lib/secrets.js";
import { problemDetails } from "../lib/errors.js";
import { db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { InferInsertModel } from "drizzle-orm";

const JWT_SECRET = getSecret("JWT_SECRET");
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";
const HMAC_CACHE_TTL_MS = 60_000;

type ApiKeyRow = InferInsertModel<typeof apiKeys>;

const hmacSecretCache = new Map<string, { secret: Buffer; expiresAt: number }>();

function decryptHmacSecret(encrypted: Buffer, masterKey: string): Buffer {
  const key = crypto.scryptSync(masterKey, "irion-pgcrypto-salt", 32);
  const iv = encrypted.subarray(0, 16);
  const tag = encrypted.subarray(16, 32);
  const ciphertext = encrypted.subarray(32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function getCachedHmacSecret(institutionId: string, encrypted: Buffer, masterKey: string): Buffer {
  const cached = hmacSecretCache.get(institutionId);
  if (cached && cached.expiresAt > Date.now()) return cached.secret;
  const plain = decryptHmacSecret(encrypted, masterKey);
  hmacSecretCache.set(institutionId, { secret: plain, expiresAt: Date.now() + HMAC_CACHE_TTL_MS });
  return plain;
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getClientIp(request: FastifyRequest): string {
  return (
    request.ip ??
    (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    "unknown"
  );
}

interface JwtPayload {
  sub: string;
  kid: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export async function authPlugin(app: FastifyInstance) {
  const masterKey = getSecret("WEBHOOK_SIGNING_SECRET");

  app.addHook("preParsing", async (request) => {
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      const chunks: Buffer[] = [];
      for await (const chunk of request.raw) {
        chunks.push(Buffer.from(chunk));
      }
      request.rawBody = Buffer.concat(chunks);
    }
  });

  await app.register(fastifyJwt, {
    secret: JWT_SECRET,
    sign: {
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
    },
    verify: {
      allowedIss: [JWT_ISSUER],
      allowedAud: [JWT_AUDIENCE],
    },
  });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return reply.status(401).send(
          problemDetails(request, "MISSING_SIGNATURE", "Bearer token is required")
        );
      }

      let decoded: JwtPayload;
      try {
        await request.jwtVerify();
        decoded = request.user as JwtPayload;
      } catch (jwtErr: unknown) {
        const msg = jwtErr instanceof Error ? jwtErr.message : String(jwtErr);
        if (msg.includes("expired") || msg.includes("iat")) {
          return reply.status(401).send(problemDetails(request, "EXPIRED_TOKEN"));
        }
        return reply.status(401).send(problemDetails(request, "INVALID_TOKEN"));
      }

      const { sub: institutionId, kid: apiKeyId } = decoded;

      const [keyRecord] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.status, "active")))
        .limit(1);

      if (!keyRecord) {
        return reply.status(401).send(
          problemDetails(request, "INSTITUTION_NOT_FOUND", "API key not found or revoked")
        );
      }

      if (keyRecord.allowedIps && keyRecord.allowedIps.length > 0) {
        const clientIp = getClientIp(request);
        if (!keyRecord.allowedIps.includes(clientIp)) {
          return reply.status(403).send(
            problemDetails(request, "IP_BLOCKED", `IP ${clientIp} is not in the allowed list`)
          );
        }
      }

      if (["POST", "PUT", "PATCH"].includes(request.method)) {
        const signatureHeader = request.headers["irion-signature"] as string | undefined;
        if (!signatureHeader) {
          return reply.status(401).send(problemDetails(request, "MISSING_SIGNATURE"));
        }

        const rawBody = request.rawBody;
        if (!rawBody) {
          return reply.status(401).send(
            problemDetails(request, "INVALID_SIGNATURE", "Raw body not available for HMAC verification")
          );
        }

        if (!keyRecord.hmacSecret) {
          return reply.status(401).send(
            problemDetails(request, "INVALID_SIGNATURE", "No HMAC secret configured for this API key")
          );
        }

        const hmacSecret = getCachedHmacSecret(institutionId, keyRecord.hmacSecret as Buffer, masterKey);

        const expected = crypto.createHmac("sha256", hmacSecret).update(rawBody).digest();
        const provided = Buffer.from(signatureHeader, "hex");

        if (!constantTimeEqual(expected, provided)) {
          return reply.status(401).send(problemDetails(request, "INVALID_SIGNATURE"));
        }
      }

      request.institutionId = institutionId;
      request.apiKeyId = apiKeyId;
    } catch (err) {
      request.log.error({ err }, "auth plugin error");
      return reply.status(401).send(problemDetails(request, "AUTH_FAILED"));
    }
  });
}

declare module "fastify" {
  export interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  export interface FastifyRequest {
    institutionId: string;
    apiKeyId: string;
    rawBody?: Buffer;
  }
}