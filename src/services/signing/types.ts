/**
 * Signing Provider Interface
 * 
 * Abstracts wallet creation and transaction signing.
 * Implemented by: algosdk-provider (dev), turnkey-provider (future HSM-backed)
 */

export interface CreateWalletResult {
  walletId: string;
  algorandAddress: string;
}

export interface SigningProvider {
  /**
   * Create a new wallet for an institution.
   * 
   * @param institutionId - The institution's UUID
   * @param label - Human-readable label for the wallet
   * @returns Wallet ID and Algorand address
   */
  createWallet(institutionId: string, label: string): Promise<CreateWalletResult>;

  /**
   * Sign a transaction with the wallet's private key.
   * 
   * @param walletId - The wallet ID (UUID from database)
   * @param unsignedTxnBytes - Raw unsigned transaction bytes
   * @returns Signed transaction bytes ready for submission
   */
  signTransaction(walletId: string, unsignedTxnBytes: Uint8Array): Promise<Uint8Array>;

  /**
   * Get the Algorand address for a wallet.
   * 
   * @param walletId - The wallet ID (UUID from database)
   * @returns 58-character Base32 Algorand address
   */
  getAddress(walletId: string): Promise<string>;
}

export type SigningProviderType = "algosdk" | "turnkey";