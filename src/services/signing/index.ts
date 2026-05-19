/**
 * Signing Provider Factory
 * 
 * Returns the appropriate SigningProvider based on SIGNING_PROVIDER env var.
 * Default: algosdk for development, turnkey for production (future).
 */

import { SigningProvider, SigningProviderType } from "./types.js";
import { AlgosdkSigningProvider } from "./algosdk-provider.js";
import { TurnkeySigningProvider } from "./turnkey-provider.js";

let provider: SigningProvider | null = null;

/**
 * Get the configured signing provider.
 * 
 * SIGNING_PROVIDER values:
 * - "algosdk" (default for dev): In-process Ed25519 signing with encrypted keys
 * - "turnkey": HSM-backed signing via Turnkey (delegates to turnkey service)
 * 
 * Throws if SIGNING_PROVIDER is set to an unknown value.
 */
export function getSigningProvider(): SigningProvider {
  if (provider) {
    return provider;
  }
  
  const providerType = (process.env.SIGNING_PROVIDER ?? "algosdk") as SigningProviderType;
  
  switch (providerType) {
    case "algosdk":
      provider = new AlgosdkSigningProvider();
      break;
    case "turnkey":
      // Turnkey provider delegates to existing turnkey service for backward compatibility
      // This allows existing tests that mock turnkeyService to continue working
      provider = new TurnkeySigningProvider();
      break;
    default:
      throw new Error(
        `Unknown SIGNING_PROVIDER: ${providerType}. ` +
        `Valid values: algosdk, turnkey`
      );
  }
  
  console.log(`[Signing] Using provider: ${providerType}`);
  
  return provider;
}

/**
 * Get the current provider type from environment.
 */
export function getSigningProviderType(): SigningProviderType {
  return (process.env.SIGNING_PROVIDER ?? "algosdk") as SigningProviderType;
}

/**
 * Reset the provider (for testing).
 */
export function resetSigningProvider(): void {
  provider = null;
}