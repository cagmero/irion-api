# DEFERRED.md — Phase 3 Backlog

> Last updated: 2026-05-20
> Phase 2 complete. Items organized by priority for Phase 3.

## 1. Contracts (P0 — Protocol Risk)

### LendingPool assert_loan_factory — PATCHED
**Sub-phase:** 2d.5 | **Effort:** Done

**Status:** Both LendingPool and Vault redeployed with corrected assertion (`Txn.applicationId` → `Global.callerApplicationId`). App IDs: LendingPool=762889263, Vault=762889316.

### CreditOracle Repay Integration
**Sub-phase:** 2e.4 | **Effort:** 2-3 days

**Status:** DB-only for INSTALLMENT repayments. Address convention mismatch between `LoanFactory.call_oracle_repay()` and `CreditOracle.update_on_repay()`.
- **Fix:** Coordinate LoanFactory + CreditOracle patch. Redeploy both.
- **MVP workaround:** Direct governance borrow works. Repay worker throws but captures in audit_log (no silent success).

### Loan Origination Box Race Windows
**Sub-phase:** 2e.1 | **Effort:** 1 day

**Status:** 2-wide box window for loan counter race conditions.
- **Fix:** Origination queue serializer (one at a time per app).

### Governance Bridge Replacement
**Sub-phase:** 2e.1 | **Effort:** 3-5 days

**Status:** API server holds deployer mnemonic with full governance authority over LoanFactory, LendingPool, Vault, and CreditOracle.
- **Risk:** Single point of compromise for whole protocol.
- **Fix:** Deploy GovernanceMultisig contract, replace direct deployer signing.

## 2. Infrastructure (P1 — Mainnet Blockers)

### Mainnet Migration
**Sub-phase:** Cross-cutting | **Effort:** 1-2 days

**Status:** All contracts deployed against Irion Test USDC (758916950), a mock asset.
- Redeploy against Circle USDC mainnet (31566704)
- Update env vars (`TEST_USDC_ASSET_ID` → `USDC_ASSET_ID`)
- Coordinate with Circle for faucet bypass if needed

### Signing Provider — HSM-backed
**Sub-phase:** 2d.5 | **Effort:** 2-3 days

**Status:** Migrated from Turnkey to algosdk in-process (2026-05-19). Pre-mainnet:
- Swap `SIGNING_PROVIDER=turnkey`
- Re-encrypt all private keys with new master key
- Wallet key migration (generate HSM wallets, transfer assets)
- Key rotation policy (column `encryption_key_version` exists)

### Worker Process Separation
**Sub-phase:** 2c | **Effort:** 1 day

**Status:** Workers run inline (`RUN_WORKERS_INLINE=true`).
- Add `pnpm worker` script
- Health check endpoint for workers
- Separate scaling policies per queue

### BigInt Precision Migration — COMPLETED (2h.2a)
**Sub-phase:** 2h.2 | **Effort:** Done

**Status:** All 28 `bigint({ mode: "number" })` columns migrated to `mode: "bigint"`. Zero regressions. No DB schema change needed — underlying column type was already `int8`. All routes already used string serialization for JSON transport.

### Algod Pending-Info Round Window
**Sub-phase:** 2d.5 | **Effort:** 1-2 days

**Status:** Indexer fallback adds 2-5s latency per confirmation poll.
- Options: dedicated archival node, paid algod provider, or hybrid approach

### Withdrawal Position Balance Reconciliation
**Sub-phase:** 2d.6 | **Effort:** 1 day

**Status:** Preflight detects DB vs on-chain LP token mismatch → 500.
- Nightly reconciliation job
- Admin reconcile endpoint
- Sentry configured

### Orphan Turnkey Sub-org Cleanup
**Sub-phase:** 2d.1 | **Effort:** 1 day

**Status:** `turnkey_sub_org_id` never persisted to `institutions` table.
- Backfill script reconciling Turnkey org list
- Add column, populate on creation
- Nightly reconciliation

### Turnkey Paid Tier Upgrade
**Sub-phase:** 2d.1 | **Effort:** Purchase + config

**Status:** Free tier quota exhausted during development.
- Required before any production load
- Monitor quota usage, set alerts at 80%

### Redis Client Centralization
**Sub-phase:** 2c | **Effort:** 30 min

**Status:** Three separate `new IORedis()` instantiations.
- Create `src/lib/redis.ts`, all queue/worker code imports from there

## 3. Compliance & Security (P2 — Pre-MVP)

### Real KYB Provider (Didit / Sumsub)
**Sub-phase:** 2d.1 | **Effort:** 3-5 days + cost

**Status:** Mock provider in use. Real Didit scaffolded but not wired.
- Cost: $2/session for Didit; $2k+/year minimums for most providers
- Alternative: composite from free APIs (OpenCorporates, OpenSanctions, SEC EDGAR)
- Verify webhook payload shape before switching

### Wallet Screening Providers (Hapi / Range)
**Sub-phase:** 2d.2 | **Effort:** 2-3 days

**Status:** Stub implementations returning deterministic results.
- Both require paid API keys
- Composite service in `wallet-screening.ts` is the right abstraction

### Admin API Surface
**Sub-phase:** 2d.1 | **Effort:** 2-3 days

**Status:** Single shared `ADMIN_API_KEY`.
- No per-operator keys, no role separation, no audit trail
- Add `admin_keys` table, replace single-secret check

## 4. Post-MVP Features (P3)

### Skipped Wallet Integration Tests
**Sub-phase:** 2d.5 | **Effort:** 1 day

**Status:** 2 tests skipped in `accounts-wallet.test.ts` (mock setup doesn't trigger opt-in path).
- Refactor for dependency injection
- Unskip and verify opt-in flow

### OpenAPI Verification
**Sub-phase:** 2h.2 | **Effort:** 1 hour

**Status:** Regenerated from real handlers. Needs validation:
- Verify spec matches actual routes (all endpoints documented)
- swagger-cli validate or automated test

### Test Debt Backfill
**Sub-phase:** 2h.2 | **Effort:** 2-3 hours

**Status:** 280 tests (target: 300+). Gap: ~20 tests.
- Audit each sub-phase against its brief
- Write missing tests for uncovered edge cases

## Delivery Artifacts (Delivered in Phase 2h)

| Item | File | Status |
|------|------|--------|
| Acceptance suite | `src/scripts/acceptance-smoke.ts` | Created — 12 criteria, run against live server |
| Deployment runbook | `docs/deployment-runbook.md` | Created — 8 steps, env vars, smoke test ordering |
| Demo artifacts | `docs/demo/*.md` | Reviewed — webhook-sample.json updated with 2g format |
| DEFERRED.md audit | This document | Complete — organized by priority, effort estimates |
