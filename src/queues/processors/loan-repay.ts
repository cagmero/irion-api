/**
 * Loan Repay Worker — REVOLVING and INSTALLMENT
 *
 * REVOLVING: wallet axfer USDC to pool, decrement drawnAmount.
 * INSTALLMENT: routes payment to earliest unpaid installment.
 *   - Partial: DB only, no contract call
 *   - Exact: 1 LoanFactory.repay call
 *   - Multi (≤5): atomic group of up to 5 repay txns
 *   - Excess: 422 EXCESS_PAYMENT
 *   - >5 installments: 422 INSTALLMENT_BATCH_TOO_LARGE
 */

import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { loans, installments, auditLog } from "../../db/schema.js";
import { webhookDeliveryQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { getSigningProvider } from "../../services/signing/index.js";
import { signWithGovernance } from "../../services/governance.js";
import { eq, and, sql } from "drizzle-orm";
import { ApiError } from "../../lib/errors.js";

export interface LoanRepayJob {
  loanId: string; walletId: string; walletAddress: string;
  amount: string; institutionId: string;
}

const POOL_ADDR = process.env.LENDING_POOL_V2_USDC_ADDRESS ?? "5USZIKFWRDC62ODEPUHINMSR4M6PXUNLTPCZLXSYXWQ7BWP2WSGBQTIZCQ";
const POOL_ASSET = parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950");
const LOAN_FACTORY_ID = parseInt(process.env.LOAN_FACTORY_APP_ID ?? "762889354");
const LENDING_POOL_ID = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID ?? "762889263");
const ORACLE_ID = parseInt(process.env.CREDIT_ORACLE_APP_ID ?? "762892340");
const BATCH_MAX = 5;

const rc = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null, tls: {} });

function eb(p: string, v: number) { const b = new Uint8Array(9); b[0] = p.charCodeAt(0); new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(1, BigInt(v), false); return b; }
function sl(m: number) { return new Promise(r => setTimeout(r, m)); }

export async function processLoanRepay(job: Job<LoanRepayJob>): Promise<void> {
  const { loanId, walletId, walletAddress, amount, institutionId } = job.data;
  const amt = BigInt(amount);
  const sg = getSigningProvider();
  const ad = algorandService.client.client.algod;
  const dp = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!).addr.toString();

  try {
    // Read loan from DB
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId)).limit(1);
    if (!loan) throw new Error("Loan not found");

    if (loan.type === "revolving") {
      // REVOLVING: simple pool axfer (existing path)
      const sp = await ad.getTransactionParams().do();
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: walletAddress, receiver: POOL_ADDR, assetIndex: POOL_ASSET, amount: amt, suggestedParams: sp,
      });
      const signed = await sg.signTransaction(walletId, algosdk.encodeUnsignedTransaction(txn));
      const txH = await algorandService.submitSignedTransaction(signed);
      await sl(5000);
      await db.update(loans).set({ drawnAmount: sql`GREATEST(${loans.drawnAmount} - ${Number(amt)}, 0)` }).where(eq(loans.id, loanId));
      await db.insert(auditLog).values({ institutionId, action: "loan.repaid", details: { loanId, txHash: txH, amount } });
      try {
        const sp2 = await ad.getTransactionParams().do();
        const oSel = algosdk.ABIMethod.fromSignature("update_on_repay(address,uint64,bool)void").getSelector();
        const oTxn = algosdk.makeApplicationNoOpTxnFromObject({
          sender: dp, appIndex: ORACLE_ID,
          appArgs: [oSel, algosdk.decodeAddress(walletAddress).publicKey, algosdk.ABIUintType.from("uint64").encode(amt), new Uint8Array([0x80])],
          accounts: [walletAddress], suggestedParams: { ...sp2, fee: 2000, flatFee: true },
        });
        const sO = await signWithGovernance(algosdk.encodeUnsignedTransaction(oTxn), async (a, d) => { await db.insert(auditLog).values({ institutionId, action: a, details: d }); });
        await algorandService.submitSignedTransaction(sO);
      } catch { /* non-fatal */ }
      return;
    }

    if (loan.type !== "installment") {
      throw new Error(`Unsupported loan type for repay: ${loan.type}`);
    }

    // ── INSTALLMENT routing ──────────────────────────────────────────────
    const onchainLoanId = loan.onchainLoanId;
    if (!onchainLoanId || onchainLoanId === 0) {
      throw new Error("Cannot repay installment loan without onchain loan ID");
    }

    const insts = await db.select().from(installments)
      .where(and(eq(installments.loanId, loanId), sql`${installments.status} != 'paid'`))
      .orderBy(installments.installmentIndex).limit(20);

    if (insts.length === 0) throw new Error("All installments already paid");

    let remaining = Number(amt);
    const toPay: any[] = [];

    for (const inst of insts) {
      if (remaining <= 0) break;
      const due = inst.totalAmount - (inst.amountPaid ?? 0);
      if (due <= 0) continue;
      if (remaining >= due) {
        toPay.push({ id: inst.id, index: inst.installmentIndex, amount: due, total: inst.totalAmount });
        remaining -= due;
      } else {
        // Partial payment — DB only, no contract call
        await db.update(installments).set({
          amountPaid: (inst.amountPaid ?? 0) + remaining,
          status: "partial",
        }).where(eq(installments.id, inst.id));
        await db.insert(auditLog).values({ institutionId, action: "installment.partial", details: { loanId, instIndex: inst.installmentIndex, amount: remaining } });
        remaining = 0;
        break;
      }
    }

    if (remaining > 0) {
      throw new ApiError("EXCESS_PAYMENT", `Payment of ${Number(amt)} exceeds remaining installment balance`);
    }

    if (toPay.length === 0) {
      // Only partial payments — no contract call needed
      console.log(`[loan-repay] Partial payment only for ${loanId}`);
      return;
    }

    if (toPay.length > BATCH_MAX) {
      throw new ApiError("INSTALLMENT_BATCH_TOO_LARGE", `Payment covers ${toPay.length} installments — max ${BATCH_MAX} per request`);
    }

    // Build atomic group of LoanFactory.repay txns
    const sp = await ad.getTransactionParams().do();
    const txns: algosdk.Transaction[] = [];
    const repaySel = algosdk.ABIMethod.fromSignature("repay(uint64,axfer)void").getSelector();
    const oId = BigInt(onchainLoanId);

    // txn[0]: axfer to pool for first installment
    const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: walletAddress, receiver: POOL_ADDR, assetIndex: POOL_ASSET, amount: BigInt(toPay[0].amount), suggestedParams: sp,
    });
    txns.push(axfer);

    // txn[1..N]: LoanFactory.repay calls
    for (let i = 0; i < toPay.length; i++) {
      const repayTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: walletAddress, appIndex: LOAN_FACTORY_ID,
        appArgs: [repaySel, algosdk.ABIUintType.from("uint64").encode(oId)],
        foreignApps: [LOAN_FACTORY_ID, LENDING_POOL_ID, ORACLE_ID],
        foreignAssets: [POOL_ASSET],
        suggestedParams: { ...sp, fee: 3000, flatFee: true },
      });
      (repayTxn.applicationCall as any).boxes = [
        { appIndex: LOAN_FACTORY_ID, name: eb("l", Number(oId)) },
        { appIndex: ORACLE_ID, name: new Uint8Array([0x63, ...algosdk.decodeAddress(walletAddress).publicKey]) },
      ];
      txns.push(repayTxn);
    }

    // Set group
    const gid = algosdk.computeGroupID(txns);
    txns.forEach(t => t.group = gid);

    // Sign all
    const signed = await Promise.all(txns.map(t => sg.signTransaction(walletId, algosdk.encodeUnsignedTransaction(t))));
    const combined = new Uint8Array(signed.reduce((a: number[], b: Uint8Array) => [...a, ...b], []));

    let txH = await algorandService.submitSignedTransaction(combined);
    await new Promise(r => setTimeout(r, 15000));

    // Mark installments paid (DB reflects state)
    for (const p of toPay) {
      await db.update(installments).set({
        status: "paid", amountPaid: p.total, paidAtRound: 0, txHash: txH,
      }).where(eq(installments.id, p.id));
    }

    const totalPaid = (loan.installmentsPaid ?? 0) + toPay.length;
    await db.update(loans).set({
      installmentsPaid: totalPaid,
      status: totalPaid >= (loan.installmentCount ?? 0) ? "repaid" : "active",
    }).where(eq(loans.id, loanId));

    await db.insert(auditLog).values({ institutionId, action: "installment.paid", details: { loanId, count: toPay.length, txHash: txH } });

    // CreditOracle update
    try {
      const sp2 = await ad.getTransactionParams().do();
      const oSel = algosdk.ABIMethod.fromSignature("update_on_repay(address,uint64,bool)void").getSelector();
      const totalAmt = toPay.reduce((s: number, p: any) => s + p.amount, 0);
      const oTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: dp, appIndex: ORACLE_ID,
        appArgs: [oSel, algosdk.decodeAddress(walletAddress).publicKey, algosdk.ABIUintType.from("uint64").encode(BigInt(totalAmt)), new Uint8Array([0x80])],
        accounts: [walletAddress], suggestedParams: { ...sp2, fee: 2000, flatFee: true },
      });
      const sO = await signWithGovernance(algosdk.encodeUnsignedTransaction(oTxn), async (a, d) => { await db.insert(auditLog).values({ institutionId, action: a, details: d }); });
      await algorandService.submitSignedTransaction(sO);
    } catch { /* non-fatal */ }

    await webhookDeliveryQueue.add("installment.paid", {
      event: "installment.paid", institutionId,
      payload: { loanId, txHash: txH, count: toPay.length },
    });

    console.log(`[loan-repay] ${toPay.length} installment(s) paid for ${loanId}: ${txH}`);
  } catch (e: any) {
    await db.insert(auditLog).values({ institutionId, action: "loan.repay_failed", details: { loanId, error: e.message } });
    throw e;
  }
}

export function startLoanRepayWorker(): Worker<LoanRepayJob> {
  const w = new Worker<LoanRepayJob>("loan-repay", processLoanRepay, { connection: rc, concurrency: 3, lockDuration: 200_000 });
  w.on("failed", (j, e) => console.error(`[loan-repay] job ${j?.id} failed:`, e.message));
  w.on("completed", (j) => console.log(`[loan-repay] job ${j.id} completed`));
  return w;
}
