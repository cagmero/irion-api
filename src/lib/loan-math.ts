/**
 * Loan Math — Off-chain interest computation for TERM and INSTALLMENT loans.
 *
 * Interest is computed off-chain because the LoanFactory contract does not track
 * interest on-chain. The contract only checks total_repaid >= principal for completion.
 *
 * Borrower must repay principal + accrued_interest to fully close the loan.
 * The API computes total_due and surfaces it via GET /v1/loans/:id.
 *
 * Pre-mainnet: enforce interest on-chain via contract upgrade.
 *
 * Formula: simple interest
 *   accrued_interest = principal × rate_bps × rounds_elapsed / (ROUNDS_PER_YEAR × 10000)
 */

// Algorand mainnet/testnet ~3s blocks → ~10.5M rounds/year
export const ROUNDS_PER_YEAR = 10_512_000;
export const BPS = 10_000; // basis points denominator

export interface InterestInput {
  principal: number;
  interestRateBps: number;
  originationRound: number;
  currentRound: number;
  lateFeeBps?: number;
  isLate?: boolean;
}

export interface InterestResult {
  accruedInterest: number;
  lateFee: number;
  totalDue: number;
  roundsElapsed: number;
}

export function computeInterest(input: InterestInput): InterestResult {
  const { principal, interestRateBps, originationRound, currentRound, lateFeeBps = 0, isLate = false } = input;
  const roundsElapsed = Math.max(0, currentRound - originationRound);
  const accruedInterest = Number(
    BigInt(principal) * BigInt(interestRateBps) * BigInt(roundsElapsed) /
    (BigInt(ROUNDS_PER_YEAR) * BigInt(BPS))
  );
  const lateFee = isLate
    ? Number((BigInt(principal + accruedInterest) * BigInt(lateFeeBps)) / BigInt(BPS))
    : 0;
  return { accruedInterest, lateFee, totalDue: principal + accruedInterest + lateFee, roundsElapsed };
}

export interface InstallmentShape {
  index: number;
  dueRound: number;
  principalPortion: number;
  interestPortion: number;
  totalAmount: number;
  outstandingBefore: number;
}

export interface AmortizationInput {
  principal: number;
  interestRateBps: number;
  numInstallments: number;
  intervalRounds: number;
  originationRound: number;
}

/**
 * Compute amortization schedule using simple-interest-per-installment.
 *
 * Each installment's interest = outstanding × rate × intervalRounds / ROUNDS_PER_YEAR
 * Principal portion = total per-installment allocation (principal/n) minus interest.
 * Last installment may differ slightly due to rounding.
 *
 * Contract tracks only installments_paid and installment_amount = principal/n (no interest).
 * Interest is off-chain. The API requires totalAmount to match contract expectations.
 */
export function amortizationSchedule(input: AmortizationInput): InstallmentShape[] {
  const { principal, interestRateBps, numInstallments, intervalRounds, originationRound } = input;
  if (numInstallments <= 0) return [];

  const basePrincipal = Math.floor(principal / numInstallments);
  let outstanding = principal;
  const schedule: InstallmentShape[] = [];

  for (let i = 0; i < numInstallments; i++) {
    const dueRound = originationRound + intervalRounds * (i + 1);

    // Interest on outstanding balance for this interval
    const interestPortion = Number(
      BigInt(outstanding) * BigInt(interestRateBps) * BigInt(intervalRounds) /
      (BigInt(ROUNDS_PER_YEAR) * BigInt(BPS))
    );

    // Principal portion: equal split, last takes remainder
    const isLast = i === numInstallments - 1;
    const principalPortion = isLast ? outstanding : Math.min(basePrincipal, outstanding);
    const totalAmount = principalPortion + interestPortion;

    schedule.push({
      index: i, dueRound,
      principalPortion, interestPortion, totalAmount,
      outstandingBefore: outstanding,
    });
    outstanding -= principalPortion;
  }
  return schedule;
}
