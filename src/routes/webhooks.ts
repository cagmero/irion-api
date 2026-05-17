import { FastifyInstance, FastifyRequest } from "fastify";

export async function webhooksRoutes(app: FastifyInstance) {
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
  }, async (_request: FastifyRequest) => {
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
  }, async (request: FastifyRequest) => {
    return { id: (request.params as { id: string }).id, status: "deleted" };
  });
}
