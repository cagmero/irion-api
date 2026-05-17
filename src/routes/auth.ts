import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const tokenBodySchema = {
  type: "object",
  required: ["grant_type", "client_id", "client_secret"],
  properties: {
    grant_type: { type: "string", const: "client_credentials" },
    client_id: { type: "string", minLength: 1 },
    client_secret: { type: "string", minLength: 1 },
  },
};

export async function authRoutes(app: FastifyInstance) {
  app.post("/token", {
    config: { rateLimitTier: "public" } as any,
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
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    return { accessToken: "mock-token", expiresIn: 3600, tokenType: "Bearer" };
  });
}
