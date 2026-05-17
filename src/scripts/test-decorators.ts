import "dotenv/config";
import { buildApp } from "../app.js";

async function run() {
  const app = await buildApp();
  console.log("authenticate:", typeof app.authenticate);
  console.log("idempotency:", typeof app.idempotency);
  await app.close();
}

run().catch((e) => { console.error(e); process.exit(1); });