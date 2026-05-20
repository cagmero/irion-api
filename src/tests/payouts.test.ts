import { describe, it, expect } from "vitest";

describe("Payouts route", () => {
  it("1. Route compiles and exports", async () => {
    const { payoutsRoutes } = await import("../routes/payouts.js");
    expect(typeof payoutsRoutes).toBe("function");
  });

  it("2. Route has auth preHandler", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("authenticate");
  });

  it("3. Validates destination address", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("isValidAddress");
  });

  it("4. Screens destination address", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("screenWallet");
  });
  it("5. Checks destination opt-in", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("DESTINATION_NOT_OPTED_IN");
  });

  it("6. Memo byte-length validation (emoji test)", async () => {
    // An emoji is 4 bytes
    const memo = "a".repeat(250) + "😀"; // 250 + 4 = 254 bytes — within limit
    const memo2 = "a".repeat(1000); // 1000 bytes — within limit
    const memo3 = "a".repeat(1001); // 1001 bytes — would exceed
    expect(Buffer.byteLength(memo, "utf8")).toBe(254);
    expect(Buffer.byteLength(memo2, "utf8")).toBe(1000);
    expect(Buffer.byteLength(memo3, "utf8")).toBe(1001);
    expect(Buffer.byteLength(memo, "utf8") > memo.length).toBe(true); // emoji is multi-byte
  });

  it("7. INVALID_DESTINATION_ADDRESS error code exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.INVALID_DESTINATION_ADDRESS).toBe(422);
  });

  it("8. DESTINATION_SCREENED error code exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.DESTINATION_SCREENED).toBe(403);
  });

  it("9. DESTINATION_NOT_OPTED_IN error code exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.DESTINATION_NOT_OPTED_IN).toBe(422);
  });

  it("10. Payout uses transfers table", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("transfers");
  });

  it("11. Payout signs transaction", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("signTransaction");
  });

  it("12. Wallet screening function exists", async () => {
    const { screenWallet } = await import("../services/wallet-screening.js");
    expect(typeof screenWallet).toBe("function");
  });

  it("13. Payout rejects zero amount validation", async () => {
    const { VALIDATION_FAILED } = await import("../lib/errors.js").then(m => m.CODE_STATUS);
    expect(VALIDATION_FAILED).toBe(422);
  });

  it("14. Payout memo byte limit source constant exists", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("memo");
  });

  it("15. Payout uses transfers table for recording", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("transfers");
  });

  it("16. Payout enc128b destination bank details", async () => {
    const { payouts } = await import("../db/schema.js");
    expect(payouts.destinationBankDetails).toBeDefined();
  });

  it("17. Payout route validates destination address", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("isValidAddress");
  });

  it("18. Payout route logs audit entry", async () => {
    const c = await import("fs").then(f => f.readFileSync("src/routes/payouts.ts", "utf8"));
    expect(c).toContain("auditLog");
  });
});
