import crypto from "crypto";
import algosdk from "algosdk";

const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const TEST_USDC_ID = 758916950;
const FUND_AMT = 10_000_000;
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", 443);

function assert(c: boolean, m: string) { if (!c) { console.error(`  ✗ ${m}`); process.exit(1); } console.log(`  ✓ ${m}`); }
function step(n: string, t: string) { console.log(`\n${"─".repeat(60)}\nStep ${n}: ${t}\n${"─".repeat(60)}`); }
async function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function getBal(addr: string, id: number) {
  const info = await algod.accountInformation(addr).do();
  const a: any[] = info.assets ?? info["assets"] ?? [];
  const f = a.find((x: any) => Number(x.assetId ?? x["asset-id"]) === id);
  return f ? Number(f.amount ?? f["amount"]) : 0;
}

async function provision() {
  const acct = await (await fetch(`${BASE}/v1/accounts`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: `Term ${Date.now()}` }),
  })).json();
  await fetch(`${BASE}/v1/accounts/${acct.id}/kyb/approve`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY }, body: "{}" });
  const h = Buffer.from(acct.hmac_secret as string, "hex");
  const tok = (await (await fetch(`${BASE}/v1/auth/token`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: acct.client_id, client_secret: acct.client_secret }),
  })).json()).access_token as string;
  const w = await (await fetch(`${BASE}/v1/accounts/${acct.id}/wallets`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`,
      "Irion-Signature": crypto.createHmac("sha256", h).update(JSON.stringify({ label: "T" })).digest("hex") },
    body: JSON.stringify({ label: "T" }),
  })).json();
  return { instId: acct.id, token: tok, walletId: w.walletId, walletAddr: w.algorandAddress, hmac: h };
}

async function main() {
  console.log("=".repeat(60));
  console.log(" TERM LOAN SMOKE TEST — Happy Path");
  console.log("=".repeat(60));

  const ctx = await provision();
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);

  // Fund wallet + deposit for liquidity
  step("1", "Fund + deposit");
  let sp = await algod.getTransactionParams().do();
  const ft = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: ctx.walletAddr,
    assetIndex: TEST_USDC_ID, amount: BigInt(FUND_AMT), suggestedParams: sp,
  });
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(ft.signTxn(deployer.sk)).do()).txid, 5);
  const depSig = crypto.createHmac("sha256", ctx.hmac).update(JSON.stringify({ assetId: TEST_USDC_ID, amount: "2000000" })).digest("hex");
  await fetch(`${BASE}/v1/deposits`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "Irion-Signature": depSig },
    body: JSON.stringify({ assetId: TEST_USDC_ID, amount: "2000000" }),
  });
  await wait(25000);

  // Happy path: originate TERM with 100-round maturity
  step("2", "Originate TERM loan (100-round maturity)");
  const payload = { walletId: ctx.walletId, loanType: "TERM", borrowAssetId: TEST_USDC_ID, borrowAmount: "1000000", interestRateBps: 500, maturityRounds: 100 };
  const sig = crypto.createHmac("sha256", ctx.hmac).update(JSON.stringify(payload)).digest("hex");
  const r = await (await fetch(`${BASE}/v1/loans`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "Irion-Signature": sig },
    body: JSON.stringify(payload),
  })).json();
  assert(r.id, "Loan originated");
  const loanId = r.id;
  console.log(`  Loan ID: ${loanId}`);

  // Wait for origination
  await wait(30000);
  let ls = await (await fetch(`${BASE}/v1/loans/${loanId}`, { headers: { Authorization: `Bearer ${ctx.token}` } })).json();
  assert(ls.status === "active", `Loan active (got: ${ls.status})`);
  console.log(`  State:`, JSON.stringify(ls));

  // Wait 10 rounds, verify interest
  step("3", "Verify interest accrual after ~10 rounds");
  const s1 = await algod.status().do();
  const round0 = Number(s1["last-round"] ?? s1.lastRound ?? 0);
  while (Number((await algod.status().do())["last-round"]) < round0 + 10) await wait(3000);
  ls = await (await fetch(`${BASE}/v1/loans/${loanId}`, { headers: { Authorization: `Bearer ${ctx.token}` } })).json();
  console.log(`  State after 10 rounds:`, JSON.stringify(ls));

  // Repay
  step("4", "Repay full amount");
  const repaySig = crypto.createHmac("sha256", ctx.hmac).update(JSON.stringify({ amount: "1000000" })).digest("hex");
  const repayR = await fetch(`${BASE}/v1/loans/${loanId}/repay`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "Irion-Signature": repaySig },
    body: JSON.stringify({ amount: "1000000" }),
  });
  assert(repayR.status === 202, `Repay accepted (${repayR.status})`);
  await wait(20000);

  ls = await (await fetch(`${BASE}/v1/loans/${loanId}`, { headers: { Authorization: `Bearer ${ctx.token}` } })).json();
  console.log(`  Post-repay:`, JSON.stringify(ls));

  // Default path
  console.log(`\n${"=".repeat(60)}`);
  console.log(" TERM LOAN SMOKE TEST — Default Path");
  console.log("=".repeat(60));

  const ctx2 = await provision();
  sp = await algod.getTransactionParams().do();
  const ft2 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: ctx2.walletAddr,
    assetIndex: TEST_USDC_ID, amount: BigInt(3_000_000), suggestedParams: sp,
  });
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(ft2.signTxn(deployer.sk)).do()).txid, 5);

  step("5", "Originate TERM with 5-round maturity");
  const p2 = { walletId: ctx2.walletId, loanType: "TERM", borrowAssetId: TEST_USDC_ID, borrowAmount: "500000", interestRateBps: 500, maturityRounds: 5 };
  const s2 = crypto.createHmac("sha256", ctx2.hmac).update(JSON.stringify(p2)).digest("hex");
  const r2 = await (await fetch(`${BASE}/v1/loans`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx2.token}`, "Irion-Signature": s2 },
    body: JSON.stringify(p2),
  })).json();
  assert(r2.id, "Loan 2 originated");
  const loanId2 = r2.id;
  await wait(30000);

  // Wait for maturity + 1 round
  step("6", "Wait for maturity");
  const s2s = await algod.status().do();
  const target = Number(s2s["last-round"] ?? s2s.lastRound ?? 0) + 10;
  while (Number((await algod.status().do())["last-round"]) < target) await wait(3000);

  step("7", "Mark defaulted");
  const dR = await fetch(`${BASE}/v1/loans/${loanId2}/mark-defaulted`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: "{}",
  });
  const dB = await dR.json();
  console.log(`  Default response: ${dR.status} ${JSON.stringify(dB)}`);
  assert(dR.status === 202, `Defaulted (${dR.status})`);

  const ls2 = await (await fetch(`${BASE}/v1/loans/${loanId2}`, { headers: { Authorization: `Bearer ${ctx2.token}` } })).json();
  console.log(`  Final state:`, JSON.stringify(ls2));
  assert(ls2.status === "defaulted", `Status = defaulted`);

  const bal = await getBal(ctx.walletAddr, TEST_USDC_ID);
  console.log(`\n  Wallet USDC (happy): ${bal}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(" SMOKE TEST COMPLETED — Both paths");
  console.log("=".repeat(60));
}

main().catch(e => { console.error("\n✗ FAILED:", e.message ?? e); process.exit(1); });
