import "dotenv/config";
import Fastify from "fastify";
import idempotencyPlugin from "../plugins/idempotency.js";

async function run() {
  const app = Fastify({ logger: false });
  app.decorate("institutionId", "test-inst-123");
  app.decorate("authenticate", async (request: any, reply: any) => {
    request.institutionId = "test";
  });
  console.log("before register: has idempotency =", app.hasDecorator("idempotency"));
  try {
    await app.register(idempotencyPlugin);
    console.log("after register: has idempotency =", app.hasDecorator("idempotency"));
    console.log("idempotency type =", typeof app.idempotency);
  } catch (e: any) {
    console.error("Error:", e.message);
  }
  await app.close();
}

run().catch((e) => { console.error(e.message); process.exit(1); });