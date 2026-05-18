# DEFERRED.md

Items deferred for future implementation.

## Real KYB Provider (Didit / Sumsub / Alternative)

**Status:** Mock provider in use for MVP
**What's stubbed:** `src/services/kyb/mock-provider.ts` provides deterministic responses based on institution name pattern matching. Real Didit integration is scaffolded in `src/services/kyb/didit-provider.ts` but not wired in.
**Why:** Didit's KYB Registry Check is $2/session — too expensive for development burn. Real KYB providers also typically require enterprise contracts ($2k+/year minimums) that aren't justified pre-revenue.
**Recovery:**
1. When budget allows, evaluate Didit / Sumsub / Veriff for production KYB
2. Alternative: build composite provider from free APIs (OpenCorporates 500/mo free + OpenSanctions + Companies House + SEC EDGAR) — see comments in `didit-provider.ts`
3. Once chosen, set `KYB_PROVIDER=<chosen>` in production env; mock provider stays as the default for dev/test environments
**Uncertainties to verify when activating real provider:**
- Didit's actual webhook payload shape may differ from mock's `{ event, session_id, status, business_session_id, details }`
- Didit's v3 API endpoint shape (`/v3/session`) is from prior research; actual response may differ
**Owner:** TBD
**Target:** Post-MVP / first paid customer

## Wallet Screening Providers (Hapi / Range)

**Status:** Stub implementations in use for MVP
**What's stubbed:** `src/services/hapi.ts` and `src/services/range.ts` return deterministic results based on env-var-driven denylists (`HAPI_MOCK_DENYLIST`, `RANGE_MOCK_DENYLIST`). Composite `src/services/wallet-screening.ts` calls both and fails if either flags.
**Why:** Hapi and Range require paid API keys and enterprise contracts. Not justified pre-revenue.
**Recovery:**
1. Obtain Hapi API key and Range API credentials
2. Replace stub implementations with real HTTP calls to their respective APIs
3. Keep denylist pattern as a fallback / override layer for manual blocklisting
4. Composite service stays — it's the right abstraction for multi-provider screening
**Owner:** TBD
**Target:** Post-MVP / first paid customer