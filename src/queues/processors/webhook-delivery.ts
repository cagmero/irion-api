import crypto from "crypto";
import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { db } from "../../db/index.js";
import { webhooks, webhookDeliveries } from "../../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { decryptWebhookSecret } from "../../services/webhook-crypto.js";

export interface WebhookDeliveryJob {
  event: string;
  institutionId: string;
  payload: Record<string, unknown>;
}

const MAX_ATTEMPTS = 5;
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

const BACKOFF_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
// 1 min, 5 min, 15 min, 1 hour, 6 hours

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  tls: {},
});

export function computeNextRetry(attempt: number): Date {
  const idx = Math.max(0, Math.min(attempt - 1, BACKOFF_DELAYS_MS.length - 1));
  return new Date(Date.now() + BACKOFF_DELAYS_MS[idx]);
}

export function formatSignature(secret: Buffer, body: string, timestamp: number): string {
  const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

export async function deliverToWebhook(
  wh: typeof webhooks.$inferSelect,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify({ event, institutionId: wh.institutionId, payload });
  const now = Date.now();
  const ts = Math.floor(now / 1000);

  const currentSecret = decryptWebhookSecret(wh.secret as Buffer);
  const signature = formatSignature(currentSecret, body, ts);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Irion-Signature": signature,
    "Irion-Event": event,
    "Irion-Timestamp": new Date(now).toISOString(),
    "Idempotency-Key": deliveryId,
  };

  // Dual-sign during grace period (both old and new key versions)
  if (wh.previousSecret && wh.gracePeriodEndsAt && new Date() < wh.gracePeriodEndsAt) {
    const oldSecret = decryptWebhookSecret(wh.previousSecret as Buffer);
    const oldSig = crypto.createHmac("sha256", oldSecret).update(`${ts}.${body}`).digest("hex");
    headers["Irion-Signature"] = `t=${ts},v1=${signature.split(",")[1].split("=")[1]},v0=${oldSig}`;
  }

  const res = await fetch(wh.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "no body");
    throw new Error(`Webhook ${wh.url} returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function processWebhookDelivery(job: Job<WebhookDeliveryJob>): Promise<void> {
  const { event, institutionId, payload } = job.data;

  const activeWebhooks = await db
    .select()
    .from(webhooks)
    .where(and(
      eq(webhooks.institutionId, institutionId),
      eq(webhooks.isActive, true),
      sql`${event} = ANY(${webhooks.events})`,
    ));

  if (activeWebhooks.length === 0) {
    console.log(`[webhook-delivery] No active webhooks for ${institutionId} event ${event}`);
    return;
  }

  const attemptNum = (job.attemptsAttempted ?? 0) + 1;

  const results = await Promise.allSettled(
    activeWebhooks.map(async (wh) => {
      const deliveryId = crypto.randomUUID();
      try {
        await deliverToWebhook(wh, event, payload);
        await db.insert(webhookDeliveries).values({
          id: deliveryId,
          webhookId: wh.id,
          eventType: event,
          payload: payload as any,
          status: "delivered",
          attempts: attemptNum,
        });
        console.log(`[webhook-delivery] Delivered ${event} -> ${wh.url} (${deliveryId})`);
      } catch (err: any) {
        const errorMsg = err.message ?? String(err);
        console.error(`[webhook-delivery] Failed ${event} -> ${wh.url}: ${errorMsg}`);
        const isDlq = attemptNum >= MAX_ATTEMPTS;
        const nextRetry = isDlq ? null : computeNextRetry(attemptNum);

        await db.insert(webhookDeliveries).values({
          id: deliveryId,
          webhookId: wh.id,
          eventType: event,
          payload: payload as any,
          status: isDlq ? "failed" : "pending",
          attempts: attemptNum,
          lastError: errorMsg,
          dlqAt: isDlq ? sql`now()` : null,
          nextRetryAt: nextRetry,
        });

        if (isDlq) {
          console.error(`[webhook-delivery] DLQ ${wh.url} after ${MAX_ATTEMPTS} attempts`);
        }
        throw err;
      }
    }),
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    const first = (failures[0] as PromiseRejectedResult).reason;
    throw new Error(`Webhook delivery failed for ${failures.length}/${activeWebhooks.length} endpoints: ${first.message}`);
  }
}

export function startWebhookDeliveryWorker(): Worker<WebhookDeliveryJob> {
  const worker = new Worker<WebhookDeliveryJob>(
    "webhook-delivery",
    processWebhookDelivery,
    {
      connection: redisConnection,
      concurrency: 10,
      lockDuration: 30_000,
    },
  );

  worker.on("completed", (job) => {
    console.log(`[webhook-delivery] job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[webhook-delivery] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
