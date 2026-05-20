import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { adminRoutes } from "../routes/admin.js";
import { isApiError, CODE_STATUS } from "../lib/errors.js";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{
            id: "wallet-test-001",
            algorandAddress: "IWSSVZLAE5EIXWVRXCUPI5NODWAF3O5JSV5DXKGNUIAEZSUAKAW2VXFXCU",
          }]),
        })),
      })),
    })),
  },
}));

vi.mock("../lib/secrets.js", () => ({
  getSecret: vi.fn((name: string) => {
    const s: Record<string, string> = {
      ADMIN_API_KEY: "test-admin-key",
      DEPLOYER_MNEMONIC: "test test test test test test test test test test test test test test test test test test test test test test test test",
    };
    if (s[name]) return s[name];
    throw new Error(`Secret "${name}" not set`);
  }),
}));

vi.mock("../services/algorand.js", () => ({
  algorandService: {
    deployerAccount: {
      addr: "IWSSVZLAE5EIXWVRXCUPI5NODWAF3O5JSV5DXKGNUIAEZSUAKAW2VXFXCU",
      sk: new Uint8Array(64),
    },
    client: {
      client: {
        algod: {
          getTransactionParams: vi.fn().mockReturnValue({ do: vi.fn().mockResolvedValue({}) }),
        },
      },
    },
    submitSignedTransaction: vi.fn().mockResolvedValue("TXHASH123"),
  },
}));

vi.mock("algosdk", () => ({
  default: {
    makeAssetTransferTxnWithSuggestedParamsFromObject: vi.fn().mockReturnValue({
      signTxn: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    }),
  },
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error: any, _req: any, reply: any) => {
    console.log("[admin error]", error?.message, error?.code, error?.constructor?.name);
    if (isApiError(error)) {
      const status = CODE_STATUS[error.code];
      return reply.status(status).send({ status, code: error.code, detail: error.detail });
    }
    return reply.status(500).send({ status: 500, code: "INTERNAL_ERROR", detail: error.message });
  });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.ready();
  return app;
}

describe("POST /v1/admin/fund-wallet", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const VALID_WALLET_ID = "a0e9c5b1-8f3d-4c6e-b1a4-9d2e8f3c5a7c";

  it("Funds wallet with TEST_USDC → 200 with txHash", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/fund-wallet",
      headers: { "x-admin-key": "test-admin-key", "content-type": "application/json" },
      payload: { walletId: VALID_WALLET_ID, amount: "5000000" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.txHash).toBe("TXHASH123");
    expect(body.amount).toBe("5000000");
    await app.close();
  });

  it("Missing admin key → 401", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/fund-wallet",
      headers: { "content-type": "application/json" },
      payload: { walletId: VALID_WALLET_ID, amount: "5000000" },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("Invalid admin key → 401", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/fund-wallet",
      headers: { "x-admin-key": "wrong-key", "content-type": "application/json" },
      payload: { walletId: VALID_WALLET_ID, amount: "5000000" },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
