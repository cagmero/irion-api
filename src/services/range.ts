// STUBBED: Range wallet screening not yet integrated.
// See DEFERRED.md → "Wallet Screening Providers" for activation plan.

export interface RangeScreenResult {
  flagged: boolean;
  riskScore: number;        // 0-1000
  labels: string[];         // e.g. ["sanctioned", "exchange", "mixer"]
  checkedAt: string;        // ISO 8601
}

export async function screenWalletRange(algorandAddress: string): Promise<RangeScreenResult> {
  // STUBBED: returns clean result for any address not in the test denylist
  const denylist = (process.env.RANGE_MOCK_DENYLIST ?? "").split(",").filter(Boolean);
  const flagged = denylist.includes(algorandAddress);

  return {
    flagged,
    riskScore: flagged ? 950 : 10,
    labels: flagged ? ["mock_denylist"] : [],
    checkedAt: new Date().toISOString(),
  };
}