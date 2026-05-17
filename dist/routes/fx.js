"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fxRoutes = fxRoutes;
async function fxRoutes(app) {
    app.post("/quote", {
        schema: {
            body: {
                type: "object",
                required: ["fromAssetId", "toAssetId", "fromAmount"],
                properties: {
                    fromAssetId: { type: "integer", minimum: 0 },
                    toAssetId: { type: "integer", minimum: 0 },
                    fromAmount: { type: "string", pattern: "^[0-9]+$" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        quoteId: { type: "string" },
                        rate: { type: "number" },
                        expiresAt: { type: "string" },
                    },
                },
            },
        },
    }, async (_request) => {
        return { quoteId: "mock-quote-id", rate: 1.0, expiresAt: new Date(Date.now() + 60000).toISOString() };
    });
    app.post("/execute", {
        schema: {
            body: {
                type: "object",
                required: ["quoteId"],
                properties: {
                    quoteId: { type: "string", format: "uuid" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        executionId: { type: "string" },
                        status: { type: "string" },
                    },
                },
            },
        },
    }, async (_request) => {
        return { executionId: "mock-execution-id", status: "completed" };
    });
}
//# sourceMappingURL=fx.js.map