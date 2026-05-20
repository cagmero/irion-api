/**
 * FX Quote Service — fetches real Tinyman testnet pool rates, derives synthetic quotes.
 *
 * TEST_USDC (758916950) is a mock asset not listed on Tinyman.
 * This service reads the real ALGO/USDC testnet pool for a reference rate,
 * then derives TEST_USDC quotes with a synthetic spread.
 *
 * Pre-mainnet: replace with real Tinyman pool lookup for the actual asset pair.
 */

import algosdk from "algosdk";
import { algorandService } from "../algorand.js";

// Real testnet USDC (Circle-issued, has Tinyman liquidity)
const REAL_USDC_ID = 10458941;
// Our mock TEST_USDC
const TEST_USDC_ID = 758916950;

const BASE_URL = "https://testnet.analytics.tinyman.org/api/v1";

const SUPPORTED_PAIRS: Record<string, { poolAsset: number }> = {
  [`${TEST_USDC_ID}-0`]: { poolAsset: REAL_USDC_ID },   // TEST_USDC → ALGO (via real USDC)
  [`0-${TEST_USDC_ID}`]: { poolAsset: 0 },               // ALGO → TEST_USDC (via ALGO)
};

const SPREAD_BPS = 30;  // 0.3% spread
const FEE_BPS = 30;     // 0.3% fee

export interface FxQuote {
  exchangeRate: number;
  toAmount: number;
  priceImpactBps: number;
  feeAmount: number;
}

async function fetchTinymanRate(fromAssetId: number, toAssetId: number): Promise<number | null> {
  try {
    // Find pool by asset IDs
    const resp = await fetch(`${BASE_URL}/pools/`);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const pools = data.results || data || [];

    for (const pool of pools) {
      const assets = pool.assets || pool.pool?.assets || [];
      const a1 = Number(assets[0]?.id ?? assets[0]?.asset_id ?? 0);
      const a2 = Number(assets[1]?.id ?? assets[1]?.asset_id ?? 0);
      // Look for ALGO/REAL_USDC pool (asset 0 = ALGO)
      if ((a1 === 0 && a2 === REAL_USDC_ID) || (a1 === REAL_USDC_ID && a2 === 0)) {
        return pool.price_ratio || pool.priceRatio || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function applySpread(rate: number, spreadBps: number): number {
  return rate * (1 - spreadBps / 10000);
}

function estimatePriceImpact(fromAmount: number, _rate: number): number {
  // Simplified: very small trades (<1 ALGO) have <10bps impact
  if (fromAmount < 1_000_000) return 5;
  if (fromAmount < 10_000_000) return 15;
  return 50;
}

function getDefaultRate(fromAssetId: number, toAssetId: number): number {
  // Reasonable fallback rates when Tinyman API unavailable
  if (fromAssetId === 0 && toAssetId === TEST_USDC_ID) return 0.25;  // 1 ALGO = 0.25 TEST_USDC
  if (fromAssetId === TEST_USDC_ID && toAssetId === 0) return 4.0;   // 1 TEST_USDC = 4 ALGO
  return 1.0;
}

export async function getFxQuote(fromAssetId: number, toAssetId: number, fromAmount: number): Promise<FxQuote> {
  const pairKey = `${fromAssetId}-${toAssetId}`;
  if (!SUPPORTED_PAIRS[pairKey]) {
    throw new Error(`Unsupported pair: ${fromAssetId} → ${toAssetId}`);
  }

  // Try to get real rate from Tinyman
  let rate = await fetchTinymanRate(fromAssetId, toAssetId);
  if (rate === null) {
    rate = getDefaultRate(fromAssetId, toAssetId);
  }

  // Apply spread and fee
  const adjustedRate = applySpread(rate, SPREAD_BPS);
  const feeAmount = Math.floor(fromAmount * FEE_BPS / 10000);
  const netAmount = fromAmount - feeAmount;
  const toAmount = Math.floor(netAmount * adjustedRate);
  const priceImpactBps = estimatePriceImpact(fromAmount, rate);

  return { exchangeRate: adjustedRate, toAmount, priceImpactBps, feeAmount };
}
