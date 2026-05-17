/**
 * Turnkey Service - Institutional Wallet Signing
 * 
 * Provides wallet creation and transaction signing for Algorand
 * Uses Turnkey for secure key management and signing operations
 * SDK: @turnkey/sdk-server
 */
import { TurnkeyServerClient } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import algosdk from "algosdk";
import { getSecret } from "../lib/secrets.js";
import { ApiError } from "../lib/errors.js";

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

interface TurnkeyConfig {
  organizationId: string;
  apiBaseUrl: string;
  apiPublicKey: string;
  apiPrivateKey: string;
}

function getConfig(): TurnkeyConfig {
  return {
    organizationId: getSecret("TURNKEY_ORG_ID"),
    apiBaseUrl: getSecret("TURNKEY_API_BASE_URL"),
    apiPublicKey: getSecret("TURNKEY_API_PUBLIC_KEY"),
    apiPrivateKey: getSecret("TURNKEY_API_PRIVATE_KEY"),
  };
}

function createClient(): TurnkeyServerClient {
  const config = getConfig();
  const stamper = new ApiKeyStamper({
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
  });
  return new TurnkeyServerClient({
    apiBaseUrl: config.apiBaseUrl,
    organizationId: config.organizationId,
    stamper,
  });
}

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      
      const status = err.status || err.statusCode;
      const isRetryable = status >= 500 || err.code === "ENOTFOUND" || err.code === "ECONNRESET";
      
      if (!isRetryable || attempt === MAX_RETRIES - 1) {
        throw err;
      }
      
      console.warn(`Turnkey ${operation} failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}. Retrying in ${RETRY_DELAYS[attempt]}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
  
  throw lastError;
}

/**
 * Create a sub-organization for an institution
 */
export async function createSubOrganization(
  institutionId: string,
  institutionName: string
): Promise<{ subOrgId: string }> {
  const config = getConfig();
  const client = createClient();
  
  try {
    const response = await withRetry("createSubOrganization", async () => 
      client.createSubOrganization({
        organizationId: config.organizationId,
        name: `${institutionName} (${institutionId})`,
        rootUsers: [
          {
            userName: `root-${institutionId}`,
            apiKeys: [
              {
                publicKey: config.apiPublicKey,
                privateKey: config.apiPrivateKey,
              },
            ],
          },
        ],
      } as any)
    );
    
    const subOrgId = (response as any).subOrganization?.id;
    if (!subOrgId) {
      throw new Error("No subOrgId returned from Turnkey");
    }
    
    return { subOrgId };
  } catch (err: any) {
    const error = new ApiError("TURNKEY_ERROR", "Failed to create sub-organization", { cause: err });
    error.cause = err;
    throw error;
  }
}

/**
 * Create a wallet for an institution
 * 
 * Returns:
 * - walletId: The Turnkey wallet container ID
 * - address: 64-char hex Ed25519 public key (used as signWith)
 * - algorandAddress: 58-char Base32 Algorand address
 */
export async function createWallet(
  subOrgId: string,
  label: string
): Promise<{ walletId: string; address: string; algorandAddress: string }> {
  const client = createClient();
  
  try {
    const walletName = `Wallet - ${label} - ${Date.now()}`;
    
    const response = await withRetry("createWallet", async () =>
      client.createWallet({
        organizationId: subOrgId,
        walletName,
        accounts: [
          {
            curve: "CURVE_ED25519",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/283'/0'/0/0",
            addressFormat: "ADDRESS_FORMAT_COMPRESSED",
          },
        ],
      } as any)
    );
    
    const walletId = (response as any).walletId;
    const turnkeyAccountAddress = (response as any).addresses?.[0];
    
    if (!walletId || !turnkeyAccountAddress) {
      throw new Error("Missing walletId or address in Turnkey response");
    }
    
    const algorandAddress = deriveAlgorandAddress(turnkeyAccountAddress);
    
    return { walletId, address: turnkeyAccountAddress, algorandAddress };
  } catch (err: any) {
    const error = new ApiError("TURNKEY_ERROR", "Failed to create wallet", { cause: err });
    error.cause = err;
    throw error;
  }
}

/**
 * Sign a transaction with Turnkey
 * 
 * Takes unsigned transaction bytes, signs with Turnkey's Ed25519 key,
 * and returns the signed transaction bytes ready for submission
 */
export async function signTransaction(
  walletAccountAddress: string,
  subOrgId: string,
  unsignedTxnBytes: Uint8Array
): Promise<Uint8Array> {
  const client = createClient();
  
  try {
    const txnHex = Buffer.from(unsignedTxnBytes).toString("hex");
    
    // CRITICAL: signWith must be the exact 64-char lowercase hex from createWallet.addresses[0]
    const signWithAddress = walletAccountAddress.toLowerCase();
    
    const response = await withRetry("signTransaction", async () =>
      client.signRawPayload({
        organizationId: subOrgId,
        signWith: signWithAddress,
        payload: txnHex,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
      } as any)
    );
    
    const r = (response as any).r;
    const s = (response as any).s;
    
    if (!r || !s) {
      throw new Error("No signature returned from Turnkey");
    }
    
    // Combine r and s components into 64-byte Ed25519 signature
    const rBytes = Buffer.from(r, "hex");
    const sBytes = Buffer.from(s, "hex");
    const signatureBytes = Buffer.concat([rBytes, sBytes]);
    
    if (signatureBytes.length !== 64) {
      throw new Error(`Invalid signature length: ${signatureBytes.length}, expected 64`);
    }
    
    // Decode the unsigned transaction
    const unsignedTxn = algosdk.decodeUnsignedTransaction(unsignedTxnBytes);
    
    // Create signed transaction envelope: { sig: Uint8Array(64), txn: Transaction }
    const signedTxn = {
      sig: signatureBytes,
      txn: unsignedTxn,
    };
    
    // Encode the signed transaction
    const signedTxnBytes = algosdk.encodeObj(signedTxn);
    
    return signedTxnBytes;
  } catch (err: any) {
    const error = new ApiError("TURNKEY_ERROR", "Failed to sign transaction", { cause: err });
    error.cause = err;
    throw error;
  }
}

/**
 * Derive Algorand address from Turnkey public key
 * 
 * Turnkey returns raw Ed25519 public key (32 bytes, hex-encoded as 64 chars)
 * Encode as Algorand address (58-char Base32 with checksum)
 */
export function deriveAlgorandAddress(publicKeyHex: string): string {
  const publicKeyBytes = Buffer.from(publicKeyHex, "hex");
  return algosdk.encodeAddress(publicKeyBytes);
}