import { screenWalletHapi, type HapiScreenResult } from "./hapi.js";
import { screenWalletRange, type RangeScreenResult } from "./range.js";

export interface WalletScreeningResult {
  passed: boolean;
  details: {
    hapi: HapiScreenResult;
    range: RangeScreenResult;
  };
}

export async function screenWallet(address: string): Promise<WalletScreeningResult> {
  const [hapi, range] = await Promise.all([
    screenWalletHapi(address),
    screenWalletRange(address),
  ]);

  return {
    passed: !hapi.flagged && !range.flagged,
    details: { hapi, range },
  };
}