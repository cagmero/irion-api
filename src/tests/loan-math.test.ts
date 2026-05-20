import { describe, it, expect } from "vitest";
import { computeInterest, amortizationSchedule, ROUNDS_PER_YEAR } from "../lib/loan-math.js";

describe("computeInterest", () => {
  const P = 1_000_000, R500 = 500, ORIG = 10_000;

  it("zero rounds → zero", () => {
    const r = computeInterest({ principal: P, interestRateBps: R500, originationRound: ORIG, currentRound: ORIG });
    expect(r.accruedInterest).toBe(0); expect(r.totalDue).toBe(P);
  });
  it("full year → 5%", () => {
    const r = computeInterest({ principal: P, interestRateBps: R500, originationRound: ORIG, currentRound: ORIG + ROUNDS_PER_YEAR });
    expect(r.accruedInterest).toBe(50_000); expect(r.totalDue).toBe(1_050_000);
  });
  it("half year → ~2.5%", () => {
    const r = computeInterest({ principal: P, interestRateBps: R500, originationRound: ORIG, currentRound: ORIG + Math.floor(ROUNDS_PER_YEAR / 2) });
    expect(r.accruedInterest).toBeGreaterThan(24_900); expect(r.accruedInterest).toBeLessThan(25_100);
  });
  it("zero principal → zero", () => {
    const r = computeInterest({ principal: 0, interestRateBps: R500, originationRound: ORIG, currentRound: ORIG + 1000 });
    expect(r.accruedInterest).toBe(0); expect(r.totalDue).toBe(0);
  });
  it("late fee", () => {
    const r = computeInterest({ principal: P, interestRateBps: R500, originationRound: ORIG, currentRound: ORIG + 100, isLate: true, lateFeeBps: 200 });
    expect(r.lateFee).toBeGreaterThan(0); expect(r.lateFee).toBeLessThan(P);
  });
  it("large numbers", () => {
    const r = computeInterest({ principal: 9_000_000_000, interestRateBps: 1000, originationRound: ORIG, currentRound: ORIG + 10_000 });
    expect(r.accruedInterest).toBeGreaterThan(0); expect(r.totalDue).toBeGreaterThan(9_000_000_000);
  });
});

describe("amortizationSchedule", () => {
  it("zero interest = uniform", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 0, numInstallments: 10, intervalRounds: 100_000, originationRound: 1000 });
    expect(s).toHaveLength(10);
    expect(s[0].principalPortion).toBe(100_000);
    expect(s[0].interestPortion).toBe(0);
  });
  it("1 installment = full principal + interest", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 500, numInstallments: 1, intervalRounds: 100_000, originationRound: 1000 });
    expect(s).toHaveLength(1);
    expect(s[0].principalPortion).toBe(1_000_000);
    expect(s[0].interestPortion).toBeGreaterThan(0);
  });
  it("12 installments track outstanding", () => {
    const s = amortizationSchedule({ principal: 12_000_000, interestRateBps: 1000, numInstallments: 12, intervalRounds: 100_000, originationRound: 1000 });
    expect(s).toHaveLength(12);
    expect(s[0].outstandingBefore).toBe(12_000_000);
    expect(s[11].outstandingBefore - s[11].principalPortion).toBe(0);
  });
  it("total principal sums correctly", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 500, numInstallments: 5, intervalRounds: 100_000, originationRound: 1000 });
    expect(s.reduce((a, x) => a + x.principalPortion, 0)).toBe(1_000_000);
  });
  it("due rounds increment", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 500, numInstallments: 4, intervalRounds: 50_000, originationRound: 1000 });
    expect(s[0].dueRound).toBe(1000 + 50_000);
    expect(s[3].dueRound).toBe(1000 + 200_000);
  });
  it("zero installments = empty", () => {
    expect(amortizationSchedule({ principal: 1000, interestRateBps: 500, numInstallments: 0, intervalRounds: 100, originationRound: 0 })).toHaveLength(0);
  });
  it("100 installments", () => {
    const s = amortizationSchedule({ principal: 10_000_000, interestRateBps: 500, numInstallments: 100, intervalRounds: 10_000, originationRound: 1000 });
    expect(s).toHaveLength(100);
    expect(s.reduce((a, x) => a + x.principalPortion, 0)).toBe(10_000_000);
  });
  it("1 installment zero interest", () => {
    const s = amortizationSchedule({ principal: 5_000_000, interestRateBps: 0, numInstallments: 1, intervalRounds: 100_000, originationRound: 1000 });
    expect(s[0].principalPortion).toBe(5_000_000);
    expect(s[0].interestPortion).toBe(0);
  });
  it("high interest rate", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 5000, numInstallments: 6, intervalRounds: 50_000, originationRound: 1000 });
    expect(s[0].interestPortion).toBeGreaterThan(0);
    expect(s.reduce((a, x) => a + x.principalPortion, 0)).toBe(1_000_000);
  });
  it("2 installments with interest", () => {
    const s = amortizationSchedule({ principal: 2_000_000, interestRateBps: 500, numInstallments: 2, intervalRounds: 100_000, originationRound: 1000 });
    expect(s).toHaveLength(2);
    expect(s[0].principalPortion + s[1].principalPortion).toBe(2_000_000);
  });
  it("very short interval", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 500, numInstallments: 4, intervalRounds: 1_000, originationRound: 1000 });
    expect(s).toHaveLength(4);
    expect(s[0].interestPortion).toBeLessThan(1000);
  });
  it("very long interval", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 500, numInstallments: 3, intervalRounds: 5_000_000, originationRound: 1000 });
    expect(s[0].interestPortion).toBeGreaterThan(20000);
    expect(s[0].interestPortion).toBeLessThan(30000);
  });
  it("6 installments 1000 bps", () => {
    const s = amortizationSchedule({ principal: 6_000_000, interestRateBps: 1000, numInstallments: 6, intervalRounds: 50_000, originationRound: 1000 });
    expect(s[0].interestPortion).toBeGreaterThan(0);
    expect(s.reduce((a, x) => a + x.principalPortion, 0)).toBe(6_000_000);
  });
  it("10 installments 200 bps", () => {
    const s = amortizationSchedule({ principal: 10_000_000, interestRateBps: 200, numInstallments: 10, intervalRounds: 200_000, originationRound: 1000 });
    expect(s[0].interestPortion).toBeGreaterThan(0);
    expect(s[9].principalPortion).toBeGreaterThan(0);
  });
  it("installment schedule has correct total", () => {
    const s = amortizationSchedule({ principal: 1_000_000, interestRateBps: 500, numInstallments: 4, intervalRounds: 100_000, originationRound: 1000 });
    const totalInterest = s.reduce((a, x) => a + x.interestPortion, 0);
    expect(totalInterest).toBeGreaterThan(0);
  });
});
