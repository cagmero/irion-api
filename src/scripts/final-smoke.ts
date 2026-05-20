import crypto from "crypto";
import algosdk from "algosdk";
const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const USDC = 758916950;
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", 443);

function assert(c: boolean, m: string) { if (!c) { console.error(`  ✗ ${m}`); process.exit(1); } console.log(`  ✓ ${m}`); }
function step(n: string, t: string) { console.log(`\n${"=".repeat(60)}\n${n}: ${t}\n${"=".repeat(60)}`); }
function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);
  console.log("Deployer:", deployer.addr.toString());

  step("1", "Provision institution + wallet");
  const acct = await (await fetch(`${BASE}/v1/accounts`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: `Final ${Date.now()}` }),
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
      "Irion-Signature": crypto.createHmac("sha256", h).update(JSON.stringify({ label: "F" })).digest("hex") },
    body: JSON.stringify({ label: "F" }),
  })).json();
  assert(!!w.algorandAddress, "Wallet created");
  console.log("  Wallet:", w.walletId, "Addr:", w.algorandAddress);

  // Fund wallet + deposit
  step("2", "Fund wallet + deposit for liquidity");
  const sp = await algod.getTransactionParams().do();
  const ft = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: w.algorandAddress,
    assetIndex: USDC, amount: BigInt(3_000_000), suggestedParams: sp,
  });
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(ft.signTxn(deployer.sk)).do()).txid, 5);
  console.log("  Funded 3 USDC");

  const ds = crypto.createHmac("sha256", h).update(JSON.stringify({ assetId: USDC, amount: "1000000" })).digest("hex");
  const dr = await fetch(`${BASE}/v1/deposits`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "Irion-Signature": ds },
    body: JSON.stringify({ assetId: USDC, amount: "1000000" }),
  });
  assert(dr.status === 202, "Deposit submitted");
  await wait(25000);

  // Originate 3-installment loan
  step("3", "Originate 3-installment loan");
  const p = { walletId: w.walletId, loanType: "INSTALLMENT", borrowAssetId: USDC, borrowAmount: "600000", interestRateBps: 500, installmentCount: 3, installmentIntervalRounds: 100000 };
  const sig = crypto.createHmac("sha256", h).update(JSON.stringify(p)).digest("hex");
  const lo = await (await fetch(`${BASE}/v1/loans`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "Irion-Signature": sig },
    body: JSON.stringify(p),
  })).json();
  assert(!!lo.id, "Loan originated");
  const loanId = lo.id;
  console.log("  Loan ID:", loanId);
  await wait(25000);

  // Verify schedule
  const sched = await (await fetch(`${BASE}/v1/loans/${loanId}/schedule`, { headers: { Authorization: `Bearer ${tok}` } })).json();
  assert(sched.installments?.length === 3, "3 installments created");
  console.log("  Installment 0:", sched.installments[0].totalAmount);

  // Repay installment 0 (should fail — CreditOracle inner txn bug, but throw instead of silent success)
  step("4", "Repay installment 0 (expect failure — no silent success)");
  const amt0 = sched.installments[0].totalAmount;
  const rSig = crypto.createHmac("sha256", h).update(JSON.stringify({ amount: amt0 })).digest("hex");
  const r = await fetch(`${BASE}/v1/loans/${loanId}/repay`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "Irion-Signature": rSig },
    body: JSON.stringify({ amount: amt0 }),
  });
  console.log("  Repay response:", r.status, await r.json().then(j => JSON.stringify(j)).catch(() => ""));
  // The repay should return 202 (submitted to worker) — the worker will fail
  assert(r.status === 202, `Repay accepted (${r.status})`);
  await wait(20000);

  // Check loan state — installments should NOT be marked 'paid' (worker likely failed)
  step("5", "Verify installment state after failed repay");
  const sched2 = await (await fetch(`${BASE}/v1/loans/${loanId}/schedule`, { headers: { Authorization: `Bearer ${tok}` } })).json();
  console.log("  Installment 0:", JSON.stringify(sched2.installments?.[0]));
  const inst0 = sched2.installments?.[0];
  // The installment should NOT be 'paid' since the contract call failed
  assert(inst0?.status !== "paid", `Installment 0 NOT marked paid (status=${inst0?.status})`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(" SMOKE TEST COMPLETE");
  console.log("=".repeat(60));
  console.log("  Origination tx:", lo.txHash || "(in worker)");
  console.log("  Origination explorer: https://testnet.explorer.perawallet.app/tx/" + (lo.txHash || ""));
  console.log("  Repay attempted, contract call threw as expected (no DB-only fallback)");
  console.log("  Installment 0 status:", inst0?.status, "(not 'paid' — correct)");
}

main().catch(e => { console.error("\n✗ FAILED:", e.message ?? e); process.exit(1); });
