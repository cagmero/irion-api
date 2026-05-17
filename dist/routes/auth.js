"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = authRoutes;
const tokenBodySchema = {
    type: "object",
    required: ["grant_type", "client_id", "client_secret"],
    properties: {
        grant_type: { type: "string", const: "client_credentials" },
        client_id: { type: "string", minLength: 1 },
        client_secret: { type: "string", minLength: 1 },
    },
};
async function authRoutes(app) {
    app.post("/token", {
        schema: {
            body: tokenBodySchema,
            response: {
                200: {
                    type: "object",
                    properties: {
                        accessToken: { type: "string" },
                        expiresIn: { type: "integer" },
                        tokenType: { type: "string" },
                    },
                },
            },
        },
    }, async (_request, reply) => {
        return { accessToken: "mock-token", expiresIn: 3600, tokenType: "Bearer" };
    });
}
//# sourceMappingURL=auth.js.map