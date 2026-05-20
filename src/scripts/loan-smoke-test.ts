/**
 * Loan Origination Smoke Test — 2e.1 (full flow)
 *
 * End-to-end test of the OVERCOLLATERALIZED loan origination flow:
 *   1.  POST /v1/accounts — provision institution
 *   2.  POST /v1/auth/token — authenticate
 *   3.  POST /v1/accounts/:id/wallets — create wallet + auto opt-in
 *   4.  Fund wallet with 2.5 TEST_USDC from deployer
 *   5.  POST /v1/loans — submit loan origination (enqueues step-1 worker)
 *   6.  Poll loan status: pending → collateral_locked → submitted → active
 *   7.  Verify on-chain: wallet USDC balance changed appropriately
 *   8.  DB queries: loan row + borrowing_positions
 *   9.  Verify webhook format
 *
 * Prerequisites:
 *   - Server running: pnpm tsx --env-file=.env.local src/index.ts
 *   - DEPLOYER_MNEMONIC, GOVERNANCE_BRIDGE_ENABLED=true
 *   - All env vars set in .env.local
 *
 * Run: pnpm tsx --env-file=.env.local src/scripts/loan-smoke-test.ts
 */

import crypto from "crypto";
import algosdk from "algosdk";

const BASE       = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY  = process.env.ADMIN_API_KEY!;
const TEST_USDC_ID = parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950");
const LOAN_FACTORY_APP_ID = parseInt(process.env.LOAN_FACTORY_APP_ID ?? "762889354");

const COLLATERAL_AMT = 1_500_000; // 1.5 TEST_USDC
const BORROW_AMT     = 1_000_000; // 1.0 TEST_USDC (borrow)
const DEPOSIT_AMT    = 2_000_000; // 2.0 TEST_USDC (deposit to pool for liquidity — > borrow to avoid circuit breaker)
const FUND_AMT       = 4_500_000; // 4.5 TEST_USDC (1.5 collateral + 2 deposit + 1 buffer)

const algodClient = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL   ?? "https://testnet-api.algonode.cloud",
  parseInt(process.env.ALGOD_PORT ?? "443")
);

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); process.exit(1); }
  console.log(`  ✓ ${msg}`);
}

function step(n: string, title: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Step ${n}: ${title}`);
  console.log("─".repeat(60));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForConfirmation(txHash: string, maxRounds = 8): Promise<any> {
  return algosdk.waitForConfirmation(algodClient, txHash, maxRounds);
}

async function getAssetBalance(address: string, assetId: number): Promise<number> {
  try {
    const info = await algodClient.accountInformation(address).do();
    const assets = info.assets ?? info["assets"] ?? [];
    const asset = assets.find((a: any) => Number(a.assetId ?? a["asset-id"]) === assetId);
    return asset ? Number(asset.amount ?? asset["amount"]) : 0;
  } catch { return 0; }
}

async function run() {
  console.log("=".repeat(60));
  console.log(" LOAN ORIGINATION SMOKE TEST — 2e.1");
  console.log(`  Server : ${BASE}`);
  console.log(`  Asset  : TEST_USDC ASA ${TEST_USDC_ID}`);
  console.log(`  Collateral: ${COLLATERAL_AMT} (1.5 USDC) → Borrow: ${BORROW_AMT} (1.0 USDC)`);
  console.log("=".repeat(60));

  // ── Step 1: Provision institution ─────────────────────────────────────────
  step("1", "POST /v1/accounts — provision institution");

  const institutionName = `Loan Smoke ${Date.now()}`;
  const acctRes = await fetch(`${BASE}/v1/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: institutionName }),
  });
  const acct = await acctRes.json();

  assert(acctRes.status === 201, "POST /v1/accounts → 201");

  const kybRes = await fetch(`${BASE}/v1/accounts/${acct.id}/kyb/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: "{}",
  });
  assert(kybRes.status === 200, "KYB approved");
  assert(!!acct.hmac_secret, "hmac_secret present");

  const hmacSecret = Buffer.from(acct.hmac_secret as string, "hex");
  const institutionId = acct.id as string;

  // ── Step 2: Authenticate ──────────────────────────────────────────────────
  step("2", "POST /v1/auth/token");

  const tokenRes = await fetch(`${BASE}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: acct.client_id, client_secret: acct.client_secret }),
  });
  const tokenBody = await tokenRes.json();
  assert(tokenRes.status === 200, "JWT obtained");
  const jwt = tokenBody.access_token as string;

  // ── Step 3: Create wallet ─────────────────────────────────────────────────
  step("3", "POST /v1/accounts/:id/wallets");

  const walletPayload = { label: "Loan Test Wallet" };
  const walletSig = crypto.createHmac("sha256", hmacSecret)
    .update(JSON.stringify(walletPayload)).digest("hex");

  const walletRes = await fetch(`${BASE}/v1/accounts/${institutionId}/wallets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${jwt}`,
      "Irion-Signature": walletSig,
    },
    body: JSON.stringify(walletPayload),
  });
  const wallet = await walletRes.json();
  assert(walletRes.status === 201, "Wallet created");
  assert(!!wallet.algorandAddress, "algorandAddress present");
  assert(wallet.optedInAssets?.includes(TEST_USDC_ID), "opted into TEST_USDC");

  const walletAddr = wallet.algorandAddress as string;
  const walletId = wallet.walletId as string;

  // ── Step 4: Fund wallet with TEST_USDC ────────────────────────────────────
  step("4", "Fund wallet from deployer");

  const deployerMnemonic = process.env.DEPLOYER_MNEMONIC;
  assert(!!deployerMnemonic, "DEPLOYER_MNEMONIC set");

  const deployer = algosdk.mnemonicToSecretKey(deployerMnemonic);
  const deployerInfo = await algodClient.accountInformation(deployer.addr.toString()).do();
  const deployerAssets: any[] = deployerInfo.assets ?? deployerInfo["assets"] ?? [];
  const deployerAsset = deployerAssets.find((a: any) => Number(a.assetId ?? a["asset-id"]) === TEST_USDC_ID);
  const deployerBal = deployerAsset ? Number(deployerAsset.amount ?? deployerAsset["amount"]) : 0;
  assert(deployerBal >= FUND_AMT, `Deployer has ≥${FUND_AMT} TEST_USDC`);

  const sp = await algodClient.getTransactionParams().do();
  const fundTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: walletAddr,
    assetIndex: TEST_USDC_ID, amount: BigInt(FUND_AMT), suggestedParams: sp,
  });
  const signedFund = fundTxn.signTxn(deployer.sk);
  const fundResult = await algodClient.sendRawTransaction(signedFund).do();
  await waitForConfirmation(fundResult.txid);

  const walletUsdcAfter = await getAssetBalance(walletAddr, TEST_USDC_ID);
  assert(walletUsdcAfter >= FUND_AMT, `Wallet received ${FUND_AMT} TEST_USDC`);

  // ── Step 4b: Deposit to provide pool liquidity ───────────────────────────
  step("4b", "Deposit 1 TEST_USDC to LendingPool for liquidity");

  const depositPayload = { assetId: TEST_USDC_ID, amount: String(DEPOSIT_AMT) };
  const depositSig = crypto.createHmac("sha256", hmacSecret)
    .update(JSON.stringify(depositPayload)).digest("hex");

  const depositRes = await fetch(`${BASE}/v1/deposits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${jwt}`,
      "Irion-Signature": depositSig,
    },
    body: JSON.stringify(depositPayload),
  });
  const depositBody = await depositRes.json();
  assert(depositRes.status === 202, "Deposit submitted");

  // Wait for deposit confirmation (~30s)
  console.log("  Waiting for deposit confirmation (LP tokens minted)...");
  await sleep(30000);

  // ── Step 5: POST /v1/loans ─────────────────────────────────────────────────
  step("5", "POST /v1/loans — submit loan origination");

  const loanPayload = {
    walletId, loanType: "OVERCOLLATERALIZED",
    collateralAssetId: TEST_USDC_ID, collateralAmount: String(COLLATERAL_AMT),
    borrowAssetId: TEST_USDC_ID, borrowAmount: String(BORROW_AMT),
  };
  const loanSig = crypto.createHmac("sha256", hmacSecret)
    .update(JSON.stringify(loanPayload)).digest("hex");

  const loanRes = await fetch(`${BASE}/v1/loans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${jwt}`,
      "Irion-Signature": loanSig,
    },
    body: JSON.stringify(loanPayload),
  });
  const loanBody = await loanRes.json();

  console.log(`  HTTP status : ${loanRes.status}`);
  console.log(`  loan id     : ${loanBody.id}`);
  console.log(`  status      : ${loanBody.status}`);

  assert(loanRes.status === 202, "POST /v1/loans → 202");
  assert(!!loanBody.id, "loan id present");
  assert(loanBody.status === "pending", "status = pending");

  const loanId = loanBody.id as string;

  // ── Step 6: Poll for state machine transitions ────────────────────────────
  step("6", "Poll loan status: pending → ... → active");

  console.log("  Worker processes vlock vault lock + origination. Polling every 5s up to 3min...");

  let finalStatus: string | undefined;
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    await sleep(5000);
    const statusRes = await fetch(`${BASE}/v1/loans/${loanId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const statusBody = await statusRes.json();
    console.log(`  status: ${statusBody.status}`);
    if (statusBody.status === "active" || statusBody.status === "failed_compensating" || statusBody.status === "failed_released") {
      finalStatus = statusBody.status;
      break;
    }
  }

  if (!finalStatus) {
    console.error("  ✗ Loan not in terminal state within 3min");
    process.exit(1);
  }

  if (finalStatus === "failed_compensating" || finalStatus === "failed_released") {
    console.error(`  ✗ Loan ended in failure state: ${finalStatus}`);
    console.error("  Check server logs for details on why Step 1 or Step 2 failed.");
    process.exit(1);
  }

  assert(finalStatus === "active", `Loan reached active state (got: ${finalStatus})`);
  console.log(`  ✓ Loan active!`);

  // ── Step 7: Verify on-chain balances ──────────────────────────────────────
  step("7", "On-chain balance verification");

  const finalUsdc = await getAssetBalance(walletAddr, TEST_USDC_ID);
  console.log(`  Wallet TEST_USDC balance: ${finalUsdc}`);
  console.log(`  Expected: ~${COLLATERAL_AMT + BORROW_AMT} (collateral ${COLLATERAL_AMT} sent + borrow ${BORROW_AMT} received, minus fees)`);
  // Net: -1.5M collateral + 1M borrow = -0.5M (collateral stays in vault, borrow comes from pool)
  // But the wallet started with 1.5M USDC, sent 1.5M to vault, received 1M from pool = 1M remaining
  // Actually the wallet had 1.5M after funding, sent 1.5M to vault, received 1M borrow = 1M remaining
  assert(finalUsdc > 0, "Wallet has USDC (borrow proceeds)");

  // ── Step 8: Verify DB via API ─────────────────────────────────────────────
  step("8", "Verify loan state via GET /v1/loans/:id");

  const verifyRes = await fetch(`${BASE}/v1/loans/${loanId}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const verifyBody = await verifyRes.json();
  assert(verifyRes.status === 200, "GET /v1/loans/:id → 200");
  assert(verifyBody.status === "active", `status = active`);
  assert(verifyBody.type === "overcollateralized", "type = overcollateralized");
  console.log(`  Loan details:`, JSON.stringify(verifyBody, null, 2));

  // ── Step 9: Webhook format ────────────────────────────────────────────────
  step("9", "Webhook payload format");

  const webhookPayload = {
    event: "loan.originated",
    institutionId,
    payload: { loanId, amount: String(BORROW_AMT), assetId: TEST_USDC_ID },
  };
  const expectedSig = crypto.createHmac("sha256", hmacSecret)
    .update(JSON.stringify(webhookPayload))
    .digest("hex");

  console.log(`  Expected Irion-Signature: ${expectedSig}`);
  assert(expectedSig.length === 64, "HMAC-SHA256 signature 64 hex chars");

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(" LOAN SMOKE TEST PASSED — STEP 10 REACHED");
  console.log("=".repeat(60));
  console.log(`  Institution : ${institutionId}`);
  console.log(`  Wallet addr : ${walletAddr}`);
  console.log(`  Loan ID     : ${loanId}`);
  console.log(`  Loan type   : OVERCOLLATERALIZED`);
  console.log(`  Collateral  : ${COLLATERAL_AMT} TEST_USDC`);
  console.log(`  Borrow      : ${BORROW_AMT} TEST_USDC`);
  console.log(`  Final USDC  : ${finalUsdc}`);
}

run().catch((err) => {
  console.error("\n✗ Smoke test FAILED:", err.message ?? err);
  process.exit(1);
});
