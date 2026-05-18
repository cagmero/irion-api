import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Hapi Stub", () => {
  beforeEach(() => {
    delete process.env.HAPI_MOCK_DENYLIST;
  });

  afterEach(() => {
    delete process.env.HAPI_MOCK_DENYLIST;
  });

  it("Hapi stub returns clean for non-listed address", async () => {
    const { screenWalletHapi } = await import("../services/hapi.js");
    const result = await screenWalletHapi("ALGO123");

    expect(result.flagged).toBe(false);
    expect(result.riskScore).toBe(10);
    expect(result.labels).toEqual([]);
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
  });

  it("Hapi stub returns flagged for listed address", async () => {
    process.env.HAPI_MOCK_DENYLIST = "ALGO123,ALGO456";
    const { screenWalletHapi } = await import("../services/hapi.js");
    const result = await screenWalletHapi("ALGO123");

    expect(result.flagged).toBe(true);
    expect(result.riskScore).toBe(950);
    expect(result.labels).toEqual(["mock_denylist"]);
  });
});

describe("Range Stub", () => {
  beforeEach(() => {
    delete process.env.RANGE_MOCK_DENYLIST;
  });

  afterEach(() => {
    delete process.env.RANGE_MOCK_DENYLIST;
  });

  it("Range stub returns clean for non-listed address", async () => {
    const { screenWalletRange } = await import("../services/range.js");
    const result = await screenWalletRange("ALGO789");

    expect(result.flagged).toBe(false);
    expect(result.riskScore).toBe(10);
    expect(result.labels).toEqual([]);
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
  });

  it("Range stub returns flagged for listed address", async () => {
    process.env.RANGE_MOCK_DENYLIST = "ALGO789";
    const { screenWalletRange } = await import("../services/range.js");
    const result = await screenWalletRange("ALGO789");

    expect(result.flagged).toBe(true);
    expect(result.riskScore).toBe(950);
    expect(result.labels).toEqual(["mock_denylist"]);
  });
});

describe("Composite Wallet Screening", () => {
  beforeEach(() => {
    delete process.env.HAPI_MOCK_DENYLIST;
    delete process.env.RANGE_MOCK_DENYLIST;
  });

  afterEach(() => {
    delete process.env.HAPI_MOCK_DENYLIST;
    delete process.env.RANGE_MOCK_DENYLIST;
  });

  it("Composite returns passed: true when both clean", async () => {
    const { screenWallet } = await import("../services/wallet-screening.js");
    const result = await screenWallet("ALGO123");

    expect(result.passed).toBe(true);
    expect(result.details.hapi.flagged).toBe(false);
    expect(result.details.range.flagged).toBe(false);
  });

  it("Composite returns passed: false when Hapi flags", async () => {
    process.env.HAPI_MOCK_DENYLIST = "ALGO123";
    const { screenWallet } = await import("../services/wallet-screening.js");
    const result = await screenWallet("ALGO123");

    expect(result.passed).toBe(false);
    expect(result.details.hapi.flagged).toBe(true);
  });

  it("Composite returns passed: false when Range flags", async () => {
    process.env.RANGE_MOCK_DENYLIST = "ALGO123";
    const { screenWallet } = await import("../services/wallet-screening.js");
    const result = await screenWallet("ALGO123");

    expect(result.passed).toBe(false);
    expect(result.details.range.flagged).toBe(true);
  });
});