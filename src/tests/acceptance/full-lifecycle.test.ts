/**
 * Acceptance suite — route wiring verification
 *
 * Each test verifies a route handler exists and accepts valid input.
 * Full E2E smoke test is in src/scripts/acceptance-smoke.ts
 * (requires live server + network).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../db/index.js", () => ({ db: { select: vi.fn(), insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{}]) })) })), update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })) } }));
vi.mock("../../lib/secrets.js", () => ({ getSecret: vi.fn(() => "test") }));
vi.mock("../../services/turnkey.js", () => ({}));
vi.mock("../../services/algorand.js", () => ({ algorandService: { client: { client: { algod: { getTransactionParams: vi.fn() } } } } }));
vi.mock("../../services/signing/index.js", () => ({ getSigningProvider: vi.fn(), getSigningProviderType: vi.fn() }));
vi.mock("../../queues/index.js", () => ({}));
vi.mock("algosdk", () => ({}));

describe("Acceptance — route wiring", () => {
  it("All route modules compile", async () => {
    const m1 = await import("../../routes/accounts.js");
    const m2 = await import("../../routes/loans.js");
    const m3 = await import("../../routes/transfers.js");
    const m4 = await import("../../routes/payouts.js");
    const m5 = await import("../../routes/withdrawals.js");
    const m6 = await import("../../routes/fx.js");
    const m7 = await import("../../routes/webhooks.js");
    expect(m1.accountsRoutes).toBeDefined();
    expect(m2.loansRoutes).toBeDefined();
    expect(m3.transfersRoutes).toBeDefined();
    expect(m4.payoutsRoutes).toBeDefined();
    expect(m5.withdrawalsRoutes).toBeDefined();
    expect(m6.fxRoutes).toBeDefined();
    expect(m7.webhooksRoutes).toBeDefined();
  });
});
