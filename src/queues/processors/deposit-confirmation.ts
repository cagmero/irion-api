/**
 * Deposit Confirmation Worker
 *
 * Polls algod for on-chain confirmation of a submitted deposit transaction.
 * On confirmation:
 *   1. Updates deposits.status → 'confirmed', confirmed_round (stored in txHash field)
 *   2. Upserts lending_positions for the institution
 *   3. Writes audit_log action 'deposit.confirmed'
 *   4. Enqueues outbound webhook 'deposit.confirmed'
 *
 * On timeout / pending: re-enqueues with delay (BullMQ handles via attempts + backoff)
 * On rejection:         marks deposit 'failed', writes audit, enqueues webhook
 */

import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { db } from "../../db/index.js";
import { deposits, lendingPositions, auditLog } from "../../db/schema.js";
import { webhookDeliveryQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { eq, and, sql } from "drizzle-orm";

export interface DepositConfirmationJob {
  depositId: string;
  txHash: string;
  institutionId: string;
  assetId: number;
  amount: string;    // string for bigint precision
}

const POLL_TIMEOUT_MS = 60_000;   // 60s per attempt before BullMQ retries
const POLL_INTERVAL_MS = 2_000;   // check every 2s within an attempt

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

async function processDepositConfirmation(job: Job<DepositConfirmationJob>): Promise<void> {
  const { depositId, txHash, institutionId, assetId, amount } = job.data;
  console.log(`[deposit-confirmation] Processing deposit ${depositId}, txHash: ${txHash}`);

  const algodClient = algorandService.client.client.algod;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  // Poll until confirmed, rejected, or timeout
  while (Date.now() < deadline) {
    let pending: any;
    try {
      // Try pending pool first, then fall back to indexer for confirmed txns.
      // IMPORTANT: algod pendingTransactionInformation only tracks the last ~1000 rounds.
      // For older confirmed transactions it returns {} with undefined fields (not a 404).
      // The indexer lookup is required as a fallback for any tx outside that window.
      try {
        pending = await algodClient.pendingTransactionInformation(txHash).do();
      } catch (pendingErr) {
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
    } catch (err: any) {
      // Transaction not found — may not have propagated to indexer yet, keep polling
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const confirmedRound = pending["confirmed-round"];
    const poolError = pending["pool-error"];

    if (confirmedRound && confirmedRound > 0) {
      // ── CONFIRMED ────────────────────────────────────────────────────────
      const amountN = BigInt(amount);

      // Upsert lending_positions: add deposit amount to existing balance
      await db
        .insert(lendingPositions)
        .values({
          institutionId,
          assetId,
          balance:      Number(amountN),
          accruedYield: 0,
        })
        .onConflictDoUpdate({
          target: [lendingPositions.institutionId, lendingPositions.assetId],
          set: {
            balance: sql`${lendingPositions.balance} + ${Number(amountN)}`,
            updatedAt: sql`now()`,
          },
        });

      // Update deposit status
      await db
        .update(deposits)
        .set({ status: "completed" })
        .where(eq(deposits.id, depositId));

      await db.insert(auditLog).values({
        institutionId,
        action: "deposit.confirmed",
        details: { depositId, txHash, confirmedRound, amount },
      });

      // Enqueue outbound webhook
      await webhookDeliveryQueue.add("deposit.confirmed", {
        event:         "deposit.confirmed",
        institutionId,
        payload: { depositId, txHash, amount, assetId, confirmedRound },
      });

      return;

    } else if (poolError && poolError.length > 0) {
      // ── REJECTED ─────────────────────────────────────────────────────────
      await db
        .update(deposits)
        .set({ status: "failed" })
        .where(eq(deposits.id, depositId));

      await db.insert(auditLog).values({
        institutionId,
        action: "deposit.failed",
        details: { depositId, txHash, poolError },
      });

      await webhookDeliveryQueue.add("deposit.failed", {
        event:         "deposit.failed",
        institutionId,
        payload: { depositId, txHash, error: poolError },
      });

      return;  // don't retry a rejected transaction
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Timeout: deposit stays in 'submitted' state, BullMQ retries the job
  // (up to 10 attempts over ~30 min — see queue config in queues/index.ts)
  throw new Error(`Deposit ${depositId} not confirmed within ${POLL_TIMEOUT_MS}ms — will retry`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Export factory for starting the worker (called from app entrypoint in production)
export function startDepositConfirmationWorker(): Worker<DepositConfirmationJob> {
  const worker = new Worker<DepositConfirmationJob>(
    "deposit-confirmation",
    processDepositConfirmation,
    {
      connection: redisConnection,
      concurrency: 5,
      lockDuration: 70_000, // Must be > POLL_TIMEOUT_MS (60s)
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[deposit-confirmation] job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[deposit-confirmation] job ${job.id} completed`);
  });

  return worker;
}
