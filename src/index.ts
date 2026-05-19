// !! MUST BE FIRST: Load .env.local before ANY other module imports.
// ES module `import` statements are hoisted and execute before inline code,
// so using `import dotenv; dotenv.config()` does NOT work — db/index.ts would
// already have read process.env.DATABASE_URL (as undefined) by the time config() ran.
// Solution: use the dotenv/config side-effect import with the DOTENV_CONFIG_PATH env var,
// which runs at hoist time as part of the import side effect.
//
// Set DOTENV_CONFIG_PATH before tsx starts (e.g. in package.json dev script),
// OR use a tsx --require shim. For now we use the tsx --env-file flag instead.
// See package.json: "dev": "tsx watch --env-file=.env.local src/index.ts"
import { buildApp } from "./app";
import { startDepositConfirmationWorker } from "./queues/processors/deposit-confirmation.js";
import { startWithdrawalConfirmationWorker } from "./queues/processors/withdrawal-confirmation.js";

async function start() {
  const app = await buildApp();

  if (process.env.RUN_WORKERS_INLINE === "true") {
    console.log("⚙️  Starting inline workers...");
    startDepositConfirmationWorker();
    startWithdrawalConfirmationWorker();
  }

  try {
    const port = parseInt(process.env.PORT || "4000", 10);
    const host = process.env.HOST || "0.0.0.0";
    await app.listen({ port, host });
    console.log(`🚀 Server listening on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
