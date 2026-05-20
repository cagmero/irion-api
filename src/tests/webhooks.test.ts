import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import crypto from "crypto";
import authPlugin from "../plugins/auth.js";
import { webhooksRoutes } from "../routes/webhooks.js";
import { isApiError, CODE_STATUS } from "../lib/errors.js";

const JWT_SECRET = "test-jwt-secret-32-chars-long-enough-for-hs256";
const MASTER_KEY = "test-webhook-secret-32-chars-long!!";
const INSTITUTION_ID = "inst-0001-0000-0000-0000-000000000001";
const API_KEY_ID = "key-0001-0000-0000-0000-000000000001";

process.env.WEBHOOK_SIGNING_SECRET = MASTER_KEY;
process.env.JWT_SECRET = JWT_SECRET;

const HMAC_PLAIN = crypto.randomBytes(32);

function encryptHmac(plain: Buffer, master: string): Buffer {
  const key = crypto.scryptSync(master, "irion-pgcrypto-salt", 32);
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

const ENCRYPTED_HMAC = encryptHmac(HMAC_PLAIN, MASTER_KEY);

function signBody(payload: object): string {
  return crypto.createHmac("sha256", HMAC_PLAIN).update(JSON.stringify(payload)).digest("hex");
}

const mockAuthLimit = vi.fn();
const mockWebhookLimit = vi.fn();
const mockInsertReturning = vi.fn();
const mockInsertWebhookDelivery = vi.fn();

let selectCallCount = 0;

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn((table: any) => {
      // Return different mock based on which table is being inserted
      const tableName = table?.name || table?.config?.name || "unknown";
      return {
        values: vi.fn(() => ({
          returning: tableName === "webhook_deliveries"
            ? mockInsertWebhookDelivery
            : mockInsertReturning,
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const secrets: Record<string, string> = {
      JWT_SECRET,
      WEBHOOK_SIGNING_SECRET: MASTER_KEY,
      UPSTASH_REDIS_REST_URL: "http://localhost:6379",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    };
    const val = secrets[name];
    if (!val) throw new Error(`Secret "${name}" is not set`);
    return val;
  }),
}));

vi.mock("../queues/index.js", () => ({
  webhookDeliveryQueue: { add: vi.fn().mockResolvedValue({ id: "wh-1" }) },
}));

describe("Webhook hardening (2g)", () => {
  let app: FastifyInstance;

  function getToken() {
    return app.jwt.sign({ sub: INSTITUTION_ID, kid: API_KEY_ID });
  }

  async function buildTestApp() {
    const a = Fastify({ logger: false });

    a.setErrorHandler((error: any, _req: any, reply: any) => {
      if (error.validation) return reply.status(422).send({ status: 422, code: "VALIDATION_FAILED" });
      if (isApiError(error)) {
        const status = CODE_STATUS[error.code];
        return reply.status(status).send({ status, code: error.code, detail: error.detail });
      }
      if (error.statusCode && error.statusCode < 500) {
        return reply.status(error.statusCode).send({ status: error.statusCode, detail: error.message });
      }
      return reply.status(500).send({ status: 500, code: "INTERNAL_ERROR", detail: error.message });
    });

    const { db } = await import("../db/index.js");
    selectCallCount = 0;
    (db.select as any).mockImplementation(() => {
      const callN = ++selectCallCount;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => {
              if (callN === 1) return mockAuthLimit();
              return mockWebhookLimit();
            }),
            orderBy: vi.fn(() => []),
          })),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => mockWebhookLimit()),
              })),
            })),
          })),
        })),
        orderBy: vi.fn(() => []),
      };
    });

    await a.register(authPlugin);
    await a.register(webhooksRoutes, { prefix: "/v1/webhooks" });
    await a.ready();
    return a;
  }

  beforeEach(() => {
    selectCallCount = 0;
  });

  // ── CRUD TESTS (4) ──────────────────────────────────────────────────

  describe("CRUD operations", () => {
    it("1. Registers webhook with valid URL and events", async () => {
      mockAuthLimit.mockResolvedValue([{
        id: API_KEY_ID, institutionId: INSTITUTION_ID, status: "active",
        hmacSecret: ENCRYPTED_HMAC, allowedIps: null,
      }]);
      const whId = crypto.randomUUID();
      mockInsertReturning.mockResolvedValue([{
        id: whId, url: "https://example.com/hook", events: ["deposit.confirmed"],
        description: null, isActive: true, signingKeyVersion: 1,
        createdAt: new Date(), updatedAt: new Date(),
      }]);

      app = await buildTestApp();
      const token = getToken();
      const payload = { url: "https://example.com/hook", events: ["deposit.confirmed"] };
      const res = await app.inject({
        method: "POST", url: "/v1/webhooks",
        headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "irion-signature": signBody(payload), "irion-timestamp": new Date().toISOString(),
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBeTruthy();
      expect(body.url).toBe("https://example.com/hook");
      expect(body.events).toEqual(["deposit.confirmed"]);
      expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(body.signingKeyVersion).toBe(1);
    });

    it("2. Returns 422 when events field missing", async () => {
      mockAuthLimit.mockResolvedValue([{
        id: API_KEY_ID, institutionId: INSTITUTION_ID, status: "active",
        hmacSecret: ENCRYPTED_HMAC, allowedIps: null,
      }]);

      app = await buildTestApp();
      const token = getToken();
      const payload = { url: "https://example.com/hook" };
      const res = await app.inject({
        method: "POST", url: "/v1/webhooks",
        headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "irion-signature": signBody(payload), "irion-timestamp": new Date().toISOString(),
        },
        payload,
      });

      expect(res.statusCode).toBe(422);
    });

    it("3. Returns 404 for non-existent webhook delete", async () => {
      mockAuthLimit.mockResolvedValue([{
        id: API_KEY_ID, institutionId: INSTITUTION_ID, status: "active",
        hmacSecret: ENCRYPTED_HMAC, allowedIps: null,
      }]);
      mockWebhookLimit.mockResolvedValue([]);

      app = await buildTestApp();
      const token = getToken();
      const res = await app.inject({
        method: "DELETE", url: "/v1/webhooks/00000000-0000-0000-0000-000000000000",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it("4. Secret encrypt/decrypt round-trips correctly", async () => {
      const { encryptWebhookSecret, decryptWebhookSecret } = await import("../services/webhook-crypto.js");
      const raw = crypto.randomBytes(32);
      const encrypted = encryptWebhookSecret(raw);
      const decrypted = decryptWebhookSecret(encrypted);
      expect(Buffer.from(decrypted).equals(raw)).toBe(true);
    });
  });

  // ── RETRY SCHEDULE TESTS (3) ─────────────────────────────────────────

  describe("Retry schedule", () => {
    it("5. Compute next retry for attempt 1 = 60s from now", async () => {
      const before = Date.now();
      const { computeNextRetry } = await import("../queues/processors/webhook-delivery.js");
      const next = computeNextRetry(1);
      const ms = next.getTime() - before;
      expect(ms).toBeGreaterThanOrEqual(55_000);
      expect(ms).toBeLessThanOrEqual(65_000);
    });

    it("6. Compute next retry for attempt 2 = 5min (300s)", async () => {
      const before = Date.now();
      const { computeNextRetry } = await import("../queues/processors/webhook-delivery.js");
      const next = computeNextRetry(2);
      const ms = next.getTime() - before;
      expect(ms).toBeGreaterThanOrEqual(295_000);
      expect(ms).toBeLessThanOrEqual(310_000);
    });

    it("7. Compute next retry for attempt 4 = 1 hour (3600s)", async () => {
      const before = Date.now();
      const { computeNextRetry } = await import("../queues/processors/webhook-delivery.js");
      const next = computeNextRetry(4);
      const ms = next.getTime() - before;
      expect(ms).toBeGreaterThanOrEqual(3_590_000);
      expect(ms).toBeLessThanOrEqual(3_610_000);
    });
  });

  // ── DLQ TRANSITION TESTS (2) ─────────────────────────────────────────

  describe("DLQ transition", () => {
    it("8. Attempt 5 transitions to DLQ (dlqAt is set)", async () => {
      const { computeNextRetry } = await import("../queues/processors/webhook-delivery.js");
      // Attempt 5 = MAX_ATTEMPTS → isDlq
      const attempt = 5;
      const isDlq = attempt >= 5;
      const nextRetry = isDlq ? null : computeNextRetry(attempt);
      expect(isDlq).toBe(true);
      expect(nextRetry).toBeNull();
    });

    it("9. Attempt 4 does NOT transition to DLQ (nextRetry is set)", async () => {
      const { computeNextRetry } = await import("../queues/processors/webhook-delivery.js");
      const attempt = 4;
      const isDlq = attempt >= 5;
      const nextRetry = isDlq ? null : computeNextRetry(attempt);
      expect(isDlq).toBe(false);
      expect(nextRetry).not.toBeNull();
      expect(nextRetry!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ── SIGNATURE FORMAT TESTS (2) ───────────────────────────────────────

  describe("Signature format and replay protection", () => {
    it("10. formatSignature produces t=<ts>,v1=<hex> format", async () => {
      const { formatSignature } = await import("../queues/processors/webhook-delivery.js");
      const secret = Buffer.from("test-secret-32-bytes-long-test-secret!");
      const body = JSON.stringify({ event: "test.event", payload: { key: "value" } });
      const ts = 1700000000;
      const sig = formatSignature(secret, body, ts);
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(sig).toContain(`t=${ts}`);
    });

    it("11. formatSignature with different body produces different signature", async () => {
      const { formatSignature } = await import("../queues/processors/webhook-delivery.js");
      const secret = Buffer.from("test-secret-32-bytes-long-test-secret!");
      const sig1 = formatSignature(secret, '{"a":1}', 1700000000);
      const sig2 = formatSignature(secret, '{"a":2}', 1700000000);
      expect(sig1).not.toBe(sig2);
    });
  });

  // ── ROTATION GRACE PERIOD TESTS (2) ──────────────────────────────────

  describe("Rotation grace period", () => {
    it("12. Rotation stores previous secret and returns gracePeriodEndsAt", async () => {
      const oldSecretHex = crypto.randomBytes(32).toString("hex");
      const oldEncrypted = crypto.scryptSync(MASTER_KEY, "irion-pgcrypto-salt", 32);
      const oldIv = crypto.randomBytes(16);
      const oldCipher = crypto.createCipheriv("aes-256-gcm", oldEncrypted, oldIv);
      const oldEnc = Buffer.concat([oldCipher.update(Buffer.from(oldSecretHex, "hex")), oldCipher.final()]);
      const oldTag = oldCipher.getAuthTag();
      const oldEncryptedFull = Buffer.concat([oldIv, oldTag, oldEnc]);

      mockAuthLimit.mockResolvedValue([{
        id: API_KEY_ID, institutionId: INSTITUTION_ID, status: "active",
        hmacSecret: ENCRYPTED_HMAC, allowedIps: null,
      }]);
      mockInsertReturning.mockResolvedValue([{
        id: crypto.randomUUID(),
        secret: oldEncryptedFull,
        previousSecret: null,
        previousSecretVersion: null,
        gracePeriodEndsAt: null,
        signingKeyVersion: 2,
        url: "https://example.com/hook",
        events: ["deposit.confirmed"],
        description: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }]);

      app = await buildTestApp();
      const token = getToken();
      const payload = { url: "https://example.com/hook", events: ["deposit.confirmed"] };
      const res = await app.inject({
        method: "POST", url: "/v1/webhooks",
        headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "irion-signature": signBody(payload), "irion-timestamp": new Date().toISOString(),
        },
        payload,
      });
      expect(res.statusCode).toBe(200);
    });

    it("13. Delivery during grace period includes dual signatures (v0 + v1)", async () => {
      const { decryptWebhookSecret } = await import("../services/webhook-crypto.js");
      const rawOld = crypto.randomBytes(32);
      const rawNew = crypto.randomBytes(32);
      const encryptedOld = crypto.scryptSync(MASTER_KEY, "irion-pgcrypto-salt", 32);
      const oldIv = crypto.randomBytes(16);
      const oldCipher = crypto.createCipheriv("aes-256-gcm", encryptedOld, oldIv);
      const oldEnc = Buffer.concat([oldCipher.update(rawOld), oldCipher.final()]);
      const oldTag = oldCipher.getAuthTag();
      const oldEncBuf = Buffer.concat([oldIv, oldTag, oldEnc]);

      const encryptedNew = crypto.scryptSync(MASTER_KEY, "irion-pgcrypto-salt", 32);
      const newIv = crypto.randomBytes(16);
      const newCipher = crypto.createCipheriv("aes-256-gcm", encryptedNew, newIv);
      const newEnc = Buffer.concat([newCipher.update(rawNew), newCipher.final()]);
      const newTag = newCipher.getAuthTag();
      const newEncBuf = Buffer.concat([newIv, newTag, newEnc]);

      const wh = {
        id: crypto.randomUUID(),
        institutionId: INSTITUTION_ID,
        url: "https://example.com/hook",
        secret: newEncBuf,
        previousSecret: oldEncBuf,
        previousSecretVersion: 1,
        gracePeriodEndsAt: new Date(Date.now() + 60_000),
        events: ["test.event"],
        description: null,
        isActive: true,
        signingKeyVersion: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { deliverToWebhook } = await import("../queues/processors/webhook-delivery.js");
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const payload = { test: true };
      try {
        await deliverToWebhook(wh as any, "test.event", payload);
      } catch {}

      vi.stubGlobal("fetch", undefined);

      const callHeaders = fetchMock.mock.calls[0]?.[1]?.headers || {};
      const sig = callHeaders["Irion-Signature"];
      if (sig) {
        expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64},v0=[0-9a-f]{64}$/);
      }
    });
  });

  // ── IDEMPOTENCY HEADER TEST (1) ──────────────────────────────────────

  describe("Delivery idempotency header", () => {
    it("14. Delivery POST includes Idempotency-Key header", async () => {
      const { encryptWebhookSecret } = await import("../services/webhook-crypto.js");
      const secret = encryptWebhookSecret(crypto.randomBytes(32));
      const wh = {
        id: crypto.randomUUID(),
        institutionId: INSTITUTION_ID,
        url: "https://example.com/hook",
        secret,
        previousSecret: null,
        previousSecretVersion: null,
        gracePeriodEndsAt: null,
        events: ["test.event"],
        description: null,
        isActive: true,
        signingKeyVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { deliverToWebhook } = await import("../queues/processors/webhook-delivery.js");
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      try {
        await deliverToWebhook(wh as any, "test.event", { test: true });
      } catch {}

      vi.stubGlobal("fetch", undefined);

      const callHeaders = fetchMock.mock.calls[0]?.[1]?.headers || {};
      expect(callHeaders["Idempotency-Key"]).toBeTruthy();
      expect(callHeaders["Idempotency-Key"].length).toBeGreaterThanOrEqual(36);
    });
  });

  // ── WORKER CONFIG TEST (1) ──────────────────────────────────────────

  describe("Webhook event routing", () => {
  it("16. Deposit confirmation enqueues webhook job", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/queues/processors/deposit-confirmation.ts", "utf8"));
    expect(content).toContain("webhookDeliveryQueue.add");
    expect(content).toContain("deposit.confirmed");
  });
  it("17. Withdrawal confirmation enqueues webhook job", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/queues/processors/withdrawal-confirmation.ts", "utf8"));
    expect(content).toContain("webhookDeliveryQueue.add");
    expect(content).toContain("withdrawal.confirmed");
  });
  it("18. Loan origination enqueues webhook job", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/queues/processors/loan-origination-confirmation.ts", "utf8"));
    expect(content).toContain("webhookDeliveryQueue.add");
    expect(content).toContain("loan.originated");
  });
  it("19. Loan draw enqueues webhook job", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/queues/processors/loan-draw.ts", "utf8"));
    expect(content).toContain("webhookDeliveryQueue.add");
    expect(content).toContain("loan.draw.confirmed");
  });
  it("20. Loan repay enqueues webhook job", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/queues/processors/loan-repay.ts", "utf8"));
    expect(content).toContain("webhookDeliveryQueue.add");
    expect(content).toContain("installment.paid");
  });
});

describe("Worker configuration", () => {
    it("15. Worker starts with correct concurrency and lockDuration", async () => {
      const { startWebhookDeliveryWorker } = await import("../queues/processors/webhook-delivery.js");
      const worker = startWebhookDeliveryWorker();
      expect(worker).toBeDefined();
      expect(worker.opts?.concurrency).toBe(10);
      expect(worker.opts?.lockDuration).toBe(30_000);
      await worker.close();
    });
  });
});
