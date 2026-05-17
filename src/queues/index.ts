import { Queue, QueueOptions } from "bullmq";
import Redis from "ioredis";

// In production, you would use a standard REDIS_URL for BullMQ. 
// Note: BullMQ requires a standard Redis connection (not REST).
const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const defaultQueueOptions: QueueOptions = {
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
export const webhookDeliveryQueue = new Queue("webhook-delivery", defaultQueueOptions);

// Loan Origination Queue
export const loanOriginationQueue = new Queue("loan-origination", defaultQueueOptions);

// KYB Polling Queue (for Didit)
export const kybPollQueue = new Queue("kyb-poll", defaultQueueOptions);

// Settlement Queue (for batching deposits/withdrawals)
export const settlementQueue = new Queue("settlement", defaultQueueOptions);
