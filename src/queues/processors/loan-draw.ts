import { createRedisConnection } from "../../lib/redis.js";
import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { loans, loanDraws, auditLog } from "../../db/schema.js";
import { webhookDeliveryQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { signWithGovernance } from "../../services/governance.js";
import { eq, sql } from "drizzle-orm";

export interface LoanDrawJob {
  drawId: string; loanId: string; walletId: string; walletAddress: string;
  amount: string; institutionId: string; onchainLoanId: number;
}

const LENDING_POOL_APP_ID = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID ?? "762889263");
const CREDIT_ORACLE_APP_ID = parseInt(process.env.CREDIT_ORACLE_APP_ID ?? "762892340");
const POOL_ASSET_ID = parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950");
const CONFIRM_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3000;
const redisConnection = createRedisConnection();

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function waitForConfirm(txId: string): Promise<any> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const p: any = await algorandService.client.client.algod.pendingTransactionInformation(txId).do();
      if (p["confirmed-round"] && p["confirmed-round"] > 0) return p;
      if (p["pool-error"]?.length > 0) throw new Error(`Rejected: ${p["pool-error"]}`);
      const idx = algorandService.client.client.indexer;
      const r = await idx.lookupTransactionByID(txId).do();
      if (r.transaction?.confirmedRound) { p["confirmed-round"] = Number(r.transaction.confirmedRound); return p; }
    } catch (e: any) {
      if (e.message?.includes("rejected")) throw e;
      try { const r = await algorandService.client.client.indexer.lookupTransactionByID(txId).do(); if (r.transaction?.confirmedRound) return r.transaction; } catch {}
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Txn ${txId} not confirmed`);
}

export async function processLoanDraw(job: Job<LoanDrawJob>): Promise<void> {
  const { drawId, loanId, walletAddress, amount, institutionId } = job.data;
  const amountN = BigInt(amount);
  const algod = algorandService.client.client.algod;
  try {
    const sp = await algod.getTransactionParams().do();
    const deployerAddr = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!).addr.toString();

    // 1. LendingPool.borrow() from governance
    const bSel = algosdk.ABIMethod.fromSignature("borrow(uint64,address)uint64").getSelector();
    const bTxn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: deployerAddr, appIndex: LENDING_POOL_APP_ID,
      appArgs: [bSel, algosdk.ABIUintType.from("uint64").encode(amountN), algosdk.decodeAddress(walletAddress).publicKey],
      foreignAssets: [POOL_ASSET_ID], accounts: [walletAddress],
      suggestedParams: { ...sp, fee: 3000, flatFee: true },
    });
    const signedB = await signWithGovernance(algosdk.encodeUnsignedTransaction(bTxn), async (a, d) => { await db.insert(auditLog).values({ institutionId, action: a, details: d }); });
    const borrowTx = await algorandService.submitSignedTransaction(signedB);
    await waitForConfirm(borrowTx);

    // 2. CreditOracle.update_on_borrow() from governance
    try {
      const sp2 = await algod.getTransactionParams().do();
      const oSel = algosdk.ABIMethod.fromSignature("update_on_borrow(address,uint64)void").getSelector();
      const oTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: deployerAddr, appIndex: CREDIT_ORACLE_APP_ID,
        appArgs: [oSel, algosdk.decodeAddress(walletAddress).publicKey, algosdk.ABIUintType.from("uint64").encode(amountN)],
        accounts: [walletAddress], suggestedParams: { ...sp2, fee: 2000, flatFee: true },
      });
      const signedO = await signWithGovernance(algosdk.encodeUnsignedTransaction(oTxn), async (a, d) => { await db.insert(auditLog).values({ institutionId, action: a, details: d }); });
      await algorandService.submitSignedTransaction(signedO);
      console.log(`[loan-draw] Oracle updated`);
    } catch (e: any) { console.error(`[loan-draw] Oracle skipped: ${e.message}`); }

    await db.update(loanDraws).set({ status: "completed", txHash: borrowTx }).where(eq(loanDraws.id, drawId));
    await db.update(loans).set({ drawnAmount: sql`${loans.drawnAmount} + ${Number(amountN)}` }).where(eq(loans.id, loanId));
    await db.insert(auditLog).values({ institutionId, action: "loan.draw_confirmed", details: { loanId, drawId, txHash: borrowTx, amount } });
    await webhookDeliveryQueue.add("loan.draw.confirmed", { event: "loan.draw.confirmed", institutionId, payload: { loanId, drawId, txHash: borrowTx, amount } });
    console.log(`[loan-draw] Confirmed ${drawId}: ${borrowTx}`);
  } catch (e: any) {
    await db.update(loanDraws).set({ status: "failed" }).where(eq(loanDraws.id, drawId));
    await db.insert(auditLog).values({ institutionId, action: "loan.draw_failed", details: { loanId, drawId, error: e.message } });
    throw e;
  }
}

export function startLoanDrawWorker(): Worker<LoanDrawJob> {
  const w = new Worker<LoanDrawJob>("loan-draw", processLoanDraw, { connection: redisConnection, concurrency: 3, lockDuration: 200_000 });
  w.on("failed", (j, e) => console.error(`[loan-draw] job ${j?.id} failed:`, e.message));
  w.on("completed", (j) => console.log(`[loan-draw] job ${j.id} completed`));
  return w;
}
