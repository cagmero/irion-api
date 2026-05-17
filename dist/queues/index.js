"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.settlementQueue = exports.kybPollQueue = exports.loanOriginationQueue = exports.webhookDeliveryQueue = void 0;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
// In production, you would use a standard REDIS_URL for BullMQ. 
// Note: BullMQ requires a standard Redis connection (not REST).
const redisConnection = new ioredis_1.default(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
});
const defaultQueueOptions = {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
    },
};
// Webhook Delivery Queue
exports.webhookDeliveryQueue = new bullmq_1.Queue("webhook-delivery", defaultQueueOptions);
// Loan Origination Queue
exports.loanOriginationQueue = new bullmq_1.Queue("loan-origination", defaultQueueOptions);
// KYB Polling Queue (for Didit)
exports.kybPollQueue = new bullmq_1.Queue("kyb-poll", defaultQueueOptions);
// Settlement Queue (for batching deposits/withdrawals)
exports.settlementQueue = new bullmq_1.Queue("settlement", defaultQueueOptions);
//# sourceMappingURL=index.js.map