import "dotenv/config";
import { db } from "./src/db/index.js";
import { apiKeys } from "./src/db/schema.js";
import * as argon2 from "argon2";

async function main() {
  const keys = await db.select().from(apiKeys).limit(5);
  console.log("Recent API keys:");
  for (const key of keys) {
    console.log(`  id: ${key.id}`);
    console.log(`  institutionId: ${key.institutionId}`);
    console.log(`  keyPrefix: ${key.keyPrefix}`);
    console.log(`  keyHash (first 30): ${key.keyHash.substring(0, 30)}...`);
    console.log(`  status: ${key.status}`);
    console.log("");
  }

  // Test argon2 verification with the most recent key
  if (keys.length > 0) {
    const latestKey = keys[keys.length - 1];
    console.log("Testing argon2 verification...");
    // We don't know the original plaintext, but let's verify the hash format is valid
    console.log(`  Hash starts with $argon2id$: ${latestKey.keyHash.startsWith("$argon2id$")}`);
  }
}

main().catch(console.error);
