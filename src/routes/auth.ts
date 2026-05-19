import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as argon2 from "argon2";
import { SignJWT } from "jose";
import { db } from "../db/index.js";
import { apiKeys, auditLog } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { getSecret } from "../lib/secrets.js";

const tokenBodySchema = {
  type: "object",
  required: ["client_id", "client_secret"],
  properties: {
    client_id: { type: "string", minLength: 1 },
    client_secret: { type: "string", minLength: 1 },
  },
};

export async function authRoutes(app: FastifyInstance) {
  app.post("/token", {
    config: { rateLimitTier: "public" } as any,
    schema: {
      body: tokenBodySchema,
      response: {
        200: {
          type: "object",
          properties: {
            access_token: { type: "string" },
            token_type: { type: "string" },
            expires_in: { type: "integer" },
          },
        },
        400: {
          type: "object",
          properties: {
            code: { type: "string" },
            detail: { type: "string" },
          },
        },
        401: {
          type: "object",
          properties: {
            code: { type: "string" },
            detail: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { client_id: string; client_secret: string };
    const { client_id, client_secret } = body;

    // Extract key prefix (first 20 chars: "iri_prod_sk_" + 8 hex chars for uniqueness)
    const keyPrefix = client_id.substring(0, 20);

    // Lookup active API key by prefix
    const [apiKey] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyPrefix, keyPrefix), eq(apiKeys.status, "active")));

    if (!apiKey) {
      // Log failed attempt — institutionId is NULL for anonymous (no-match) failures
      await db.insert(auditLog).values({
        institutionId: null,
        action: "auth.token_failed",
        details: { providedKeyPrefix: keyPrefix, reason: "no_match" },
      });

      return reply.code(401).send({
        code: "INVALID_CREDENTIALS",
        detail: "client_id or client_secret is invalid",
      });
    }

    // Verify client_secret against argon2id hash
    const isValid = await argon2.verify(apiKey.keyHash, client_secret);
    if (!isValid) {
      await db.insert(auditLog).values({
        institutionId: apiKey.institutionId,
        action: "auth.token_failed",
        details: { providedKeyPrefix: keyPrefix, reason: "verify_failed" },
      });

      return reply.code(401).send({
        code: "INVALID_CREDENTIALS",
        detail: "client_id or client_secret is invalid",
      });
    }

    // Mint JWT
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresIn = 900; // 15 minutes

    const token = await new SignJWT({
      sub: apiKey.institutionId,
      kid: apiKey.id,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + expiresIn)
      .setIssuer("irion-api")
      .setAudience("irion-api-v1")
      .sign(new TextEncoder().encode(getSecret("JWT_SECRET")));

    // Audit log: success
    await db.insert(auditLog).values({
      institutionId: apiKey.institutionId,
      action: "auth.token_issued",
      details: { keyId: apiKey.id, expiresAt: nowSeconds + expiresIn },
    });

    return reply.code(200).send({
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
    });
  });
}
