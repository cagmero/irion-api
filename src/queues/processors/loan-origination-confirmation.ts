/**
 * Loan Origination Confirmation Worker
 *
 * Polls algod for on-chain confirmation of the LoanFactory.originate_overcollateralized txn.
 * On confirmation: marks loan active, upserts borrowing_positions, emits webhook.
 * On timeout/retry: BullMQ handles via exponential backoff.
 * On rejection: marks loan failed, enqueues compensator.
 */

import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { db } from "../../db/index.js";
import { loans, borrowingPositions, auditLog } from "../../db/schema.js";
import { vaultReleaseCompensatorQueue, webhookDeliveryQueue } from "../index.js";
import { algorandService } from "../../services/algorand.js";
import { eq, and, sql } from "drizzle-orm";

export interface LoanOriginationConfirmJob {
  loanId: string;
  institutionId: string;
  txHash: string;
  assetId: number;
  borrowAmount: string;
}

const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2000;

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  tls: {},
});

export async function processLoanOriginationConfirm(job: Job<LoanOriginationConfirmJob>): Promise<void> {
  const { loanId, institutionId, txHash, assetId, borrowAmount } = job.data;
  const algod = algorandService.client.client.algod;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let pending: any;
    try {
      try {
        pending = await algod.pendingTransactionInformation(txHash).do();
      } catch {
        const indexer = algorandService.client.client.indexer;
        const resp = await indexer.lookupTransactionByID(txHash).do();
        pending = resp.transaction;
        if (pending && pending.confirmedRound) {
          pending["confirmed-round"] = Number(pending.confirmedRound);
        }
      }

      if (pending && pending["confirmed-round"] === undefined && pending["pool-error"] === undefined) {
        const indexer = algorandService.client.client.indexer;
        const resp = await indexer.lookupTransactionByID(txHash).do();
        pending = resp.transaction;
        if (pending && pending.confirmedRound) {
          pending["confirmed-round"] = Number(pending.confirmedRound);
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    const confirmedRound = pending["confirmed-round"];
    const poolError = pending["pool-error"];

    if (confirmedRound && confirmedRound > 0) {
      // ── CONFIRMED ──────────────────────────────────────────────────────────
      const borrowN = Number(BigInt(borrowAmount));

      // Hard invariant: vault_id must be set on loan before marking active
      const [loanBefore] = await db.select({ vaultId: loans.vaultId }).from(loans).where(eq(loans.id, loanId)).limit(1);
      if (!loanBefore || !loanBefore.vaultId || loanBefore.vaultId === 0) {
        const Sentry = await import("@sentry/node").catch(() => null);
        if (Sentry) Sentry.captureMessage("Loan invariant violation: vault_id=0", { level: "fatal", extra: { loanId }});
        await db.insert(auditLog).values({
          institutionId, action: "loan.invariant_violation",
          details: { loanId, txHash, issue: "vault_id is 0 — collateral reference lost" },
        });
        throw new Error("Invariant violation: cannot mark loan active with vault_id=0");
      }

      // Upsert borrowing_positions
      await db
        .insert(borrowingPositions)
        .values({ institutionId, assetId, balance: borrowN, accruedInterest: 0 })
        .onConflictDoUpdate({
          target: [borrowingPositions.institutionId, borrowingPositions.assetId],
          set: {
            balance: sql`${borrowingPositions.balance} + ${borrowN}`,
            updatedAt: sql`now()`,
          },
        });

      // Update loan: active
      await db.update(loans).set({
        status: "active",
        originatedAt: sql`now()`,
      }).where(eq(loans.id, loanId));

      await db.insert(auditLog).values({
        institutionId, action: "loan.active",
        details: { loanId, txHash, confirmedRound, borrowAmount },
      });

      await webhookDeliveryQueue.add("loan.originated", {
        event: "loan.originated",
        institutionId,
        payload: { loanId, txHash, amount: borrowAmount, assetId, confirmedRound },
      });

      return;

    } else if (poolError && poolError.length > 0) {
      // ── REJECTED ───────────────────────────────────────────────────────────
      await db.update(loans).set({ status: "failed_compensating" }).where(eq(loans.id, loanId));
      await db.insert(auditLog).values({
        institutionId, action: "loan.rejected",
        details: { loanId, txHash, poolError },
      });

      await vaultReleaseCompensatorQueue.add("vault-release-compensator", { loanId, institutionId });

      await webhookDeliveryQueue.add("loan.rejected", {
        event: "loan.rejected",
        institutionId,
        payload: { loanId, txHash, poolError },
      });

      return;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Loan origination ${loanId} not confirmed within ${POLL_TIMEOUT_MS}ms — will retry`);
}

export function startLoanOriginationConfirmWorker(): Worker<LoanOriginationConfirmJob> {
  const worker = new Worker<LoanOriginationConfirmJob>(
    "loan-origination-confirm", processLoanOriginationConfirm, {
      connection: redisConnection, concurrency: 5, lockDuration: 70_000,
    }
  );
  worker.on("failed", (job, err) => console.error(`[loan-origination-confirm] job ${job?.id} failed:`, err.message));
  worker.on("completed", (job) => console.log(`[loan-origination-confirm] job ${job.id} completed`));
  return worker;
}
