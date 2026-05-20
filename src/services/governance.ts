/**
 * Governance Bridge — DEMO/MVP ONLY
 *
 * Signs Algorand transactions using the deployer account (DEPLOYER_MNEMONIC)
 * to act as the protocol's governance address for vault operations.
 *
 * The deployer's Algorand address is set as governance_address in Vault,
 * LoanFactory, LendingPool, and CreditOracle contracts. This bridge allows
 * the API server to call governance-restricted methods (e.g., Vault.create_oracle_entry)
 * during the MVP phase.
 *
 * Pre-mainnet: deploy a dedicated GovernanceMultisig contract that auto-approves
 * vault creations from a whitelisted API operator account.
 * Tracked in DEFERRED.md → "Governance Bridge Replacement"
 */

import algosdk from "algosdk";
import { ApiError } from "../lib/errors.js";

const GOVERNANCE_BRIDGE_ENABLED = process.env.GOVERNANCE_BRIDGE_ENABLED === "true";

function assertBridgeEnabled(): void {
  if (!GOVERNANCE_BRIDGE_ENABLED) {
    throw new ApiError("GOVERNANCE_BRIDGE_DISABLED", "Loan origination requires GOVERNANCE_BRIDGE_ENABLED=true in .env.local");
  }
}

/**
 * Returns the deployer account used for governance signing.
 */
export function getGovernanceAccount(): algosdk.Account {
  assertBridgeEnabled();
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) {
    throw new ApiError("SIGNING_FAILED", "DEPLOYER_MNEMONIC not set — governance signing unavailable");
  }
  return algosdk.mnemonicToSecretKey(mnemonic);
}

/**
 * Signs an unsigned transaction with the governance (deployer) key.
 * Every call writes an audit log entry for forensic traceability.
 */
export async function signWithGovernance(
  unsignedTxn: Uint8Array,
  auditLogFn: (action: string, details: Record<string, unknown>) => Promise<void>,
): Promise<Uint8Array> {
  assertBridgeEnabled();
  const account = getGovernanceAccount();
  const txn = algosdk.decodeUnsignedTransaction(unsignedTxn) as any;
  const signedTxn = txn.signTxn(account.sk);

  await auditLogFn("governance_signature_used", {
    signing_authority: "governance_bridge",
    sender: account.addr.toString(),
  });

  try {
    const Sentry = await import("@sentry/node");
    Sentry.setTag("signing_authority", "governance_bridge");
  } catch { /* Sentry not configured */ }

  return signedTxn;
}

