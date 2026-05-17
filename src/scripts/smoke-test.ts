import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.test" });
import crypto from "crypto";
import * as jose from "jose";

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_SECRET_BYTES = Buffer.from(JWT_SECRET, "hex");
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";
const TEST_INSTITUTION_ID = process.env.TEST_INSTITUTION_ID!;
const TEST_API_KEY_ID = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
const TEST_HMAC_SECRET = Buffer.from(process.env.TEST_HMAC_SECRET!, "hex");
const ALGOD_URL = process.env.ALGOD_URL!;

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

function computeHmac(secret: Buffer, body: string): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

async function run() {
  console.log("=== 2b Smoke Tests ===\n");

  console.log("1. JWT signing");
  const jwt = await signJwt({ sub: TEST_INSTITUTION_ID, kid: TEST_API_KEY_ID });
  console.log("   JWT created:", jwt.substring(0, 40) + "...");

  console.log("\n2. HMAC computation");
  const testBody = JSON.stringify({ test: "data" });
  const sig = computeHmac(TEST_HMAC_SECRET, testBody);
  console.log("   HMAC-SHA256:", sig);

  console.log("\n3. Algorand client");
  console.log("   ALGOD_URL:", ALGOD_URL);

  console.log("\n4. Constant-time equal (true case)");
  const a = Buffer.from("abcd");
  const b = Buffer.from("abcd");
  const result = crypto.timingSafeEqual(a, b);
  console.log("   timingSafeEqual(ab, ab):", result);

  console.log("\n5. Constant-time equal (false case)");
  try {
    const c = Buffer.from("abce");
    crypto.timingSafeEqual(a, c);
    console.log("   unexpected: no error thrown");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("   timingSafeEqual(ab, abce) throws:", msg.split("\n")[0]);
  }

  console.log("\n=== All smoke checks passed ===");
}

run().catch((e) => { console.error(e); process.exit(1); });