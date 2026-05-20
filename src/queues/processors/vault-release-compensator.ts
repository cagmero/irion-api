/**
 * Vault Release Compensator Worker
 *
 * Releases collateral from Vault when loan origination Step 2 fails
 * after Step 1 (collateral lock) succeeded.
 *
 * Idempotent: checks loan status on startup; if already released, exits.
 * If release_tx_hash exists but not confirmed, polls for confirmation instead of resubmitting.
 */

import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { loans, auditLog } from "../../db/schema.js";
import { algorandService } from "../../services/algorand.js";
import { signWithGovernance } from "../../services/governance.js";
import { eq } from "drizzle-orm";

export interface VaultReleaseJob {
  loanId: string;
  institutionId: string;
}

const VAULT_APP_ID = parseInt(process.env.VAULT_APP_ID ?? "762889316");
const CONFIRM_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3000;

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  tls: {},
});

async function waitForConfirm(txId: string): Promise<any> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const pending: any = await algorandService.client.client.algod.pendingTransactionInformation(txId).do();
      const round = pending["confirmed-round"];
      if (round && round > 0) return pending;
      if (pending["pool-error"]?.length > 0) throw new Error(`Release rejected: ${pending["pool-error"]}`);

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
  throw new Error(`Release tx ${txId} not confirmed within ${CONFIRM_TIMEOUT_MS}ms`);
}

export async function processVaultRelease(job: Job<VaultReleaseJob>): Promise<void> {
  const { loanId, institutionId } = job.data;

  const [loan] = await db.select().from(loans).where(eq(loans.id, loanId)).limit(1);
  if (!loan) throw new Error(`Loan ${loanId} not found`);

  // Idempotency: already released
  if (loan.status === "failed_released") {
    console.log(`[vault-release-compensator] Loan ${loanId} already released`);
    return;
  }

  // If release_tx_hash exists, poll instead of resubmitting
  if (loan.releaseTxHash) {
    console.log(`[vault-release-compensator] Release already submitted for ${loanId}, polling...`);
    try {
      await waitForConfirm(loan.releaseTxHash);
      await db.update(loans).set({ status: "failed_released" }).where(eq(loans.id, loanId));
      await db.insert(auditLog).values({
        institutionId, action: "loan.collateral_released",
        details: { loanId, releaseTxHash: loan.releaseTxHash },
      });
      return;
    } catch (err: any) {
      console.error(`[vault-release-compensator] Previous release failed:`, err.message);
      // Fall through to resubmit
    }
  }

  const vaultId = loan.vaultId;
  if (!vaultId) {
    console.error(`[vault-release-compensator] Loan ${loanId} has no vault_id — cannot release. Manual intervention required.`);
    throw new Error(`Cannot release collateral for loan ${loanId}: vault_id missing from loan row`);
  }

  // Build and submit Vault.release(vault_id) via governance bridge
  const algod = algorandService.client.client.algod;
  const suggestedParams = await algod.getTransactionParams().do();

  const releaseSelector = algosdk.ABIMethod.fromSignature("release(uint64)void").getSelector();
  const vaultIdArg = algosdk.ABIUintType.from("uint64").encode(BigInt(vaultId));

  const releaseParams = { ...suggestedParams, fee: 2000, flatFee: true };
  const releaseTxn = algosdk.makeApplicationNoOpTxnFromObject({
    sender: algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!).addr.toString(),
    appIndex: VAULT_APP_ID,
    appArgs: [releaseSelector, vaultIdArg],
    boxes: [
      { appIndex: VAULT_APP_ID, name: encodeBoxName("v", vaultId) },
    ],
    suggestedParams: releaseParams,
  });

  const signedRelease = await signWithGovernance(
    algosdk.encodeUnsignedTransaction(releaseTxn),
    async (action, details) => {
      await db.insert(auditLog).values({ institutionId, action, details: { ...details, loanId, vaultId } });
    },
  );

  const releaseTxId = await algorandService.submitSignedTransaction(signedRelease);

  try {
    await waitForConfirm(releaseTxId);

    await db.update(loans).set({
      status: "failed_released",
      releaseTxHash: releaseTxId,
    }).where(eq(loans.id, loanId));

    await db.insert(auditLog).values({
      institutionId, action: "loan.collateral_released",
      details: { loanId, vaultId, releaseTxHash: releaseTxId },
    });

    console.log(`[vault-release-compensator] Collateral released for loan ${loanId}, vault ${vaultId}, tx: ${releaseTxId}`);

  } catch (err: any) {
    // Record the tx hash so we don't resubmit on retry
    await db.update(loans).set({ releaseTxHash: releaseTxId }).where(eq(loans.id, loanId));

    await db.insert(auditLog).values({
      institutionId, action: "loan.collateral_release_failed",
      details: { loanId, vaultId, releaseTxHash: releaseTxId, error: err.message },
    });

    console.error(`[vault-release-compensator] Release failed for loan ${loanId}: ${err.message}`);
    throw err; // BullMQ retries
  }
}

function encodeBoxName(prefix: string, value: number): Uint8Array {
  const buf = new Uint8Array(1 + 8);
  buf[0] = prefix.charCodeAt(0);
  new DataView(buf.buffer).setBigUint64(1, BigInt(value), false);
  return buf;
}

export function startVaultReleaseCompensatorWorker(): Worker<VaultReleaseJob> {
  const worker = new Worker<VaultReleaseJob>(
    "vault-release-compensator", processVaultRelease, {
      connection: redisConnection, concurrency: 2, lockDuration: 120_000,
    }
  );
  worker.on("failed", (job, err) => console.error(`[vault-release-compensator] job ${job?.id} failed:`, err.message));
  worker.on("completed", (job) => console.log(`[vault-release-compensator] job ${job.id} completed`));
  return worker;
}
