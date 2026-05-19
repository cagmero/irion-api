/**
 * Envelope Encryption - AES-256-GCM for private key storage
 * 
 * Uses a master key from ENCRYPTION_MASTER_KEY env var (32 bytes base64).
 * Generates a random IV for each encryption operation.
 * Authentication tag provides integrity verification.
 */

import crypto from "crypto";
import { getSecret } from "./secrets.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16;

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface EncryptedEnvelope {
  ciphertext: string; // base64
  iv: string;          // base64
  authTag: string;     // base64
}

/**
 * Get the master encryption key.
 * Key must be 32 bytes (256 bits). Encode as base64 in env.
 * 
 * Generate: openssl rand -base64 32
 */
function getMasterKey(): Buffer {
  const keyBase64 = getSecret("ENCRYPTION_MASTER_KEY");
  const key = Buffer.from(keyBase64, "base64");
  
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_MASTER_KEY must be ${KEY_LENGTH} bytes (base64). ` +
      `Got ${key.length} bytes. Generate with: openssl rand -base64 32`
    );
  }
  
  return key;
}

/**
 * Encrypt plaintext using AES-256-GCM with a random IV.
 * 
 * @param plaintext - Data to encrypt
 * @returns Encrypted payload (ciphertext, IV, auth tag)
 */
export function encrypt(plaintext: Buffer): EncryptedPayload {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return { ciphertext, iv, authTag };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * 
 * @param payload - Encrypted payload (ciphertext, IV, auth tag)
 * @returns Decrypted plaintext
 * @throws Error if authentication fails (tampered ciphertext)
 */
export function decrypt(payload: EncryptedPayload): Buffer {
  const key = getMasterKey();
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, payload.iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  
  decipher.setAuthTag(payload.authTag);
  
  const plaintext = Buffer.concat([
    decipher.update(payload.ciphertext),
    decipher.final(),
  ]);
  
  return plaintext;
}

/**
 * Encrypt and return as base64-encoded envelope (for DB storage).
 */
export function encryptToEnvelope(plaintext: Buffer): EncryptedEnvelope {
  const { ciphertext, iv, authTag } = encrypt(plaintext);
  
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypt from base64-encoded envelope (from DB).
 */
export function decryptFromEnvelope(envelope: EncryptedEnvelope): Buffer {
  return decrypt({
    ciphertext: Buffer.from(envelope.ciphertext, "base64"),
    iv: Buffer.from(envelope.iv, "base64"),
    authTag: Buffer.from(envelope.authTag, "base64"),
  });
}

/**
 * Encrypt a private key and return components for DB storage.
 */
export interface PrivateKeyEnvelope {
  ciphertext: string; // base64
  iv: string;         // base64
  authTag: string;    // base64
}

export function encryptPrivateKey(privateKey: Uint8Array): PrivateKeyEnvelope {
  return encryptToEnvelope(Buffer.from(privateKey));
}

/**
 * Decrypt a private key from DB storage.
 */
export function decryptPrivateKey(envelope: PrivateKeyEnvelope): Uint8Array {
  return decryptFromEnvelope(envelope);
}