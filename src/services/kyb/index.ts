import { getSecret } from "../../lib/secrets.js";
import type { KybProvider } from "./types.js";
import { MockKybProvider } from "./mock-provider.js";
import { DiditKybProvider } from "./didit-provider.js";

let kybProvider: KybProvider | null = null;

export function getKybProvider(): KybProvider {
  if (kybProvider) {
    return kybProvider;
  }

  const provider = getSecret("KYB_PROVIDER") || "mock";

  switch (provider) {
    case "mock":
      kybProvider = new MockKybProvider();
      break;
    case "didit":
      kybProvider = new DiditKybProvider();
      break;
    default:
      throw new Error(`Unknown KYB_PROVIDER: ${provider}. Valid values: mock, didit`);
  }

  return kybProvider;
}

export { MockKybProvider } from "./mock-provider.js";
export { DiditKybProvider } from "./didit-provider.js";
export type { KybProvider, KybSession, KybSessionStatus, KybStatus } from "./types.js";