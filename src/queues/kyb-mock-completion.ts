import crypto from "crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "../../db/index.js";
import { kybVerifications, institutions, auditLog, webhooks } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { getSecret } from "../../lib/secrets.js";

interface KybMockCompletionJob {
  institutionId: string;
  diditSessionId: string;
  institutionName: string;
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl || (!redisUrl.startsWith("redis://") && !redisUrl.startsWith("rediss://"))) {
  throw new Error("REDIS_URL is missing or malformed. Must start with redis:// or rediss://");
}

// REFACTOR: Centralize ioredis config into src/lib/redis.ts — see DEFERRED.md "Tech Debt — Redis client centralization"
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

const webhookSecret = getSecret("MOCK_KYB_WEBHOOK_SECRET");
const apiBaseUrl = getSecret("API_BASE_URL");

export async function startKybMockWorker() {
  const worker = new Worker<KybMockCompletionJob>(
    "kyb-mock-completion",
    async (job) => {
      const { institutionId, diditSessionId, institutionName } = job.data;

      const nameLower = institutionName.toLowerCase();
      let status: "approved" | "rejected" | "pending";

      if (nameLower.includes("test reject") || nameLower.includes("fail")) {
        status = "rejected";
      } else if (nameLower.includes("test pending")) {
        status = "pending";
      } else {
        status = "approved";
      }

      await db.update(kybVerifications)
        .set({ 
          status,
          details: { mockCompletedAt: new Date().toISOString() }
        })
        .where(eq(kybVerifications.diditSessionId, diditSessionId));

      if (status === "approved") {
        await db.update(institutions)
          .set({ status: "active" })
          .where(eq(institutions.id, institutionId));
      }

      // Look up webhook URL for the institution
      const [webhookRecord] = await db
        .select({ url: webhooks.url })
        .from(webhooks)
        .where(and(
          eq(webhooks.institutionId, institutionId),
          eq(webhooks.isActive, true)
        ));
      
      const webhookUrl = webhookRecord?.url;

      const webhookPayload = {
        event: "business.status.updated",
        session_id: diditSessionId,
        status,
        business_session_id: institutionId,
        details: { institutionName, mockFlow: true },
      };

      const bodyStr = JSON.stringify(webhookPayload);
      const signature = crypto
        .createHmac("sha256", webhookSecret)
        .update(bodyStr)
        .digest("hex");

      if (webhookUrl) {
        await fetch(`${apiBaseUrl}/v1/webhooks/didit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-V2": signature,
          },
          body: bodyStr,
        });
      }

      await db.insert(auditLog).values({
        institutionId,
        action: `kyb.${status}`,
        details: { diditSessionId, status, mockFlow: true },
      });
    },
    { connection }
  );

  worker.on("completed", (job) => {
    console.log(`[kyb-mock] Completed job ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[kyb-mock] Failed job ${job?.id}:`, err.message);
  });

  return worker;
}