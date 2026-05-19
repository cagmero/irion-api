/**
 * Deprecate Turnkey Wallets Script
 * 
 * Marks all Turnkey-provisioned institutions as suspended and archives their wallets.
 * This is a one-off migration script - run once when switching to algosdk provider.
 * 
 * Usage: pnpm tsx src/scripts/deprecate-turnkey-wallets.ts
 * 
 * Idempotent: safe to run multiple times. Logs counts.
 */

import { db } from "../db/index.js";
import { institutions, wallets } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

async function deprecateTurnkeyWallets() {
  console.log("[DeprecateTurnkey] Starting...");
  
  // 1. Find all institutions with turnkeySubOrgId (they were created with Turnkey)
  const turnkeyInstitutions = await db
    .select({ id: institutions.id, name: institutions.name })
    .from(institutions)
    .where(sql`turnkey_sub_org_id IS NOT NULL`);
  
  console.log(`[DeprecateTurnkey] Found ${turnkeyInstitutions.length} Turnkey-provisioned institutions`);
  
  // 2. Suspend all Turnkey institutions
  let suspendedCount = 0;
  for (const inst of turnkeyInstitutions) {
    const result = await db
      .update(institutions)
      .set({ status: "suspended" })
      .where(eq(institutions.id, inst.id));
    
    if (result) {
      suspendedCount++;
    }
  }
  
  console.log(`[DeprecateTurnkey] Suspended ${suspendedCount} institutions`);
  
  // 3. Archive all Turnkey wallets (set status to inactive)
  const turnkeyWallets = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(sql`signing_provider = 'turnkey'`);
  
  console.log(`[DeprecateTurnkey] Found ${turnkeyWallets.length} Turnkey wallets`);
  
  let archivedCount = 0;
  for (const wallet of turnkeyWallets) {
    const result = await db
      .update(wallets)
      .set({ status: "inactive" })
      .where(eq(wallets.id, wallet.id));
    
    if (result) {
      archivedCount++;
    }
  }
  
  console.log(`[DeprecateTurnkey] Archived ${archivedCount} wallets`);
  
  // 4. Clear turnkeySubOrgId from all institutions (they're now orphaned from Turnkey anyway)
  const clearResult = await db
    .update(institutions)
    .set({ turnkeySubOrgId: null })
    .where(sql`turnkey_sub_org_id IS NOT NULL`);
  
  console.log(`[DeprecateTurnkey] Cleared turnkeySubOrgId from institutions`);
  
  console.log("[DeprecateTurnkey] Done!");
  console.log(`  - Suspended institutions: ${suspendedCount}`);
  console.log(`  - Archived wallets: ${archivedCount}`);
}

deprecateTurnkeyWallets()
  .then(() => {
    console.log("[DeprecateTurnkey] Script completed successfully");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[DeprecateTurnkey] Script failed:", err);
    process.exit(1);
  });