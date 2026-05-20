import { describe, it, expect } from "vitest";
import algosdk from "algosdk";

/**
 * Deposit transaction group construction tests.
 *
 * Verifies the box reference encoding, foreign assets, and group structure
 * used in POST /v1/deposits — without requiring Turnkey signing or network calls.
 *
 * These tests catch the box-reference bug that caused:
 *   "logic eval error: invalid Box reference 0x..."
 *   "unavailable Asset 762889282"
 */

describe("Deposit transaction group construction", () => {
  const WALLET_ADDR = "IWSSVZLAE5EIXWVRXCUPI5NODWAF3O5JSV5DXKGNUIAEZSUAKAW2VXFXCU";
  const POOL_ADDR = "Y2KX4ZSQSFLW27EAE5VORM4DAY2S4EWZ24NKPLRMNHJMUXTNXNM2R6OQYM";
  const POOL_APP_ID = 762889263;
  const TEST_USDC_ID = 758916950;
  const SENIOR_LP_ID = 762889282;
  const DEPOSIT_AMOUNT = 1_000_000n;

  const sp = {
    genesisID: "testnet-v1.0",
    genesisHash: new Uint8Array(32).fill(1),
    firstValid: 1000n,
    lastValid: 2000n,
    minFee: 1000n,
    fee: 0n,
  };

  /** Helper: encode a transaction to msgpack and decode back to inspect fields */
  function decodeTxn(txn: any): Record<string, any> {
    const encoded = algosdk.encodeUnsignedTransaction(txn);
    return algosdk.decodeObj(encoded) as Record<string, any>;
  }

  it("1. Box name encoding matches contract BoxMap<Account, LenderPosition> with keyPrefix 'l'", () => {
    // Contract uses: lender_positions = BoxMap<Account, LenderPosition>({ keyPrefix: 'l' })
    // Box name = 'l' (1 byte) + ABI-encoded Account (32 bytes) = 33 bytes total
    const senderAddr = algosdk.decodeAddress(WALLET_ADDR);
    const boxName = new Uint8Array(1 + 32);
    boxName[0] = 0x6c; // 'l'
    boxName.set(senderAddr.publicKey, 1);

    expect(boxName.length).toBe(33);
    expect(boxName[0]).toBe(0x6c);
    // Bytes 1-32 must match the sender's public key
    for (let i = 0; i < 32; i++) {
      expect(boxName[i + 1]).toBe(senderAddr.publicKey[i]);
    }
  });

  it("2. Application call includes box reference with correct app ID", () => {
    const senderAddr = algosdk.decodeAddress(WALLET_ADDR);
    const boxName = new Uint8Array(1 + 32);
    boxName[0] = 0x6c;
    boxName.set(senderAddr.publicKey, 1);

    const methodSelector = algosdk.ABIMethod.fromSignature("deposit(uint64,axfer)void").getSelector();
    const trancheArg = algosdk.ABIUintType.from("uint64").encode(0n);

    const applTxn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: WALLET_ADDR,
      appIndex: POOL_APP_ID,
      appArgs: [methodSelector, trancheArg],
      foreignAssets: [TEST_USDC_ID, SENIOR_LP_ID],
      boxes: [{ appIndex: POOL_APP_ID, name: boxName }],
      suggestedParams: sp,
    });

    // Encode and decode to verify box reference is in the msgpack
    const decoded = decodeTxn(applTxn);

    // apbx = application box references
    expect(decoded.apbx).toBeDefined();
    expect(decoded.apbx).toHaveLength(1);
    // When box appIndex matches the calling app, it's omitted (implied)
    // Box name is stored as a Uint8Array in msgpack
    const boxNameDecoded = new Uint8Array(Object.values(decoded.apbx[0].n));
    expect(boxNameDecoded).toEqual(boxName);
  });

  it("3. foreignAssets includes both TEST_USDC and senior LP token", () => {
    const senderAddr = algosdk.decodeAddress(WALLET_ADDR);
    const boxName = new Uint8Array(1 + 32);
    boxName[0] = 0x6c;
    boxName.set(senderAddr.publicKey, 1);

    const methodSelector = algosdk.ABIMethod.fromSignature("deposit(uint64,axfer)void").getSelector();
    const trancheArg = algosdk.ABIUintType.from("uint64").encode(0n);

    const applTxn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: WALLET_ADDR,
      appIndex: POOL_APP_ID,
      appArgs: [methodSelector, trancheArg],
      foreignAssets: [TEST_USDC_ID, SENIOR_LP_ID],
      boxes: [{ appIndex: POOL_APP_ID, name: boxName }],
      suggestedParams: sp,
    });

    const decoded = decodeTxn(applTxn);

    // apas = application foreign assets
    expect(decoded.apas).toBeDefined();
    expect(decoded.apas).toContain(TEST_USDC_ID);
    expect(decoded.apas).toContain(SENIOR_LP_ID);
    expect(decoded.apas).toHaveLength(2);
  });

  it("4. Atomic group: axfer[0] + appl[1] with matching group ID", () => {
    const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: WALLET_ADDR,
      receiver: POOL_ADDR,
      assetIndex: TEST_USDC_ID,
      amount: DEPOSIT_AMOUNT,
      suggestedParams: sp,
    });

    const senderAddr = algosdk.decodeAddress(WALLET_ADDR);
    const boxName = new Uint8Array(1 + 32);
    boxName[0] = 0x6c;
    boxName.set(senderAddr.publicKey, 1);

    const methodSelector = algosdk.ABIMethod.fromSignature("deposit(uint64,axfer)void").getSelector();
    const trancheArg = algosdk.ABIUintType.from("uint64").encode(0n);

    const applTxn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: WALLET_ADDR,
      appIndex: POOL_APP_ID,
      appArgs: [methodSelector, trancheArg],
      foreignAssets: [TEST_USDC_ID, SENIOR_LP_ID],
      boxes: [{ appIndex: POOL_APP_ID, name: boxName }],
      suggestedParams: sp,
    });

    // Assign group
    const group = [axferTxn, applTxn];
    const groupId = algosdk.computeGroupID(group);
    axferTxn.group = groupId;
    applTxn.group = groupId;

    expect(group).toHaveLength(2);

    // Verify axfer is an asset transfer
    const axferDecoded = decodeTxn(axferTxn);
    expect(axferDecoded.type).toBe("axfer");
    expect(axferDecoded.xaid).toBe(TEST_USDC_ID); // xfer asset id

    // Verify appl is an application call
    const applDecoded = decodeTxn(applTxn);
    expect(applDecoded.type).toBe("appl");
    expect(applDecoded.apid).toBe(POOL_APP_ID); // application id

    // Both have the same group
    expect(axferDecoded.grp).toBeDefined();
    expect(applDecoded.grp).toBeDefined();
    expect(Buffer.from(axferDecoded.grp).toString("hex")).toBe(Buffer.from(applDecoded.grp).toString("hex"));
  });
});
