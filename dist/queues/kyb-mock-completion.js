"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startKybMockWorker = startKybMockWorker;
const crypto_1 = __importDefault(require("crypto"));
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const index_js_1 = require("../../db/index.js");
const schema_js_1 = require("../../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
const secrets_js_1 = require("../../lib/secrets.js");
const connection = new ioredis_1.default(process.env.UPSTASH_REDIS_REST_URL, {
    maxRetriesPerRequest: null,
});
const webhookSecret = (0, secrets_js_1.getSecret)("MOCK_KYB_WEBHOOK_SECRET");
const apiBaseUrl = (0, secrets_js_1.getSecret)("API_BASE_URL");
async function startKybMockWorker() {
    const worker = new bullmq_1.Worker("kyb-mock-completion", async (job) => {
        const { institutionId, diditSessionId, institutionName } = job.data;
        const nameLower = institutionName.toLowerCase();
        let status;
        if (nameLower.includes("test reject") || nameLower.includes("fail")) {
            status = "rejected";
        }
        else if (nameLower.includes("test pending")) {
            status = "pending";
        }
        else {
            status = "approved";
        }
        await index_js_1.db.update(schema_js_1.kybVerifications)
            .set({
            status,
            details: { mockCompletedAt: new Date().toISOString() }
        })
            .where((0, drizzle_orm_1.eq)(schema_js_1.kybVerifications.diditSessionId, diditSessionId));
        if (status === "approved") {
            await index_js_1.db.update(schema_js_1.institutions)
                .set({ status: "active" })
                .where((0, drizzle_orm_1.eq)(schema_js_1.institutions.id, institutionId));
        }
        // Look up webhook URL for the institution
        const [webhookRecord] = await index_js_1.db
            .select({ url: schema_js_1.webhooks.url })
            .from(schema_js_1.webhooks)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.webhooks.institutionId, institutionId), (0, drizzle_orm_1.eq)(schema_js_1.webhooks.isActive, true)));
        const webhookUrl = webhookRecord?.url;
        const webhookPayload = {
            event: "business.status.updated",
            session_id: diditSessionId,
            status,
            business_session_id: institutionId,
            details: { institutionName, mockFlow: true },
        };
        const bodyStr = JSON.stringify(webhookPayload);
        const signature = crypto_1.default
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
        await index_js_1.db.insert(schema_js_1.auditLog).values({
            institutionId,
            action: `kyb.${status}`,
            details: { diditSessionId, status, mockFlow: true },
        });
    }, { connection });
    worker.on("completed", (job) => {
        console.log(`[kyb-mock] Completed job ${job.id}`);
    });
    worker.on("failed", (job, err) => {
        console.error(`[kyb-mock] Failed job ${job?.id}:`, err.message);
    });
    return worker;
}
//# sourceMappingURL=kyb-mock-completion.js.map