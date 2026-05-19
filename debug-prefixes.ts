import "dotenv/config";
import { db } from "./src/db/index.js";
import { apiKeys } from "./src/db/schema.js";
import { sql } from "drizzle-orm";

async function main() {
  const keys = await db.select({
    id: apiKeys.id,
    prefix: apiKeys.keyPrefix,
    prefixLen: sql<number>`length(${apiKeys.keyPrefix})`,
    instId: apiKeys.institutionId,
    status: apiKeys.status,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys).orderBy(apiKeys.createdAt).limit(10);
  
  console.log("All API keys (oldest first):");
  for (const k of keys) {
    console.log(`  prefix="${k.prefix}" (len=${k.prefixLen}) inst=${String(k.instId).substring(0,8)}... status=${k.status}`);
  }
}

main().catch(console.error);
