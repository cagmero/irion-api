import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { setupSentry } from "../plugins/sentry.js";
import { setupRateLimiter } from "../plugins/rate-limit.js";
import authPlugin from "../plugins/auth.js";
import idempotencyPlugin from "../plugins/idempotency.js";

async function testApp() {
  const app = Fastify({ logger: false });

  try {
    console.log("1. setupSentry...");
    setupSentry(app);
    console.log("   OK");

    console.log("2. cors...");
    await app.register(cors, { origin: "*" });
    console.log("   OK");

    console.log("3. helmet...");
    await app.register(helmet);
    console.log("   OK");

    console.log("4. setupRateLimiter...");
    await setupRateLimiter(app);
    console.log("   OK");

    console.log("5. swagger...");
    await app.register(fastifySwagger, { openapi: { info: { title: "test", version: "1.0.0" } } });
    console.log("   OK");

    console.log("6. swagger-ui...");
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
    console.log("   OK");

    console.log("7. authPlugin...");
    await app.register(authPlugin);
    console.log("   OK");

    console.log("8. idempotencyPlugin...");
    await app.register(idempotencyPlugin);
    console.log("   OK");

    console.log("All plugins loaded!");
    await app.close();
  } catch (e: any) {
    console.error("FAILED:", e.message);
  }
}

testApp();