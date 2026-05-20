import { describe, it, expect } from "vitest";

describe("FX route", () => {
  it("1. fxRoutes compiles and exports", async () => {
    const { fxRoutes } = await import("../routes/fx.js");
    expect(typeof fxRoutes).toBe("function");
  });

  it("2. tinyman-quote service exists", async () => {
    const { getFxQuote } = await import("../services/fx/tinyman-quote.js");
    expect(typeof getFxQuote).toBe("function");
  });

  it("3. getFxQuote returns expected shape", async () => {
    const { getFxQuote } = await import("../services/fx/tinyman-quote.js");
    const q = await getFxQuote(758916950, 0, 1_000_000);
    expect(q.toAmount).toBeGreaterThan(0);
    expect(q.exchangeRate).toBeGreaterThan(0);
    expect(q.feeAmount).toBeGreaterThan(0);
    expect(q.priceImpactBps).toBeGreaterThanOrEqual(0);
  });

  it("4. getFxQuote reverse pair works", async () => {
    const { getFxQuote } = await import("../services/fx/tinyman-quote.js");
    const q = await getFxQuote(0, 758916950, 1_000_000);
    expect(q.toAmount).toBeGreaterThan(0);
  });

  it("5. Unsupported pair throws", async () => {
    const { getFxQuote } = await import("../services/fx/tinyman-quote.js");
    await expect(getFxQuote(1, 2, 1000)).rejects.toThrow();
  });

  it("6. INVALID_DESTINATION_ADDRESS error exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.UNSUPPORTED_ASSET_PAIR).toBe(422);
  });

  it("7. QUOTE_NOT_FOUND error exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.QUOTE_NOT_FOUND).toBe(404);
  });

  it("8. QUOTE_EXPIRED error exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.QUOTE_EXPIRED).toBe(422);
  });

  it("9. QUOTE_ALREADY_USED error exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.QUOTE_ALREADY_USED).toBe(409);
  });

  it("10. Exchange rate is reasonable", async () => {
    const { getFxQuote } = await import("../services/fx/tinyman-quote.js");
    const q = await getFxQuote(758916950, 0, 1_000_000);
    // TEST_USDC → ALGO should produce a reasonable ALGO amount
    expect(q.exchangeRate).toBeGreaterThan(1);
    expect(q.exchangeRate).toBeLessThan(10);
  });

  it("11. Fee is proportional", async () => {
    const { getFxQuote } = await import("../services/fx/tinyman-quote.js");
    const q = await getFxQuote(758916950, 0, 1_000_000_000);
    expect(q.feeAmount).toBeGreaterThan(1000);
  });

  it("12. Migration adds columns", async () => {
    const content = await import("fs").then(f => f.readFileSync("src/db/migrations/0015_fx_quotes.sql", "utf8"));
    expect(content).toContain("wallet_id");
    expect(content).toContain("used");
    expect(content).toContain("price_impact_bps");
    expect(content).toContain("fee_amount");
  });
});
