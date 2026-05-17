import "dotenv/config";
import { buildApp } from "../app.js";

async function run() {
  try {
    const app = await buildApp();
    console.log("authenticate type =", typeof app.authenticate);
    console.log("idempotency type =", typeof app.idempotency);
    await app.close();
  } catch (e: any) {
    console.error("Error building app:", e.message);
    console.error("Stack:", e.stack?.split("\n").slice(0, 5).join("\n"));
  }
}

run().catch((e) => { console.error(e.message); process.exit(1); });