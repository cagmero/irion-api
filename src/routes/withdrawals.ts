/**
 * POST /v1/withdrawals
 *
 * Withdrawal flow: institution burns LP tokens → pool sends USDC back.
 *
 * Atomic group (2 txns):
 *   txn[0]: axfer — LP tokens from wallet → pool (burn)
 *   txn[1]: appl  — withdraw(tranche, lp_amount) — pool sends USDC back via inner txn
 *
 * Inner txn count: 1 (send_asset emits 1 assetTransfer with fee: 0)
 * Outer app call fee: 2000 µALGO (covers itself + 1 inner txn)
 *
 * Contract: LendingPoolV2.withdraw(uint64,uint64)void
 * Source: irion-contracts/.../lending_pool_v2/contract.algo.ts:240-288
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import algosdk from "algosdk";
import { db } from "../db/index.js";
import { institutions, wallets, withdrawals, auditLog, lendingPositions } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { algorandService } from "../services/algorand.js";
import { withdrawalConfirmationQueue } from "../queues/index.js";
import { ApiError } from "../lib/errors.js";
import { getSigningProvider } from "../services/signing/index.js";

// Pool configuration — mirrors deposits route
const POOL_APP_ID   = parseInt(process.env.LENDING_POOL_V2_USDC_APP_ID  ?? "762889263");
const POOL_ADDRESS  = process.env.LENDING_POOL_V2_USDC_ADDRESS          ?? "Y2KX4ZSQSFLW27EAE5VORM4DAY2S4EWZ24NKPLRMNHJMUXTNXNM2R6OQYM";
const TRANCHE       = 0; // TRANCHE_SENIOR
const TEST_USDC_ASSET_ID = 758916950;
const SENIOR_LP_TOKEN_ID = parseInt(process.env.LENDING_POOL_V2_USDC_SENIOR_LP_TOKEN ?? "762889282");

const SUPPORTED_WITHDRAWAL_ASSETS: number[] = [TEST_USDC_ASSET_ID];

interface WithdrawalBody {
  walletId: string;
  assetId: number;
  amount: string;
  clientRequestId?: string;
}

export async function withdrawalsRoutes(app: FastifyInstance) {

  app.post("/withdrawals", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      body: {
        type: "object",
        required: ["walletId", "assetId", "amount"],
        properties: {
          walletId: { type: "string", format: "uuid" },
          assetId: { type: "integer", minimum: 0 },
          amount: { type: "string", pattern: "^[0-9]+$" },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            withdrawalId: { type: "string" },
            txHash:       { type: "string" },
            status:       { type: "string" },
            explorerUrl:  { type: "string" },
            submittedAt:  { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const institutionId = request.institutionId;
    const { walletId, assetId, amount: amountStr, clientRequestId } = request.body as WithdrawalBody;
    const amountN = BigInt(amountStr);

    if (amountN <= 0n) {
      throw new ApiError("VALIDATION_FAILED", "Amount must be greater than zero");
    }

    // Validate supported asset
    if (!SUPPORTED_WITHDRAWAL_ASSETS.includes(assetId)) {
      throw new ApiError("UNSUPPORTED_ASSET", `Asset ${assetId} is not supported for withdrawals`);
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

    // Fetch wallet
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.id, walletId), eq(wallets.institutionId, institutionId)))
      .limit(1);

    if (!wallet) throw new ApiError("WALLET_NOT_FOUND", "Wallet not found");
    if (!wallet.algorandAddress) throw new ApiError("WALLET_NOT_FOUND", "Wallet has no Algorand address");

    // Preflight 1: DB position balance check
    const [position] = await db
      .select()
      .from(lendingPositions)
      .where(and(eq(lendingPositions.institutionId, institutionId), eq(lendingPositions.assetId, assetId)))
      .limit(1);

    if (!position || position.balance < Number(amountN)) {
      throw new ApiError("INSUFFICIENT_POSITION_BALANCE", "Insufficient position balance for withdrawal");
    }

    // Preflight 2: On-chain LP token balance check
    const algodClient = algorandService.client.client.algod;
    const accountInfo = await algodClient.accountInformation(wallet.algorandAddress).do();
    const assets = accountInfo.assets || [];
    const lpTokenAsset = assets.find((a: any) => Number(a["asset-id"] ?? a.assetId) === SENIOR_LP_TOKEN_ID);
    const lpBalance = lpTokenAsset ? Number(lpTokenAsset.amount ?? lpTokenAsset["amount"] ?? 0) : 0;

    if (lpBalance < Number(amountN)) {
      throw new ApiError("WALLET_NOT_OPTED_IN", `Wallet not opted into or insufficient LP token balance (asset ${SENIOR_LP_TOKEN_ID})`);
    }

    // Preflight 3: DB vs on-chain balance reconciliation
    if (position.balance !== Number(lpBalance)) {
      // Auto-reconcile: use on-chain balance as source of truth
      console.warn(`Position balance mismatch: DB=${position.balance} onChain=${lpBalance} — auto-reconciling`);
      await db
        .update(lendingPositions)
        .set({ balance: BigInt(lpBalance) })
        .where(eq(lendingPositions.id, position.id));
      position.balance = Number(lpBalance);
    }

    // Idempotency check
    if (clientRequestId) {
      const [existing] = await db
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.clientRequestId, clientRequestId))
        .limit(1);

      if (existing) {
        throw new ApiError("DATABASE_CONSTRAINT_VIOLATION", "Duplicate clientRequestId");
      }
    }

    // Create withdrawal record (status: pending)
    const [withdrawal] = await db
      .insert(withdrawals)
      .values({
        institutionId,
        assetId,
        amount: Number(amountN),
        status: "pending",
        clientRequestId: clientRequestId ?? null,
      })
      .returning();

    // Audit log: initiated
    await db.insert(auditLog).values({
      institutionId,
      action: "withdrawal.initiated",
      details: { withdrawalId: withdrawal.id, amount: amountStr, assetId },
    });

    // Build 2-transaction atomic group:
    //   txn[0]: axfer — LP tokens from wallet → pool (burn)
    //   txn[1]: appl  — withdraw(tranche, lp_amount)
    //
    // Contract reads txn[GroupIndex-1] as the LP token transfer.
    // So appl MUST be at index 1, axfer at index 0.
    //
    // Inner txn count: 1 (send_asset emits 1 assetTransfer, fee: 0, fee-pooled)
    // Outer app call fee: 2000 µALGO (covers itself + 1 inner txn)

    let txHash: string;
    try {
      const suggestedParams = await algodClient.getTransactionParams().do();

      // txn[0]: LP token transfer — wallet → pool
      const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: wallet.algorandAddress,
        receiver: POOL_ADDRESS,
        assetIndex: SENIOR_LP_TOKEN_ID,
        amount: amountN,
        suggestedParams,
      });

      // Build box reference for lender position: keyPrefix 'l' + ABI-encoded Account (32 bytes)
      const senderAddr = algosdk.decodeAddress(wallet.algorandAddress);
      const boxName = new Uint8Array(1 + 32);
      boxName[0] = 0x6c; // 'l'
      boxName.set(senderAddr.publicKey, 1);

      // txn[1]: Application call — withdraw(tranche=0, lp_amount)
      const methodSelector = algosdk.ABIMethod.fromSignature("withdraw(uint64,uint64)void").getSelector();
      const trancheArg = algosdk.ABIUintType.from("uint64").encode(BigInt(TRANCHE));
      const lpAmountArg = algosdk.ABIUintType.from("uint64").encode(amountN);

      // Fee: 2000 µALGO covers outer app call (1000) + 1 inner txn (1000)
      // Inner txn: send_asset emits assetTransfer with fee: Uint64(0)
      const applParams = { ...suggestedParams, fee: 2000, flatFee: true };
      const applTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: wallet.algorandAddress,
        appIndex: POOL_APP_ID,
        appArgs: [methodSelector, trancheArg, lpAmountArg],
        foreignAssets: [TEST_USDC_ASSET_ID, SENIOR_LP_TOKEN_ID],
        boxes: [{ appIndex: POOL_APP_ID, name: boxName }],
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
      // Rollback: mark withdrawal as failed, preserve record for audit
      await db
        .update(withdrawals)
        .set({ status: "failed" })
        .where(eq(withdrawals.id, withdrawal.id));

      const isTurnkeyErr = err?.code === "TURNKEY_ERROR" || err?.name === "ApiError";
      const errorCode = isTurnkeyErr ? "TURNKEY_ERROR" : "ALGORAND_SUBMIT_FAILED";
      const detail = isTurnkeyErr
        ? `Failed to sign withdrawal transactions: ${err.message}`
        : `Failed to submit withdrawal to Algorand: ${err.message}`;

      await db.insert(auditLog).values({
        institutionId,
        action: isTurnkeyErr ? "withdrawal.signing_failed" : "withdrawal.submit_failed",
        details: { withdrawalId: withdrawal.id, error: err.message },
      });

      throw new ApiError(errorCode, detail);
    }

    // Update withdrawal: submitted
    await db
      .update(withdrawals)
      .set({ status: "submitted", txHash })
      .where(eq(withdrawals.id, withdrawal.id));

    await db.insert(auditLog).values({
      institutionId,
      action: "withdrawal.submitted",
      details: { withdrawalId: withdrawal.id, txHash },
    });

    // Enqueue confirmation worker
    await withdrawalConfirmationQueue.add("withdrawal-confirmation", {
      withdrawalId: withdrawal.id,
      txHash,
      institutionId,
      assetId,
      amount: amountStr,
    });

    const explorerUrl = `https://lora.algokit.io/testnet/transaction/${txHash}`;

    return reply.code(202).send({
      withdrawalId: withdrawal.id,
      txHash,
      status:      "submitted",
      explorerUrl,
      submittedAt: new Date().toISOString(),
    });
  });
}
