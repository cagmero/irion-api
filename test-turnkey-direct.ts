import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { TurnkeyServerClient } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";

const config = {
  organizationId: process.env.TURNKEY_ORG_ID!,
  apiBaseUrl: process.env.TURNKEY_API_BASE_URL!,
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
  parentWalletId: process.env.TURNKEY_PARENT_WALLET_ID!,
};

console.log("Config:", {
  orgId: config.organizationId?.substring(0, 8) + "...",
  baseUrl: config.apiBaseUrl,
  pubKey: config.apiPublicKey?.substring(0, 16) + "...",
  parentWalletId: config.parentWalletId,
});

const stamper = new ApiKeyStamper({
  apiPublicKey: config.apiPublicKey,
  apiPrivateKey: config.apiPrivateKey,
});

const client = new TurnkeyServerClient({
  apiBaseUrl: config.apiBaseUrl,
  organizationId: config.organizationId,
  stamper,
});

async function testCreateSubOrg() {
  try {
    console.log("\nAttempting createSubOrganization...");
    const response = await client.createSubOrganization({
      organizationId: config.organizationId,
      name: `Test Institution (test-id)`,
      rootUsers: [
        {
          userName: `root-test-id`,
          apiKeys: [
            {
              publicKey: config.apiPublicKey,
              privateKey: config.apiPrivateKey,
            },
          ],
        },
      ],
    } as any);
    console.log("SUCCESS:", JSON.stringify(response, null, 2));
  } catch (err: any) {
    console.log("\nFULL ERROR:");
    console.log("  name:", err.name);
    console.log("  message:", err.message);
    console.log("  status:", err.status);
    console.log("  statusCode:", err.statusCode);
    console.log("  code:", err.code);
    console.log("  response:", JSON.stringify(err.response, null, 2));
    console.log("  data:", JSON.stringify(err.data, null, 2));
    console.log("  stack:", err.stack);
  }
}

async function testCreateWallet() {
  try {
    console.log("\nAttempting createWallet in parent org...");
    const response = await client.createWallet({
      organizationId: config.organizationId,
      walletName: `Test Wallet - ${Date.now()}`,
      accounts: [
        {
          curve: "CURVE_ED25519",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/283'/0'/0/0",
          addressFormat: "ADDRESS_FORMAT_COMPRESSED",
        },
      ],
    } as any);
    console.log("SUCCESS:", JSON.stringify(response, null, 2));
  } catch (err: any) {
    console.log("\nFULL ERROR:");
    console.log("  name:", err.name);
    console.log("  message:", err.message);
    console.log("  status:", err.status);
    console.log("  statusCode:", err.statusCode);
    console.log("  code:", err.code);
    console.log("  response:", JSON.stringify(err.response, null, 2));
    console.log("  data:", JSON.stringify(err.data, null, 2));
  }
}

testCreateSubOrg().then(() => testCreateWallet());
