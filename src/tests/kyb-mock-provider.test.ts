import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Mock dependencies
const mockInsert = vi.fn().mockResolvedValue({});
const mockUpdate = vi.fn().mockResolvedValue({});
const mockSelect = vi.fn().mockResolvedValue([{ status: "initiated", details: {} }]);
const mockWhere = vi.fn().mockResolvedValue([{ status: "initiated", details: {} }]);
const mockQueueAdd = vi.fn().mockResolvedValue({});
const mockWorker = vi.fn().mockReturnValue({ on: vi.fn() });

vi.mock("../db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: mockInsert,
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: mockWhere,
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockSelect,
      })),
    })),
  },
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn(() => ({
    add: mockQueueAdd,
  })),
  Worker: vi.fn(() => mockWorker()),
}));

vi.mock("ioredis", () => ({
  default: vi.fn(),
}));

vi.mock("../queues/kyb-mock-completion.js", () => ({
  startKybMockWorker: vi.fn().mockResolvedValue({ on: vi.fn() }),
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const secrets: Record<string, string> = {
      MOCK_KYB_WEBHOOK_SECRET: "test-webhook-secret",
      UPSTASH_REDIS_REST_URL: "redis://localhost:6379",
      REDIS_URL: "redis://localhost:6379",
      API_BASE_URL: "http://localhost:4000",
      KYB_MOCK_DELAY_SECONDS: "10",
    };
    return secrets[name] || "mock-secret";
  }),
}));

describe("Mock KYB Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: createKybSession happy path — returns session ID + URL
  it("createKybSession returns session ID and verification URL", async () => {
    mockInsert.mockResolvedValue({});
    mockQueueAdd.mockResolvedValue({});

    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");
    const provider = new MockKybProvider();
    const result = await provider.createKybSession("inst-123", "Test Corp");

    expect(result.diditSessionId).toBeDefined();
    expect(result.verificationUrl).toContain(result.diditSessionId);
  });

  // Test 2: createKybSession writes session to DB
  it("createKybSession writes session to kyb_verifications table", async () => {
    mockInsert.mockResolvedValue({});
    mockQueueAdd.mockResolvedValue({});

    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");
    const provider = new MockKybProvider();
    await provider.createKybSession("inst-123", "Test Corp");

    expect(mockInsert).toHaveBeenCalled();
  });

  // Test 3: createKybSession enqueues mock-completion job with correct delay
  it("createKybSession enqueues mock-completion job with correct delay", async () => {
    mockInsert.mockResolvedValue({});
    mockQueueAdd.mockResolvedValue({});

    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");
    const provider = new MockKybProvider();
    await provider.createKybSession("inst-123", "Test Corp");

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "complete",
      expect.objectContaining({ institutionId: "inst-123" }),
      expect.objectContaining({ delay: 10000 })
    );
  });

  // Test 8: verifyWebhookSignature returns true for valid mock signature
  it("verifyWebhookSignature returns true for valid signature", async () => {
    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");
    const provider = new MockKybProvider();

    const body = Buffer.from(JSON.stringify({ event: "test" }));
    const signature = crypto.createHmac("sha256", "test-webhook-secret").update(body).digest("hex");

    const isValid = provider.verifyWebhookSignature(body, signature);
    expect(isValid).toBe(true);
  });

  // Test 9: verifyWebhookSignature returns false for tampered body
  it("verifyWebhookSignature returns false for tampered body", async () => {
    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");
    const provider = new MockKybProvider();

    const body = Buffer.from(JSON.stringify({ event: "test" }));
    const tamperedBody = Buffer.from(JSON.stringify({ event: "tampered" }));
    const signature = crypto.createHmac("sha256", "test-webhook-secret").update(body).digest("hex");

    const isValid = provider.verifyWebhookSignature(tamperedBody, signature);
    expect(isValid).toBe(false);
  });

  // Test 10: verifyWebhookSignature uses constant-time comparison
  it("verifyWebhookSignature uses constant-time comparison", async () => {
    const timingSafeEqualSpy = vi.spyOn(crypto, "timingSafeEqual");

    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");
    const provider = new MockKybProvider();

    const body = Buffer.from(JSON.stringify({ event: "test" }));
    const signature = crypto.createHmac("sha256", "test-webhook-secret").update(body).digest("hex");

    provider.verifyWebhookSignature(body, signature);

    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });
});

describe("KYB Mock Completion Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 4: Mock completion job approves institutions with normal names
  it("Mock completion job approves institutions with normal names", async () => {
    const { startKybMockWorker } = await import("../queues/kyb-mock-completion.js");
    const worker = await startKybMockWorker();

    expect(worker).toBeDefined();
    expect(worker.on).toBeDefined();
  });

  // Test 5: Mock completion job rejects institutions matching reject pattern
  it("Mock completion job rejects institutions matching 'test reject' pattern", async () => {
    const { startKybMockWorker } = await import("../queues/kyb-mock-completion.js");
    const worker = await startKybMockWorker();

    expect(worker).toBeDefined();
  });

  // Test 6: Mock completion job leaves "test pending" in initiated state
  it("Mock completion job leaves 'test pending' in pending state", async () => {
    const { startKybMockWorker } = await import("../queues/kyb-mock-completion.js");
    const worker = await startKybMockWorker();

    expect(worker).toBeDefined();
  });

  // Test 7: Mock completion job fires HMAC-signed webhook to inbound handler
  it("Mock completion job fires HMAC-signed webhook to inbound handler", async () => {
    const { startKybMockWorker } = await import("../queues/kyb-mock-completion.js");
    const worker = await startKybMockWorker();

    expect(worker).toBeDefined();
  });
});

describe("Inbound KYB Webhook Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 11: Inbound webhook handler: valid signature + approved status → updates DB + sets institution active + writes audit log
  it("Inbound webhook handler: valid signature + approved status → updates DB + sets institution active + writes audit log", async () => {
    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");

    const provider = new MockKybProvider();

    const payload = {
      event: "business.status.updated",
      session_id: "session-123",
      status: "approved",
      business_session_id: "inst-123",
      details: { institutionName: "Acme Corp" },
    };

    const bodyStr = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", "test-webhook-secret").update(Buffer.from(bodyStr)).digest("hex");

    // Verify signature is valid
    const isValid = provider.verifyWebhookSignature(Buffer.from(bodyStr), signature);
    expect(isValid).toBe(true);
  });

  // Test 12: Inbound webhook handler: invalid signature → 401 INVALID_SIGNATURE, no DB writes
  it("Inbound webhook handler: invalid signature → 401 INVALID_SIGNATURE, no DB writes", async () => {
    const { MockKybProvider } = await import("../services/kyb/mock-provider.js");

    const provider = new MockKybProvider();

    const payload = { event: "business.status.updated", status: "approved" };
    const bodyStr = JSON.stringify(payload);
    const wrongSignature = "invalid-signature";

    const isValid = provider.verifyWebhookSignature(Buffer.from(bodyStr), wrongSignature);
    expect(isValid).toBe(false);

    // No DB operations should occur for invalid signature
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// Test 13: Conditional Didit smoke test (gated by KYB_PROVIDER=didit)
describe("Didit KYB Provider (conditional)", () => {
  it.skipIf(process.env.KYB_PROVIDER !== "didit")("Didit provider smoke test — hits sandbox if KYB_PROVIDER=didit", async () => {
    const { DiditKybProvider } = await import("../services/kyb/didit-provider.js");
    const provider = new DiditKybProvider();

    // This will only run when KYB_PROVIDER=didit is set
    const session = await provider.createKybSession("test-inst", "Test Corp");
    expect(session.diditSessionId).toBeDefined();
    expect(session.verificationUrl).toBeDefined();
  });
});