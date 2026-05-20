/**
 * Phase 2h — Full Lifecycle Acceptance Suite (12 criteria)
 *
 * "The demo backup" — if this script passes against a fresh server + DB,
 * every major API route works. Run with:
 *   npx tsx --env-file=.env.local src/scripts/acceptance-smoke.ts
 *
 * Criteria:
 *   C1  Create institution via POST /v1/accounts
 *   C2  KYB approval via admin endpoint
 *   C3  Create wallet via POST /v1/accounts/:id/wallets
 *   C4  Deposit USDC to lending pool via POST /v1/deposits
 *   C5  Open overcollateralized loan via POST /v1/loans
 *   C6  Open revolving loan via POST /v1/loans
 *   C7  Open term loan via POST /v1/loans
 *   C8  Open installment loan via POST /v1/loans
 *   C9  Transfer between wallets via POST /v1/transfers
 *   C10 Payout to external address via POST /v1/payouts
 *   C11 FX quote + execute via POST /v1/fx/quote + /execute
 *   C12 Withdraw from lending pool via POST /v1/withdrawals
 */
import crypto from "crypto";

const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

function step(n: string): void {
  console.log(`\n--- ${n} ---`);
}

async function main() {
  console.log("=== ACCEPTANCE SUITE (12 criteria) ===");
  console.log(`Server: ${BASE}\n`);

  // ── Provision institution ──────────────────────────────────────
  step("C1: Create institution");
  const acctRes = await fetch(`${BASE}/v1/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: `Acceptance ${Date.now()}` }),
  });
  const acct = await acctRes.json();
  assert(acctRes.status === 200, `POST /v1/accounts → 200`);
  assert(!!acct.id, `institution.id present (${acct.id.slice(0, 8)}...)`);

  // ── KYB approval ───────────────────────────────────────────────
  step("C2: KYB approval");
  const kybRes = await fetch(`${BASE}/v1/accounts/${acct.id}/kyb/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: "{}",
  });
  const kyb = await kybRes.json();
  assert(kybRes.status === 200, `POST /v1/accounts/:id/kyb/approve → 200`);
  assert(kyb.status === "active", `status = active`);
  assert(kyb.kybStatus === "approved", `kybStatus = approved`);

  // ── Auth token ──────────────────────────────────────────────────
  const tokRes = await fetch(`${BASE}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: acct.client_id, client_secret: acct.client_secret }),
  });
  const tokBody = await tokRes.json();
  const token = tokBody.access_token as string;
  assert(tokRes.status === 200, `POST /v1/auth/token → 200`);
  assert(!!token, `JWT present`);

  const hmacHex = acct.hmac_secret as string;
  function sign(body: object): string {
    return crypto.createHmac("sha256", Buffer.from(hmacHex, "hex")).update(JSON.stringify(body)).digest("hex");
  }
  function ts(): string { return new Date().toISOString(); }
  function authHeaders(body: object): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "irion-signature": sign(body), "irion-timestamp": ts() };
  }

  // ── Wallet ──────────────────────────────────────────────────────
  step("C3: Create wallet");
  const wBody = { label: "Acceptance Wallet" };
  const wRes = await fetch(`${BASE}/v1/accounts/${acct.id}/wallets`, {
    method: "POST",
    headers: authHeaders(wBody),
    body: JSON.stringify(wBody),
  });
  const wallet = await wRes.json();
  assert(wRes.status === 201, `POST /v1/accounts/:id/wallets → 201`);
  assert(!!wallet.walletId, `walletId present`);
  assert(!!wallet.algorandAddress, `algorandAddress present`);

  // ── Deposit ─────────────────────────────────────────────────────
  step("C4: Deposit USDC");
  const dBody = { assetId: 758916950, amount: "1000000" };
  const dRes = await fetch(`${BASE}/v1/deposits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "irion-signature": sign(dBody) },
    body: JSON.stringify(dBody),
  });
  const dep = await dRes.json();
  assert(dRes.status === 202, `POST /v1/deposits → 202`);
  assert(!!dep.id, `deposit.id present`);

  // ── Loan types ──────────────────────────────────────────────────
  const loanPayloads = [
    { label: "OVERCOLLATERALIZED", body: { walletId: wallet.walletId, loanType: "OVERCOLLATERALIZED", borrowAssetId: 758916950, borrowAmount: "1000000", collateralAmount: "1500000" } },
    { label: "REVOLVING",         body: { walletId: wallet.walletId, loanType: "REVOLVING", borrowAssetId: 758916950, creditLimit: "5000000", interestRateBps: 500 } },
    { label: "TERM",              body: { walletId: wallet.walletId, loanType: "TERM", borrowAssetId: 758916950, borrowAmount: "2000000", termDays: 90, interestRateBps: 700 } },
    { label: "INSTALLMENT",       body: { walletId: wallet.walletId, loanType: "INSTALLMENT", borrowAssetId: 758916950, borrowAmount: "600000", installmentCount: 3, installmentIntervalRounds: 100000, interestRateBps: 500 } },
  ];

  for (const lp of loanPayloads) {
    step(`C${4 + loanPayloads.indexOf(lp) + 1}: ${lp.label} loan`);
    const lBody = lp.body;
    const lRes = await fetch(`${BASE}/v1/loans`, {
      method: "POST",
      headers: authHeaders(lBody),
      body: JSON.stringify(lBody),
    });
    const loan = await lRes.json();
    const ok = lRes.status === 202;
    assert(ok, `POST /v1/loans (${lp.label}) → ${lRes.status}`);
    if (ok) assert(loan.type === lp.label.toLowerCase(), `type = ${lp.label.toLowerCase()}`);
  }

  // ── Transfer ────────────────────────────────────────────────────
  step("C9: Transfer between wallets");
  const tBody = { fromWalletId: wallet.walletId, toWalletId: wallet.walletId, assetId: 758916950, amount: "50000" };
  const tRes = await fetch(`${BASE}/v1/transfers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "irion-signature": sign(tBody) },
    body: JSON.stringify(tBody),
  });
  assert(tRes.status === 202 || tRes.status === 200, `POST /v1/transfers → ${tRes.status}`);

  // ── Payout ──────────────────────────────────────────────────────
  step("C10: Payout to external address");
  const pBody = { walletId: wallet.walletId, assetId: 758916950, amount: "25000", destinationAddress: wallet.algorandAddress };
  const pRes = await fetch(`${BASE}/v1/payouts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "irion-signature": sign(pBody) },
    body: JSON.stringify(pBody),
  });
  assert(pRes.status === 202 || pRes.status === 200, `POST /v1/payouts → ${pRes.status}`);

  // ── FX ──────────────────────────────────────────────────────────
  step("C11: FX quote + execute");
  const fqBody = { fromAssetId: 758916950, toAssetId: 0, fromAmount: "1000000" };
  const fqRes = await fetch(`${BASE}/v1/fx/quote`, {
    method: "POST",
    headers: authHeaders(fqBody),
    body: JSON.stringify(fqBody),
  });
  const fq = await fqRes.json();
  assert(fqRes.status === 200, `POST /v1/fx/quote → 200`);
  assert(!!fq.quoteId, `quoteId present`);
  assert(Number(fq.toAmount) > 0, `toAmount > 0 (${fq.toAmount})`);

  const feBody = { quoteId: fq.quoteId };
  const feRes = await fetch(`${BASE}/v1/fx/execute`, {
    method: "POST",
    headers: authHeaders(feBody),
    body: JSON.stringify(feBody),
  });
  const fe = await feRes.json();
  assert(feRes.status === 202, `POST /v1/fx/execute → 202`);
  assert(fe.status === "submitted", `status = submitted`);

  // ── Withdrawal ──────────────────────────────────────────────────
  step("C12: Withdraw from lending pool");
  const wdBody = { assetId: 758916950, amount: "500000" };
  const wdRes = await fetch(`${BASE}/v1/withdrawals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "irion-signature": sign(wdBody) },
    body: JSON.stringify(wdBody),
  });
  assert(wdRes.status === 202 || wdRes.status === 200, `POST /v1/withdrawals → ${wdRes.status}`);

  // ── Summary ─────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(` ACCEPTANCE SUITE: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(` ${failed > 0 ? "SOME CRITERIA FAILED — investigate above" : "ALL CRITERIA PASSED — demo-ready"}`);
  console.log(`=${"=".repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\nACCEPTANCE SUITE CRASHED:", e.message ?? e);
  process.exit(1);
});
