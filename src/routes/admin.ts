import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import algosdk from "algosdk";
import { db } from "../db/index.js";
import {
  institutions, wallets, apiKeys, kybVerifications, creditProfiles,
  lendingPositions, borrowingPositions, deposits, withdrawals, loans,
  loanDraws, loanRepayments, installments, fxQuotes, transfers, payouts,
  webhooks, webhookDeliveries, auditLog, idempotencyKeys
} from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { algorandService } from "../services/algorand.js";
import { ApiError } from "../lib/errors.js";
import { getSecret } from "../lib/secrets.js";
import crypto from "crypto";

function requireAdminKey(request: FastifyRequest): void {
  const provided = request.headers["x-admin-key"] as string | undefined;
  if (!provided || typeof provided !== "string") {
    throw new ApiError("ADMIN_AUTH_REQUIRED", "X-Admin-Key header is required");
  }

  const expected = getSecret("ADMIN_API_KEY");

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const lengthMatch = a.length === b.length;
  const padded = lengthMatch ? b : Buffer.alloc(a.length);
  const valuesMatch = crypto.timingSafeEqual(a, padded);

  if (!lengthMatch || !valuesMatch) {
    throw new ApiError("ADMIN_AUTH_REQUIRED", "X-Admin-Key is invalid");
  }
}

export async function adminRoutes(app: FastifyInstance) {
  // ── POST /v1/admin/fund-wallet ──
  app.post("/fund-wallet", {
    schema: {
      body: {
        type: "object",
        required: ["walletId", "amount"],
        properties: {
          walletId: { type: "string", format: "uuid" },
          amount: { type: "string", pattern: "^[0-9]+$" },
          assetId: { type: "integer", minimum: 0 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            txHash: { type: "string" },
            walletId: { type: "string" },
            amount: { type: "string" },
            assetId: { type: "integer" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireAdminKey(request);

    const { walletId, amount, assetId } = request.body as {
      walletId: string;
      amount: string;
      assetId?: number;
    };

    const assetIdN = assetId ?? parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950", 10);
    const amountN = BigInt(amount);
    if (amountN <= 0n) throw new ApiError("VALIDATION_FAILED", "Amount must be > 0");

    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
    if (!wallet) throw new ApiError("WALLET_NOT_FOUND", "Wallet not found");
    if (!wallet.algorandAddress) throw new ApiError("WALLET_NOT_FOUND", "Wallet has no Algorand address");

    const deployer = algorandService.deployerAccount;
    const algodClient = algorandService.client.client.algod;
    const sp = await algodClient.getTransactionParams().do();

    const fundTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: deployer.addr,
      receiver: wallet.algorandAddress,
      assetIndex: assetIdN,
      amount: amountN,
      suggestedParams: sp,
    });

    const signed = fundTxn.signTxn(deployer.sk);
    const txHash = await algorandService.submitSignedTransaction(signed);

    return reply.code(200).send({
      txHash,
      walletId: wallet.id,
      amount: amountN.toString(),
      assetId: assetIdN,
    });
  });

  // ── POST /v1/admin/delete-institution ──
  app.post("/delete-institution", {
    schema: {
      body: {
        type: "object",
        required: ["institutionId"],
        properties: {
          institutionId: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            deleted: { type: "boolean" },
            institutionId: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireAdminKey(request);
    const { institutionId } = request.body as { institutionId: string };

    // Verify institution exists
    const [inst] = await db.select().from(institutions).where(eq(institutions.id, institutionId)).limit(1);
    if (!inst) throw new ApiError("INSTITUTION_NOT_FOUND", "Institution not found");

    // Manual cascading delete — schema FKs do not have ON DELETE CASCADE.
    // Two-pass approach: query child IDs first, then delete in dependency order.
    const loanRows = await db.select({ id: loans.id }).from(loans).where(eq(loans.institutionId, institutionId));
    const loanIds = loanRows.map((r) => r.id);
    const webhookRows = await db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.institutionId, institutionId));
    const webhookIds = webhookRows.map((r) => r.id);

    if (loanIds.length > 0) {
      await db.delete(loanDraws).where(inArray(loanDraws.loanId, loanIds));
      await db.delete(loanRepayments).where(inArray(loanRepayments.loanId, loanIds));
      await db.delete(installments).where(inArray(installments.loanId, loanIds));
    }
    if (webhookIds.length > 0) {
      await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.webhookId, webhookIds));
    }

    await db.delete(loans).where(eq(loans.institutionId, institutionId));
    await db.delete(fxQuotes).where(eq(fxQuotes.institutionId, institutionId));
    await db.delete(transfers).where(eq(transfers.institutionId, institutionId));
    await db.delete(payouts).where(eq(payouts.institutionId, institutionId));
    await db.delete(deposits).where(eq(deposits.institutionId, institutionId));
    await db.delete(withdrawals).where(eq(withdrawals.institutionId, institutionId));
    await db.delete(lendingPositions).where(eq(lendingPositions.institutionId, institutionId));
    await db.delete(borrowingPositions).where(eq(borrowingPositions.institutionId, institutionId));
    await db.delete(creditProfiles).where(eq(creditProfiles.institutionId, institutionId));
    await db.delete(wallets).where(eq(wallets.institutionId, institutionId));
    await db.delete(auditLog).where(eq(auditLog.institutionId, institutionId));
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.institutionId, institutionId));
    await db.delete(apiKeys).where(eq(apiKeys.institutionId, institutionId));
    await db.delete(kybVerifications).where(eq(kybVerifications.institutionId, institutionId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));

    return reply.code(200).send({ deleted: true, institutionId });
  });
}
