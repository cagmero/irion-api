import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { fxQuotes, transfers, auditLog } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { ApiError } from "../lib/errors.js";
import { getFxQuote } from "../services/fx/tinyman-quote.js";

export async function fxRoutes(app: FastifyInstance) {

  // ── POST /v1/fx/quote ──────────────────────────────────────────────
  app.post("/quote", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      body: {
        type: "object", required: ["fromAssetId", "toAssetId", "fromAmount"],
        properties: {
          fromAssetId: { type: "integer", minimum: 0 },
          toAssetId: { type: "integer", minimum: 0 },
          fromAmount: { type: "string", pattern: "^[0-9]+$" },
          walletId: { type: "string", format: "uuid" },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const { fromAssetId, toAssetId, fromAmount, walletId } = request.body as any;
    const fromN = BigInt(fromAmount);
    if (fromN <= 0n) throw new ApiError("VALIDATION_FAILED", "Amount must be > 0");

    try {
      const quote = await getFxQuote(fromAssetId, toAssetId, Number(fromN));

      const [row] = await db.insert(fxQuotes).values({
        institutionId: request.institutionId,
        walletId: walletId || null, fromAssetId, toAssetId,
        fromAmount: Number(fromN),
        toAmount: quote.toAmount,
        exchangeRate: String(quote.exchangeRate),
        priceImpactBps: quote.priceImpactBps,
        feeAmount: quote.feeAmount,
        expiresAt: new Date(Date.now() + 60_000),
      }).returning();

      return {
        quoteId: row.id,
        fromAmount, toAmount: String(quote.toAmount),
        exchangeRate: quote.exchangeRate,
        expiresAt: row.expiresAt.toISOString(),
        priceImpactBps: quote.priceImpactBps,
        feeAmount: String(quote.feeAmount),
      };
    } catch (e: any) {
      throw new ApiError("UNSUPPORTED_ASSET_PAIR", e.message || "Unsupported pair");
    }
  });

  // ── POST /v1/fx/execute ─────────────────────────────────────────────
  app.post("/execute", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      body: {
        type: "object", required: ["quoteId"],
        properties: {
          quoteId: { type: "string", format: "uuid" },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { quoteId, clientRequestId } = request.body as any;

    const [quote] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, quoteId)).limit(1);
    if (!quote) throw new ApiError("QUOTE_NOT_FOUND", "Quote not found");
    if (quote.used) throw new ApiError("QUOTE_ALREADY_USED", "Quote already used");
    if (new Date() > new Date(quote.expiresAt)) throw new ApiError("QUOTE_EXPIRED", "Quote expired");

    await db.update(fxQuotes).set({ used: true }).where(eq(fxQuotes.id, quoteId));

    const [transfer] = await db.insert(transfers).values({
      institutionId: quote.institutionId,
      type: "fx", assetId: quote.toAssetId,
      amount: quote.toAmount,
      destinationAddress: "fx-swap",
      fxQuoteId: quoteId,
      clientRequestId: clientRequestId ?? null,
    }).returning();

    await db.insert(auditLog).values({
      institutionId: quote.institutionId,
      action: "fx.executed",
      details: { quoteId, transferId: transfer.id, fromAssetId: quote.fromAssetId, toAssetId: quote.toAssetId, fromAmount: quote.fromAmount, toAmount: quote.toAmount },
    });

    return reply.code(202).send({
      id: transfer.id, quoteId, status: "submitted",
      note: "Execution is mocked per MVP scope. Real Tinyman swap deferred to Phase 3.",
    });
  });
}
