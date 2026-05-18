"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhooksRoutes = webhooksRoutes;
const index_js_1 = require("../services/kyb/index.js");
const index_js_2 = require("../db/index.js");
const schema_js_1 = require("../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
async function webhooksRoutes(app) {
    // Inbound Didit webhook handler
    app.post("/didit", async (request, reply) => {
        const rawBody = request.rawBody;
        const signatureHeader = request.headers["x-signature-v2"];
        const kybProvider = (0, index_js_1.getKybProvider)();
        const isValid = kybProvider.verifyWebhookSignature(rawBody, signatureHeader);
        if (!isValid) {
            return reply.status(401).send({ code: "INVALID_SIGNATURE", message: "Webhook signature verification failed" });
        }
        const payload = request.body;
        if (payload.event !== "business.status.updated") {
            return reply.status(200).send({});
        }
        const { session_id, status, business_session_id, details } = payload;
        const newStatus = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending";
        await index_js_2.db.update(schema_js_1.kybVerifications)
            .set({ details: { webhookReceivedAt: new Date().toISOString(), ...details } })
            .where((0, drizzle_orm_1.eq)(schema_js_1.kybVerifications.diditSessionId, session_id));
        if (newStatus === "approved") {
            await index_js_2.db.update(schema_js_1.institutions)
                .set({ status: "active" })
                .where((0, drizzle_orm_1.eq)(schema_js_1.institutions.id, business_session_id));
        }
        await index_js_2.db.insert(schema_js_1.auditLog).values({
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
    }, async (_request) => {
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
    }, async (request) => {
        return { id: request.params.id, status: "deleted" };
    });
}
//# sourceMappingURL=webhooks.js.map