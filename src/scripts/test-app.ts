import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../plugins/auth.js";
import idempotencyPlugin from "../plugins/idempotency.js";
import { accountsRoutes } from "../routes/accounts.js";
import { authRoutes } from "../routes/auth.js";

async function run() {
  const app = Fastify({ logger: false });

  await app.register(authPlugin);
  await app.register(idempotencyPlugin);

  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(accountsRoutes, { prefix: "/v1/accounts" });

  await app.ready();
  console.log("authenticate type =", typeof app.authenticate);
  console.log("idempotency type =", typeof app.idempotency);
  await app.close();
}

run().catch((e) => { console.error(e.message); process.exit(1); });