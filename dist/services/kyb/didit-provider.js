"use strict";
// FUTURE — not used in MVP
// TODO(phase 3): activate when Didit paid tier ($2/session) is provisioned
// Alternative providers to evaluate: Sumsub ($1.50-3/session), Veriff, Persona
// Composite free option: OpenCorporates + OpenSanctions + Companies House + SEC EDGAR
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiditKybProvider = void 0;
const crypto_1 = __importDefault(require("crypto"));
const secrets_js_1 = require("../../lib/secrets.js");
const index_js_1 = require("../../db/index.js");
const schema_js_1 = require("../../db/schema.js");
class DiditKybProvider {
    baseUrl;
    apiKey;
    workflowId;
    webhookSecret;
    constructor() {
        this.baseUrl = (0, secrets_js_1.getSecret)("DIDIT_API_BASE_URL");
        this.apiKey = (0, secrets_js_1.getSecret)("DIDIT_API_KEY");
        this.workflowId = (0, secrets_js_1.getSecret)("DIDIT_WORKFLOW_ID");
        this.webhookSecret = (0, secrets_js_1.getSecret)("DIDIT_WEBHOOK_SECRET");
    }
    async createKybSession(institutionId, institutionName) {
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
        await index_js_1.db.insert(schema_js_1.kybVerifications).values({
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
    async getSessionStatus(sessionId) {
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
        const statusMap = {
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
    verifyWebhookSignature(rawBody, signatureHeader) {
        if (!signatureHeader) {
            return false;
        }
        const expectedSignature = crypto_1.default
            .createHmac("sha256", this.webhookSecret)
            .update(rawBody)
            .digest("hex");
        if (signatureHeader.length !== expectedSignature.length) {
            return false;
        }
        return crypto_1.default.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature));
    }
}
exports.DiditKybProvider = DiditKybProvider;
//# sourceMappingURL=didit-provider.js.map