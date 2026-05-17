"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accountsRoutes = accountsRoutes;
async function accountsRoutes(app) {
    app.post("/", {
        schema: {
            body: {
                type: "object",
                required: ["name"],
                properties: {
                    name: { type: "string", minLength: 1, maxLength: 255 },
                    metadata: { type: "object" },
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
    }, async (_request) => {
        return { status: "pending", id: "mock-institution-id" };
    });
    app.get("/:id/balance", {
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
                        institutionId: { type: "string" },
                        balances: { type: "array" },
                    },
                },
            },
        },
    }, async (request) => {
        return { institutionId: request.params.id, balances: [] };
    });
    app.post("/:id/wallets", {
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: {
                    id: { type: "string", format: "uuid" },
                },
            },
            body: {
                type: "object",
                required: ["label"],
                properties: {
                    label: { type: "string", minLength: 1, maxLength: 255 },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        walletId: { type: "string" },
                        address: { type: "string" },
                    },
                },
            },
        },
    }, async (request) => {
        return { walletId: "mock-wallet-id", address: "MOCK_ADDRESS" };
    });
}
//# sourceMappingURL=accounts.js.map