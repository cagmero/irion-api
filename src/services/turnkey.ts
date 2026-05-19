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
import crypto from "crypto";
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

function createClient(organizationId?: string): TurnkeyServerClient {
  const config = getConfig();
  const stamper = new ApiKeyStamper({
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
  });
  // Use the provided organizationId (sub-org) or fall back to the root org.
  // Turnkey requires the client's organizationId to match the request target org.
  // Root org API keys have authority over sub-orgs, but the request must be scoped
  // to the sub-org for wallet and signing operations.
  return new TurnkeyServerClient({
    apiBaseUrl: config.apiBaseUrl,
    organizationId: organizationId ?? config.organizationId,
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
      
      // Turnkey error code 8 = quota exceeded — never retry
      if (err.code === 8) {
        throw err;
      }
      
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
 * Compress a P-256 public key from uncompressed (65 bytes, 04 + x + y) to
 * compressed (33 bytes, 02/03 + x) format required by Turnkey.
 */
function compressPublicKey(uncompressedHex: string): string {
  const bytes = Buffer.from(uncompressedHex, "hex");
  const x = bytes.subarray(1, 33);
  const y = bytes.subarray(33, 65);
  const prefix = y[y.length - 1] % 2 === 0 ? "02" : "03";
  return prefix + x.toString("hex");
}

/**
 * Create a sub-organization for an institution
 * 
 * Generates a new P-256 key pair for the sub-org's root user API key.
 * The private key is NOT stored — the parent org's API key manages the sub-org.
 */
export async function createSubOrganization(
  institutionId: string,
  institutionName: string
): Promise<{ subOrgId: string }> {
  const config = getConfig();
  const client = createClient();
  
  // Generate a new P-256 key pair for the sub-org root user
  const { publicKey: rootPublicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });
  
  // Extract uncompressed public key from DER SPKI (last 65 bytes)
  const pubKeyBuffer = rootPublicKey as Buffer;
  const uncompressedHex = pubKeyBuffer.subarray(pubKeyBuffer.length - 65).toString("hex");
  const compressedPublicKey = compressPublicKey(uncompressedHex);
  
  try {
    const response = await withRetry("createSubOrganization", async () => 
      client.createSubOrganization({
        organizationId: config.organizationId,
        subOrganizationName: `${institutionName} (${institutionId})`,
        rootQuorumThreshold: 1,
        rootUsers: [
          {
            // The root user gets TWO API keys:
            // 1. The generated ephemeral P-256 key (institutional root — placeholder for future use)
            // 2. The server's TURNKEY_API_PUBLIC_KEY — allows this server to call createWallet
            //    and signTransaction inside this sub-org using the same credentials as the root org.
            //    Without this, wallet/signing operations fail with ORGANIZATION_MISMATCH.
            userName: `root-${institutionId}`,
            apiKeys: [
              {
                apiKeyName: `api-key-${institutionId}`,
                publicKey: compressedPublicKey,
                curveType: "API_KEY_CURVE_P256",
              },
              {
                apiKeyName: `server-api-key-${institutionId}`,
                publicKey: config.apiPublicKey,
                curveType: "API_KEY_CURVE_P256",
              },
            ],
            authenticators: [],
            oauthProviders: [],
          },
        ],
      } as any)
    );
    
    const subOrgId = (response as any).subOrganizationId;
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
  // Client must be scoped to the sub-org — Turnkey rejects cross-org wallet creation.
  const client = createClient(subOrgId);
  
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
  // Use root org client — the root API key has authority over sub-org resources.
  const client = createClient();
  
  try {
    // Decode the unsigned transaction to get the correct signable bytes.
    // Algorand signs SHA512/256("TX" + msgpack(txn)), which Transaction.bytesToSign() computes.
    const unsignedTxn = algosdk.decodeUnsignedTransaction(unsignedTxnBytes);
    const signableBytes = unsignedTxn.bytesToSign();
    const signableHex = Buffer.from(signableBytes).toString("hex");
    
    // signWith must be the exact address from createWallet.addresses[0]
    const signWithAddress = walletAccountAddress.toLowerCase();
    
    const response = await withRetry("signTransaction", async () =>
      client.signRawPayload({
        organizationId: subOrgId,
        signWith: signWithAddress,
        payload: signableHex,
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
    
    // algosdk v3: use Transaction.attachSignature(senderAddress, sig) to produce
    // correctly encoded msgpack bytes. The old approach of algosdk.encodeObj({ sig, txn })
    // produces camelCase field names that algod rejects with:
    //   "msgpack decode error: no matching struct field found when decoding stream map with key assetTransfer"
    // attachSignature() uses Transaction.toEncodingData() which emits the correct
    // abbreviated msgpack keys (e.g. "arcv", "xaid") expected by algod.
    const walletAddress = walletAccountAddress.startsWith("0x")
      ? algosdk.encodeAddress(Buffer.from(walletAccountAddress.slice(2), "hex"))
      : algosdk.encodeAddress(Buffer.from(walletAccountAddress, "hex"));
    const signedTxnBytes = unsignedTxn.attachSignature(walletAddress, signatureBytes);
    
    return signedTxnBytes;
  } catch (err: any) {
    // Turnkey error code 8 = quota exceeded — map to a specific error with Retry-After hint
    if (err.code === 8) {
      const error = new ApiError(
        "TURNKEY_QUOTA_EXCEEDED",
        "Turnkey signing quota exceeded. Free tier limit reached — retry after quota reset or upgrade plan.",
        { cause: err, retryAfterSeconds: 3600 }
      );
      error.cause = err;
      throw error;
    }
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