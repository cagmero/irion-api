import crypto from "crypto";
import { getSecret } from "../../lib/secrets.js";
import { db } from "../../db/index.js";
import { kybVerifications } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import type { KybProvider, KybSession, KybSessionStatus } from "./types.js";

export class MockKybProvider implements KybProvider {
  private webhookSecret: string;
  private delaySeconds: number;

  constructor() {
    this.webhookSecret = getSecret("MOCK_KYB_WEBHOOK_SECRET");
    this.delaySeconds = parseInt(process.env.KYB_MOCK_DELAY_SECONDS || "10", 10);
  }

  async createKybSession(institutionId: string, institutionName: string): Promise<KybSession> {
    const diditSessionId = crypto.randomUUID();
    const verificationUrl = `https://mock-kyb.local/verify/${diditSessionId}`;

    await db.insert(kybVerifications).values({
      institutionId,
      diditSessionId,
      status: "initiated",
      details: { institutionName },
    });

    await this.enqueueMockCompletion(institutionId, diditSessionId, institutionName);

    return { diditSessionId, verificationUrl };
  }

  async getSessionStatus(sessionId: string): Promise<KybSessionStatus> {
    const [record] = await db
      .select()
      .from(kybVerifications)
      .where(eq(kybVerifications.diditSessionId, sessionId));

    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return {
      status: record.status,
      details: (record.details as Record<string, unknown>) || {},
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
    if (!signatureHeader) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (signatureHeader.length !== expectedSignature.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expectedSignature)
    );
  }

  private async enqueueMockCompletion(
    institutionId: string,
    diditSessionId: string,
    institutionName: string
  ): Promise<void> {
    const { Queue } = await import("bullmq");
    const IORedis = (await import("ioredis")).default;

    const redisUrl = getSecret("REDIS_URL");
    if (!redisUrl.startsWith("redis://") && !redisUrl.startsWith("rediss://")) {
      throw new Error("REDIS_URL is missing or malformed. Must start with redis:// or rediss://");
    }

    const connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      tls: {},
    });

    const kybMockQueue = new Queue("kyb-mock-completion", { connection });

    await kybMockQueue.add("complete", {
      institutionId,
      diditSessionId,
      institutionName,
    }, {
      delay: this.delaySeconds * 1000,
    });
  }
}