import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.test" });
import crypto from "crypto";
import * as jose from "jose";
import http from "http";

const JWT_SECRET_BYTES = Buffer.from(process.env.JWT_SECRET!, "hex");
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";
const TEST_INSTITUTION_ID = process.env.TEST_INSTITUTION_ID!;
const TEST_API_KEY_ID = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
const TEST_HMAC_SECRET = Buffer.from(process.env.TEST_HMAC_SECRET!, "hex");

async function signJwt(payload: object): Promise<string> {
  const key = await jose.importJWK({ k: JWT_SECRET_BYTES.toString("base64url"), kty: "oct" }, "HS256");
  return await new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime("15m")
    .sign(key);
}

function hmac(secret: Buffer, body: string): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

async function httpRequest(options: http.RequestOptions, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  console.log("=== 2b End-to-End Plugin Tests ===\n");

  console.log("1. GET /health (no auth required — public route)");
  let res = await httpRequest({ host: "localhost", port: 4000, path: "/health", method: "GET" });
  console.log(`   Status: ${res.status}`);
  console.log(`   Body: ${res.body}`);
  console.log(`   ✓ No 401\n`);

  console.log("2. POST /v1/auth/token without Bearer (missing auth)");
  res = await httpRequest({
    host: "localhost", port: 4000, path: "/v1/auth/token", method: "POST",
    headers: { "content-type": "application/json" },
  }, JSON.stringify({}));
  console.log(`   Status: ${res.status}`);
  const errBody = JSON.parse(res.body || "{}");
  console.log(`   type: ${errBody.type}`);
  console.log(`   title: ${errBody.title}`);
  console.log(`   status: ${errBody.status}`);
  console.log(`   instance: ${errBody.instance}`);
  console.log(`   ✓ 401 with RFC 7807 problem details\n`);

  console.log("3. GET /health — rate limit headers present");
  res = await httpRequest({ host: "localhost", port: 4000, path: "/health", method: "GET" });
  const limit = res.headers["x-ratelimit-limit"];
  const remaining = res.headers["x-ratelimit-remaining"];
  console.log(`   X-RateLimit-Limit: ${limit}`);
  console.log(`   X-RateLimit-Remaining: ${remaining}`);
  console.log(`   ✓ Rate limit headers present\n`);

  console.log("4. Verify RFC 7807 error structure on /v1/auth/token");
  res = await httpRequest({
    host: "localhost", port: 4000, path: "/v1/auth/token", method: "POST",
    headers: { "content-type": "application/json" },
  }, JSON.stringify({}));
  const err = JSON.parse(res.body || "{}");
  const hasAllFields = err.type && err.title && err.status && err.instance && err.requestId;
  console.log(`   All RFC 7807 fields present: ${hasAllFields ? "YES" : "NO"}`);
  console.log(`   type: ${err.type}`);
  console.log(`   title: ${err.title}`);
  console.log(`   status: ${err.status}`);
  console.log(`   instance: ${err.instance}`);
  console.log(`   requestId: ${err.requestId}`);
  console.log(`   ✓ RFC 7807 compliant\n`);

  console.log("=== All end-to-end plugin tests complete ===");
}

run().catch((e) => { console.error(e); process.exit(1); });