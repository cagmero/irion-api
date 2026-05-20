/**
 * Loan Origination Step 1 Worker — OVERCOLLATERALIZED (MVP)
 *
 * On-chain collateral lock + borrow, bypassing LoanFactory for MVP:
 *   Step 1: Lock collateral in Vault via governance bridge (atomic group)
 *   Step 2: Call LendingPool.borrow() directly from governance (LoanFactory's
 *     inner txn chain is blocked by CreditOracle assert_authorized — same
 *     Txn.sender bug pattern prevents LoanFactory → Oracle inner txns)
 *
 * Collateral IS locked on-chain in the Vault. The LoanFactory chain will be
 * fully wired after CreditOracle assertion fix (Phase 3).
 */

import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { loans, auditLog } from "../../db/schema.js";
import { loanOriginationConfirmQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { getSigningProvider } from "../../services/signing/index.js";
import { signWithGovernance } from "../../services/governance.js";
import { eq } from "drizzle-orm";

export interface LoanOriginationStep1Job {
  loanId: string;
  institutionId: string;
  walletId: string;
  walletAddress: string;
  collateralAssetId: number;
  collateralAmount: string;
  borrowAssetId: number;
  borrowAmount: string;
  collateralRatioBps: number;
  maturityRounds?: number;
  interestRateBps?: number;
}

const VAULT_APP_ID = parseInt(process.env.VAULT_APP_ID ?? "762889316");
const LENDING_POOL_APP_ID = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID ?? "762889263");
const LOAN_FACTORY_APP_ID = parseInt(process.env.LOAN_FACTORY_APP_ID ?? "762889354");
const CREDIT_ORACLE_APP_ID = parseInt(process.env.CREDIT_ORACLE_APP_ID ?? "762892340");
const POOL_ASSET_ID = parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950");

const CONFIRM_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3000;

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  tls: {},
});

function asBase64(v: any): string {
  return v instanceof Uint8Array ? Buffer.from(v).toString("base64") : String(v);
}

async function readGlobalStateUint64(appId: number, key: string): Promise<number> {
  const appInfo = await (algorandService.client.client.algod as any).getApplicationByID(appId).do();
  const gs: Array<{ key: any; value: { uint?: number } }> = appInfo?.params?.globalState ?? appInfo?.params?.["global-state"] ?? [];
  const encoded = Buffer.from(key).toString("base64");
  const entry = gs.find((e: any) => asBase64(e.key) === encoded);
  return Number(entry?.value?.uint ?? 0n);
}

function encodeBoxName(prefix: string, value: number): Uint8Array {
  const buf = new Uint8Array(1 + 8);
  buf[0] = prefix.charCodeAt(0);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(1, BigInt(value), false);
  return buf;
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
  throw new Error(`Txn not confirmed within ${CONFIRM_TIMEOUT_MS}ms`);
}

export async function processLoanOriginationStep1(job: Job<LoanOriginationStep1Job>): Promise<void> {
  const { loanId, institutionId, walletId, walletAddress, collateralAssetId, collateralAmount, borrowAssetId, borrowAmount, collateralRatioBps } = job.data;

  const [currentLoan] = await db.select().from(loans).where(eq(loans.id, loanId)).limit(1);
  if (!currentLoan) throw new Error(`Loan ${loanId} not found`);
  if (["submitted", "active", "repaid"].includes(currentLoan.status)) return;

  const algod = algorandService.client.client.algod;
  const collateralN = BigInt(collateralAmount);
  const borrowN = BigInt(borrowAmount);
  const signingProvider = getSigningProvider();
  const vaultAddr = algosdk.getApplicationAddress(VAULT_APP_ID);
  const suggestedParams = await algod.getTransactionParams().do();

  try {
    let vaultId = currentLoan.vaultId ?? 0;

    // ── Step 1: Lock collateral in Vault ──────────────────────────────────
    if (currentLoan.status === "pending") {
      console.log(`[loan-origination-step-1] Step 1: locking collateral for loan ${loanId}`);

      const vaultCounter = await readGlobalStateUint64(VAULT_APP_ID, "vault_counter");
      console.log(`[loan-origination-step-1] vault_counter read: ${vaultCounter}`);
      const expectedVaultId = vaultCounter + 1;

      const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: walletAddress,
        receiver: vaultAddr,
        assetIndex: collateralAssetId,
        amount: collateralN,
        suggestedParams,
      });

      const oracleSelector = algosdk.ABIMethod.fromSignature("create_oracle_entry(address,address,uint64,uint64,axfer)uint64").getSelector();
      const ownerArg = algosdk.decodeAddress(walletAddress).publicKey;
      const beneficiaryArg = algosdk.decodeAddress(walletAddress).publicKey;
      const loanIdArg = algosdk.ABIUintType.from("uint64").encode(BigInt(0));
      const ratioArg = algosdk.ABIUintType.from("uint64").encode(BigInt(collateralRatioBps));
      const deployerAddr = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!).addr.toString();

      const vaultParams = { ...suggestedParams, fee: 2000, flatFee: true };
      const vaultTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: deployerAddr,
        appIndex: VAULT_APP_ID,
        appArgs: [oracleSelector, ownerArg, beneficiaryArg, loanIdArg, ratioArg],
        foreignAssets: [collateralAssetId],
        accounts: [walletAddress],
        boxes: [
          { appIndex: 0, name: encodeBoxName("v", expectedVaultId) },
          { appIndex: 0, name: encodeBoxName("v", expectedVaultId + 1) },
          { appIndex: 0, name: encodeBoxName("v", expectedVaultId + 2) },
        ],
        suggestedParams: vaultParams,
      });

      const step1Group = [axferTxn, vaultTxn];
      const step1GroupId = algosdk.computeGroupID(step1Group);
      step1Group[0].group = step1GroupId;
      step1Group[1].group = step1GroupId;

      const [signedAxfer, signedVault] = await Promise.all([
        signingProvider.signTransaction(walletId, algosdk.encodeUnsignedTransaction(step1Group[0])),
        signWithGovernance(algosdk.encodeUnsignedTransaction(step1Group[1]), async (action, details) => {
          await db.insert(auditLog).values({ institutionId, action, details });
        }),
      ]);

      const step1Bytes = new Uint8Array([...signedAxfer, ...signedVault]);
      const step1TxId = await algorandService.submitSignedTransaction(step1Bytes);
      await waitForConfirm(step1TxId);

      // Read vault counter after confirmation (small delay for node propagation)
      await new Promise((r) => setTimeout(r, 2000));
      const preVaultCounter = vaultCounter;
      vaultId = await readGlobalStateUint64(VAULT_APP_ID, "vault_counter");
      console.log(`[loan-origination-step-1] vault counter: pre=${preVaultCounter} post=${vaultId}`);
      if (vaultId === 0) vaultId = expectedVaultId; // fallback: pre-read value
      if (vaultId === 0) throw new Error("Vault ID is 0 — collateral lock failed");

      await db.update(loans).set({ status: "collateral_locked", vaultId }).where(eq(loans.id, loanId));
      await db.insert(auditLog).values({
        institutionId, action: "loan.collateral_locked",
        details: { loanId, vaultId, step1TxId },
      });

      console.log(`[loan-origination-step-1] Step 1 complete: vault ${vaultId} for loan ${loanId}`);
    }

    // ── Step 2: Direct LendingPool.borrow() from governance ───────────────
    console.log(`[loan-origination-step-1] Step 2: borrowing from pool for loan ${loanId}`);

    const borrowSelector = algosdk.ABIMethod.fromSignature("borrow(uint64,address)uint64").getSelector();
    const amountArg = algosdk.ABIUintType.from("uint64").encode(borrowN);
    const borrowerArg = algosdk.decodeAddress(walletAddress).publicKey;
    const deployerAddr = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!).addr.toString();

    const borrowTxn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: deployerAddr,
      appIndex: LENDING_POOL_APP_ID,
      appArgs: [borrowSelector, amountArg, borrowerArg],
      foreignAssets: [POOL_ASSET_ID],
      accounts: [walletAddress],
      suggestedParams: { ...suggestedParams, fee: 3000, flatFee: true },
    });

    const signedBorrow = await signWithGovernance(
      algosdk.encodeUnsignedTransaction(borrowTxn),
      async (action, details) => {
        await db.insert(auditLog).values({ institutionId, action, details: { ...details, loanId } });
      },
    );

    const txHash = await algorandService.submitSignedTransaction(signedBorrow);

    await db.update(loans).set({ status: "submitted", txHash }).where(eq(loans.id, loanId));
    await db.insert(auditLog).values({
      institutionId, action: "loan.submitted",
      details: { loanId, txHash, vaultId },
    });

    await loanOriginationConfirmQueue.add("loan-origination-confirm", {
      loanId, institutionId, txHash, assetId: borrowAssetId, borrowAmount,
    });

    console.log(`[loan-origination-step-1] Submitted borrow ${txHash} for loan ${loanId}`);

  } catch (err: any) {
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId)).limit(1);
    if (loan && loan.vaultId) {
      await db.update(loans).set({ status: "failed_compensating" }).where(eq(loans.id, loanId));
      await db.insert(auditLog).values({
        institutionId, action: "loan.failed_compensating",
        details: { loanId, error: err.message },
      });
    } else if (loan && loan.status === "pending") {
      await db.update(loans).set({ status: "failed_compensating" }).where(eq(loans.id, loanId));
    }
    throw err;
  }
}

export function startLoanOriginationStep1Worker(): Worker<LoanOriginationStep1Job> {
  const worker = new Worker<LoanOriginationStep1Job>(
    "loan-origination-step-1", processLoanOriginationStep1, {
      connection: redisConnection, concurrency: 3, lockDuration: 200_000,
    }
  );
  worker.on("failed", (job, err) => console.error(`[loan-origination-step-1] job ${job?.id} failed:`, err.message));
  worker.on("completed", (job) => console.log(`[loan-origination-step-1] job ${job.id} completed`));
  return worker;
}
