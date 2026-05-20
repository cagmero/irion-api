/**
 * REVOLVING Loan Origination Worker
 *
 * Calls LoanFactory.originate_revolving(asset_id, initial_draw=0) from the wallet.
 * Captures the on-chain loan_id from the ABI return value.
 * This on-chain loan_id is required for subsequent LoanFactory.draw() and repay() calls.
 */

import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { loans, auditLog } from "../../db/schema.js";
import { algorandService } from "../../services/algorand.js";
import { getSigningProvider } from "../../services/signing/index.js";
import { eq } from "drizzle-orm";

export interface RevolvingOriginationJob {
  loanId: string;
  institutionId: string;
  walletId: string;
  walletAddress: string;
  borrowAssetId: number;
  creditLimit: string;
}

const LOAN_FACTORY_APP_ID = parseInt(process.env.LOAN_FACTORY_APP_ID ?? "762889354");
const LENDING_POOL_APP_ID = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID ?? "762889263");
const CREDIT_ORACLE_APP_ID = parseInt(process.env.CREDIT_ORACLE_APP_ID ?? "762892340");

const CONFIRM_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3000;

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

function encodeBoxName(prefix: string, value: number): Uint8Array {
  const buf = new Uint8Array(1 + 8);
  buf[0] = prefix.charCodeAt(0);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(1, BigInt(value), false);
  return buf;
}

function encodeAddressBoxName(address: string): Uint8Array {
  const addr = algosdk.decodeAddress(address);
  const buf = new Uint8Array(1 + 32);
  buf[0] = 0x75;
  buf.set(addr.publicKey, 1);
  return buf;
}
function profileBoxName(address: string): Uint8Array {
  return new Uint8Array([0x63, ...algosdk.decodeAddress(address).publicKey]);
}

async function waitForConfirm(txId: string): Promise<any> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const pending: any = await algorandService.client.client.algod.pendingTransactionInformation(txId).do();
      const round = pending["confirmed-round"];
      if (round && round > 0) return pending;
      if (pending["pool-error"]?.length > 0) throw new Error(`Txn rejected: ${pending["pool-error"]}`);
      const indexer = algorandService.client.client.indexer;
      const resp = await indexer.lookupTransactionByID(txId).do();
      if (resp.transaction?.confirmedRound) {
        pending["confirmed-round"] = Number(resp.transaction.confirmedRound);
        return pending;
      }
    } catch (err: any) {
      if (err.message?.includes("rejected")) throw err;
      try {
        const indexer = algorandService.client.client.indexer;
        const resp = await indexer.lookupTransactionByID(txId).do();
        if (resp.transaction?.confirmedRound) return resp.transaction;
      } catch { /* keep polling */ }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Txn ${txId} not confirmed within ${CONFIRM_TIMEOUT_MS}ms`);
}

export async function processRevolvingOrigination(job: Job<RevolvingOriginationJob>): Promise<void> {
  const { loanId, institutionId, walletId, walletAddress, borrowAssetId } = job.data;
  const signingProvider = getSigningProvider();
  const algod = algorandService.client.client.algod;

  try {
    // Read loan counter for box pre-declaration
    const appInfo: any = await algod.getApplicationByID(LOAN_FACTORY_APP_ID).do();
    const gs = appInfo?.params?.globalState ?? [];
    const encoded = Buffer.from("loan_counter").toString("base64");
    const entry = gs.find((e: any) => Buffer.from(e.key).toString("base64") === encoded);
    const loanCounter = Number(entry?.value?.uint ?? 0n);
    const expectedOnchainId = loanCounter + 1;

    const suggestedParams = await algod.getTransactionParams().do();

    const origSelector = algosdk.ABIMethod.fromSignature("originate_revolving(uint64,uint64)uint64").getSelector();
    const assetIdArg = algosdk.ABIUintType.from("uint64").encode(BigInt(borrowAssetId));
    const initialDrawArg = algosdk.ABIUintType.from("uint64").encode(BigInt(0));

    const origTxn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: walletAddress,
      appIndex: LOAN_FACTORY_APP_ID,
      appArgs: [origSelector, assetIdArg, initialDrawArg],
      foreignApps: [LOAN_FACTORY_APP_ID, LENDING_POOL_APP_ID, CREDIT_ORACLE_APP_ID],
      foreignAssets: [borrowAssetId],
      suggestedParams: { ...suggestedParams, fee: 4000, flatFee: true },
    });
    (origTxn.applicationCall as any).boxes = [
      { appIndex: LOAN_FACTORY_APP_ID, name: encodeBoxName("l", expectedOnchainId) },
      { appIndex: LOAN_FACTORY_APP_ID, name: encodeAddressBoxName(walletAddress) },
      { appIndex: LOAN_FACTORY_APP_ID, name: encodeBoxName("r", borrowAssetId) },
      { appIndex: CREDIT_ORACLE_APP_ID, name: profileBoxName(walletAddress) },
    ];

    const [signed] = await Promise.all([
      signingProvider.signTransaction(walletId, algosdk.encodeUnsignedTransaction(origTxn)),
    ]);

    const txHash = await algorandService.submitSignedTransaction(signed);
    const confirmed = await waitForConfirm(txHash);

    // Parse onchain loan_id from ABI return log (handle both string and bytes logs)
    const logs: any[] = confirmed.logs ?? [];
    const onchainIdLog = logs.find((l: any) => {
      const s = typeof l === "string" ? l : Buffer.from(l).toString("hex");
      return s.length >= 12 && (s.startsWith("151f7c75") || s.startsWith("0x151f7c75"));
    });
    const logStr = typeof onchainIdLog === "string" ? onchainIdLog : Buffer.from(onchainIdLog ?? []).toString("hex");
    const onchainLoanId = onchainIdLog ? Number(BigInt("0x" + logStr.slice(8, 24))) : expectedOnchainId;

    await db.update(loans).set({ status: "active", onchainLoanId, txHash }).where(eq(loans.id, loanId));
    await db.insert(auditLog).values({
      institutionId, action: "loan.originated_onchain",
      details: { loanId, onchainLoanId, txHash },
    });

    console.log(`[revolving-origination] Confirmed: loan ${loanId}, onchain_id ${onchainLoanId}`);
  } catch (err: any) {
    await db.update(loans).set({ status: "failed_compensating" }).where(eq(loans.id, loanId));
    throw err;
  }
}

export function startRevolvingOriginationWorker(): Worker<RevolvingOriginationJob> {
  const worker = new Worker<RevolvingOriginationJob>("revolving-origination", processRevolvingOrigination, {
    connection: redisConnection, concurrency: 3, lockDuration: 200_000,
  });
  worker.on("failed", (job, err) => console.error(`[revolving-origination] job ${job?.id} failed:`, err.message));
  worker.on("completed", (job) => console.log(`[revolving-origination] job ${job.id} completed`));
  return worker;
}
