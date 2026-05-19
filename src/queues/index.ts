import { Queue, QueueOptions } from "bullmq";
import Redis from "ioredis";

// In production, you would use a standard REDIS_URL for BullMQ. 
// Note: BullMQ requires a standard Redis connection (not REST).
const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  tls: {},
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

// Deposit Confirmation Queue — polls algod for on-chain confirmation, updates deposits + positions
export const depositConfirmationQueue = new Queue("deposit-confirmation", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 10,            // up to 10 retries over ~30 minutes
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Withdrawal Confirmation Queue — polls algod for on-chain confirmation, updates withdrawals + positions
export const withdrawalConfirmationQueue = new Queue("withdrawal-confirmation", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 10,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});
