// STUBBED: Hapi Protocol wallet screening not yet integrated.
// See DEFERRED.md → "Wallet Screening Providers" for activation plan.

export interface HapiScreenResult {
  flagged: boolean;
  riskScore: number;        // 0-1000
  labels: string[];         // e.g. ["sanctioned", "exchange", "mixer"]
  checkedAt: string;        // ISO 8601
}

export async function screenWalletHapi(algorandAddress: string): Promise<HapiScreenResult> {
  // STUBBED: returns clean result for any address not in the test denylist
  const denylist = (process.env.HAPI_MOCK_DENYLIST ?? "").split(",").filter(Boolean);
  const flagged = denylist.includes(algorandAddress);

  return {
    flagged,
    riskScore: flagged ? 950 : 10,
    labels: flagged ? ["mock_denylist"] : [],
    checkedAt: new Date().toISOString(),
  };
}