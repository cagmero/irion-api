import { createRedisConnection } from "../lib/redis.js";
import { Queue, QueueOptions } from "bullmq";

const redisConnection = createRedisConnection();

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

// Loan Origination Step 1 Queue — locks collateral in Vault, then calls LoanFactory.originate_overcollateralized
export const loanOriginationStep1Queue = new Queue("loan-origination-step-1", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Loan Origination Confirmation Queue — confirms step 2 txn, marks loan active
export const loanOriginationConfirmQueue = new Queue("loan-origination-confirm", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 10,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Vault Release Compensator Queue — releases collateral if step 2 fails
export const vaultReleaseCompensatorQueue = new Queue("vault-release-compensator", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Loan Draw Queue — processes draws against a revolving credit line
export const loanDrawQueue = new Queue("loan-draw", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Loan Repay Queue — processes repayments via LoanFactory.repay() atomic group
export const loanRepayQueue = new Queue("loan-repay", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// REVOLVING Origination Queue — calls LoanFactory.originate_revolving, captures onchain_loan_id
export const revolvingOriginationQueue = new Queue("revolving-origination", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// TERM Origination Queue — calls LoanFactory.originate_term, captures onchain_loan_id
export const termOriginationQueue = new Queue("term-origination", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// INSTALLMENT Origination Queue
export const installmentOriginationQueue = new Queue("installment-origination", {
  ...defaultQueueOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});
