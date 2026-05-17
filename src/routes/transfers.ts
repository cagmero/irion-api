import { FastifyInstance, FastifyRequest } from "fastify";

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
  app.post("/deposits", {
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
        200: {
          type: "object",
          properties: {
            depositId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const { assetId, amount, clientRequestId } = request.body as AssetAmountBody;
    return { depositId: "mock-deposit-id", status: "pending", assetId, amount, clientRequestId };
  });

  app.post("/withdrawals", {
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
        200: {
          type: "object",
          properties: {
            withdrawalId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const { assetId, amount, clientRequestId } = request.body as AssetAmountBody;
    return { withdrawalId: "mock-withdrawal-id", status: "pending", assetId, amount, clientRequestId };
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
