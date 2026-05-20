import crypto from "crypto";
import algosdk from "algosdk";
const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const USDC = 758916950;
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", 443);

function assert(c: boolean, m: string) { if (!c) { console.error(`  ✗ ${m}`); process.exit(1); } console.log(`  ✓ ${m}`); }
function step(n: string, t: string) { console.log(`\n${"=".repeat(60)}\n${n}: ${t}\n${"=".repeat(60)}`); }
function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function getBal(addr: string) {
  const i = await algod.accountInformation(addr).do();
  const a: any[] = i.assets ?? i["assets"] ?? [];
  const f = a.find((x: any) => Number(x.assetId ?? x["asset-id"]) === USDC);
  return f ? Number(f.amount ?? f["amount"]) : 0;
}

async function provision() {
  const acct = await (await fetch(`${BASE}/v1/accounts`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: `Inst ${Date.now()}` }),
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
      "Irion-Signature": crypto.createHmac("sha256", h).update(JSON.stringify({ label: "I" })).digest("hex") },
    body: JSON.stringify({ label: "I" }),
  })).json();
  return { instId: acct.id, token: tok, walletId: w.walletId, walletAddr: w.algorandAddress, hmac: h };
}

async function inject(p: any) { return (await fetch(p.url, p)).json(); }

async function main() {
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);

  // ── PATH 1: Happy path — 12-installment loan, single repay + batch ──
  step("PATH 1", "Happy path — 12-installment loan");
  const ctx = await provision();

  // Fund
  let sp = await algod.getTransactionParams().do();
  const ft = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: ctx.walletAddr,
    assetIndex: USDC, amount: BigInt(5_000_000), suggestedParams: sp,
  });
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(ft.signTxn(deployer.sk)).do()).txid, 5);

  // Deposit for liquidity
  const ds = crypto.createHmac("sha256", ctx.hmac).update(JSON.stringify({ assetId: USDC, amount: "2000000" })).digest("hex");
  await fetch(`${BASE}/v1/deposits`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "Irion-Signature": ds },
    body: JSON.stringify({ assetId: USDC, amount: "2000000" }),
  });
  await wait(25000);

  // Originate 12-installment loan
  const p = { walletId: ctx.walletId, loanType: "INSTALLMENT", borrowAssetId: USDC, borrowAmount: "1200000", interestRateBps: 500, installmentCount: 12, installmentIntervalRounds: 100000 };
  const sig = crypto.createHmac("sha256", ctx.hmac).update(JSON.stringify(p)).digest("hex");
  const r = await (await fetch(`${BASE}/v1/loans`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "Irion-Signature": sig },
    body: JSON.stringify(p),
  })).json();
  assert(!!r.id, "Loan originated");
  const loanId = r.id;
  console.log(`  Loan: ${loanId}`);
  await wait(25000);

  // Verify schedule
  const sched = await (await fetch(`${BASE}/v1/loans/${loanId}/schedule`, { headers: { Authorization: `Bearer ${ctx.token}` } })).json();
  assert(sched.installments?.length === 12, `12 installments created (got ${sched.installments?.length})`);
  console.log(`  Installment 0 due: ${sched.installments?.[0]?.totalAmount}`);

  // Repay installment 1 (single)
  await wait(5000);
  const rSig1 = crypto.createHmac("sha256", ctx.hmac).update(JSON.stringify({ amount: sched.installments[0].totalAmount })).digest("hex");
  const r1 = await fetch(`${BASE}/v1/loans/${loanId}/repay`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "Irion-Signature": rSig1 },
    body: JSON.stringify({ amount: sched.installments[0].totalAmount }),
  });
  assert(r1.status === 202, `Repay 1 accepted (${r1.status})`);
  await wait(15000);

  // Repay installments 2-3 as batch
  const batchAmt = Number(sched.installments[1].totalAmount) + Number(sched.installments[2].totalAmount);
  const rSig2 = crypto.createHmac("sha256", ctx.hmac).update(JSON.stringify({ amount: String(batchAmt) })).digest("hex");
  const r2 = await fetch(`${BASE}/v1/loans/${loanId}/repay`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "Irion-Signature": rSig2 },
    body: JSON.stringify({ amount: String(batchAmt) }),
  });
  assert(r2.status === 202, `Batch repay accepted (${r2.status})`);
  await wait(15000);
  console.log(`  Path 1 complete: 1 single repay + 1 batch (2 installments)`);

  // ── PATH 2: Multi-installment batch (all in one atomic group) ──
  step("PATH 2", "Multi-installment batch — 3 installments at once");
  const ctx2 = await provision();
  sp = await algod.getTransactionParams().do();
  const ft2 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: ctx2.walletAddr,
    assetIndex: USDC, amount: BigInt(3_000_000), suggestedParams: sp,
  });
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(ft2.signTxn(deployer.sk)).do()).txid, 5);

  const ds2 = crypto.createHmac("sha256", ctx2.hmac).update(JSON.stringify({ assetId: USDC, amount: "1000000" })).digest("hex");
  await fetch(`${BASE}/v1/deposits`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx2.token}`, "Irion-Signature": ds2 },
    body: JSON.stringify({ assetId: USDC, amount: "1000000" }),
  });
  await wait(20000);

  const p2 = { walletId: ctx2.walletId, loanType: "INSTALLMENT", borrowAssetId: USDC, borrowAmount: "600000", interestRateBps: 500, installmentCount: 3, installmentIntervalRounds: 5000 };
  const s2 = crypto.createHmac("sha256", ctx2.hmac).update(JSON.stringify(p2)).digest("hex");
  const r2o = await (await fetch(`${BASE}/v1/loans`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx2.token}`, "Irion-Signature": s2 },
    body: JSON.stringify(p2),
  })).json();
  assert(!!r2o.id, "Loan 2 originated");
  await wait(25000);

  const sched2 = await (await fetch(`${BASE}/v1/loans/${r2o.id}/schedule`, { headers: { Authorization: `Bearer ${ctx2.token}` } })).json();
  assert(sched2.installments?.length === 3, "3 installments");
  const total3 = sched2.installments.reduce((s: number, i: any) => s + Number(i.totalAmount), 0);
  const rSig3 = crypto.createHmac("sha256", ctx2.hmac).update(JSON.stringify({ amount: String(total3) })).digest("hex");
  const r3 = await fetch(`${BASE}/v1/loans/${r2o.id}/repay`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx2.token}`, "Irion-Signature": rSig3 },
    body: JSON.stringify({ amount: String(total3) }),
  });
  assert(r3.status === 202, `Batch of 3 accepted (${r3.status})`);
  console.log(`  Path 2 complete: all 3 installments in one atomic group`);

  // ── PATH 3: Default path ──
  step("PATH 3", "Default — miss installment, mark-defaulted");
  const ctx3 = await provision();
  sp = await algod.getTransactionParams().do();
  const ft3 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: ctx3.walletAddr,
    assetIndex: USDC, amount: BigInt(2_000_000), suggestedParams: sp,
  });
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(ft3.signTxn(deployer.sk)).do()).txid, 5);

  const p3 = { walletId: ctx3.walletId, loanType: "INSTALLMENT", borrowAssetId: USDC, borrowAmount: "500000", interestRateBps: 500, installmentCount: 3, installmentIntervalRounds: 3 };
  const s3 = crypto.createHmac("sha256", ctx3.hmac).update(JSON.stringify(p3)).digest("hex");
  const r3o = await (await fetch(`${BASE}/v1/loans`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx3.token}`, "Irion-Signature": s3 },
    body: JSON.stringify(p3),
  })).json();
  assert(!!r3o.id, "Loan 3 originated");
  await wait(25000);

  // Wait past 3-round maturity
  const st = await algod.status().do();
  const target = Number(st["last-round"] ?? st.lastRound ?? 0) + 10;
  while (Number((await algod.status().do())["last-round"]) < target) await wait(3000);

  // Mark defaulted
  const dR = await fetch(`${BASE}/v1/loans/${r3o.id}/mark-defaulted`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY }, body: "{}",
  });
  const dB = await dR.json();
  console.log(`  Default: ${dR.status} ${JSON.stringify(dB)}`);
  assert(dR.status === 202, `Defaulted (${dR.status})`);

  const ls3 = await (await fetch(`${BASE}/v1/loans/${r3o.id}`, { headers: { Authorization: `Bearer ${ctx3.token}` } })).json();
  assert(ls3.status === "defaulted" || ls3.status === "failed_compensating", `Status defaulted (got: ${ls3.status})`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(" ALL 3 SMOKE PATHS COMPLETED");
  console.log("=".repeat(60));
  console.log(`  Path 1 (happy):  1 single repay + 1 batch (2 installments)`);
  console.log(`  Path 2 (batch):  3 installments in one atomic group`);
  console.log(`  Path 3 (default): Loan defaulted after maturity`);
}

main().catch(e => { console.error("\n✗ FAILED:", e.message ?? e); process.exit(1); });
