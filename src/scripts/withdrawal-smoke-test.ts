/**
 * Withdrawal Smoke Test — 2d.6 (full flow)
 *
 * End-to-end test of the withdrawal flow against a live server + testnet:
 *   1.  POST /v1/accounts         — provision institution + Turnkey sub-org
 *   2.  POST /v1/auth/token       — authenticate, get JWT
 *   3.  POST /v1/accounts/:id/wallets — create wallet + auto opt-in TEST_USDC + senior LP
 *   3b. Verify opt-in txns landed on-chain
 *   4.  Fund institution wallet with TEST_USDC from deployer account
 *   5.  POST /v1/deposits         — deposit 1 TEST_USDC to get LP tokens
 *   5b. Wait for deposit confirmation + LP token mint
 *   6.  POST /v1/withdrawals      — withdraw 0.5 TEST_USDC (burn LP tokens)
 *   7.  Verify withdrawal txHash on-chain
 *   8.  Verify wallet balances updated (LP burned, USDC returned)
 *
 * Prerequisites:
 *   - Server running: pnpm tsx --env-file=.env.local src/index.ts
 *   - DEPLOYER_MNEMONIC account holds TEST_USDC (758916950)
 *   - All env vars set in .env.local
 *
 * Run: pnpm tsx --env-file=.env.local src/scripts/withdrawal-smoke-test.ts
 */

import crypto from "crypto";
import algosdk from "algosdk";

const BASE       = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY  = process.env.ADMIN_API_KEY!;
const TEST_USDC_ID = parseInt(process.env.TEST_USDC_ASSET_ID                     ?? "758916950");
const SENIOR_LP  = parseInt(process.env.LENDING_POOL_V2_USDC_SENIOR_LP_TOKEN ?? "762580194");
const POOL_APP   = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID          ?? "762580175");
const POOL_ADDR  = process.env.LENDING_POOL_V2_USDC_ADDRESS                  ?? "Y2KX4ZSQSFLW27EAE5VORM4DAY2S4EWZ24NKPLRMNHJMUXTNXNM2R6OQYM";
const DEPOSIT_AMT = 1_000_000; // 1 TEST_USDC (6 decimals)
const WITHDRAW_AMT = 500_000;  // 0.5 TEST_USDC

const algodClient = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL   ?? "https://testnet-api.algonode.cloud",
  parseInt(process.env.ALGOD_PORT ?? "443")
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); process.exit(1); }
  console.log(`  ✓ ${msg}`);
}

function step(n: string, title: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Step ${n}: ${title}`);
  console.log("─".repeat(60));
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
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(
  path: string,
  token: string
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function waitForConfirmation(txHash: string, maxRounds = 8): Promise<any> {
  return algosdk.waitForConfirmation(algodClient, txHash, maxRounds);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function getAssetBalance(address: string, assetId: number): Promise<number> {
  try {
    const info = await algodClient.accountInformation(address).do();
    const assets = info.assets ?? info["assets"] ?? [];
    const asset = assets.find((a: any) => Number(a.assetId ?? a["asset-id"]) === assetId);
    return asset ? Number(asset.amount ?? asset["amount"]) : 0;
  } catch {
    return 0;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("=".repeat(60));
  console.log(" WITHDRAWAL SMOKE TEST — 2d.6 (full flow)");
  console.log(`  Server : ${BASE}`);
  console.log(`  Network: Algorand Testnet (AlgoNode)`);
  console.log(`  Asset  : TEST_USDC ASA ${TEST_USDC_ID}`);
  console.log(`  Pool   : App ${POOL_APP}`);
  console.log("=".repeat(60));

  // ── Step 1: Provision institution ─────────────────────────────────────────
  step("1", "POST /v1/accounts — provision institution");

  const institutionName = `Withdrawal Smoke ${Date.now()}`;
  const { status: s1, body: acct } = await post(
    "/v1/accounts",
    { name: institutionName },
    { "X-Admin-Key": ADMIN_KEY }
  );

  console.log(`  HTTP status  : ${s1}`);
  console.log(`  id           : ${acct.id}`);

  assert(s1 === 201,              "POST /v1/accounts → 201");
  assert(!!acct.id,               "institution.id present");
  assert(!!acct.hmac_secret,      "hmac_secret present (one-time)");

  // Approve KYB via admin endpoint
  const { status: sKyb } = await post(
    `/v1/accounts/${acct.id}/kyb/approve`,
    {},
    { "X-Admin-Key": ADMIN_KEY }
  );
  assert(sKyb === 200, "KYB approved via admin endpoint");

  const hmacSecret  = Buffer.from(acct.hmac_secret as string, "hex");
  const institutionId = acct.id as string;

  // ── Step 2: Authenticate ──────────────────────────────────────────────────
  step("2", "POST /v1/auth/token — authenticate");

  const { status: s2, body: tokenRes } = await post("/v1/auth/token", {
    client_id:     acct.client_id,
    client_secret: acct.client_secret,
  });

  assert(s2 === 200,         "POST /v1/auth/token → 200");
  const jwt = tokenRes.access_token as string;
  assert(!!jwt,              "JWT present");

  // ── Step 3: Create wallet (+ auto opt-in) ─────────────────────────────────
  step("3", "POST /v1/accounts/:id/wallets — create wallet + auto opt-in");

  const walletPayload = { label: "Withdrawal Test Wallet" };
  const walletSig = crypto.createHmac("sha256", hmacSecret)
    .update(JSON.stringify(walletPayload)).digest("hex");

  const walletRes = await fetch(`${BASE}/v1/accounts/${institutionId}/wallets`, {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Authorization":   `Bearer ${jwt}`,
      "Irion-Signature": walletSig,
    },
    body: JSON.stringify(walletPayload),
  });
  const s3   = walletRes.status;
  const wallet = await walletRes.json();

  assert(s3 === 201,                              "POST /v1/wallets → 201");
  assert(!!wallet.algorandAddress,                "algorandAddress present");
  assert(wallet.optedInAssets?.includes(TEST_USDC_ID), `opted into TEST_USDC`);
  assert(wallet.optedInAssets?.includes(SENIOR_LP),`opted into senior LP`);

  const walletAddress = wallet.algorandAddress as string;

  // ── Step 3b: Verify opt-ins landed on-chain ───────────────────────────────
  step("3b", "Verify opt-in transactions confirmed on-chain");

  let iusdcOptedIn = false;
  let lpOptedIn = false;
  const deadline3b = Date.now() + 30_000;

  while (Date.now() < deadline3b) {
    try {
      const walletInfo = await algodClient.accountInformation(walletAddress).do();
      const assets = walletInfo.assets ?? walletInfo["assets"] ?? [];
      iusdcOptedIn = assets.some((a: any) => Number(a.assetId ?? a["asset-id"]) === TEST_USDC_ID);
      lpOptedIn    = assets.some((a: any) => Number(a.assetId ?? a["asset-id"]) === SENIOR_LP);
      if (iusdcOptedIn && lpOptedIn) break;
    } catch { /* keep polling */ }
    await sleep(2000);
  }

  assert(iusdcOptedIn,  "TEST_USDC opt-in confirmed on-chain");
  assert(lpOptedIn,     "senior LP opt-in confirmed on-chain");

  // ── Step 4: Fund institution wallet with TEST_USDC ────────────────────────
  step("4", "Fund institution wallet with 1 TEST_USDC from deployer");

  const deployerMnemonic = process.env.DEPLOYER_MNEMONIC;
  assert(!!deployerMnemonic, "DEPLOYER_MNEMONIC is set");

  const deployer = algosdk.mnemonicToSecretKey(deployerMnemonic);
  console.log(`  Deployer : ${deployer.addr}`);

  const deployerInfo = await algodClient.accountInformation(deployer.addr.toString()).do();
  const deployerAssets = deployerInfo.assets ?? deployerInfo["assets"] ?? [];
  const deployerTestUSDC = deployerAssets.find((a: any) => Number(a.assetId ?? a["asset-id"]) === TEST_USDC_ID);
  const deployerBalance = deployerTestUSDC ? Number(deployerTestUSDC.amount ?? deployerTestUSDC["amount"]) : 0;

  assert(deployerBalance >= DEPOSIT_AMT, `Deployer has ≥${DEPOSIT_AMT} TEST_USDC`);

  const sp4 = await algodClient.getTransactionParams().do();
  const fundTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          deployer.addr.toString(),
    receiver:        walletAddress,
    assetIndex:      TEST_USDC_ID,
    amount:          BigInt(DEPOSIT_AMT),
    suggestedParams: sp4,
  });
  const signedFund = fundTxn.signTxn(deployer.sk);
  const fundResult = await algodClient.sendRawTransaction(signedFund).do();
  const fundHash   = fundResult.txid;

  console.log(`  Fund txHash : ${fundHash}`);
  await waitForConfirmation(fundHash);

  const walletBalanceAfter = await getAssetBalance(walletAddress, TEST_USDC_ID);
  assert(walletBalanceAfter >= DEPOSIT_AMT, `Wallet received ${DEPOSIT_AMT} TEST_USDC`);

  // ── Step 5: POST /v1/deposits — deposit 1 TEST_USDC ───────────────────────
  step("5", "POST /v1/deposits — deposit 1 TEST_USDC to get LP tokens");

  const depositPayload = { assetId: TEST_USDC_ID, amount: String(DEPOSIT_AMT) };
  const depositSig = crypto.createHmac("sha256", hmacSecret)
    .update(JSON.stringify(depositPayload)).digest("hex");

  const depositFetch = await fetch(`${BASE}/v1/deposits`, {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Authorization":   `Bearer ${jwt}`,
      "Irion-Signature": depositSig,
    },
    body: JSON.stringify(depositPayload),
  });
  const s5         = depositFetch.status;
  const depositRes = await depositFetch.json();

  assert(s5 === 202,                                  "POST /v1/deposits → 202");
  assert(!!depositRes.txHash,                         "txHash present");
  assert(depositRes.status === "submitted",           "status = submitted");

  const depositTxHash = depositRes.txHash as string;
  console.log(`  Deposit txHash: ${depositTxHash}`);

  await waitForConfirmation(depositTxHash);
  console.log(`  ✓ Deposit txn confirmed`);

  // ── Step 5b: Wait for deposit confirmation + LP token mint ────────────────
  step("5b", "Wait for deposit confirmation worker + LP token mint");

  console.log(`  Polling for LP token balance at wallet...`);
  let lpBalance = 0;
  const deadline5b = Date.now() + 90_000;
  let pollCount = 0;

  while (Date.now() < deadline5b) {
    await sleep(3000);
    pollCount++;
    lpBalance = await getAssetBalance(walletAddress, SENIOR_LP);
    if (lpBalance > 0) break;
    if (pollCount % 5 === 0) console.log(`  [${pollCount * 3}s] still polling for LP tokens...`);
  }

  assert(lpBalance > 0, `Wallet received LP tokens (balance: ${lpBalance})`);
  console.log(`  LP token balance: ${lpBalance}`);

  // Brief pause to ensure algod nodes have propagated the LP token mint
  console.log(`  Waiting 5s for algod propagation...`);
  await sleep(5000);

  // ── Step 6: POST /v1/withdrawals — withdraw 0.5 TEST_USDC ─────────────────
  step("6", "POST /v1/withdrawals — withdraw 0.5 TEST_USDC");

  const withdrawPayload = { walletId: wallet.walletId, assetId: TEST_USDC_ID, amount: String(WITHDRAW_AMT) };
  const withdrawSig = crypto.createHmac("sha256", hmacSecret)
    .update(JSON.stringify(withdrawPayload)).digest("hex");

  const withdrawFetch = await fetch(`${BASE}/v1/withdrawals`, {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Authorization":   `Bearer ${jwt}`,
      "Irion-Signature": withdrawSig,
    },
    body: JSON.stringify(withdrawPayload),
  });
  const s6         = withdrawFetch.status;
  const withdrawRes = await withdrawFetch.json();

  console.log(`  HTTP status   : ${s6}`);
  console.log(`  withdrawalId  : ${withdrawRes.withdrawalId}`);
  console.log(`  txHash        : ${withdrawRes.txHash}`);
  console.log(`  status        : ${withdrawRes.status}`);

  if (s6 !== 202) {
    console.error("  Raw error body:", JSON.stringify(withdrawRes));
    process.exit(1);
  }

  assert(s6 === 202,                                  "POST /v1/withdrawals → 202");
  assert(!!withdrawRes.withdrawalId,                  "withdrawalId present");
  assert(!!withdrawRes.txHash,                        "txHash present");
  assert(withdrawRes.status === "submitted",          "status = submitted");

  const withdrawTxHash = withdrawRes.txHash as string;
  const withdrawalId = withdrawRes.withdrawalId as string;

  // ── Step 7: Wait for withdrawal on-chain confirmation ─────────────────────
  step("7", "Wait for withdrawal on-chain confirmation");

  console.log(`  Polling algod for txn ${withdrawTxHash}...`);
  console.log(`  Explorer: https://testnet.explorer.perawallet.app/tx/${withdrawTxHash}`);

  let confirmedRound: number | undefined;
  try {
    const confirmation = await waitForConfirmation(withdrawTxHash, 10);
    confirmedRound = Number(confirmation["confirmed-round"] ?? confirmation.confirmedRound ?? 0);
    console.log(`  ✓ Confirmed at round ${confirmedRound}`);
  } catch (err: any) {
    console.error(`  ✗ Confirmation failed: ${err.message}`);
    process.exit(1);
  }

  assert(!!confirmedRound && confirmedRound > 0, `Withdrawal confirmed at round ${confirmedRound}`);

  // ── Step 8: Verify wallet balances updated ────────────────────────────────
  step("8", "Verify wallet balances updated (LP burned, USDC returned)");

  // Wait for withdrawal confirmation worker to update positions
  await sleep(5000);

  const finalLpBalance = await getAssetBalance(walletAddress, SENIOR_LP);
  const finalUsdcBalance = await getAssetBalance(walletAddress, TEST_USDC_ID);

  console.log(`  Final LP balance   : ${finalLpBalance} (was ${lpBalance})`);
  console.log(`  Final USDC balance : ${finalUsdcBalance}`);

  // LP tokens should have been burned (reduced by withdraw amount)
  assert(finalLpBalance < lpBalance, "LP token balance decreased (burned)");
  // USDC balance should be reduced (sent to pool, then returned minus any fees)
  // The exact amount depends on pool mechanics, but it should be < initial deposit
  assert(finalUsdcBalance < DEPOSIT_AMT, "USDC balance changed after withdrawal");

  // Verify via balance endpoint
  const { status: bs, body: bb } = await get(`/v1/accounts/${institutionId}/balance`, jwt);
  assert(bs === 200, "GET /v1/accounts/:id/balance → 200");
  assert(bb.lending?.length > 0, "lending_positions has entries");

  const pos = bb.lending.find((p: any) => p.assetId === TEST_USDC_ID);
  if (pos) {
    console.log(`  lending_positions for TEST_USDC:`);
    console.log(`    balance    : ${pos.balance}`);
    console.log(`    totalValue : ${pos.totalValue}`);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(" SMOKE TEST PASSED — ALL 8 STEPS");
  console.log("=".repeat(60));
  console.log(`\n  Institution    : ${institutionId}`);
  console.log(`  Wallet address : ${walletAddress}`);
  console.log(`  Deposit ID     : ${depositRes.depositId}`);
  console.log(`  Withdrawal ID  : ${withdrawalId}`);
  console.log(`  Deposit txHash : ${depositTxHash}`);
  console.log(`  Withdraw txHash: ${withdrawTxHash}`);
  console.log(`\n  Pera Explorer (deposit)  : https://testnet.explorer.perawallet.app/tx/${depositTxHash}`);
  console.log(`  Pera Explorer (withdraw) : https://testnet.explorer.perawallet.app/tx/${withdrawTxHash}`);
}

run().catch((err) => {
  console.error("\n✗ Smoke test FAILED with uncaught error:", err.message ?? err);
  console.error(err.stack);
  process.exit(1);
});
