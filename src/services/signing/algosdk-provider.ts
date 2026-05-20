/**
 * Algosdk Signing Provider - In-process Ed25519 signing
 * 
 * Generates Ed25519 key pairs using algosdk, encrypts private keys with
 * AES-256-GCM using ENCRYPTION_MASTER_KEY, and stores encrypted material in DB.
 * 
 * WARNING: Private keys are held in memory during signing. Buffer is zeroed
 * after use to minimize exposure.
 */

import algosdk from "algosdk";
import { db } from "../../db/index.js";
import { wallets } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { SigningProvider, CreateWalletResult } from "./types.js";
import { encryptPrivateKey, decryptPrivateKey, PrivateKeyEnvelope } from "../../lib/envelope-encryption.js";
import { ApiError } from "../../lib/errors.js";

export class AlgosdkSigningProvider implements SigningProvider {
  /**
   * Create a new wallet with algosdk-generated Ed25519 key pair.
   * 
   * Generates a new account, encrypts the private key, and inserts a wallet row
   * with signing_provider = 'algosdk'.
   */
  async createWallet(institutionId: string, label: string): Promise<CreateWalletResult> {
    // Generate new Ed25519 key pair
    const account = algosdk.generateAccount();
    // Ensure algorandAddress is a string (algosdk v3 may return Address object)
    const algorandAddress = typeof account.addr === "string" 
      ? account.addr 
      : (account.addr as any).toString();
    
    // Encrypt private key for storage
    const encryptedSk = encryptPrivateKey(account.sk);
    
    // Insert wallet record
    const [wallet] = await db
      .insert(wallets)
      .values({
        institutionId,
        label,
        isPrimary: true,
        // Turnkey-specific fields (not used for algosdk, but required by schema)
        turnkeyWalletId: `algosdk-${walletId()}`,  // Placeholder, not used
        turnkeyAddress: Buffer.from(algosdk.decodeAddress(algorandAddress).publicKey).toString("hex"),  // 64-char hex
        algorandAddress,
        signingProvider: "algosdk",
        encryptedSkCiphertext: encryptedSk.ciphertext,
        encryptedSkIv: encryptedSk.iv,
        encryptedSkAuthTag: encryptedSk.authTag,
        encryptionKeyVersion: 1,
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
   * Sign a transaction using the wallet's decrypted private key.
   * 
   * Fetches encrypted sk from DB, decrypts, signs transaction, then zeros
   * the private key buffer from memory.
   */
  async signTransaction(walletId: string, unsignedTxnBytes: Uint8Array): Promise<Uint8Array> {
    // Fetch wallet record
    const [wallet] = await db
      .select({
        algorandAddress: wallets.algorandAddress,
        encryptedSkCiphertext: wallets.encryptedSkCiphertext,
        encryptedSkIv: wallets.encryptedSkIv,
        encryptedSkAuthTag: wallets.encryptedSkAuthTag,
        signingProvider: wallets.signingProvider,
      })
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .limit(1);
    
    if (!wallet) {
      throw new ApiError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
    }
    
    if (wallet.signingProvider !== "algosdk") {
      throw new ApiError(
        "INVALID_SIGNING_PROVIDER",
        `Wallet ${walletId} is not an algosdk wallet (provider: ${wallet.signingProvider})`
      );
    }
    
    if (!wallet.encryptedSkCiphertext || !wallet.encryptedSkIv || !wallet.encryptedSkAuthTag) {
      throw new ApiError(
        "MISSING_PRIVATE_KEY",
        `Wallet ${walletId} has no encrypted private key stored`
      );
    }
    
    // Decrypt private key
    const envelope: PrivateKeyEnvelope = {
      ciphertext: wallet.encryptedSkCiphertext,
      iv: wallet.encryptedSkIv,
      authTag: wallet.encryptedSkAuthTag,
    };
    
    let sk: Uint8Array | null = null;
    
    try {
      sk = decryptPrivateKey(envelope);
      
      // Sign transaction
      // Use algosdk v3: decode, then sign with sk, produce correctly encoded msgpack
      const unsignedTxn = algosdk.decodeUnsignedTransaction(unsignedTxnBytes);
      const signedTxnBytes = unsignedTxn.signTxn(sk);
      
      return signedTxnBytes;
    } finally {
      // Zero the private key buffer from memory
      if (sk) {
        sk.fill(0);
      }
    }
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

/**
 * Generate a short UUID suffix for placeholder IDs.
 */
function walletId(): string {
  return crypto.randomUUID().substring(0, 8);
}