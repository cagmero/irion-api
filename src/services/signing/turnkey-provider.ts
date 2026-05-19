/**
 * Turnkey Signing Provider - HSM-backed signing via Turnkey
 * 
 * Wraps the existing turnkey.ts implementation to conform to SigningProvider interface.
 * Used for production deployments requiring HSM-backed key custody.
 */

import { db } from "../../db/index.js";
import { wallets, institutions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { SigningProvider, CreateWalletResult } from "./types.js";
import { createSubOrganization, createWallet as tkCreateWallet, signTransaction as tkSignTransaction } from "../turnkey.js";
import { ApiError } from "../../lib/errors.js";

export class TurnkeySigningProvider implements SigningProvider {
  /**
   * Create a new wallet with Turnkey.
   * 
   * This requires the institution to already have a Turnkey sub-organization.
   * If not, it creates one first.
   */
  async createWallet(institutionId: string, label: string): Promise<CreateWalletResult> {
    // Fetch institution to get subOrgId
    const [institution] = await db
      .select({ turnkeySubOrgId: institutions.turnkeySubOrgId })
      .from(institutions)
      .where(eq(institutions.id, institutionId))
      .limit(1);
    
    if (!institution) {
      throw new ApiError("INSTITUTION_NOT_FOUND", `Institution ${institutionId} not found`);
    }
    
    let subOrgId = institution.turnkeySubOrgId;
    
    // If no sub-org exists, create one
    if (!subOrgId) {
      const [inst] = await db
        .select({ name: institutions.name })
        .from(institutions)
        .where(eq(institutions.id, institutionId))
        .limit(1);
      
      const result = await createSubOrganization(institutionId, inst?.name ?? "Unknown");
      subOrgId = result.subOrgId;
      
      // Persist sub-org ID
      await db
        .update(institutions)
        .set({ turnkeySubOrgId: subOrgId })
        .where(eq(institutions.id, institutionId));
    }
    
    // Create wallet in Turnkey
    const { walletId, address: turnkeyAddress, algorandAddress } = await tkCreateWallet(subOrgId, label);
    
    // Insert wallet record (using existing schema, turnkey-specific fields populated)
    const [wallet] = await db
      .insert(wallets)
      .values({
        institutionId,
        label,
        isPrimary: true,
        turnkeyWalletId: walletId,
        turnkeyAddress,  // 64-char hex (signWith key for Turnkey)
        algorandAddress, // 58-char Base32 (public-facing)
        signingProvider: "turnkey",
        optedInAssets: [],
        status: "active",
      })
      .returning();
    
    return {
      walletId: wallet.id,
      algorandAddress: wallet.algorandAddress!,
    };
  }

  /**
   * Sign a transaction with Turnkey.
   * 
   * Uses the wallet's turnkeyAddress and the institution's subOrgId.
   */
  async signTransaction(walletId: string, unsignedTxnBytes: Uint8Array): Promise<Uint8Array> {
    // Fetch wallet to get turnkeyAddress
    const [wallet] = await db
      .select({
        turnkeyAddress: wallets.turnkeyAddress,
        institutionId: wallets.institutionId,
        signingProvider: wallets.signingProvider,
      })
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .limit(1);
    
    if (!wallet) {
      throw new ApiError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
    }
    
    if (wallet.signingProvider !== "turnkey") {
      throw new ApiError(
        "INVALID_SIGNING_PROVIDER",
        `Wallet ${walletId} is not a Turnkey wallet (provider: ${wallet.signingProvider})`
      );
    }
    
    // Fetch institution to get subOrgId
    const [institution] = await db
      .select({ turnkeySubOrgId: institutions.turnkeySubOrgId })
      .from(institutions)
      .where(eq(institutions.id, wallet.institutionId))
      .limit(1);
    
    if (!institution?.turnkeySubOrgId) {
      throw new ApiError(
        "MISSING_SUB_ORG",
        `Institution ${wallet.institutionId} has no Turnkey sub-organization`
      );
    }
    
    // Sign with Turnkey
    return await tkSignTransaction(wallet.turnkeyAddress, institution.turnkeySubOrgId, unsignedTxnBytes);
  }

  /**
   * Get the Algorand address for a wallet.
   */
  async getAddress(walletId: string): Promise<string> {
    const [wallet] = await db
      .select({ algorandAddress: wallets.algorandAddress })
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .limit(1);
    
    if (!wallet) {
      throw new ApiError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
    }
    
    if (!wallet.algorandAddress) {
      throw new ApiError("MISSING_ADDRESS", `Wallet ${walletId} has no Algorand address`);
    }
    
    return wallet.algorandAddress;
  }
}