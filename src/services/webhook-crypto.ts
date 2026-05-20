import crypto from "crypto";

export function encryptWebhookSecret(plaintext: Buffer): Buffer {
  const masterKey = process.env.WEBHOOK_SIGNING_SECRET;
  if (!masterKey) throw new Error("WEBHOOK_SIGNING_SECRET not set");
  const key = crypto.scryptSync(masterKey, "irion-pgcrypto-salt", 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decryptWebhookSecret(encrypted: Buffer): Buffer {
  const masterKey = process.env.WEBHOOK_SIGNING_SECRET;
  if (!masterKey) throw new Error("WEBHOOK_SIGNING_SECRET not set");
  const key = crypto.scryptSync(masterKey, "irion-pgcrypto-salt", 32);
  const iv = encrypted.subarray(0, 16);
  const tag = encrypted.subarray(16, 32);
  const ciphertext = encrypted.subarray(32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
