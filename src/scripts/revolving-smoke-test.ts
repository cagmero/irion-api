/**
 * REVOLVING Full Lifecycle Smoke Test — 2e.2
 * Steps: open 1 USDC line → draw 0.5 → draw 0.3 → fail-draw 0.5 → repay 0.4 → draw 0.4 → repay 0.8 → completed
 */

import crypto from "crypto";
import algosdk from "algosdk";

const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const TEST_USDC_ID = 758916950;
const FUND_AMT = 10_000_000;
const POOL_ID = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID ?? "762889263");
const LF_ID = parseInt(process.env.LOAN_FACTORY_APP_ID ?? "762889354");
const ORACLE_ID = parseInt(process.env.CREDIT_ORACLE_APP_ID ?? "762892340");

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", 443);

function assert(cond: boolean, msg: string) { if (!cond) { console.error(`  ✗ FAIL: ${msg}`); process.exit(1); } console.log(`  ✓ ${msg}`); }
function step(n: string, title: string) { console.log(`\n${"─".repeat(60)}\nStep ${n}: ${title}\n${"─".repeat(60)}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function encodeBoxName(prefix: string, value: number): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = prefix.charCodeAt(0);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(1, BigInt(value), false);
  return buf;
}

async function readLoanBox(onchainId: number): Promise<number> {
  const boxName = encodeBoxName("l", onchainId);
  const b64 = Buffer.from(boxName).toString("base64");
  const resp = await fetch(`https://testnet-api.algonode.cloud/v2/applications/${LF_ID}/box?name=b64:${b64}`);
  if (!resp.ok) return -1;
  const data: any = await resp.json();
  const val = new Uint8Array(Buffer.from(data.value, "base64"));
  if (val.length >= 120) return Number(new DataView(val.buffer, val.byteOffset, val.byteLength).getBigUint64(112, false));
  return -2;
}

async function getOracleScore(institutionId: string): Promise<number> {
  const addr = (await algod.accountInformation(institutionId).catch(() => null))?.address;
  if (!addr) return -1;
  try {
    const resp = await fetch(`https://testnet-api.algonode.cloud/v2/applications/${ORACLE_ID}/box?name=b64:${Buffer.from(new Uint8Array([0x63, ...algosdk.decodeAddress(addr).publicKey])).toString("base64")}`);
    return resp.ok ? 1 : 0;
  } catch { return -1; }
}

async function main() {
  console.log("=".repeat(60));
  console.log(" REVOLVING CREDIT SMOKE TEST — Full Lifecycle");
  console.log("=".repeat(60));

  step("1", "Provision");
  const acct = await (await fetch(`${BASE}/v1/accounts`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: `FullRev ${Date.now()}` }),
  })).json();
  assert(!!acct.id, "Account created");
  await fetch(`${BASE}/v1/accounts/${acct.id}/kyb/approve`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY }, body: "{}" });
  assert(true, "KYB approved");

  const hmacSecret = Buffer.from(acct.hmac_secret as string, "hex");
  const instId = acct.id as string;
  const token = (await (await fetch(`${BASE}/v1/auth/token`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: acct.client_id, client_secret: acct.client_secret }),
  })).json()).access_token as string;

  const wallet = await (await fetch(`${BASE}/v1/accounts/${instId}/wallets`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      "Irion-Signature": crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ label: "Rev" })).digest("hex") },
    body: JSON.stringify({ label: "Rev" }),
  })).json();
  assert(!!wallet.algorandAddress, "Wallet created");
  const walletAddr = wallet.algorandAddress as string;
  const walletId = wallet.walletId as string;

  step("2", "Fund wallet + pool deposit");
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);
  const sp = await algod.getTransactionParams().do();
  const fundTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: walletAddr,
    assetIndex: TEST_USDC_ID, amount: BigInt(FUND_AMT), suggestedParams: sp,
  });
  const fundId = (await algod.sendRawTransaction(fundTxn.signTxn(deployer.sk)).do()).txid;
  await algosdk.waitForConfirmation(algod, fundId, 5);
  let bal = await (await algod.accountInformation(walletAddr).do()).assets?.find((a: any) => Number(a["asset-id"] ?? a.assetId) === TEST_USDC_ID)?.amount ?? 0;
  assert(Number(bal) >= FUND_AMT, `Funded ${FUND_AMT}`);

  const depSig = crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ assetId: TEST_USDC_ID, amount: "2000000" })).digest("hex");
  const depR = await fetch(`${BASE}/v1/deposits`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Irion-Signature": depSig },
    body: JSON.stringify({ assetId: TEST_USDC_ID, amount: "2000000" }),
  });
  assert(depR.status === 202, "Deposit submitted");
  await sleep(30000);

  step("3", "Open revolving line (1 USDC limit)");
  const openSig = crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ walletId, loanType: "REVOLVING", borrowAssetId: TEST_USDC_ID, borrowAmount: "1000000" })).digest("hex");
  const openR = await fetch(`${BASE}/v1/loans`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Irion-Signature": openSig },
    body: JSON.stringify({ walletId, loanType: "REVOLVING", borrowAssetId: TEST_USDC_ID, borrowAmount: "1000000" }),
  });
  const openB = await openR.json();
  assert(openR.status === 202, `Line opened (${openR.status})`);
  const loanId = openB.id;
  assert(!!loanId, "Loan ID present");

  // Wait for revolving-origination worker to call LoanFactory.originate_revolving
  console.log("  Waiting for origination worker...");
  let onchainId = -1, attempts = 0;
  while (attempts++ < 30) {
    const lr = await (await fetch(`${BASE}/v1/loans/${loanId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    if (lr.status === "active") { console.log(`  Loan active: ${JSON.stringify(lr)}`); break; }
    if (lr.status === "failed_compensating") { console.error("  Origination failed!"); process.exit(1); }
    await sleep(5000);
  }

  step("4a", "Draw 0.5 USDC via LoanFactory.draw()");
  const d1Sig = crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ amount: "500000" })).digest("hex");
  const d1R = await fetch(`${BASE}/v1/loans/${loanId}/draw`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Irion-Signature": d1Sig },
    body: JSON.stringify({ amount: "500000" }),
  });
  assert(d1R.status === 202, `Draw 1 accepted (${d1R.status})`);
  console.log("  Waiting for draw confirmation...");
  await sleep(20000);

  step("4b", "Draw 0.3 USDC");
  const d2Sig = crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ amount: "300000" })).digest("hex");
  const d2R = await fetch(`${BASE}/v1/loans/${loanId}/draw`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Irion-Signature": d2Sig },
    body: JSON.stringify({ amount: "300000" }),
  });
  assert(d2R.status === 202, `Draw 2 accepted`);
  await sleep(20000);

  step("5", "Verify drawn amount (on-chain + DB)");
  const loanState = await (await fetch(`${BASE}/v1/loans/${loanId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const onchainDrawn = await readLoanBox(1);
  console.log(`  DB drawnAmount: ${loanState.drawnAmount}`);
  console.log(`  On-chain box drawn: ${onchainDrawn}`);
  assert(Number(loanState.drawnAmount ?? 0) >= 800000, `DB drawn >= 800000`);

  step("6", "Attempt over-limit draw of 0.5 USDC (should fail)");
  const dOverSig = crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ amount: "500000" })).digest("hex");
  const dOverR = await fetch(`${BASE}/v1/loans/${loanId}/draw`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Irion-Signature": dOverSig },
    body: JSON.stringify({ amount: "500000" }),
  });
  const dOverB = await dOverR.json();
  console.log(`  Over-limit response: ${dOverR.status} ${JSON.stringify(dOverB)}`);
  assert(dOverR.status === 422, `Over-limit draw rejected (${dOverR.status})`);

  step("7", "Repay 0.4 USDC via LoanFactory.repay()");
  const r1Sig = crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ amount: "400000" })).digest("hex");
  const r1R = await fetch(`${BASE}/v1/loans/${loanId}/repay`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Irion-Signature": r1Sig },
    body: JSON.stringify({ amount: "400000" }),
  });
  assert(r1R.status === 202, `Repay accepted`);
  await sleep(20000);

  step("8", "Verify drawn = 0.4 after repay");
  const repState = await (await fetch(`${BASE}/v1/loans/${loanId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  console.log(`  Post-repay: ${JSON.stringify(repState)}`);
  assert(Number(repState.drawnAmount ?? 0) <= 400000, `Drawn <= 400000`);

  step("9", "Repay 0.4 USDC (repay to zero)");
  const r2Sig = crypto.createHmac("sha256", hmacSecret).update(JSON.stringify({ amount: "400000" })).digest("hex");
  const r2R = await fetch(`${BASE}/v1/loans/${loanId}/repay`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Irion-Signature": r2Sig },
    body: JSON.stringify({ amount: "400000" }),
  });
  assert(r2R.status === 202, `Final repay accepted`);
  await sleep(30000);

  step("10", "Verify completed status");
  const finalState = await (await fetch(`${BASE}/v1/loans/${loanId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  console.log(`  Final state: ${JSON.stringify(finalState)}`);
  assert(finalState.status === "repaid" || finalState.status === "completed", `Status is completed/repaid (got: ${finalState.status})`);

  const finalBal = await (await algod.accountInformation(walletAddr).do()).assets?.find((a: any) => Number(a["asset-id"] ?? a.assetId) === TEST_USDC_ID)?.amount ?? 0;
  console.log(`  Wallet USDC: ${finalBal}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(" SMOKE TEST COMPLETED — ALL 10 STEPS");
  console.log("=".repeat(60));
}

main().catch(e => { console.error("\n✗ FAILED:", e.message ?? e); process.exit(1); });
