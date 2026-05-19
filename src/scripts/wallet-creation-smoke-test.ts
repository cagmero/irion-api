/**
 * Wallet Creation Smoke Test — 2d.4
 *
 * Provisions a fresh institution, creates a wallet, verifies the Algorand address,
 * and confirms the wallet persists in DB and surfaces correctly in GET /accounts/:id.
 *
 * Run: tsx --env-file=.env.local src/scripts/wallet-creation-smoke-test.ts
 */

import crypto from "crypto";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;

if (!ADMIN_KEY) {
  console.error("ADMIN_API_KEY not set in .env.local");
  process.exit(1);
}

function hmacSign(secret: Buffer, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function post(
  path: string,
  payload: object,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const bodyStr = JSON.stringify(payload);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: bodyStr,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function get(
  path: string,
  token: string
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function run() {
  console.log("=== Wallet Creation Smoke Test ===\n");

  // ── Step 1: POST /v1/accounts ─────────────────────────────────────────────
  console.log("Step 1: POST /v1/accounts — provision new institution");
  const institutionName = `Smoke Test Bank ${Date.now()}`;
  const { status: s1, body: acct } = await post(
    "/v1/accounts",
    { name: institutionName },
    { "X-Admin-Key": ADMIN_KEY }
  );
  console.log(`  Status: ${s1}`);
  console.log(`  id: ${acct.id}`);
  console.log(`  turnkeySubOrgId: ${acct.turnkeySubOrgId}`);
  assert(s1 === 201, "POST /v1/accounts returns 201");
  assert(!!acct.id, "Response contains institution id");
  assert(!!acct.client_id, "Response contains client_id");
  assert(!!acct.client_secret, "Response contains client_secret");
  assert(!!acct.turnkeySubOrgId, "Response contains turnkeySubOrgId");
  console.log();

  // ── Step 2: POST /v1/auth/token ───────────────────────────────────────────
  console.log("Step 2: POST /v1/auth/token — authenticate with new credentials");
  const { status: s2, body: tokenRes } = await post(
    "/v1/auth/token",
    { client_id: acct.client_id, client_secret: acct.client_secret }
  );
  console.log(`  Status: ${s2}`);
  assert(s2 === 200, "POST /v1/auth/token returns 200");
  const jwt = tokenRes.access_token as string;
  assert(!!jwt, "Response contains access_token");
  // Decode payload to verify sub claim
  const jwtPayload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  assert(jwtPayload.sub === acct.id, `JWT.sub === institution id (${acct.id})`);
  assert(jwtPayload.iss === "irion-api", "JWT.iss = irion-api");
  console.log();

  // ── Step 3: POST /v1/accounts/:id/wallets ────────────────────────────────
  console.log("Step 3: POST /v1/accounts/:id/wallets — create Turnkey wallet");
  assert(!!acct.hmac_secret, "POST /v1/accounts response contains hmac_secret");
  const walletPayload = { label: "Primary Treasury Wallet" };
  const walletBodyStr = JSON.stringify(walletPayload);
  // Use hmac_secret from the provisioning response to sign the wallet creation request.
  // This is the one-time exposure of the plaintext HMAC key for the institution.
  const hmacSecret = Buffer.from(acct.hmac_secret as string, "hex");
  const irionSig = crypto.createHmac("sha256", hmacSecret).update(walletBodyStr).digest("hex");

  const { status: s3, body: wallet } = await fetch(`${BASE}/v1/accounts/${acct.id}/wallets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "Irion-Signature": irionSig,
    },
    body: walletBodyStr,
  }).then(async r => ({ status: r.status, body: await r.json() }));

  console.log(`  Status: ${s3}`);
  console.log(`  walletId: ${wallet.walletId}`);
  console.log(`  algorandAddress: ${wallet.algorandAddress}`);
  console.log(`  isPrimary: ${wallet.isPrimary}`);
  assert(s3 === 201, "POST /v1/accounts/:id/wallets returns 201");
  assert(!!wallet.walletId, "Response contains walletId");
  assert(!!wallet.algorandAddress, "Response contains algorandAddress");
  assert(wallet.isPrimary === true, "isPrimary is true");
  assert(wallet.algorandAddress.length === 58, `Algorand address is 58 chars (got ${wallet.algorandAddress.length})`);
  assert(!wallet.turnkeyWalletId, "Response does NOT expose turnkeyWalletId");
  assert(!wallet.address, "Response does NOT expose 64-char hex address");
  console.log();

  // Validate Algorand address format (Base32 + checksum)
  const algosdk = await import("algosdk");
  assert(
    algosdk.default.isValidAddress(wallet.algorandAddress),
    `algosdk.isValidAddress("${wallet.algorandAddress}") === true`
  );
  console.log();

  // ── Step 4: GET /v1/accounts/:id — confirm primaryWallet populated ────────
  console.log("Step 4: GET /v1/accounts/:id — confirm wallet surfaces in profile");
  const { status: s4, body: profile } = await get(`/v1/accounts/${acct.id}`, jwt);
  console.log(`  Status: ${s4}`);
  console.log(`  profile.primaryWallet.algorandAddress: ${profile.primaryWallet?.algorandAddress}`);
  assert(s4 === 200, "GET /v1/accounts/:id returns 200");
  assert(!!profile.primaryWallet, "primaryWallet is not null");
  assert(
    profile.primaryWallet.algorandAddress === wallet.algorandAddress,
    "GET /:id primaryWallet.algorandAddress matches POST /wallets response"
  );
  console.log();

  // ── Step 5: POST /v1/accounts/:id/wallets again → 409 WALLET_ALREADY_EXISTS
  console.log("Step 5: POST /v1/accounts/:id/wallets again → 409 (idempotency guard)");
  const { status: s5, body: dupRes } = await fetch(`${BASE}/v1/accounts/${acct.id}/wallets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "Irion-Signature": irionSig,
    },
    body: walletBodyStr,
  }).then(async r => ({ status: r.status, body: await r.json() }));
  console.log(`  Status: ${s5}`);
  // Live server uses RFC 7807 error format (type URI contains error code)
  const errorType: string = dupRes.type ?? "";
  console.log(`  type: ${errorType}`);
  assert(s5 === 409, "Second POST /wallets returns 409");
  assert(
    errorType.includes("wallet_already_exists"),
    `Error type contains wallet_already_exists (got: ${errorType})`
  );
  console.log();

  console.log("=== Smoke test PASSED ===");
  console.log(`Institution: ${acct.id}`);
  console.log(`Algorand address: ${wallet.algorandAddress}`);
}

run().catch((err) => {
  console.error("Smoke test FAILED:", err);
  process.exit(1);
});
