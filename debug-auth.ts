import "dotenv/config";
import { db } from "./src/db/index.js";
import { apiKeys } from "./src/db/schema.js";
import { eq, and } from "drizzle-orm";
import * as argon2 from "argon2";

async function main() {
  const clientId = "iri_prod_sk_033c9ef518074e007ba3cf9816e945d9";
  const clientSecret = "892a7f8203f6bb7df33d65e0fe07d94e3e77360610b15e7e630e937391fd4ec5";

  const lastUnderscoreIdx = clientId.lastIndexOf("_");
  const keyPrefix = clientId.substring(0, lastUnderscoreIdx + 1);
  console.log("Extracted keyPrefix:", keyPrefix);

  const [apiKey] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyPrefix, keyPrefix), eq(apiKeys.status, "active")));

  if (!apiKey) {
    console.log("NO API KEY FOUND with prefix:", keyPrefix);
    
    // List all keys with this prefix
    const allKeys = await db.select().from(apiKeys).where(eq(apiKeys.keyPrefix, keyPrefix));
    console.log("All keys with this prefix:", allKeys.length);
    for (const k of allKeys) {
      console.log(`  id=${k.id}, status=${k.status}, prefix="${k.keyPrefix}"`);
    }
    return;
  }

  console.log("Found API key:", apiKey.id);
  console.log("  institutionId:", apiKey.institutionId);
  console.log("  keyPrefix:", apiKey.keyPrefix);
  console.log("  status:", apiKey.status);

  const isValid = await argon2.verify(apiKey.keyHash, clientSecret);
  console.log("Argon2 verify result:", isValid);
  
  if (!isValid) {
    console.log("Hash stored:", apiKey.keyHash.substring(0, 50) + "...");
    // Try hashing the secret ourselves to compare
    const newHash = await argon2.hash(clientSecret, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1,
    });
    console.log("New hash of same secret:", newHash.substring(0, 50) + "...");
    console.log("Note: argon2 hashes differ due to random salt, but verify should still work");
  }
}

main().catch(console.error);
