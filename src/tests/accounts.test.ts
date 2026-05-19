import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB
const mockSelect = vi.fn();
const mockInsert = vi.fn().mockResolvedValue([{}]);
const mockUpdate = vi.fn().mockResolvedValue({});

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockSelect,
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: mockInsert,
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: mockUpdate,
      })),
    })),
  },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn(() => "test-secret"),
}));

vi.mock("argon2", () => ({
  hash: vi.fn().mockResolvedValue("$argon2id$test-hash"),
  argon2id: 2,
}));

vi.mock("../services/turnkey.js", () => ({
  createSubOrganization: vi.fn().mockResolvedValue({ subOrgId: "test-suborg-id" }),
}));

vi.mock("../services/signing/index.js", () => ({
  getSigningProvider: vi.fn(() => ({
    createWallet: vi.fn(),
    signTransaction: vi.fn(),
    getAddress: vi.fn(),
  })),
  getSigningProviderType: vi.fn().mockReturnValue("turnkey"),
}));

vi.mock("../services/kyb/index.js", () => ({
  getKybProvider: vi.fn(() => ({
    createKybSession: vi.fn().mockResolvedValue({
      diditSessionId: "test-kyb-session-id",
      verificationUrl: "https://mock-kyb.local/verify/test-session",
    }),
  })),
}));

describe("POST /v1/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("Creates institution with API credentials, Turnkey org, and KYB session → 201", async () => {
    mockSelect.mockResolvedValue([]);
    mockInsert.mockResolvedValueOnce([{ id: "inst-123", status: "pending" }]);
    mockInsert.mockResolvedValueOnce([{ id: "key-456" }]);

    const { accountsRoutes } = await import("../routes/accounts.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(accountsRoutes, { prefix: "/v1/accounts" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { "x-admin-key": "test-secret" }, // getSecret mock returns "test-secret"
      payload: { name: "Test Institution" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe("inst-123");
    expect(body.status).toBe("pending");
    expect(body.client_id).toMatch(/^iri_prod_sk_/);
    expect(body.client_secret).toBeDefined();
    expect(body.client_secret).toHaveLength(64);
    expect(body.turnkeySubOrgId).toBe("test-suborg-id");
    expect(body.kybSessionId).toBe("test-kyb-session-id");
    expect(body.kybVerificationUrl).toBeDefined();
  });

  it("Duplicate institution name → 409 INSTITUTION_ALREADY_EXISTS", async () => {
    mockSelect.mockResolvedValue([{ id: "existing-id", name: "Test Institution" }]);

    const { accountsRoutes } = await import("../routes/accounts.js");
    const fastify = (await import("fastify")).default();

    fastify.setErrorHandler((error: any, _request: any, reply: any) => {
      if (error.code === "INSTITUTION_ALREADY_EXISTS") {
        return reply.status(409).send({ code: error.code, detail: error.detail });
      }
      return reply.status(500).send({ code: "INTERNAL_ERROR", detail: "Internal error" });
    });

    await fastify.register(accountsRoutes, { prefix: "/v1/accounts" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { "x-admin-key": "test-secret" },
      payload: { name: "Test Institution" },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.code).toBe("INSTITUTION_ALREADY_EXISTS");
  });

  it("Missing name → 400 validation error", async () => {
    const { accountsRoutes } = await import("../routes/accounts.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(accountsRoutes, { prefix: "/v1/accounts" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { "x-admin-key": "test-secret" },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it("Turnkey failure → 502 TURNKEY_ERROR, institution rolled back", async () => {
    const { createSubOrganization } = await import("../services/turnkey.js");
    (createSubOrganization as any).mockRejectedValueOnce(new Error("Turnkey down"));

    mockSelect.mockResolvedValue([]);
    mockInsert.mockResolvedValueOnce([{ id: "inst-fail", status: "pending" }]);
    mockInsert.mockResolvedValueOnce([{ id: "key-fail" }]);

    const { accountsRoutes } = await import("../routes/accounts.js");
    const fastify = (await import("fastify")).default();

    fastify.setErrorHandler((error: any, _request: any, reply: any) => {
      if (error.code === "TURNKEY_ERROR") {
        return reply.status(502).send({ code: error.code, detail: error.detail });
      }
      return reply.status(500).send({ code: "INTERNAL_ERROR", detail: "Internal error" });
    });

    await fastify.register(accountsRoutes, { prefix: "/v1/accounts" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { "x-admin-key": "test-secret" },
      payload: { name: "Test Institution" },
    });

    expect(response.statusCode).toBe(502);
    expect(mockUpdate).toHaveBeenCalled();
  });

  // ── Admin-key guard (2d.1d) ────────────────────────────────────────────────

  it("Missing X-Admin-Key → 401 ADMIN_AUTH_REQUIRED", async () => {
    const { accountsRoutes } = await import("../routes/accounts.js");
    const fastify = (await import("fastify")).default();

    fastify.setErrorHandler((error: any, _request: any, reply: any) => {
      if (error.code === "ADMIN_AUTH_REQUIRED") {
        return reply.status(401).send({ code: error.code, detail: error.message });
      }
      return reply.status(500).send({ code: "INTERNAL_ERROR", detail: "Internal error" });
    });

    await fastify.register(accountsRoutes, { prefix: "/v1/accounts" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/accounts",
      // no X-Admin-Key header
      payload: { name: "Test Institution" },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe("ADMIN_AUTH_REQUIRED");
  });

  it("Wrong X-Admin-Key → 401 ADMIN_AUTH_REQUIRED", async () => {
    const { accountsRoutes } = await import("../routes/accounts.js");
    const fastify = (await import("fastify")).default();

    fastify.setErrorHandler((error: any, _request: any, reply: any) => {
      if (error.code === "ADMIN_AUTH_REQUIRED") {
        return reply.status(401).send({ code: error.code, detail: error.message });
      }
      return reply.status(500).send({ code: "INTERNAL_ERROR", detail: "Internal error" });
    });

    await fastify.register(accountsRoutes, { prefix: "/v1/accounts" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { "x-admin-key": "definitely-wrong-key" },
      payload: { name: "Test Institution" },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe("ADMIN_AUTH_REQUIRED");
  });

  it("Correct X-Admin-Key → 201 (guard passes, request proceeds)", async () => {
    // getSecret mock returns "test-secret" for all keys including ADMIN_API_KEY
    mockSelect.mockResolvedValue([]);
    mockInsert.mockResolvedValueOnce([{ id: "inst-admin-ok", status: "pending" }]);
    mockInsert.mockResolvedValueOnce([{ id: "key-admin-ok" }]);

    const { accountsRoutes } = await import("../routes/accounts.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(accountsRoutes, { prefix: "/v1/accounts" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { "x-admin-key": "test-secret" }, // matches getSecret("ADMIN_API_KEY") mock
      payload: { name: "Test Institution" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe("inst-admin-ok");
  });
});
