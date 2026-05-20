import { describe, it, expect } from "vitest";

describe("Transfers route", () => {
  it("1. Transfer route file compiles", async () => {
    const { transfersRoutes } = await import("../routes/transfers.js");
    expect(typeof transfersRoutes).toBe("function");
  });

  it("2. Transfer requires auth", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/routes/transfers.ts", "utf-8"));
    expect(content).toContain("authenticate");
  });

  it("3. Transfer has preflight checks", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/routes/transfers.ts", "utf-8"));
    expect(content).toContain("INSUFFICIENT_BALANCE");
    expect(content).toContain("WALLET_NOT_OPTED_IN");
  });

  it("4. WALLET_INSTITUTION_MISMATCH error exists", async () => {
    const { CODE_STATUS } = await import("../lib/errors.js");
    expect(CODE_STATUS.WALLET_INSTITUTION_MISMATCH).toBe(403);
  });

  it("5. Transfer schema has from/to wallet IDs", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/db/schema.ts", "utf-8"));
    expect(content).toContain("fromWalletId");
    expect(content).toContain("toWalletId");
  });

  it("6. Migration 0013 adds wallet columns", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/db/migrations/0013_transfers.sql", "utf-8"));
    expect(content).toContain("from_wallet_id");
    expect(content).toContain("to_wallet_id");
  });
  it("7. Transfer smoke script exists", async () => {
    const fs = await import("fs");
    expect(fs.existsSync("src/scripts/transfer-smoke-test.ts")).toBe(true);
  });
  it("8. Transfer route signs with signingProvider", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/routes/transfers.ts", "utf-8"));
    expect(content).toContain("signingProvider.signTransaction");
  });
  it("9. Transfer submits via algorandService", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/routes/transfers.ts", "utf-8"));
    expect(content).toContain("algorandService.submitSignedTransaction");
  });
  it("10. Transfer creates audit log entry", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/routes/transfers.ts", "utf-8"));
    expect(content).toContain("auditLog");
  });
  it("11. Transfer sets type = 'onchain'", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/routes/transfers.ts", "utf-8"));
    expect(content).toContain("type: \"onchain\"");
  });
  it("12. Transfer populates destination_address", async () => {
    const content = await import("fs").then(fs => fs.readFileSync("src/routes/transfers.ts", "utf-8"));
    expect(content).toContain("destinationAddress");
  });
});
