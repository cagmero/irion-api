"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhooksRoutes = webhooksRoutes;
async function webhooksRoutes(app) {
    app.post("/", {
        schema: {
            body: {
                type: "object",
                required: ["url", "events"],
                properties: {
                    url: { type: "string", format: "uri", maxLength: 1024 },
                    events: { type: "array", items: { type: "string" }, minItems: 1 },
                    description: { type: "string", maxLength: 255 },
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
        return { id: "mock-webhook-id", status: "created" };
    });
    app.delete("/:id", {
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
    }, async (request) => {
        return { id: request.params.id, status: "deleted" };
    });
}
//# sourceMappingURL=webhooks.js.map