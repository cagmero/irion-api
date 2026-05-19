/**
 * Withdrawal Confirmation Worker
 *
 * Polls algod for on-chain confirmation of a submitted withdrawal transaction.
 * On confirmation:
 *   1. Updates withdrawals.status → 'completed'
 *   2. Decrements lending_positions.balance by withdrawal amount
 *   3. Writes audit_log action 'withdrawal.confirmed'
 *   4. Enqueues outbound webhook 'withdrawal.confirmed'
 *
 * On timeout / pending: re-enqueues with delay (BullMQ handles via attempts + backoff)
 * On rejection:         marks withdrawal 'failed', writes audit, enqueues webhook
 */

import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { db } from "../../db/index.js";
import { withdrawals, lendingPositions, auditLog } from "../../db/schema.js";
import { webhookDeliveryQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { eq, and, sql } from "drizzle-orm";

export interface WithdrawalConfirmationJob {
  withdrawalId: string;
  txHash: string;
  institutionId: string;
  assetId: number;
  amount: string;    // string for bigint precision
}

const POLL_TIMEOUT_MS = 60_000;   // 60s per attempt before BullMQ retries
const POLL_INTERVAL_MS = 2_000;   // check every 2s within an attempt

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  tls: {},
});

export async function processWithdrawalConfirmation(job: Job<WithdrawalConfirmationJob>): Promise<void> {
  const { withdrawalId, txHash, institutionId, assetId, amount } = job.data;

  const algodClient = algorandService.client.client.algod;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  // Poll until confirmed, rejected, or timeout
  // IMPORTANT: algod pendingTransactionInformation only tracks the last ~1000 rounds.
  // For older confirmed transactions it returns {} with undefined fields (not a 404).
  // The indexer lookup is required as a fallback for any tx outside that window.
  while (Date.now() < deadline) {
    let pending: any;
    try {
      try {
        pending = await algodClient.pendingTransactionInformation(txHash).do();
      } catch {
        // Transaction not in pending pool — use indexer for confirmed transactions
        const indexerClient = algorandService.client.client.indexer;
        const resp = await indexerClient.lookupTransactionByID(txHash).do();
        pending = resp.transaction;
        // Indexer uses camelCase (confirmedRound as BigInt), algod uses kebab-case
        if (pending && pending.confirmedRound) {
          pending["confirmed-round"] = Number(pending.confirmedRound);
        }
      }

      // Empty-response check: algod returns {} for txns outside the ~1000-round window.
      // If both fields are undefined, fall back to indexer.
      if (pending && pending["confirmed-round"] === undefined && pending["pool-error"] === undefined) {
        const indexerClient = algorandService.client.client.indexer;
        const resp = await indexerClient.lookupTransactionByID(txHash).do();
        pending = resp.transaction;
        if (pending && pending.confirmedRound) {
          pending["confirmed-round"] = Number(pending.confirmedRound);
        }
      }
    } catch {
      // Transaction not found — may not have propagated to indexer yet, keep polling
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const confirmedRound = pending["confirmed-round"];
    const poolError = pending["pool-error"];

    if (confirmedRound && confirmedRound > 0) {
      // ── CONFIRMED ────────────────────────────────────────────────────────
      const amountN = BigInt(amount);

      // Decrement lending_positions balance
      await db
        .update(lendingPositions)
        .set({
          balance: sql`GREATEST(${lendingPositions.balance} - ${Number(amountN)}, 0)`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(lendingPositions.institutionId, institutionId), eq(lendingPositions.assetId, assetId)));

      // Update withdrawal status
      await db
        .update(withdrawals)
        .set({ status: "completed" })
        .where(eq(withdrawals.id, withdrawalId));

      await db.insert(auditLog).values({
        institutionId,
        action: "withdrawal.confirmed",
        details: { withdrawalId, txHash, confirmedRound, amount },
      });

      // Enqueue outbound webhook
      await webhookDeliveryQueue.add("withdrawal.confirmed", {
        event:         "withdrawal.confirmed",
        institutionId,
        payload: { withdrawalId, txHash, amount, assetId, confirmedRound },
      });

      return;

    } else if (poolError && poolError.length > 0) {
      // ── REJECTED ─────────────────────────────────────────────────────────
      await db
        .update(withdrawals)
        .set({ status: "failed" })
        .where(eq(withdrawals.id, withdrawalId));

      await db.insert(auditLog).values({
        institutionId,
        action: "withdrawal.rejected",
        details: { withdrawalId, txHash, poolError },
      });

      await webhookDeliveryQueue.add("withdrawal.rejected", {
        event:         "withdrawal.rejected",
        institutionId,
        payload: { withdrawalId, txHash, poolError },
      });

      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Timeout — throw so BullMQ retries
  throw new Error(`Withdrawal ${withdrawalId} not confirmed within ${POLL_TIMEOUT_MS}ms — will retry`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Export factory for starting the worker
export function startWithdrawalConfirmationWorker(): Worker<WithdrawalConfirmationJob> {
  const worker = new Worker<WithdrawalConfirmationJob>(
    "withdrawal-confirmation",
    processWithdrawalConfirmation,
    {
      connection: redisConnection,
      concurrency: 5,
      lockDuration: 70_000, // Must be > POLL_TIMEOUT_MS (60s)
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[withdrawal-confirmation] job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[withdrawal-confirmation] job ${job.id} completed`);
  });

  return worker;
}
