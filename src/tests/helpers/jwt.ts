import { SignJWT } from "jose";

const JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-32-chars-long-enough-for-hs256";
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";

/**
 * Create a JWT for test use. Matches the auth plugin's expected claims:
 * - sub: institution ID
 * - kid: API key ID (required for auth plugin's DB lookup)
 * - iss/aud: must match fastify-jwt verify config
 */
export async function makeTestToken(
  institutionId: string,
  options?: { apiKeyId?: string; expiresInSec?: number }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: institutionId, kid: options?.apiKeyId ?? "key-id-1" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + (options?.expiresInSec ?? 900))
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/**
 * Create an expired JWT for testing token expiry handling.
 */
export async function makeExpiredToken(institutionId: string): Promise<string> {
  const past = Math.floor(Date.now() / 1000) - 3600;
  return new SignJWT({ sub: institutionId, kid: "key-id-1" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(past)
    .setExpirationTime(past + 300)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .sign(new TextEncoder().encode(JWT_SECRET));
}
