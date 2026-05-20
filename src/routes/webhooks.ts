import crypto from "crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { webhooks, webhookDeliveries } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { ApiError } from "../lib/errors.js";
import { encryptWebhookSecret } from "../services/webhook-crypto.js";

export async function webhooksRoutes(app: FastifyInstance) {
  // Inbound Didit webhook handler
  app.post("/didit", async (request: FastifyRequest, reply) => {
    const rawBody = (request as any).rawBody as Buffer;
    const signatureHeader = request.headers["x-signature-v2"] as string;

    const { getKybProvider } = await import("../services/kyb/index.js");
    const kybProvider = getKybProvider();

    const isValid = kybProvider.verifyWebhookSignature(rawBody, signatureHeader);
    if (!isValid) {
      return reply.status(401).send({ code: "INVALID_SIGNATURE", message: "Webhook signature verification failed" });
    }

    const payload = request.body as any;
    if (payload.event !== "business.status.updated") {
      return reply.status(200).send({});
    }

    const { session_id, status, business_session_id, details } = payload;
    const newStatus = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending";

    const { kybVerifications, institutions, auditLog } = await import("../db/schema.js");
    await db.update(kybVerifications)
      .set({ details: { webhookReceivedAt: new Date().toISOString(), ...details } })
      .where(eq(kybVerifications.diditSessionId, session_id));

    if (newStatus === "approved") {
      await db.update(institutions)
        .set({ status: "active" })
        .where(eq(institutions.id, business_session_id));
    }

    await db.insert(auditLog).values({
      institutionId: business_session_id,
      action: `kyb.${newStatus}`,
      details: { diditSessionId: session_id, status: newStatus },
    });

    return reply.status(200).send({});
  });

  // POST /v1/webhooks — Register a new outbound webhook
  app.post("/", {
    preHandler: [async (request: FastifyRequest, reply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      body: {
        type: "object",
        required: ["url", "events"],
        properties: {
          url: { type: "string", format: "uri", maxLength: 1024 },
          events: { type: "array", items: { type: "string" }, minItems: 1 },
          description: { type: "string", maxLength: 255 },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const { url, events, description } = request.body as any;
    const institutionId = request.institutionId;

    const rawSecret = crypto.randomBytes(32);
    const encryptedSecret = encryptWebhookSecret(rawSecret);

    const [row] = await db.insert(webhooks).values({
      institutionId,
      url,
      secret: encryptedSecret,
      events,
      description: description ?? null,
      isActive: true,
      signingKeyVersion: 1,
    }).returning();

    return {
      id: row.id,
      url: row.url,
      events: row.events,
      description: row.description,
      isActive: row.isActive,
      secret: rawSecret.toString("hex"),
      signingKeyVersion: row.signingKeyVersion,
      createdAt: row.createdAt.toISOString(),
    };
  });

  // GET /v1/webhooks — List webhooks
  app.get("/", {
    preHandler: [async (request: FastifyRequest, reply) => {
      await (request.server as any).authenticate(request, reply);
    }],
  }, async (request: FastifyRequest) => {
    const rows = await db.select().from(webhooks)
      .where(and(eq(webhooks.institutionId, request.institutionId), eq(webhooks.isActive, true)))
      .orderBy(webhooks.createdAt);

    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: r.events,
      description: r.description,
      isActive: r.isActive,
      signingKeyVersion: r.signingKeyVersion,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });

  // DELETE /v1/webhooks/:id — Deactivate a webhook
  app.delete("/:id", {
    preHandler: [async (request: FastifyRequest, reply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
  }, async (request: FastifyRequest) => {
    const { id } = request.params as any;

    const [existing] = await db.select().from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.institutionId, request.institutionId)))
      .limit(1);
    if (!existing) throw new ApiError("WEBHOOK_NOT_FOUND", "Webhook not found");

    await db.update(webhooks).set({ isActive: false, updatedAt: sql`now()` })
      .where(eq(webhooks.id, id));

    return { id, status: "deleted" };
  });

  // POST /v1/webhooks/:id/rotate-secret — Rotate signing secret with 24h grace period
  app.post("/:id/rotate-secret", {
    preHandler: [async (request: FastifyRequest, reply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
  }, async (request: FastifyRequest) => {
    const { id } = request.params as any;

    const [existing] = await db.select().from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.institutionId, request.institutionId)))
      .limit(1);
    if (!existing) throw new ApiError("WEBHOOK_NOT_FOUND", "Webhook not found");

    const rawSecret = crypto.randomBytes(32);
    const encryptedSecret = encryptWebhookSecret(rawSecret);

    // Store previous secret for 24h grace period
    const graceEnds = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.update(webhooks).set({
      previousSecret: existing.secret,
      previousSecretVersion: existing.signingKeyVersion,
      secret: encryptedSecret,
      signingKeyVersion: sql`${webhooks.signingKeyVersion} + 1`,
      gracePeriodEndsAt: graceEnds,
      updatedAt: sql`now()`,
    }).where(eq(webhooks.id, id));

    return {
      id,
      secret: rawSecret.toString("hex"),
      signingKeyVersion: (existing.signingKeyVersion ?? 0) + 1,
      previousSecretVersion: existing.signingKeyVersion ?? null,
      gracePeriodEndsAt: graceEnds.toISOString(),
    };
  });

  // GET /v1/webhooks/deliveries — List recent deliveries for the institution
  app.get("/deliveries", {
    preHandler: [async (request: FastifyRequest, reply) => {
      await (request.server as any).authenticate(request, reply);
    }],
  }, async (request: FastifyRequest) => {
    const rows = await db.select({
      id: webhookDeliveries.id,
      webhookId: webhookDeliveries.webhookId,
      eventType: webhookDeliveries.eventType,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
      dlqAt: webhookDeliveries.dlqAt,
      createdAt: webhookDeliveries.createdAt,
    })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .where(eq(webhooks.institutionId, request.institutionId))
      .orderBy(sql`${webhookDeliveries.createdAt} desc`)
      .limit(50);

    return rows.map((r) => ({
      ...r,
      dlqAt: r.dlqAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
