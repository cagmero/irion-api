/**
 * Create a sub-organization for an institution
 */
export declare function createSubOrganization(institutionId: string, institutionName: string): Promise<{
    subOrgId: string;
}>;
/**
 * Create a wallet for an institution
 *
 * Returns:
 * - walletId: The Turnkey wallet container ID
 * - address: 64-char hex Ed25519 public key (used as signWith)
 * - algorandAddress: 58-char Base32 Algorand address
 */
export declare function createWallet(subOrgId: string, label: string): Promise<{
    walletId: string;
    address: string;
    algorandAddress: string;
}>;
/**
 * Sign a transaction with Turnkey
 *
 * Takes unsigned transaction bytes, signs with Turnkey's Ed25519 key,
 * and returns the signed transaction bytes ready for submission
 */
export declare function signTransaction(walletAccountAddress: string, subOrgId: string, unsignedTxnBytes: Uint8Array): Promise<Uint8Array>;
/**
 * Derive Algorand address from Turnkey public key
 *
 * Turnkey returns raw Ed25519 public key (32 bytes, hex-encoded as 64 chars)
 * Encode as Algorand address (58-char Base32 with checksum)
 */
export declare function deriveAlgorandAddress(publicKeyHex: string): string;
//# sourceMappingURL=turnkey.d.ts.map