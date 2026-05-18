import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getKybProvider } from "../services/kyb/index.js";
import { db } from "../db/index.js";
import { kybVerifications, institutions, auditLog } from "../db/schema.js";
import { eq } from "drizzle-orm";

export async function webhooksRoutes(app: FastifyInstance) {
  // Inbound Didit webhook handler
  app.post("/didit", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (request as any).rawBody as Buffer;
    const signatureHeader = request.headers["x-signature-v2"] as string;

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

  // Outbound webhook registration
  app.post("/", {
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
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (_request: FastifyRequest) => {
    return { id: "mock-webhook-id", status: "created" };
  });

  app.delete("/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    return { id: (request.params as { id: string }).id, status: "deleted" };
  });
}
