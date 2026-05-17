/**
 * Turnkey smoke test - verifies API shapes before production implementation
 * Run with: npx tsx src/scripts/turnkey-smoke-test.ts
 */
import "dotenv/config";
import { TurnkeyServerClient } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import algosdk from "algosdk";

const TURNKEY_ORG_ID = process.env.TURNKEY_ORG_ID!;
const TURNKEY_API_BASE_URL = process.env.TURNKEY_API_BASE_URL!;
const TURNKEY_API_PUBLIC_KEY = process.env.TURNKEY_API_PUBLIC_KEY!;
const TURNKEY_API_PRIVATE_KEY = process.env.TURNKEY_API_PRIVATE_KEY!;

if (!TURNKEY_ORG_ID || !TURNKEY_API_PUBLIC_KEY || !TURNKEY_API_PRIVATE_KEY) {
  console.error("Missing required Turnkey credentials in .env.local");
  process.exit(1);
}

(async () => {
  const stamper = new ApiKeyStamper({
    apiPublicKey: TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: TURNKEY_API_PRIVATE_KEY,
  });

  const turnkey = new TurnkeyServerClient({
    apiBaseUrl: TURNKEY_API_BASE_URL,
    organizationId: TURNKEY_ORG_ID,
    stamper: stamper,
  });

  console.log("🔑 Initialized Turnkey client with @turnkey/sdk-server\n");

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Create Wallet
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("📋 Step 1: Creating wallet...");
  
  const createWalletResponse = await turnkey.createWallet({
    organizationId: TURNKEY_ORG_ID,
    walletName: `Test Wallet - ${Date.now()}`,
    accounts: [
      {
        curve: "CURVE_ED25519",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/283'/0'/0/0",
        addressFormat: "ADDRESS_FORMAT_COMPRESSED",
      },
    ],
  });

  const walletId = createWalletResponse.walletId;
  const turnkeyAccountAddress = createWalletResponse.addresses?.[0] || ""; // 64-char hex
  
  console.log(`✅ Wallet created: ${walletId}`);
  console.log(`   → Full createWallet response:`, JSON.stringify(createWalletResponse, null, 2));
  console.log(`   → turnkeyAccountAddress (64-char hex): ${turnkeyAccountAddress}`);

  if (!walletId || !turnkeyAccountAddress) {
    throw new Error("Missing walletId or address");
  }

  // Derive Algorand address from the Ed25519 public key
  const pubKeyBytes = Buffer.from(turnkeyAccountAddress, "hex");
  const algorandAddress = algosdk.encodeAddress(pubKeyBytes);
  console.log(`   → algorandAddress (58-char Base32): ${algorandAddress}`);

  // Verify address derivation
  const isValid = algosdk.isValidAddress(algorandAddress);
  console.log(`   → algosdk.isValidAddress(): ${isValid}`);
  
  // Verify round-trip
  const decoded = algosdk.decodeAddress(algorandAddress);
  const recoveredKey = Buffer.from(decoded.publicKey).toString("hex");
  console.log(`   → Round-trip check (encode → decode): ${recoveredKey === turnkeyAccountAddress ? "PASS ✓" : "FAIL ✗"}\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Sign Raw Payload
  // ─────────────────────────────────────────────────────────────────────────────
  const payload = Buffer.from("test-payload-12345678901234567890");
  const payloadHex = payload.toString("hex");
  
  console.log(`📋 Step 2: Signing payload...`);
  console.log(`   → Payload (hex): ${payloadHex}`);
  
  // CRITICAL: signWith must be the exact 64-char lowercase hex from addresses[0]
  const signWithAddress = turnkeyAccountAddress.toLowerCase();
  console.log(`   → signWith parameter: ${signWithAddress}`);
  
  const signResponse = await turnkey.signRawPayload({
    organizationId: TURNKEY_ORG_ID,
    signWith: signWithAddress,
    payload: payloadHex,
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
  });

  // Extract r, s, v components and combine into 64-byte signature
  const rBytes = Buffer.from(signResponse.r, "hex");
  const sBytes = Buffer.from(signResponse.s, "hex");
  const signatureBytes = Buffer.concat([rBytes, sBytes]);
  
  console.log(`   → Signature r: ${signResponse.r.slice(0, 20)}...`);
  console.log(`   → Signature s: ${signResponse.s.slice(0, 20)}...`);
  console.log(`   → Combined signature: ${signatureBytes.length} bytes (expected 64)\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 3: Verify Signature using nacl.sign.detached.verify
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("📋 Step 3: Verifying signature with nacl.sign.detached.verify...");
  
  // nacl.sign.detached.verify expects: message Uint8Array, signature Uint8Array, publicKey Uint8Array
  const nacl = require("tweetnacl");
  
  // Convert Buffer to Uint8Array (Buffer is compatible but TypeScript may complain)
  const messageUint8 = new Uint8Array(payload);
  const signatureUint8 = new Uint8Array(signatureBytes);
  const pubKeyUint8 = new Uint8Array(pubKeyBytes);
  
  console.log(`   → message bytes: ${messageUint8.length}`);
  console.log(`   → signature bytes: ${signatureUint8.length}`);
  console.log(`   → publicKey bytes: ${pubKeyUint8.length}`);
  
  const verified = nacl.sign.detached.verify(messageUint8, signatureUint8, pubKeyUint8);
  
  console.log(`   → nacl.sign.detached.verify: ${verified ? "PASS ✓" : "FAIL ✗"}`);
  
  if (!verified) {
    throw new Error("Signature verification failed!");
  }
  console.log();
  
  // Show the raw signature bytes for verification
  console.log("📋 Step 4: Signature bytes:");
  console.log(`   → ${signatureBytes.slice(0, 16).toString("hex")}... (first 16 bytes)`);
  console.log(`   → ${signatureBytes.slice(16, 32).toString("hex")}... (bytes 16-32)`);
  console.log(`   → ${signatureBytes.slice(32, 48).toString("hex")}... (bytes 32-48)`);
  console.log(`   → ${signatureBytes.slice(48, 64).toString("hex")}... (last 16 bytes)`);
  console.log(`   → Total: ${signatureBytes.length} bytes\n`);

  console.log("✅ All steps completed successfully!");
  console.log("\n📊 Summary:");
  console.log(`   • SDK: @turnkey/sdk-server v6.0.0`);
  console.log(`   • walletId: ${walletId}`);
  console.log(`   • turnkeyAccountAddress (64-char hex): ${turnkeyAccountAddress}`);
  console.log(`   • algorandAddress (58-char Base32): ${algorandAddress}`);
  console.log(`   • Signature: ${signatureBytes.length} bytes`);
})();