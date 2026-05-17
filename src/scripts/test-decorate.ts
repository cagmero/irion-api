import "dotenv/config";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import { getSecret } from "../lib/secrets.js";

async function run() {
  const app = Fastify({ logger: false });

  const jwtSecret = getSecret("JWT_SECRET");
  const masterKey = getSecret("WEBHOOK_SIGNING_SECRET");

  await app.register(fastifyJwt, {
    secret: jwtSecret,
    sign: { iss: "irion-api", aud: "irion-api-v1" },
    verify: { algorithms: ["HS256"], allowedIss: ["irion-api"], allowedAud: ["irion-api-v1"] },
  });

  app.decorate("authenticate", async (request: any, reply: any) => {
    console.log("authenticate called!");
    request.institutionId = "test-inst";
  });

  app.post("/test", { preHandler: [app.authenticate] }, async (request, reply) => {
    return { institutionId: (request as any).institutionId };
  });

  await app.ready();
  console.log("authenticate after ready:", typeof app.authenticate);
  await app.close();
}

run().catch((e) => { console.error(e.message); process.exit(1); });