import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB
const mockSelect = vi.fn();
const mockInsert = vi.fn().mockResolvedValue({});

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockSelect,
      })),
    })),
    insert: vi.fn(() => ({
      values: mockInsert,
    })),
  },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn(() => "test-jwt-secret-32-chars-long-enough"),
}));

vi.mock("argon2", () => ({
  verify: vi.fn(),
  argon2id: 2,
}));

describe("POST /v1/auth/token", () => {
  const TEST_API_KEY_PLAIN = "iri_prod_sk_1a2b3c4d5e6f7g8h9i0j";
  const TEST_API_KEY_PREFIX = "iri_prod_sk_1a2b3c4d";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // Test 1: Valid credentials → 200, JWT returned, JWT decodes with correct claims
  it("Valid credentials → 200, JWT returned with correct claims", async () => {
    const { verify } = await import("argon2");
    (verify as any).mockResolvedValue(true);

    const mockApiKey = {
      id: "test-key-id",
      institutionId: "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b",
      keyPrefix: TEST_API_KEY_PREFIX,
      keyHash: "$argon2id$test",
      status: "active",
    };
    mockSelect.mockResolvedValue([mockApiKey]);

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: TEST_API_KEY_PLAIN,
        client_secret: "correct-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.access_token).toBeDefined();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);

    const { decodeJwt } = await import("jose");
    const decoded = decodeJwt(body.access_token) as any;
    expect(decoded.sub).toBe(mockApiKey.institutionId);
    expect(decoded.kid).toBe(mockApiKey.id);
    expect(decoded.iss).toBe("irion-api");
    expect(decoded.aud).toBe("irion-api-v1");
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  // Test 2: Wrong client_secret → 401 INVALID_CREDENTIALS, generic detail
  it("Wrong client_secret → 401 INVALID_CREDENTIALS, generic detail", async () => {
    const { verify } = await import("argon2");
    (verify as any).mockResolvedValue(false);

    const mockApiKey = {
      id: "test-key-id",
      institutionId: "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b",
      keyPrefix: TEST_API_KEY_PREFIX,
      keyHash: "$argon2id$test",
      status: "active",
    };
    mockSelect.mockResolvedValue([mockApiKey]);

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: TEST_API_KEY_PLAIN,
        client_secret: "wrong-secret",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe("INVALID_CREDENTIALS");
    expect(body.detail).toBe("client_id or client_secret is invalid");
  });

  // Test 3: Nonexistent client_id → 401 INVALID_CREDENTIALS, same generic detail
  it("Nonexistent client_id → 401 INVALID_CREDENTIALS, same generic detail", async () => {
    mockSelect.mockResolvedValue([]);

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: "iri_test_sk_nonexistent",
        client_secret: "any-secret",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe("INVALID_CREDENTIALS");
    expect(body.detail).toBe("client_id or client_secret is invalid");
  });

  // Test 3b: Account enumeration prevention — error messages are byte-identical
  it("Account enumeration prevention — error messages byte-identical between wrong secret and nonexistent client_id", async () => {
    const { verify } = await import("argon2");
    (verify as any).mockResolvedValue(false);

    const mockApiKey = {
      id: "test-key-id",
      institutionId: "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b",
      keyPrefix: TEST_API_KEY_PREFIX,
      keyHash: "$argon2id$test",
      status: "active",
    };

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    // Case 1: wrong secret
    mockSelect.mockResolvedValue([mockApiKey]);
    const resp1 = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: TEST_API_KEY_PLAIN,
        client_secret: "wrong-secret",
      },
    });

    // Case 2: nonexistent client_id
    mockSelect.mockResolvedValue([]);
    const resp2 = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: "iri_test_sk_nonexistent",
        client_secret: "any-secret",
      },
    });

    expect(resp1.json()).toEqual(resp2.json());
  });

  // Test 4: Missing client_id → 400 VALIDATION_FAILED
  it("Missing client_id → 400 VALIDATION_FAILED", async () => {
    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_secret: "some-secret",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  // Test 5: Missing client_secret → 400 VALIDATION_FAILED
  it("Missing client_secret → 400 VALIDATION_FAILED", async () => {
    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: TEST_API_KEY_PLAIN,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  // Test 6: Revoked API key → 401 INVALID_CREDENTIALS
  it("Revoked API key → 401 INVALID_CREDENTIALS", async () => {
    mockSelect.mockResolvedValue([]);

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: "iri_test_sk_revoked_key",
        client_secret: "any-secret",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe("INVALID_CREDENTIALS");
  });

  // Test 7: Successful token → JWT has correct sub, kid, iss, aud, exp (15 min in future)
  it("Successful token → JWT has correct sub, kid, iss, aud, exp (15 min in future)", async () => {
    const { verify } = await import("argon2");
    (verify as any).mockResolvedValue(true);

    const mockApiKey = {
      id: "test-key-id",
      institutionId: "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b",
      keyPrefix: TEST_API_KEY_PREFIX,
      keyHash: "$argon2id$test",
      status: "active",
    };
    mockSelect.mockResolvedValue([mockApiKey]);

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: TEST_API_KEY_PLAIN,
        client_secret: "correct-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    const { decodeJwt } = await import("jose");
    const decoded = decodeJwt(body.access_token) as any;

    expect(decoded.sub).toBe(mockApiKey.institutionId);
    expect(decoded.kid).toBe(mockApiKey.id);
    expect(decoded.iss).toBe("irion-api");
    expect(decoded.aud).toBe("irion-api-v1");

    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(decoded.exp).toBeGreaterThan(nowSeconds);
    expect(decoded.exp - decoded.iat).toBe(900);
  });

  // Test 8: Audit log written — success writes auth.token_issued
  it("Audit log written: success case writes auth.token_issued", async () => {
    const { verify } = await import("argon2");
    (verify as any).mockResolvedValue(true);

    const mockApiKey = {
      id: "test-key-id",
      institutionId: "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7b",
      keyPrefix: TEST_API_KEY_PREFIX,
      keyHash: "$argon2id$test",
      status: "active",
    };
    mockSelect.mockResolvedValue([mockApiKey]);

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: TEST_API_KEY_PLAIN,
        client_secret: "correct-secret",
      },
    });

    expect(mockInsert).toHaveBeenCalledWith({
      institutionId: mockApiKey.institutionId,
      action: "auth.token_issued",
      details: expect.objectContaining({ keyId: mockApiKey.id }),
    });
  });

  // Test 9: Audit log written — failure writes auth.token_failed
  it("Audit log written: failure case writes auth.token_failed", async () => {
    mockSelect.mockResolvedValue([]);

    const { authRoutes } = await import("../routes/auth.js");
    const fastify = (await import("fastify")).default();
    await fastify.register(authRoutes, { prefix: "/v1/auth" });

    await fastify.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: {
        client_id: "iri_test_sk_nonexistent",
        client_secret: "any-secret",
      },
    });

    // institutionId is NULL for anonymous (no-match) failures — no sentinel UUID
    // to avoid FK violation on audit_log.institution_id
    expect(mockInsert).toHaveBeenCalledWith({
      institutionId: null,
      action: "auth.token_failed",
      details: expect.objectContaining({ reason: "no_match" }),
    });
  });
});
