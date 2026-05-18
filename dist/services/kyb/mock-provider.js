"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockKybProvider = void 0;
const crypto_1 = __importDefault(require("crypto"));
const secrets_js_1 = require("../../lib/secrets.js");
const index_js_1 = require("../../db/index.js");
const schema_js_1 = require("../../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
class MockKybProvider {
    webhookSecret;
    delaySeconds;
    constructor() {
        this.webhookSecret = (0, secrets_js_1.getSecret)("MOCK_KYB_WEBHOOK_SECRET");
        this.delaySeconds = parseInt(process.env.KYB_MOCK_DELAY_SECONDS || "10", 10);
    }
    async createKybSession(institutionId, institutionName) {
        const diditSessionId = crypto_1.default.randomUUID();
        const verificationUrl = `https://mock-kyb.local/verify/${diditSessionId}`;
        await index_js_1.db.insert(schema_js_1.kybVerifications).values({
            institutionId,
            diditSessionId,
            status: "initiated",
            details: { institutionName },
        });
        await this.enqueueMockCompletion(institutionId, diditSessionId, institutionName);
        return { diditSessionId, verificationUrl };
    }
    async getSessionStatus(sessionId) {
        const [record] = await index_js_1.db
            .select()
            .from(schema_js_1.kybVerifications)
            .where((0, drizzle_orm_1.eq)(schema_js_1.kybVerifications.diditSessionId, sessionId));
        if (!record) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        return {
            status: record.status,
            details: record.details || {},
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
    async enqueueMockCompletion(institutionId, diditSessionId, institutionName) {
        const { Queue } = await Promise.resolve().then(() => __importStar(require("bullmq")));
        const IORedis = (await Promise.resolve().then(() => __importStar(require("ioredis")))).default;
        const redisUrl = (0, secrets_js_1.getSecret)("UPSTASH_REDIS_REST_URL");
        const connection = new IORedis(redisUrl, {
            maxRetriesPerRequest: null,
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
exports.MockKybProvider = MockKybProvider;
//# sourceMappingURL=mock-provider.js.map