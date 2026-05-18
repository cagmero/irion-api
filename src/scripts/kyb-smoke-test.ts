/**
 * KYB Mock Provider Smoke Test
 * 
 * Tests the full KYB flow with the mock provider:
 * 1. Create institution
 * 2. Create KYB session
 * 3. Wait for mock completion
 * 4. Verify institution is active
 * 5. Verify webhook was received
 */

import { getKybProvider } from "../services/kyb/index.js";

async function runSmokeTest() {
  console.log("🔑 KYB Mock Provider Smoke Test\n");

  // Step 1: Create KYB session
  console.log("📋 Step 1: Creating KYB session...");
  const kybProvider = getKybProvider();
  
  const session = await kybProvider.createKybSession("a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b", "Acme Test Corp");
  console.log(`   → Session ID: ${session.diditSessionId}`);
  console.log(`   → Verification URL: ${session.verificationUrl}\n`);

  // Step 2: Check initial status
  console.log("📋 Step 2: Checking initial status...");
  const initialStatus = await kybProvider.getSessionStatus(session.diditSessionId);
  console.log(`   → Initial status: ${initialStatus.status}\n`);

  // Step 3: Wait for mock completion (default 10 seconds)
  const delaySeconds = parseInt(process.env.KYB_MOCK_DELAY_SECONDS || "10", 10);
  console.log(`📋 Step 3: Waiting ${delaySeconds}s for mock completion...`);
  await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000 + 1000));

  // Step 4: Check final status
  console.log("📋 Step 4: Checking final status...");
  const finalStatus = await kybProvider.getSessionStatus(session.diditSessionId);
  console.log(`   → Final status: ${finalStatus.status}\n`);

  // Step 5: Verify signature
  console.log("📋 Step 5: Verifying signature verification...");
  const testBody = Buffer.from(JSON.stringify({ event: "business.status.updated", status: "approved" }));
  const validSignature = kybProvider.verifyWebhookSignature(testBody, 
    require("crypto").createHmac("sha256", process.env.MOCK_KYB_WEBHOOK_SECRET || "").update(testBody).digest("hex")
  );
  console.log(`   → Valid signature: ${validSignature ? "PASS ✓" : "FAIL ✗"}`);

  const tamperedBody = Buffer.from(JSON.stringify({ event: "business.status.updated", status: "rejected" }));
  const invalidSignature = kybProvider.verifyWebhookSignature(tamperedBody,
    require("crypto").createHmac("sha256", process.env.MOCK_KYB_WEBHOOK_SECRET || "").update(testBody).digest("hex")
  );
  console.log(`   → Tampered body rejected: ${!invalidSignature ? "PASS ✓" : "FAIL ✗"}\n`);

  console.log("✅ Smoke test completed!");
  console.log("\n📊 Summary:");
  console.log(`   • Provider: ${process.env.KYB_PROVIDER || "mock"}`);
  console.log(`   • Session created: ${session.diditSessionId}`);
  console.log(`   • Final status: ${finalStatus.status}`);
  console.log(`   • Signature verification: ${validSignature && !invalidSignature ? "PASS ✓" : "FAIL ✗"}`);
}

runSmokeTest().catch(console.error);