import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { loans, auditLog } from "../../db/schema.js";
import { webhookDeliveryQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { getSigningProvider } from "../../services/signing/index.js";
import { signWithGovernance } from "../../services/governance.js";
import { eq } from "drizzle-orm";

export interface TermOriginationJob {
  loanId: string; institutionId: string; walletId: string; walletAddress: string;
  borrowAssetId: number; borrowAmount: string; maturityRounds: number;
}

const LOAN_FACTORY_APP_ID = parseInt(process.env.LOAN_FACTORY_APP_ID ?? "762889354");
const LENDING_POOL_APP_ID = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID ?? "762889263");
const CREDIT_ORACLE_APP_ID = parseInt(process.env.CREDIT_ORACLE_APP_ID ?? "762892340");
const POOL_ASSET_ID = parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950");
const CONFIRM_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3000;
const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null, tls: {} });

function encodeBoxName(prefix: string, value: number): Uint8Array {
  const buf = new Uint8Array(9); buf[0] = prefix.charCodeAt(0);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(1, BigInt(value), false);
  return buf;
}
function encodeAddressBoxName(address: string): Uint8Array {
  const addr = algosdk.decodeAddress(address);
  const buf = new Uint8Array(33); buf[0] = 0x75; buf.set(addr.publicKey, 1);
  return buf;
}
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
function asBase64(v: any): string { return v instanceof Uint8Array ? Buffer.from(v).toString("base64") : String(v); }
async function readGlobalStateUint64(appId: number, key: string): Promise<number> {
  const appInfo = await (algorandService.client.client.algod as any).getApplicationByID(appId).do();
  for (const e of (appInfo?.params?.globalState ?? [])) {
    if (asBase64(e.key) === Buffer.from(key).toString("base64")) return Number(e.value?.uint ?? 0n);
  }
  return 0;
}

export async function processTermOrigination(job: Job<TermOriginationJob>): Promise<void> {
  const { loanId, institutionId, walletId, walletAddress, borrowAssetId, borrowAmount, maturityRounds } = job.data;
  const amountN = BigInt(borrowAmount);
  const signing = getSigningProvider();
  const algod = algorandService.client.client.algod;
  const deployerAddr = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!).addr.toString();

  try {
    const counter = await readGlobalStateUint64(LOAN_FACTORY_APP_ID, "loan_counter");
    const expectedId = counter + 1;
    const sp = await algod.getTransactionParams().do();

    const sel = algosdk.ABIMethod.fromSignature("originate_term(uint64,uint64,uint64)uint64").getSelector();
    const txn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: walletAddress, appIndex: LOAN_FACTORY_APP_ID,
      appArgs: [sel, algosdk.ABIUintType.from("uint64").encode(BigInt(borrowAssetId)),
               algosdk.ABIUintType.from("uint64").encode(amountN),
               algosdk.ABIUintType.from("uint64").encode(BigInt(maturityRounds))],
      foreignApps: [LOAN_FACTORY_APP_ID, LENDING_POOL_APP_ID, CREDIT_ORACLE_APP_ID],
      foreignAssets: [POOL_ASSET_ID],
      suggestedParams: { ...sp, fee: 4000, flatFee: true },
    });
    (txn.applicationCall as any).boxes = [
      { appIndex: LOAN_FACTORY_APP_ID, name: encodeBoxName("l", expectedId) },
      { appIndex: LOAN_FACTORY_APP_ID, name: encodeAddressBoxName(walletAddress) },
      { appIndex: LOAN_FACTORY_APP_ID, name: encodeBoxName("r", borrowAssetId) },
      // CreditOracle profile box needed for inner txn from LoanFactory → Oracle
      { appIndex: CREDIT_ORACLE_APP_ID, name: new Uint8Array([0x63, ...algosdk.decodeAddress(walletAddress).publicKey]) },
    ];

    const [signed] = await Promise.all([signing.signTransaction(walletId, algosdk.encodeUnsignedTransaction(txn))]);
    const txHash = await algorandService.submitSignedTransaction(signed);
    const confirmed = await waitForConfirm(txHash);

    // Parse ABI return for onchain loan_id
    const logs: any[] = confirmed.logs ?? [];
    const abiLog = typeof logs[0] === "string" ? logs[0] : Buffer.from(logs[0] ?? []).toString("hex");
    const onchainId = abiLog.startsWith("151f7c75") ? Number(BigInt("0x" + abiLog.slice(8, 24))) : expectedId;

    // Read maturity_round from LoanFactory box (offset 168 = 4+32+4+32+8+8+8+8+8+8+8+8+8+8+8+8+8+8)
    let maturityRound = 0;
    try {
      const boxName = encodeBoxName("l", onchainId);
      const boxResp = await (algod as any).getApplicationBoxByName(LOAN_FACTORY_APP_ID, boxName).do();
      const val: Uint8Array = boxResp.value;
      if (val.length >= 176) {
        maturityRound = Number(new DataView(val.buffer, val.byteOffset, val.byteLength).getBigUint64(168, false));
      }
    } catch { /* box readable only if confirmed */ }

    await db.update(loans).set({ status: "active", onchainLoanId: onchainId, maturityRound, txHash }).where(eq(loans.id, loanId));
    await db.insert(auditLog).values({ institutionId, action: "loan.originated", details: { loanId, onchainId, maturityRound, txHash } });

    // CreditOracle update
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
    } catch { /* non-fatal */ }

    await webhookDeliveryQueue.add("loan.originated", { event: "loan.originated", institutionId, payload: { loanId, txHash, amount: borrowAmount } });
    console.log(`[term-origination] ${loanId} onchain=${onchainId} maturity=${maturityRound}`);
  } catch (e: any) {
    await db.update(loans).set({ status: "failed_compensating" }).where(eq(loans.id, loanId));
    throw e;
  }
}

export function startTermOriginationWorker(): Worker<TermOriginationJob> {
  const w = new Worker<TermOriginationJob>("term-origination", processTermOrigination, { connection: redisConnection, concurrency: 3, lockDuration: 200_000 });
  w.on("failed", (j, e) => console.error(`[term-origination] job ${j?.id} failed:`, e.message));
  w.on("completed", (j) => console.log(`[term-origination] job ${j.id} completed`));
  return w;
}
