import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { loans, installments, auditLog } from "../../db/schema.js";
import { webhookDeliveryQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { getSigningProvider } from "../../services/signing/index.js";
import { signWithGovernance } from "../../services/governance.js";
import { eq } from "drizzle-orm";
import { amortizationSchedule } from "../../lib/loan-math.js";

export interface InstallmentJob {
  loanId: string; institutionId: string; walletId: string; walletAddress: string;
  borrowAssetId: number; borrowAmount: string;
  interestRateBps: number; installmentCount: number; intervalRounds: number;
}

const LOAN_FACTORY_ID = parseInt(process.env.LOAN_FACTORY_APP_ID ?? "762889354");
const LENDING_POOL_ID = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID ?? "762889263");
const ORACLE_ID = parseInt(process.env.CREDIT_ORACLE_APP_ID ?? "762892340");
const POOL_ASSET = parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950");
const R = 180_000;
const PI = 3000;
const rc = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null, tls: {} });

function eb(p: string, v: number) { const b = new Uint8Array(9); b[0] = p.charCodeAt(0); new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(1, BigInt(v), false); return b; }
function ea(a: string) { const d = algosdk.decodeAddress(a); const b = new Uint8Array(33); b[0] = 0x75; b.set(d.publicKey, 1); return b; }
function ep(a: string) { return new Uint8Array([0x63, ...algosdk.decodeAddress(a).publicKey]); }
function sl(m: number) { return new Promise(r => setTimeout(r, m)); }

async function wc(t: string) {
  const dl = Date.now() + R;
  while (Date.now() < dl) {
    try {
      const p: any = await algorandService.client.client.algod.pendingTransactionInformation(t).do();
      if (p["confirmed-round"] && p["confirmed-round"] > 0) return p;
      if (p["pool-error"]?.length > 0) throw new Error(`Rejected: ${p["pool-error"]}`);
      const x = algorandService.client.client.indexer;
      const r = await x.lookupTransactionByID(t).do();
      if (r.transaction?.confirmedRound) { p["confirmed-round"] = Number(r.transaction.confirmedRound); return p; }
    } catch (e: any) {
      if (e.message?.includes("rejected")) throw e;
      try { const r = await algorandService.client.client.indexer.lookupTransactionByID(t).do(); if (r.transaction?.confirmedRound) return r.transaction; } catch {}
    }
    await sl(PI);
  }
  throw new Error(`Txn ${t} not confirmed`);
}

function gb(v: any): string { return v instanceof Uint8Array ? Buffer.from(v).toString("base64") : String(v); }
async function rgs(id: number, k: string): Promise<number> {
  const info = await (algorandService.client.client.algod as any).getApplicationByID(id).do();
  for (const e of (info?.params?.globalState ?? []))
    if (gb(e.key) === Buffer.from(k).toString("base64")) return Number(e.value?.uint ?? 0n);
  return 0;
}

export async function processInstallmentOrigination(job: Job<InstallmentJob>): Promise<void> {
  const { loanId, institutionId, walletId, walletAddress, borrowAssetId, borrowAmount, interestRateBps, installmentCount, intervalRounds } = job.data;
  const amt = BigInt(borrowAmount);
  const sg = getSigningProvider();
  const ad = algorandService.client.client.algod;
  const dp = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!).addr.toString();

  try {
    const ct = await rgs(LOAN_FACTORY_ID, "loan_counter");
    const ei = ct + 1;
    const sp = await ad.getTransactionParams().do();

    const sel = algosdk.ABIMethod.fromSignature("originate_installment(uint64,uint64,uint64,address)uint64").getSelector();
    const txn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: walletAddress, appIndex: LOAN_FACTORY_ID,
      appArgs: [sel, algosdk.ABIUintType.from("uint64").encode(BigInt(borrowAssetId)),
               algosdk.ABIUintType.from("uint64").encode(amt),
               algosdk.ABIUintType.from("uint64").encode(BigInt(installmentCount)),
               algosdk.decodeAddress(walletAddress).publicKey],
      foreignApps: [LOAN_FACTORY_ID, LENDING_POOL_ID, ORACLE_ID],
      foreignAssets: [POOL_ASSET],
      suggestedParams: { ...sp, fee: 4000, flatFee: true },
    });
    (txn.applicationCall as any).boxes = [
      { appIndex: LOAN_FACTORY_ID, name: eb("l", ei) },
      { appIndex: LOAN_FACTORY_ID, name: ea(walletAddress) },
      { appIndex: LOAN_FACTORY_ID, name: eb("r", borrowAssetId) },
      { appIndex: ORACLE_ID, name: ep(walletAddress) },
    ];

    const [signed] = await Promise.all([sg.signTransaction(walletId, algosdk.encodeUnsignedTransaction(txn))]);
    const txH = await algorandService.submitSignedTransaction(signed);
    const conf = await wc(txH);

    const logs: any[] = conf.logs ?? [];
    const abiLog = typeof logs[0] === "string" ? logs[0] : Buffer.from(logs[0] ?? []).toString("hex");
    const onId = abiLog.startsWith("151f7c75") ? Number(BigInt("0x" + abiLog.slice(8, 24))) : ei;

    // Compute and persist installment schedule
    const schedule = amortizationSchedule({
      principal: Number(amt), interestRateBps, numInstallments: installmentCount,
      intervalRounds, originationRound: Number(conf["confirmed-round"] ?? 0),
    });

    await db.insert(installments).values(schedule.map(s => ({
      loanId, installmentIndex: s.index, dueRound: s.dueRound,
      principalPortion: s.principalPortion, interestPortion: s.interestPortion,
      totalAmount: s.totalAmount,
    })));

    await db.update(loans).set({ status: "active", onchainLoanId: onId, txHash: txH,
      installmentIntervalRounds: intervalRounds, installmentCount }).where(eq(loans.id, loanId));
    await db.insert(auditLog).values({ institutionId, action: "loan.originated", details: { loanId, onId, txH } });

    // CreditOracle update
    try {
      const sp2 = await ad.getTransactionParams().do();
      const oSel = algosdk.ABIMethod.fromSignature("update_on_borrow(address,uint64)void").getSelector();
      const oTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: dp, appIndex: ORACLE_ID,
        appArgs: [oSel, algosdk.decodeAddress(walletAddress).publicKey, algosdk.ABIUintType.from("uint64").encode(amt)],
        accounts: [walletAddress], suggestedParams: { ...sp2, fee: 2000, flatFee: true },
      });
      const sO = await signWithGovernance(algosdk.encodeUnsignedTransaction(oTxn), async (a, d) => { await db.insert(auditLog).values({ institutionId, action: a, details: d }); });
      await algorandService.submitSignedTransaction(sO);
    } catch { /* non-fatal */ }

    await webhookDeliveryQueue.add("loan.originated", { event: "loan.originated", institutionId, payload: { loanId, txHash: txH } });
    console.log(`[installment-orig] ${loanId} onchain=${onId}`);
  } catch (e: any) {
    await db.update(loans).set({ status: "failed_compensating" }).where(eq(loans.id, loanId));
    throw e;
  }
}

export function startInstallmentOriginationWorker(): Worker<InstallmentJob> {
  const w = new Worker<InstallmentJob>("installment-origination", processInstallmentOrigination, { connection: rc, concurrency: 3, lockDuration: 200_000 });
  w.on("failed", (j, e) => console.error(`[installment-orig] job ${j?.id} failed:`, e.message));
  w.on("completed", (j) => console.log(`[installment-orig] job ${j.id} completed`));
  return w;
}
