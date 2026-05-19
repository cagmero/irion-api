import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { TurnkeyServerClient } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import crypto from "crypto";

const config = {
  organizationId: process.env.TURNKEY_ORG_ID!,
  apiBaseUrl: process.env.TURNKEY_API_BASE_URL!,
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
};

const stamper = new ApiKeyStamper({
  apiPublicKey: config.apiPublicKey,
  apiPrivateKey: config.apiPrivateKey,
});

const client = new TurnkeyServerClient({
  apiBaseUrl: config.apiBaseUrl,
  organizationId: config.organizationId,
  stamper,
});

function compressPublicKey(uncompressedHex: string): string {
  const bytes = Buffer.from(uncompressedHex, "hex");
  // Uncompressed: 04 (1 byte) + x (32 bytes) + y (32 bytes) = 65 bytes
  const x = bytes.subarray(1, 33);
  const y = bytes.subarray(33, 65);
  const yLastByte = y[y.length - 1];
  const prefix = yLastByte % 2 === 0 ? "02" : "03";
  return prefix + x.toString("hex");
}

async function testCreateSubOrg() {
  const institutionId = crypto.randomUUID();
  const institutionName = "Test Institution";

  // Generate a new P-256 key pair
  const { publicKey: rootPublicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });

  // Extract uncompressed public key from DER SPKI
  // SPKI header for P-256 is 26 bytes, then 04 + x + y (65 bytes)
  const pubKeyBuffer = rootPublicKey as Buffer;
  const uncompressedKeyHex = pubKeyBuffer.subarray(pubKeyBuffer.length - 65).toString("hex");
  console.log("Uncompressed (from DER):", uncompressedKeyHex, `(${uncompressedKeyHex.length / 2} bytes)`);
  
  const compressedPublicKey = compressPublicKey(uncompressedKeyHex);
  console.log("Compressed:", compressedPublicKey, `(${compressedPublicKey.length / 2} bytes)`);
  console.log("Starts with 02/03:", compressedPublicKey.startsWith("02") || compressedPublicKey.startsWith("03"));

  try {
    console.log("\nAttempting createSubOrganization...");
    const response = await client.createSubOrganization({
      organizationId: config.organizationId,
      subOrganizationName: `${institutionName} (${institutionId})`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: `root-${institutionId}`,
          apiKeys: [
            {
              apiKeyName: `api-key-${institutionId}`,
              publicKey: compressedPublicKey,
              curveType: "API_KEY_CURVE_P256",
            },
          ],
          authenticators: [],
          oauthProviders: [],
        },
      ],
    } as any);

    console.log("SUCCESS");
    const subOrgId = (response as any).subOrganizationId;
    console.log("Sub-org ID:", subOrgId);
  } catch (err: any) {
    console.log("\nFULL ERROR:");
    console.log("  name:", err.name);
    console.log("  message:", err.message);
    console.log("  code:", err.code);
  }
}

testCreateSubOrg();
