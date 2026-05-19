import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as argon2 from "argon2";
import crypto from "crypto";
import { db } from "../db/index.js";
import {
  institutions,
  apiKeys,
  kybVerifications,
  wallets,
  lendingPositions,
  borrowingPositions,
  auditLog,
} from "../db/schema.js";
import { sql, eq, and, desc } from "drizzle-orm";
import algosdk from "algosdk";
import { createSubOrganization } from "../services/turnkey.js";
import { algorandService } from "../services/algorand.js";
import { getKybProvider } from "../services/kyb/index.js";
import { ApiError } from "../lib/errors.js";
import { getSecret } from "../lib/secrets.js";
import { getSigningProvider, getSigningProviderType } from "../services/signing/index.js";

// Asset symbol lookup — testnet asset IDs used in Irion contracts.
//
// ASSET NOTE (Deviation 5):
// Using mock asset (Irion Test USDC, ID 758916950) on testnet because Circle's
// testnet USDC faucet is rate-limited. Mainnet deployment requires:
// 1. Redeploy LendingPool against asset ID 31566704 (Circle USDC mainnet)
// 2. Update env vars
// 3. Re-run full integration suite
//
// Circle USDC references:
//   Testnet:  10458941
//   Mainnet:  31566704
const CIRCLE_USDC_TESTNET_ASSET_ID = 10458941;
const CIRCLE_USDC_MAINNET_ASSET_ID = 31566704;

const ASSET_SYMBOLS: Record<number, string> = {
  758916950: "TEST_USDC", // Irion Test USDC (mock)
  10458941:  "USDC",      // Circle USDC testnet (for reference)
  0:         "ALGO",      // ALGO is always assetId 0 in Algorand
};

function requireAdminKey(request: FastifyRequest): void {
  const provided = request.headers["x-admin-key"] as string | undefined;
  const expected = getSecret("ADMIN_API_KEY");

  if (!provided) {
    throw new ApiError("ADMIN_AUTH_REQUIRED", "X-Admin-Key header is required");
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const lengthMatch = a.length === b.length;

  const padded = lengthMatch ? b : Buffer.alloc(a.length);
  const valuesMatch = crypto.timingSafeEqual(a, padded);

  if (!lengthMatch || !valuesMatch) {
    throw new ApiError("ADMIN_AUTH_REQUIRED", "X-Admin-Key is invalid");
  }
}

export async function accountsRoutes(app: FastifyInstance) {
  app.post("/", {
    config: { rateLimitTier: "public" } as any,
    schema: {
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 255 },
          metadata: { type: "object" },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string" },
            client_id: { type: "string" },
            client_secret: { type: "string" },
            hmac_secret: { type: "string" },
            turnkeySubOrgId: { type: "string" },
            kybSessionId: { type: "string" },
            kybVerificationUrl: { type: "string" },
          },
        },
        409: {
          type: "object",
          properties: {
            code: { type: "string" },
            detail: { type: "string" },
          },
        },
        502: {
          type: "object",
          properties: {
            code: { type: "string" },
            detail: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireAdminKey(request);

    const body = request.body as { name: string; metadata?: Record<string, unknown> };
    const { name } = body;

    const [existing] = await db
      .select()
      .from(institutions)
      .where(sql`lower(name) = lower(${name})`);

    if (existing) {
      throw new ApiError("INSTITUTION_ALREADY_EXISTS", `Institution with name "${name}" already exists`);
    }

    const [institution] = await db
      .insert(institutions)
      .values({ name, status: "pending" })
      .returning();

    const keyRandom = crypto.randomBytes(16).toString("hex");
    const clientId = `iri_prod_sk_${keyRandom}`;
    const keyPrefix = clientId.substring(0, 20);
    const clientSecret = crypto.randomBytes(32).toString("hex");

    const keyHash = await argon2.hash(clientSecret, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1,
    });

    const hmacSecretPlain = crypto.randomBytes(32);
    const masterKey = getSecret("WEBHOOK_SIGNING_SECRET");
    const hmacSecretKey = crypto.scryptSync(masterKey, "irion-pgcrypto-salt", 32);
    const hmacIv = crypto.randomBytes(16);
    const hmacCipher = crypto.createCipheriv("aes-256-gcm", hmacSecretKey, hmacIv);
    const hmacEncrypted = Buffer.concat([hmacCipher.update(hmacSecretPlain), hmacCipher.final()]);
    const hmacTag = hmacCipher.getAuthTag();
    const hmacSecretEncrypted = Buffer.concat([hmacIv, hmacTag, hmacEncrypted]);

    const [apiKey] = await db
      .insert(apiKeys)
      .values({
        institutionId: institution.id,
        keyPrefix,
        keyHash,
        hmacSecret: hmacSecretEncrypted,
        status: "active",
      })
      .returning();

    // Create sub-organization only for Turnkey provider
    const signingProviderType = getSigningProviderType();
    let turnkeySubOrgId: string | undefined;

    if (signingProviderType === "turnkey") {
      try {
        const result = await createSubOrganization(institution.id, name);
        turnkeySubOrgId = result.subOrgId;
        await db
          .update(institutions)
          .set({ turnkeySubOrgId })
          .where(eq(institutions.id, institution.id));
      } catch (err: any) {
        await db
          .update(institutions)
          .set({ status: "suspended" })
          .where(eq(institutions.id, institution.id));
        throw new ApiError("TURNKEY_ERROR", "Failed to create institutional wallet infrastructure");
      }
    }

    const kybProvider = getKybProvider();
    const kybSession = await kybProvider.createKybSession(institution.id, name);

    return reply.code(201).send({
      id: institution.id,
      status: institution.status,
      client_id: clientId,
      client_secret: clientSecret,
      hmac_secret: hmacSecretPlain.toString("hex"),
      turnkeySubOrgId,
      kybSessionId: kybSession.diditSessionId,
      kybVerificationUrl: kybSession.verificationUrl,
    });
  });

  app.get("/:id", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            id:        { type: "string" },
            name:      { type: "string" },
            status:    { type: "string" },
            kyb: {
              type: "object",
              properties: {
                status:     { type: "string" },
                verifiedAt: { type: ["string", "null"] },
                provider:   { type: "string" },
              },
            },
            primaryWallet: {
              type: ["object", "null"],
              properties: {
                algorandAddress: { type: "string" },
                turnkeyWalletId: { type: "string" },
              },
            },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const callerInstitutionId = request.institutionId;

    if (callerInstitutionId !== id) {
      throw new ApiError("FORBIDDEN_RESOURCE", "You may only access your own account");
    }

    const [row] = await db
      .select({
        id:               institutions.id,
        name:             institutions.name,
        status:           institutions.status,
        createdAt:        institutions.createdAt,
        updatedAt:        institutions.updatedAt,
        kybStatus:        kybVerifications.status,
        kybUpdatedAt:     kybVerifications.updatedAt,
        walletAddress:    wallets.algorandAddress,
        walletTurnkeyId:  wallets.turnkeyWalletId,
      })
      .from(institutions)
      .leftJoin(kybVerifications, eq(kybVerifications.institutionId, institutions.id))
      .leftJoin(
        wallets,
        and(eq(wallets.institutionId, institutions.id), eq(wallets.isPrimary, true))
      )
      .where(eq(institutions.id, id))
      .orderBy(desc(kybVerifications.createdAt))
      .limit(1);

    if (!row) {
      throw new ApiError("INSTITUTION_NOT_FOUND", `Institution ${id} not found`);
    }

    const kybProvider = process.env.KYB_PROVIDER ?? "mock";

    return reply.code(200).send({
      id:     row.id,
      name:   row.name,
      status: row.status,
      kyb: {
        status:     row.kybStatus ?? "initiated",
        verifiedAt: row.kybUpdatedAt?.toISOString() ?? null,
        provider:   kybProvider,
      },
      primaryWallet: row.walletAddress
        ? { algorandAddress: row.walletAddress, turnkeyWalletId: row.walletTurnkeyId! }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  });

  app.post("/:id/kyb/approve", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    requireAdminKey(request);
    const { id } = request.params as { id: string };

    await db
      .update(kybVerifications)
      .set({ status: "approved", details: { adminApproved: true } })
      .where(eq(kybVerifications.institutionId, id));

    await db
      .update(institutions)
      .set({ status: "active" })
      .where(eq(institutions.id, id));

    return reply.status(200).send({ status: "active", kybStatus: "approved" });
  });

  app.get("/:id/balance", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            lending:     { type: "array" },
            borrowing:   { type: "array" },
            lastUpdated: { type: ["string", "null"] },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const callerInstitutionId = request.institutionId;

    if (callerInstitutionId !== id) {
      throw new ApiError("FORBIDDEN_RESOURCE", "You may only access your own account");
    }

    const [lendingRows, borrowingRows] = await Promise.all([
      db.select().from(lendingPositions).where(eq(lendingPositions.institutionId, id)),
      db.select().from(borrowingPositions).where(eq(borrowingPositions.institutionId, id)),
    ]);

    const lending = lendingRows.map((r) => {
      const bal = BigInt(r.balance);
      const yld = BigInt(r.accruedYield);
      return {
        assetId:      r.assetId,
        assetSymbol:  ASSET_SYMBOLS[r.assetId] ?? "UNKNOWN",
        balance:      bal.toString(),
        accruedYield: yld.toString(),
        totalValue:   (bal + yld).toString(),
      };
    });

    const borrowing = borrowingRows.map((r) => {
      const bal  = BigInt(r.balance);
      const int_ = BigInt(r.accruedInterest);
      return {
        assetId:         r.assetId,
        assetSymbol:     ASSET_SYMBOLS[r.assetId] ?? "UNKNOWN",
        balance:         bal.toString(),
        accruedInterest: int_.toString(),
        totalOwed:       (bal + int_).toString(),
      };
    });

    const allUpdatedAts = [
      ...lendingRows.map((r) => r.updatedAt),
      ...borrowingRows.map((r) => r.updatedAt),
    ].filter(Boolean) as Date[];
    const lastUpdated = allUpdatedAts.length > 0
      ? new Date(Math.max(...allUpdatedAts.map((d) => d.getTime()))).toISOString()
      : null;

    return reply.code(200).send({ lending, borrowing, lastUpdated });
  });

  app.post("/:id/wallets", {
    preHandler: [async (request: FastifyRequest, reply: FastifyReply) => {
      await (request.server as any).authenticate(request, reply);
    }],
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
      body: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            walletId:        { type: "string" },
            algorandAddress: { type: "string" },
            label:           { type: "string" },
            isPrimary:       { type: "boolean" },
            optedInAssets:   { type: "array", items: { type: "integer" } },
            createdAt:       { type: "string" },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const callerInstitutionId = request.institutionId;
    const { label: labelInput } = (request.body ?? {}) as { label?: string };
    const label = labelInput?.trim() || "Primary Wallet";

    if (callerInstitutionId !== id) {
      throw new ApiError("FORBIDDEN_RESOURCE", "You may only create wallets for your own account");
    }

    const [institution] = await db
      .select()
      .from(institutions)
      .where(eq(institutions.id, id))
      .limit(1);

    if (!institution) {
      throw new ApiError("INSTITUTION_NOT_FOUND", `Institution ${id} not found`);
    }
    if (institution.status === "suspended") {
      throw new ApiError("INSTITUTION_SUSPENDED", "Institution is suspended");
    }

    const signingProviderType = getSigningProviderType();
    if (signingProviderType === "turnkey" && !institution.turnkeySubOrgId) {
      throw new ApiError(
        "INSTITUTION_SUSPENDED",
        "Institution has no Turnkey sub-organization. Re-provision via POST /v1/accounts or contact support."
      );
    }

    const [existingWallet] = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.institutionId, id), eq(wallets.isPrimary, true)))
      .limit(1);

    if (existingWallet) {
      throw new ApiError("WALLET_ALREADY_EXISTS", "Institution already has a primary wallet");
    }

    // Create wallet via signing provider (agnostic to provider type)
    const signingProvider = getSigningProvider();
    const { walletId, algorandAddress: algorandAddr } = await signingProvider.createWallet(id, label);

    if (!algosdk.isValidAddress(algorandAddr)) {
      throw new ApiError(
        "INTERNAL_ERROR",
        `Derived Algorand address is invalid: ${algorandAddr}`
      );
    }

    // Fund the new wallet with ALGO
    const algodClient = algorandService.client.client.algod;
    const FUND_AMOUNT = 500_000;
    const deployerMnemonic = process.env.DEPLOYER_MNEMONIC;
    if (deployerMnemonic) {
      const deployer = algosdk.mnemonicToSecretKey(deployerMnemonic);
      const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer.addr.toString(),
        receiver: algorandAddr,
        amount: BigInt(FUND_AMOUNT),
        suggestedParams: await algodClient.getTransactionParams().do(),
      });
      const signedFund = fundTxn.signTxn(deployer.sk);
      try {
        await algorandService.submitSignedTransaction(signedFund);
      } catch (err: any) {
        console.warn(`Warning: Failed to fund wallet ${algorandAddr}: ${err.message}`);
      }
    }

    // Opt wallet into required ASAs
    const ASSETS_TO_OPT_IN = [
      parseInt(process.env.TEST_USDC_ASSET_ID ?? "758916950"),
      parseInt(process.env.LENDING_POOL_V2_USDC_SENIOR_LP_TOKEN ?? "762580194"),
    ];

    const optedInAssets: number[] = [];
    const sp = await algodClient.getTransactionParams().do();

    for (const assetId of ASSETS_TO_OPT_IN) {
      const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender:        algorandAddr,
        receiver:      algorandAddr,
        assetIndex:    assetId,
        amount:        0n,
        suggestedParams: sp,
      });

      const signedOptIn = await signingProvider.signTransaction(
        walletId,
        algosdk.encodeUnsignedTransaction(optInTxn)
      );

      try {
        await algorandService.submitSignedTransaction(signedOptIn);
        optedInAssets.push(assetId);
      } catch (err: any) {
        const alreadyOptedIn = err?.message?.includes("already opted in") ||
                               err?.message?.includes("asset already in account");
        if (!alreadyOptedIn) {
          throw new ApiError(
            "ALGORAND_SUBMIT_FAILED",
            `Failed to opt wallet into asset ${assetId}: ${err.message}`
          );
        }
        optedInAssets.push(assetId);
      }
    }

    // Update wallet with optedInAssets
    const [wallet] = await db
      .update(wallets)
      .set({ optedInAssets })
      .where(eq(wallets.id, walletId))
      .returning();

    await db.insert(auditLog).values({
      institutionId: id,
      action: "wallet.created",
      details: { walletId, algorandAddress: algorandAddr, optedInAssets },
    });

    return reply.code(201).send({
      walletId:        wallet.id,
      algorandAddress: algorandAddr,
      label:           wallet.label,
      isPrimary:       wallet.isPrimary,
      optedInAssets:   wallet.optedInAssets,
      createdAt:       wallet.createdAt.toISOString(),
    });
  });
}