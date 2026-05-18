import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { setupSentry } from "./plugins/sentry.js";
import { setupRateLimiter } from "./plugins/rate-limit.js";
import authPlugin from "./plugins/auth.js";
import idempotencyPlugin from "./plugins/idempotency.js";

import { registerRoutes } from "./routes/index.js";

export async function buildApp(): Promise<FastifyInstance> {
  // Validate REDIS_URL at startup — required for BullMQ workers
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || (!redisUrl.startsWith("redis://") && !redisUrl.startsWith("rediss://"))) {
    throw new Error("REDIS_URL is missing or malformed. Must start with redis:// or rediss://");
  }

  const app = fastify({
    logger: true,
  });

  setupSentry(app);

  await app.register(cors, {
    origin: process.env.CORS_ORIGINS?.split(",") || "*",
  });
  await app.register(helmet);

  setupRateLimiter(app);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Irion B2B API",
        description: "API for Irion Network's B2B Neobank platform",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(authPlugin);
  await app.register(idempotencyPlugin);

  app.get("/health", { config: { rateLimitTier: "public" } as any }, async () => {
    return { status: "ok", time: new Date().toISOString() };
  });

  await registerRoutes(app);

  return app;
}