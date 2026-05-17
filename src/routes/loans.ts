import { FastifyInstance, FastifyRequest } from "fastify";

export async function loansRoutes(app: FastifyInstance) {
  app.post("/originate", {
    schema: {
      body: {
        type: "object",
        required: ["type", "assetId", "principalAmount", "interestRateBps"],
        properties: {
          type: { type: "string", enum: ["installment", "revolving", "term", "overcollateralized"] },
          assetId: { type: "integer", minimum: 0 },
          principalAmount: { type: "string", pattern: "^[0-9]+$" },
          interestRateBps: { type: "integer", minimum: 0 },
          collateralAssetId: { type: "integer", minimum: 0 },
          collateralAmount: { type: "string", pattern: "^[0-9]+$" },
          ltvRatioBps: { type: "integer", minimum: 0 },
          termDays: { type: "integer", minimum: 1 },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            loanId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (_request: FastifyRequest) => {
    return { loanId: "mock-loan-id", status: "pending" };
  });

  app.post("/draw", {
    schema: {
      body: {
        type: "object",
        required: ["loanId", "amount"],
        properties: {
          loanId: { type: "string", format: "uuid" },
          amount: { type: "string", pattern: "^[0-9]+$" },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            drawId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (_request: FastifyRequest) => {
    return { drawId: "mock-draw-id", status: "pending" };
  });

  app.post("/repay", {
    schema: {
      body: {
        type: "object",
        required: ["loanId", "amount"],
        properties: {
          loanId: { type: "string", format: "uuid" },
          amount: { type: "string", pattern: "^[0-9]+$" },
          clientRequestId: { type: "string", maxLength: 255 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            repaymentId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (_request: FastifyRequest) => {
    return { repaymentId: "mock-repayment-id", status: "pending" };
  });

  app.get("/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    return { id: (request.params as { id: string }).id, status: "active" };
  });
}
