import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import algosdk from "algosdk";
import { db } from "../db/index.js";
import { wallets, transfers, auditLog } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { algorandService } from "../services/algorand.js";
import { ApiError } from "../lib/errors.js";
import { getSigningProvider } from "../services/signing/index.js";
import { screenWallet } from "../services/wallet-screening.js";
import { explorerUrl } from "../lib/explorer.js";

export async function payoutsRoutes(app: FastifyInstance) {
  app.post("/payouts", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      body: {
        type: "object", required: ["fromWalletId", "destinationAddress", "assetId", "amount", "memo"],
        properties: {
          fromWalletId: { type: "string", format: "uuid" },
          destinationAddress: { type: "string", maxLength: 64 },
          assetId: { type: "integer", minimum: 0 },
          amount: { type: "string", pattern: "^[0-9]+$" },
          memo: { type: "string", maxLength: 255 },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: {
        202: { type: "object", properties: { id: { type: "string" }, txHash: { type: "string" }, explorerUrl: { type: "string" }, status: { type: "string" } } },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const institutionId = request.institutionId;
    const body = request.body as Record<string, any>;
    const { fromWalletId, assetId, amount: amountStr, memo } = body;
    const destinationAddress = body.destinationAddress as string || "";
    const clientRequestId = (body.clientRequestId as string) || "";
    const amountN = BigInt(amountStr);
    if (amountN <= 0n) throw new ApiError("VALIDATION_FAILED", "Amount must be > 0");
    if (Buffer.byteLength(memo, "utf8") > 1000) throw new ApiError("VALIDATION_FAILED", "Memo exceeds 1000 bytes");

    const [fromWallet] = await db.select().from(wallets).where(and(eq(wallets.id, fromWalletId), eq(wallets.institutionId, institutionId))).limit(1);
    if (!fromWallet) throw new ApiError("WALLET_NOT_FOUND", "Source wallet not found");
    if (!algosdk.isValidAddress(destinationAddress)) throw new ApiError("INVALID_DESTINATION_ADDRESS", "Invalid Algorand address");

    const screenResult = await screenWallet(destinationAddress);
    if (!screenResult.passed) throw new ApiError("DESTINATION_SCREENED", "Address is on screening denylist");

    const ac = algorandService.client.client.algod;
    const toInfo = await ac.accountInformation(destinationAddress!).do();
    const toAssets: any[] = toInfo.assets ?? [];
    if (!toAssets.some((a: any) => Number(a["asset-id"] ?? a.assetId) === assetId)) throw new ApiError("DESTINATION_NOT_OPTED_IN", "Not opted in");

    const fromInfo = await ac.accountInformation(fromWallet.algorandAddress!).do();
    const assets: any[] = fromInfo.assets ?? [];
    const fb = (assets.find((a: any) => Number(a["asset-id"] ?? a.assetId) === assetId)?.amount ?? 0);
    if (Number(fb) < Number(amountN)) throw new ApiError("INSUFFICIENT_BALANCE", `Balance ${fb} < ${amountN}`);

    const [transfer] = await db.insert(transfers).values({
      institutionId, fromWalletId, type: "onchain", assetId, amount: Number(amountN),
      destinationAddress: destinationAddress as any, memo, clientRequestId: clientRequestId as any,
    }).returning();

    const sg = getSigningProvider();
    const sp = await ac.getTransactionParams().do();
    const noteBytes = new TextEncoder().encode(memo);
    const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: fromWallet.algorandAddress as any, receiver: destinationAddress as any,
      assetIndex: assetId, amount: amountN, suggestedParams: sp, note: noteBytes,
    });

    const signed = await sg.signTransaction(fromWalletId, algosdk.encodeUnsignedTransaction(axferTxn));
    const txHash = await algorandService.submitSignedTransaction(signed);

    await db.update(transfers).set({ status: "submitted", txHash }).where(eq(transfers.id, transfer.id));
    await db.insert(auditLog).values({ institutionId, action: "payout.submitted", details: { transferId: transfer.id, destinationAddress, amount: amountStr, txHash, memo } });

    return reply.code(202).send({ id: transfer.id, txHash, explorerUrl: explorerUrl.tx(txHash), status: "submitted" });
  });
}
