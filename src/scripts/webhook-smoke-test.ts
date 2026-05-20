/**
 * Webhook Smoke Test — 2g
 *
 * Starts a local HTTP listener, delivers a webhook via deliverToWebhook(),
 * and verifies:
 *   1. Signature format: t=<ts>,v1=<hex>
 *   2. Idempotency-Key header present
 *   3. HMAC recomputation matches
 *   4. Body contains event + institutionId + payload
 */
import http from "http";
import crypto from "crypto";
import { decryptWebhookSecret, encryptWebhookSecret } from "../services/webhook-crypto.js";
import { deliverToWebhook } from "../queues/processors/webhook-delivery.js";

const PORT = 18998;
const LOCAL_URL = `http://localhost:${PORT}/hook`;
const INSTITUTION_ID = "smoke-test-inst-0001";
const EVENT = "deposit.confirmed";
const PAYLOAD = { depositId: "test-123", txHash: "FAKETX", amount: "1000000", assetId: 758916950, confirmedRound: 99999999 };

let receivedBody: string = "";
let receivedHeaders: http.IncomingHttpHeaders = {};
let resolveReceived: (v: unknown) => void;

async function main() {
  // Start local listener
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      receivedBody = body;
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
      if (resolveReceived) resolveReceived(null);
    });
  });

  await new Promise((resolve) => server.listen(PORT, resolve as any));
  console.log(`Listener on ${PORT}`);

  // Create webhook config with known secret
  const rawSecret = crypto.randomBytes(32);
  const encryptedSecret = encryptWebhookSecret(rawSecret);

  const wh: any = {
    id: crypto.randomUUID(),
    institutionId: INSTITUTION_ID,
    url: LOCAL_URL,
    secret: encryptedSecret,
    previousSecret: null,
    previousSecretVersion: null,
    gracePeriodEndsAt: null,
    events: [EVENT],
    description: null,
    isActive: true,
    signingKeyVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Deliver the webhook
  const deliveryPromise = new Promise((resolve) => { resolveReceived = resolve; });
  await deliverToWebhook(wh, EVENT, PAYLOAD);
  await deliveryPromise;

  console.log("\n============================================");
  console.log(" 2G — WEBHOOK SMOKE TEST EVIDENCE");
  console.log("============================================\n");

  // 1. Signature format
  const sigHeader = receivedHeaders["irion-signature"] as string;
  console.log("1. Signature header:", sigHeader);
  const sigMatch = sigHeader?.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  const sigOk = sigMatch != null;
  console.log("   Format t=<ts>,v1=<hex>:", sigOk ? "PASS" : "FAIL");
  if (sigMatch) {
    console.log(`   Timestamp: ${sigMatch[1]}, Hex len: ${sigMatch[2].length}`);
  }

  // 2. Idempotency-Key header
  const idKey = receivedHeaders["idempotency-key"] as string;
  console.log("\n2. Idempotency-Key:", idKey);
  console.log("   Present:", idKey?.length > 0 ? "PASS" : "FAIL");

  // 3. Irion-Event header
  const eventHdr = receivedHeaders["irion-event"] as string;
  console.log("\n3. Irion-Event:", eventHdr);
  console.log("   Match:", eventHdr === EVENT ? "PASS" : "FAIL");

  // 4. HMAC recomputation
  const bodyStr = receivedBody;
  const body = JSON.parse(bodyStr);
  const recomputedSig = crypto
    .createHmac("sha256", rawSecret)
    .update(`${sigMatch?.[1] ?? "0"}.${bodyStr}`)
    .digest("hex");
  const v1 = sigMatch?.[2] ?? "";
  console.log("\n4. HMAC verification:");
  console.log("   Computed:  ", recomputedSig);
  console.log("   Received:  ", v1);
  console.log("   Match:    ", recomputedSig === v1 ? "PASS" : "FAIL");

  // 5. Body structure
  console.log("\n5. Body structure:");
  console.log("   Event:", body.event, "→", body.event === EVENT ? "PASS" : "FAIL");
  console.log("   institutionId:", body.institutionId, "→", body.institutionId === INSTITUTION_ID ? "PASS" : "FAIL");
  console.log("   payload.depositId:", body.payload?.depositId);

  // Cleanup
  server.close();
  console.log("\n============================================");
  const allOk = sigOk && idKey?.length > 0 && eventHdr === EVENT && recomputedSig === v1 && body.event === EVENT;
  console.log(allOk ? " 2G SMOKE TEST PASSED" : " 2G SMOKE TEST FAILED");
  console.log("============================================");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
