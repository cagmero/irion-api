import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import algosdk from "algosdk";
import { db } from "../db/index.js";
import { institutions, wallets, deposits, auditLog, lendingPositions } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { algorandService } from "../services/algorand.js";
import { depositConfirmationQueue } from "../queues/index.js";
import { ApiError } from "../lib/errors.js";
import { getSigningProvider } from "../services/signing/index.js";

// Supported assets for deposits — extend as new pools are deployed
//
// ASSET NOTE (Deviation 5):
// Using mock asset (Irion Test USDC, ID 758916950) on testnet because Circle's
// testnet USDC faucet is rate-limited. Mainnet deployment requires:
// 1. Redeploy LendingPool against asset ID 31566704 (Circle USDC mainnet)
// 2. Update env vars
// 3. Re-run full integration suite
//
// Circle USDC references:
//   Testnet:  10458941 (VETIGP3I6RCUVLVYNDW5UA2OJMXB5WP6L6HJ3RWO2R37GP4AVETICXC55I)
//   Mainnet:  31566704
const CIRCLE_USDC_TESTNET_ASSET_ID  = 10458941;
const CIRCLE_USDC_MAINNET_ASSET_ID  = 31566704;

const SUPPORTED_DEPOSIT_ASSETS: Record<number, { poolAppId: number; poolAddress: string; tranche: number }> = {
  758916950: {   // TEST_USDC (Irion Test USDC, mock) — pool_asset_id in LendingPool V2
    poolAppId:   parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID  ?? "762580175"),
    poolAddress: process.env.LENDING_POOL_V2_USDC_ADDRESS          ?? "Y2KX4ZSQSFLW27EAE5VORM4DAY2S4EWZ24NKPLRMNHJMUXTNXNM2R6OQYM",
    tranche: 0,  // TRANCHE_SENIOR
  },
};

interface AssetAmountBody {
  assetId: number;
  amount: string;
  clientRequestId?: string;
}

interface TransferBody {
  type: "internal" | "onchain" | "fx";
  assetId: number;
  amount: string;
  destinationAddress: string;
  clientRequestId?: string;
  fxQuoteId?: string;
}

export async function transfersRoutes(app: FastifyInstance) {

  // ── POST /v1/deposits ─────────────────────────────────────────────────────
  app.post("/deposits", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      body: {
        type: "object",
        required: ["assetId", "amount"],
        properties: {
          assetId: { type: "integer", minimum: 0 },
          amount: { type: "string", pattern: "^[0-9]+$" },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            depositId:   { type: "string" },
            txHash:      { type: "string" },
            status:      { type: "string" },
            explorerUrl: { type: "string" },
            submittedAt: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const institutionId = request.institutionId;
    const { assetId, amount: amountStr, clientRequestId } = request.body as AssetAmountBody;
    const amountN = BigInt(amountStr);

    if (amountN <= 0n) {
      throw new ApiError("VALIDATION_FAILED", "Amount must be greater than zero");
    }

    // Validate supported asset
    const poolConfig = SUPPORTED_DEPOSIT_ASSETS[assetId];
    if (!poolConfig) {
      throw new ApiError("UNSUPPORTED_ASSET", `Asset ${assetId} is not supported for deposits`);
    }

    // Fetch institution
    const [institution] = await db
      .select()
      .from(institutions)
      .where(eq(institutions.id, institutionId))
      .limit(1);

    if (!institution) throw new ApiError("INSTITUTION_NOT_FOUND", "Institution not found");
    if (institution.status === "suspended") throw new ApiError("INSTITUTION_SUSPENDED", "Institution is suspended");
    if (institution.status === "pending") throw new ApiError("KYB_NOT_APPROVED", "Institution has not completed KYB approval");
    // Check wallet exists - signing provider handles the sub-org requirement internally if needed

    // Fetch primary wallet
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.institutionId, institutionId), eq(wallets.isPrimary, true)))
      .limit(1);

    if (!wallet) throw new ApiError("WALLET_REQUIRED", "Institution does not have a primary wallet");
    if (!wallet.algorandAddress) throw new ApiError("WALLET_REQUIRED", "Wallet has no Algorand address");

    // 1. Create deposit record (status: pending)
    const [deposit] = await db
      .insert(deposits)
      .values({
        institutionId,
        assetId,
        amount: Number(amountN),  // mode:"number" — precision-safe for current MVP balances
        status: "pending",
        clientRequestId: clientRequestId ?? null,
      })
      .returning();

    // Audit log: initiated
    await db.insert(auditLog).values({
      institutionId,
      action: "deposit.initiated",
      details: { depositId: deposit.id, amount: amountStr, assetId },
    });

    // 2. Build 2-transaction atomic group:
    //    txn[0]: axfer — institution wallet sends assetId to pool
    //    txn[1]: appl  — deposit(tranche, payment=ref to txn[0])
    //
    // NOTE: The LendingPool contract reads txn[GroupIndex-1] as the payment txn.
    // So the appl call MUST be at index 1, and the axfer MUST be at index 0.
    //
    // Box reference: The LendingPool uses BoxMap<Account, LenderPosition>({ keyPrefix: 'l' }).
    // The box name is 'l' + ABI-encoded Account (32 bytes). Must be declared in boxes array.

    let txHash: string;
    try {
      const algodClient = algorandService.client.client.algod;
      const suggestedParams = await algodClient.getTransactionParams().do();

      // txn[0]: Asset transfer (axfer) — institution wallet → pool
      const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: wallet.algorandAddress,
        receiver: poolConfig.poolAddress,
        assetIndex: assetId,
        amount: amountN,
        suggestedParams,
      });

      // Build box reference for lender position: keyPrefix 'l' + ABI-encoded Account (32 bytes)
      const senderAddr = algosdk.decodeAddress(wallet.algorandAddress);
      const boxName = new Uint8Array(1 + 32);
      boxName[0] = 0x6c; // 'l'
      boxName.set(senderAddr.publicKey, 1);

      // txn[1]: Application call — deposit(tranche=0, payment=gtxn[0])
      // The ABI method selector for deposit(uint64,axfer)void
      const methodSelector = algosdk.ABIMethod.fromSignature("deposit(uint64,axfer)void").getSelector();
      const trancheArg = algosdk.ABIUintType.from("uint64").encode(BigInt(poolConfig.tranche));

      const applParams = { ...suggestedParams, fee: 3000, flatFee: true };
      const applTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: wallet.algorandAddress,
        appIndex: poolConfig.poolAppId,
        appArgs: [methodSelector, trancheArg],
        foreignAssets: [assetId, parseInt(process.env.LENDING_POOL_V2_USDC_SENIOR_LP_TOKEN ?? "762580194")],
        boxes: [{ appIndex: poolConfig.poolAppId, name: boxName }],
        suggestedParams: applParams,
      });

      // Assign group
      const group = [axferTxn, applTxn];
      const groupId = algosdk.computeGroupID(group);
      axferTxn.group = groupId;
      applTxn.group = groupId;

      // Sign both with signing provider
      const signingProvider = getSigningProvider();

      const [signedAxfer, signedAppl] = await Promise.all([
        signingProvider.signTransaction(wallet.id, algosdk.encodeUnsignedTransaction(axferTxn)),
        signingProvider.signTransaction(wallet.id, algosdk.encodeUnsignedTransaction(applTxn)),
      ]);

      // Submit atomic group
      const combined = new Uint8Array([...signedAxfer, ...signedAppl]);
      const submitResult = await algorandService.submitSignedTransaction(combined);
      txHash = submitResult;

    } catch (err: any) {
      // Rollback: mark deposit as failed, preserve record for audit
      await db
        .update(deposits)
        .set({ status: "failed" })
        .where(eq(deposits.id, deposit.id));

      const isTurnkeyErr = err?.code === "TURNKEY_ERROR" || err?.name === "ApiError";
      const errorCode = isTurnkeyErr ? "TURNKEY_ERROR" : "ALGORAND_SUBMIT_FAILED";
      const detail = isTurnkeyErr
        ? `Failed to sign deposit transactions: ${err.message}`
        : `Failed to submit deposit to Algorand: ${err.message}`;

      await db.insert(auditLog).values({
        institutionId,
        action: isTurnkeyErr ? "deposit.signing_failed" : "deposit.submit_failed",
        details: { depositId: deposit.id, error: err.message },
      });

      throw new ApiError(errorCode, detail);
    }

    // 3. Update deposit: submitted
    await db
      .update(deposits)
      .set({ status: "submitted", txHash })
      .where(eq(deposits.id, deposit.id));

    await db.insert(auditLog).values({
      institutionId,
      action: "deposit.submitted",
      details: { depositId: deposit.id, txHash },
    });

    // 4. Enqueue confirmation job — worker polls algod and updates positions
    await depositConfirmationQueue.add("deposit-confirmation", {
      depositId: deposit.id,
      txHash,
      institutionId,
      assetId,
      amount: amountStr,
    });

    const explorerUrl = `https://testnet.explorer.perawallet.app/tx/${txHash}`;

    return reply.code(202).send({
      depositId:   deposit.id,
      txHash,
      status:      "submitted",
      explorerUrl,
      submittedAt: new Date().toISOString(),
    });
  });

  app.post("/transfers", {
    schema: {
      body: {
        type: "object",
        required: ["type", "assetId", "amount", "destinationAddress"],
        properties: {
          type: { type: "string", enum: ["internal", "onchain", "fx"] },
          assetId: { type: "integer", minimum: 0 },
          amount: { type: "string", pattern: "^[0-9]+$" },
          destinationAddress: { type: "string", maxLength: 255 },
          clientRequestId: { type: "string", maxLength: 255 },
          fxQuoteId: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            transferId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const body = request.body as TransferBody;
    return { transferId: "mock-transfer-id", status: "pending" };
  });

  app.post("/payouts", {
    schema: {
      body: {
        type: "object",
        required: ["amount"],
        properties: {
          amount: { type: "string", pattern: "^[0-9]+$" },
          destinationBankDetails: { type: "string" },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            payoutId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (_request: FastifyRequest) => {
    return { payoutId: "mock-payout-id", status: "pending" };
  });
}
