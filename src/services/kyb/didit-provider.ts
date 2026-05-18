// FUTURE — not used in MVP
// TODO(phase 3): activate when Didit paid tier ($2/session) is provisioned
// Alternative providers to evaluate: Sumsub ($1.50-3/session), Veriff, Persona
// Composite free option: OpenCorporates + OpenSanctions + Companies House + SEC EDGAR

import crypto from "crypto";
import { getSecret } from "../../lib/secrets.js";
import { db } from "../../db/index.js";
import { kybVerifications } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import type { KybProvider, KybSession, KybSessionStatus } from "./types.js";

export class DiditKybProvider implements KybProvider {
  private baseUrl: string;
  private apiKey: string;
  private workflowId: string;
  private webhookSecret: string;

  constructor() {
    this.baseUrl = getSecret("DIDIT_API_BASE_URL");
    this.apiKey = getSecret("DIDIT_API_KEY");
    this.workflowId = getSecret("DIDIT_WORKFLOW_ID");
    this.webhookSecret = getSecret("DIDIT_WEBHOOK_SECRET");
  }

  async createKybSession(institutionId: string, institutionName: string): Promise<KybSession> {
    const response = await fetch(`${this.baseUrl}/v3/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        workflow_id: this.workflowId,
        reference_id: institutionId,
        metadata: { institutionName },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Didit API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    await db.insert(kybVerifications).values({
      institutionId,
      diditSessionId: data.session_id,
      status: "initiated",
      details: { institutionName, diditResponse: data },
    });

    return {
      diditSessionId: data.session_id,
      verificationUrl: data.verification_url,
    };
  }

  async getSessionStatus(sessionId: string): Promise<KybSessionStatus> {
    const response = await fetch(`${this.baseUrl}/v3/session/${sessionId}`, {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Didit API error: ${response.statusText}`);
    }

    const data = await response.json();

    const statusMap: Record<string, KybSessionStatus["status"]> = {
      initiated: "initiated",
      pending: "pending",
      approved: "approved",
      rejected: "rejected",
    };

    return {
      status: statusMap[data.status] || "pending",
      details: data,
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
}