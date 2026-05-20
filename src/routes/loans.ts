import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { institutions, wallets, loans, loanDraws, auditLog } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { algorandService } from "../services/algorand.js";
import { loanOriginationStep1Queue } from "../queues/index.js";
import { ApiError } from "../lib/errors.js";

const TEST_USDC_ASSET_ID = 758916950;
const MIN_COLLATERAL_RATIO_BPS = 15000;

type OriginateBody = {
  walletId: string;
  loanType: "OVERCOLLATERALIZED" | "REVOLVING" | "TERM" | "INSTALLMENT";
  collateralAssetId?: number;
  collateralAmount?: string;
  borrowAssetId: number;
  borrowAmount: string;
  initialDraw?: string;
  interestRateBps?: number;
  maturityRounds?: number;
  installmentCount?: number;
  installmentIntervalRounds?: number;
  clientRequestId?: string;
};

interface DrawBody {
  amount: string;
  clientRequestId?: string;
}

interface RepayBody {
  amount: string;
  clientRequestId?: string;
}

export async function loansRoutes(app: FastifyInstance) {

  // ── POST /v1/loans — Originate loan (OVERCOLLATERALIZED or REVOLVING) ──
  app.post("/", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      body: {
        type: "object",
        required: ["walletId", "loanType", "borrowAssetId", "borrowAmount"],
        properties: {
          walletId: { type: "string", format: "uuid" },
          loanType: { type: "string", enum: ["OVERCOLLATERALIZED", "REVOLVING", "TERM", "INSTALLMENT"] },
          collateralAssetId: { type: "integer", minimum: 0 },
          collateralAmount: { type: "string", pattern: "^[0-9]+$" },
          borrowAssetId: { type: "integer", minimum: 0 },
          borrowAmount: { type: "string", pattern: "^[0-9]+$" },
          initialDraw: { type: "string", pattern: "^[0-9]+$" },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: { 202: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const institutionId = request.institutionId;
    const { walletId, loanType, collateralAssetId, collateralAmount, borrowAssetId, borrowAmount, initialDraw, clientRequestId } = request.body as OriginateBody;
    const borrowN = BigInt(borrowAmount);

    if (borrowN <= 0n) throw new ApiError("VALIDATION_FAILED", "Borrow amount must be greater than zero");
    if (loanType === "REVOLVING" && borrowAssetId !== TEST_USDC_ASSET_ID) throw new ApiError("UNSUPPORTED_ASSET", "Only TEST_USDC is supported");

    // Common preflight: institution status
    const [institution] = await db.select().from(institutions).where(eq(institutions.id, institutionId)).limit(1);
    if (!institution) throw new ApiError("INSTITUTION_NOT_FOUND", "Institution not found");
    if (institution.status === "suspended") throw new ApiError("INSTITUTION_SUSPENDED", "Institution is suspended");
    if (institution.status === "pending") throw new ApiError("KYB_NOT_APPROVED", "Institution has not completed KYB approval");

    const [wallet] = await db.select().from(wallets).where(and(eq(wallets.id, walletId), eq(wallets.institutionId, institutionId))).limit(1);
    if (!wallet) throw new ApiError("WALLET_NOT_FOUND", "Wallet not found");
    if (!wallet.algorandAddress) throw new ApiError("WALLET_NOT_FOUND", "Wallet has no Algorand address");

    // On-chain checks
    const algodClient = algorandService.client.client.algod;
    const accountInfo = await algodClient.accountInformation(wallet.algorandAddress).do();
    const assets = accountInfo.assets || [];

    const optedIn = assets.some((a: any) => Number(a["asset-id"] ?? a.assetId) === borrowAssetId);
    if (!optedIn) throw new ApiError("WALLET_NOT_OPTED_IN", `Wallet not opted into asset ${borrowAssetId}`);

    const [activeLoan] = await db.select().from(loans).where(and(eq(loans.walletId, walletId), eq(loans.status, "active"))).limit(1);
    if (activeLoan) throw new ApiError("LOAN_ALREADY_ACTIVE", `Wallet has an active loan`);

    if (clientRequestId) {
      const [existing] = await db.select().from(loans).where(eq(loans.clientRequestId, clientRequestId)).limit(1);
      if (existing) return reply.code(200).send({ id: existing.id, status: existing.status });
    }

    if (loanType === "OVERCOLLATERALIZED") {
      if (!collateralAssetId || !collateralAmount) throw new ApiError("VALIDATION_FAILED", "Collateral required for OVERCOLLATERALIZED loans");
      const collateralN = BigInt(collateralAmount);
      if (collateralN <= 0n) throw new ApiError("VALIDATION_FAILED", "Collateral amount must be > 0");
      if (collateralAssetId !== TEST_USDC_ASSET_ID) throw new ApiError("UNSUPPORTED_ASSET", "Only TEST_USDC supported");

      const walletAsset = assets.find((a: any) => Number(a["asset-id"] ?? a.assetId) === collateralAssetId);
      const walletBalance = walletAsset ? Number(walletAsset.amount ?? walletAsset["amount"] ?? 0) : 0;
      if (walletBalance < Number(collateralN)) throw new ApiError("INSUFFICIENT_COLLATERAL", `Balance ${walletBalance} < ${collateralN}`);

      const ratioBps = Number((collateralN * 10000n) / borrowN);
      if (ratioBps < MIN_COLLATERAL_RATIO_BPS) throw new ApiError("COLLATERAL_RATIO_TOO_LOW", `Ratio ${ratioBps / 100}% < ${MIN_COLLATERAL_RATIO_BPS / 100}%`);

      const [loan] = await db.insert(loans).values({
        institutionId, walletId, type: "overcollateralized", status: "pending",
        assetId: borrowAssetId, principalAmount: Number(borrowN), creditLimit: Number(borrowN),
        collateralAssetId, collateralAmount: Number(collateralN), collateralRatioBps: ratioBps,
        interestRateBps: 0, ltvRatioBps: 0,
      }).returning();

      await db.insert(auditLog).values({ institutionId, action: "loan.pending", details: { loanId: loan.id } });
      await loanOriginationStep1Queue.add("loan-origination-step-1", {
        loanId: loan.id, institutionId, walletId, walletAddress: wallet.algorandAddress,
        collateralAssetId, collateralAmount, borrowAssetId, borrowAmount, collateralRatioBps: ratioBps,
      });
    return reply.code(202).send({ id: loan.id, status: "pending" });
  }

  // ── REVOLVING ────────────────────────────────────────────────────────
  if (loanType === "REVOLVING") {
    const initialDrawN = initialDraw ? BigInt(initialDraw) : 0n;
    if (initialDrawN > borrowN) throw new ApiError("VALIDATION_FAILED", "Initial draw exceeds credit limit");

    const [loan] = await db.insert(loans).values({
      institutionId, walletId, type: "revolving", status: "pending",
      assetId: borrowAssetId, principalAmount: Number(borrowN), creditLimit: Number(borrowN),
      interestRateBps: 0,
    }).returning();

    await db.insert(auditLog).values({ institutionId, action: "loan.pending", details: { loanId: loan.id, loanType, creditLimit: borrowN.toString() } });

    const { revolvingOriginationQueue } = await import("../queues/index.js");
    await revolvingOriginationQueue.add("revolving-origination", {
      loanId: loan.id, institutionId, walletId, walletAddress: wallet.algorandAddress,
      borrowAssetId, creditLimit: borrowN.toString(),
    });

    return reply.code(202).send({ id: loan.id, status: "pending" });
  }

  // ── TERM ──────────────────────────────────────────────────────────────
  if (loanType === "TERM") {
    const termIntBps = (request.body as any).interestRateBps ?? 0;
    const termMatRounds = (request.body as any).maturityRounds ?? 0;
    if (termIntBps <= 0) throw new ApiError("VALIDATION_FAILED", "Interest rate required");
    if (termMatRounds <= 0) throw new ApiError("VALIDATION_FAILED", "Maturity rounds required");

    const [termLoan] = await db.insert(loans).values({
      institutionId, walletId, type: "term", status: "pending",
      assetId: borrowAssetId, principalAmount: Number(borrowN),
      creditLimit: Number(borrowN), interestRateBps: termIntBps, lateFeeBps: 200,
    }).returning();

    await db.insert(auditLog).values({ institutionId, action: "loan.pending", details: { loanId: termLoan.id, loanType } });

    const { termOriginationQueue } = await import("../queues/index.js");
    await termOriginationQueue.add("term-origination", {
      loanId: termLoan.id, institutionId, walletId, walletAddress: wallet.algorandAddress,
      borrowAssetId, borrowAmount, maturityRounds: termMatRounds,
    });

    return reply.code(202).send({ id: termLoan.id, status: "pending" });
  }

  // ── INSTALLMENT ────────────────────────────────────────────────────────
  if (loanType === "INSTALLMENT") {
    const instCount = (request.body as any).installmentCount ?? 0;
    const instInterval = (request.body as any).installmentIntervalRounds ?? 0;
    if (instCount <= 0) throw new ApiError("VALIDATION_FAILED", "Installment count required");
    if (instInterval <= 0) throw new ApiError("VALIDATION_FAILED", "Installment interval required");

    const [instLoan] = await db.insert(loans).values({
      institutionId, walletId, type: "installment", status: "pending",
      assetId: borrowAssetId, principalAmount: Number(borrowN),
      creditLimit: Number(borrowN), installmentCount: instCount,
      installmentIntervalRounds: instInterval, interestRateBps: 0,
    }).returning();

    await db.insert(auditLog).values({ institutionId, action: "loan.pending", details: { loanId: instLoan.id, loanType } });

    const { installmentOriginationQueue } = await import("../queues/index.js");
    await installmentOriginationQueue.add("installment-origination", {
      loanId: instLoan.id, institutionId, walletId, walletAddress: wallet.algorandAddress,
      borrowAssetId, borrowAmount, interestRateBps: 500, installmentCount: instCount, intervalRounds: instInterval,
    });

    return reply.code(202).send({ id: instLoan.id, status: "pending" });
  }

  throw new ApiError("VALIDATION_FAILED", "Unsupported loan type");
});

// ── GET /v1/loans/:id/schedule — Get installment schedule ────────
app.get("/:id/schedule", {
  schema: {
    params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
  },
}, async (request: FastifyRequest) => {
  const { id } = request.params as { id: string };
  const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
  if (!loan) throw new ApiError("LOAN_NOT_FOUND", "Loan not found");
  const { installments: instTable } = await import("../db/schema.js");
  const insts = await db.select().from(instTable).where(eq(instTable.loanId, id)).orderBy(instTable.installmentIndex).limit(200);
  return {
    loanId: id, loanType: loan.type, status: loan.status,
    installments: insts.map((i: any) => ({
      index: i.installmentIndex, dueRound: i.dueRound,
      principalPortion: i.principalPortion.toString(), interestPortion: i.interestPortion.toString(),
      totalAmount: i.totalAmount.toString(), status: i.status,
      amountPaid: i.amountPaid.toString(), paidAtRound: i.paidAtRound, txHash: i.txHash,
    })),
  };
});

  app.post("/:id/draw", {
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      body: {
        type: "object", required: ["amount"],
        properties: { amount: { type: "string", pattern: "^[0-9]+$" }, clientRequestId: { type: "string", maxLength: 255 } },
      },
      response: { 202: { type: "object", properties: { drawId: { type: "string" }, status: { type: "string" } } } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { amount, clientRequestId } = request.body as DrawBody;
    const amountN = BigInt(amount);
    if (amountN <= 0n) throw new ApiError("VALIDATION_FAILED", "Amount must be > 0");

    const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
    if (!loan) throw new ApiError("LOAN_NOT_FOUND", "Loan not found");
    if (loan.status !== "active") throw new ApiError("LOAN_NOT_ACTIVE", "Loan not active");
    if (loan.type !== "revolving") throw new ApiError("LOAN_NOT_ACTIVE", "Not a revolving loan");

    const creditLimit = loan.creditLimit ?? 0;
    const drawn = loan.drawnAmount ?? 0;
    const available = creditLimit - drawn;
    if (Number(amountN) > available) throw new ApiError("INSUFFICIENT_AVAILABLE_CREDIT", `Available credit ${available}`);

    const [draw] = await db.insert(loanDraws).values({ loanId: id, amount: Number(amountN), clientRequestId: clientRequestId ?? null }).returning();

    // Enqueue draw via LoanFactory.draw()
    const { loanDrawQueue } = await import("../queues/index.js");
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, loan.walletId)).limit(1);
    await loanDrawQueue.add("loan-draw", {
      drawId: draw.id, loanId: id, walletId: loan.walletId ?? "", walletAddress: wallet?.algorandAddress ?? "",
      amount, institutionId: loan.institutionId, onchainLoanId: 0,
    });

    return reply.code(202).send({ drawId: draw.id, status: "pending" });
  });

  // ── POST /v1/loans/:id/repay — Repay revolving line ────────────────
  app.post("/:id/repay", {
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      body: {
        type: "object", required: ["amount"],
        properties: { amount: { type: "string", pattern: "^[0-9]+$" }, clientRequestId: { type: "string", maxLength: 255 } },
      },
      response: { 202: { type: "object", properties: { repaymentId: { type: "string" }, status: { type: "string" } } } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { amount, clientRequestId } = request.body as RepayBody;
    const amountN = BigInt(amount);
    if (amountN <= 0n) throw new ApiError("VALIDATION_FAILED", "Amount must be > 0");

    const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
    if (!loan) throw new ApiError("LOAN_NOT_FOUND", "Loan not found");
    if (loan.status !== "active") throw new ApiError("LOAN_NOT_ACTIVE", "Loan not active");

    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, loan.walletId)).limit(1);
    if (!wallet || !wallet.algorandAddress) throw new ApiError("WALLET_NOT_FOUND", "Wallet not found for this loan");

    const { loanRepayQueue } = await import("../queues/index.js");
    await loanRepayQueue.add("loan-repay", {
      loanId: id, walletId: loan.walletId ?? "", walletAddress: wallet.algorandAddress,
      amount, institutionId: loan.institutionId,
    });

    await db.insert(auditLog).values({ institutionId: loan.institutionId, action: "loan.repay_initiated", details: { loanId: id, amount } });

    return reply.code(202).send({ repaymentId: id + "-repay", status: "submitted" });
  });

  // ── GET /v1/loans/:id — Get loan status (extended for REVOLVING) ──
  app.get("/:id", {
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string" }, status: { type: "string" }, type: { type: "string" },
            collateralAmount: { type: "string" }, borrowAmount: { type: "string" },
            creditLimit: { type: "string" }, drawnAmount: { type: "string" },
            availableCredit: { type: "string" }, collateralRatio: { type: "string" },
            draws: { type: "array" },
          },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
    if (!loan) throw new ApiError("LOAN_NOT_FOUND", "Loan not found");

    const creditLimit = loan.creditLimit ?? 0;
    const drawnAmount = loan.drawnAmount ?? 0;
    const draws = await db.select().from(loanDraws).where(eq(loanDraws.loanId, id)).orderBy(loanDraws.createdAt).limit(50);

    return {
      id: loan.id, status: loan.status, type: loan.type,
      collateralAmount: loan.collateralAmount?.toString() ?? "0",
      borrowAmount: loan.principalAmount.toString(),
      creditLimit: creditLimit.toString(),
      drawnAmount: drawnAmount.toString(),
      availableCredit: (creditLimit - drawnAmount).toString(),
      collateralRatio: loan.collateralRatioBps ? (loan.collateralRatioBps / 100).toFixed(2) : "0",
      draws: draws.map((d: any) => ({ id: d.id, amount: d.amount.toString(), status: d.status, txHash: d.txHash, createdAt: d.createdAt })),
    };
  });

  // ── POST /v1/loans/:id/mark-defaulted — Admin only ─────────────────
  app.post("/:id/mark-defaulted", async (request: FastifyRequest, reply: FastifyReply) => {
    const adminKey = request.headers["x-admin-key"] as string;
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return reply.status(403).send({ status: 403, code: "ADMIN_AUTH_REQUIRED" });
    }
    const { id } = request.params as { id: string };
    const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
    if (!loan) throw new ApiError("LOAN_NOT_FOUND", "Loan not found");
    if (loan.status !== "active") throw new ApiError("LOAN_NOT_ACTIVE", "Loan not active");
    // Check maturity
    if (loan.maturityRound && loan.maturityRound > 0) {
      const status = await algorandService.client.client.algod.status().do();
      const currentRound = Number(status["last-round"] ?? status.lastRound ?? 0);
      if (currentRound <= loan.maturityRound) throw new ApiError("VALIDATION_FAILED", "Loan not yet mature");
    }
    await db.update(loans).set({ status: "defaulted" }).where(eq(loans.id, id));
    await db.insert(auditLog).values({ institutionId: loan.institutionId, action: "loan.defaulted", details: { loanId: id } });
    return reply.code(202).send({ status: "defaulted" });
  });
}
