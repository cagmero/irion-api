import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { deposits, withdrawals, loans, loanDraws, loanRepayments, transfers, payouts } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";

export async function transactionsRoutes(app: FastifyInstance) {
  // ── GET /v1/transactions — Paginated unified transaction feed ──
  app.get("/", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          offset: { type: "integer", minimum: 0 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            transactions: { type: "array" },
            total: { type: "integer" },
            limit: { type: "integer" },
            offset: { type: "integer" },
          },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const institutionId = request.institutionId;
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);

    // Query all transaction tables in parallel
    const [
      depositRows,
      withdrawalRows,
      loanRows,
      drawRows,
      repayRows,
      transferRows,
      payoutRows,
    ] = await Promise.all([
      db.select().from(deposits).where(eq(deposits.institutionId, institutionId)),
      db.select().from(withdrawals).where(eq(withdrawals.institutionId, institutionId)),
      db.select().from(loans).where(eq(loans.institutionId, institutionId)),
      db.select().from(loanDraws).where(eq(loanDraws.loanId, db.select({ id: loans.id }).from(loans).where(eq(loans.institutionId, institutionId))) as any),
      db.select().from(loanRepayments).where(eq(loanRepayments.loanId, db.select({ id: loans.id }).from(loans).where(eq(loans.institutionId, institutionId))) as any),
      db.select().from(transfers).where(eq(transfers.institutionId, institutionId)),
      db.select().from(payouts).where(eq(payouts.institutionId, institutionId)),
    ]);

    // Query draws/repays separately — filter by loan IDs in JS to avoid complex Drizzle join mocking
    const allDraws = await db.select().from(loanDraws);
    const allRepays = await db.select().from(loanRepayments);
    const loanIds = new Set(loanRows.map((l) => l.id));
    const draws = allDraws.filter((d) => loanIds.has(d.loanId));
    const repays = allRepays.filter((r) => loanIds.has(r.loanId));

    const all: Array<{
      id: string;
      type: string;
      status: string;
      amount: string | null;
      assetId: number | null;
      txHash: string | null;
      createdAt: Date;
      metadata: Record<string, any>;
    }> = [];

    for (const d of depositRows) {
      all.push({
        id: d.id,
        type: "deposit",
        status: d.status,
        amount: d.amount.toString(),
        assetId: d.assetId,
        txHash: d.txHash,
        createdAt: d.createdAt,
        metadata: { clientRequestId: d.clientRequestId },
      });
    }

    for (const w of withdrawalRows) {
      all.push({
        id: w.id,
        type: "withdrawal",
        status: w.status,
        amount: w.amount.toString(),
        assetId: w.assetId,
        txHash: w.txHash,
        createdAt: w.createdAt,
        metadata: { clientRequestId: w.clientRequestId },
      });
    }

    for (const l of loanRows) {
      all.push({
        id: l.id,
        type: `loan_origination_${l.type}`,
        status: l.status,
        amount: l.principalAmount.toString(),
        assetId: l.assetId,
        txHash: l.txHash,
        createdAt: l.createdAt,
        metadata: {
          loanType: l.type,
          walletId: l.walletId,
          collateralAssetId: l.collateralAssetId,
          collateralAmount: l.collateralAmount?.toString() ?? null,
          onchainLoanId: l.onchainLoanId?.toString() ?? null,
        },
      });
    }

    for (const d of draws) {
      all.push({
        id: d.id,
        type: "loan_draw",
        status: d.status,
        amount: d.amount.toString(),
        assetId: null,
        txHash: d.txHash,
        createdAt: d.createdAt,
        metadata: { loanId: d.loanId },
      });
    }

    for (const r of repays) {
      all.push({
        id: r.id,
        type: "loan_repay",
        status: r.status,
        amount: r.amount.toString(),
        assetId: null,
        txHash: r.txHash,
        createdAt: r.createdAt,
        metadata: { loanId: r.loanId },
      });
    }

    for (const t of transferRows) {
      all.push({
        id: t.id,
        type: `transfer_${t.type}`,
        status: t.status,
        amount: t.amount.toString(),
        assetId: t.assetId,
        txHash: t.txHash,
        createdAt: t.createdAt,
        metadata: {
          fromWalletId: t.fromWalletId,
          toWalletId: t.toWalletId,
          destinationAddress: t.destinationAddress,
          memo: t.memo,
          fxQuoteId: t.fxQuoteId,
        },
      });
    }

    for (const p of payoutRows) {
      all.push({
        id: p.id,
        type: "payout",
        status: p.status,
        amount: p.amount.toString(),
        assetId: null,
        txHash: null,
        createdAt: p.createdAt,
        metadata: { clientRequestId: p.clientRequestId },
      });
    }

    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = all.length;
    const page = all.slice(offset, offset + limit);

    return {
      transactions: page.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
      })),
      total,
      limit,
      offset,
    };
  });
}
