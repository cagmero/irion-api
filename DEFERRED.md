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

## Turnkey Partial-Failure Recovery

**Status:** Soft-handled (institution marked `suspended`, no automated recovery)

**What happens today:** When `createSubOrganization` fails *after* partial execution (e.g., the sub-org was created in Turnkey but the SDK call timed out before returning the ID), `POST /v1/accounts` catches the error, marks `institutions.status = 'suspended'`, and surfaces `502 TURNKEY_ERROR`. No attempt is made to detect whether Turnkey actually created the sub-org, and no retry path exists.

**What's missing:**
- No reconciliation of orphan Turnkey sub-orgs created during failed attempts
- No retry/recovery endpoint for operators to unstick `suspended` institutions
- No detection of whether the failure was pre-Turnkey-call (nothing to clean up) or post (orphan may exist)
- `institutions` table has no `turnkey_sub_org_id` column — even a successful partial-creation cannot be linked after the fact

**Why deferred:** Failure recovery design depends on understanding Turnkey's idempotency story (whether `createSubOrganization` is safe to call twice with the same name, and whether the SDK supports request IDs for deduplication). This needs to be tested against the live Turnkey sandbox before committing to a recovery pattern.

**Recovery plan:**
1. Add `turnkey_sub_org_id` column to `institutions` — populated immediately after a successful `createSubOrganization` call, before the KYB session is started. This narrows the unrecoverable window.
2. Implement `POST /v1/accounts/:id/retry-provision` (operator-only, X-Admin-Key) — re-attempts Turnkey sub-org creation for `suspended` institutions that have no `turnkey_sub_org_id`.
3. Nightly reconciliation job: list all Turnkey sub-orgs under the parent org, cross-reference against `institutions.turnkey_sub_org_id` — flag unlinked sub-orgs for manual review.

**Owner:** TBD
**Target:** Phase 3

---

## Admin API Surface

**Status:** Single shared secret (`ADMIN_API_KEY` via `X-Admin-Key` header)

**What's in place:** `POST /v1/accounts` requires `X-Admin-Key: <ADMIN_API_KEY>` for all calls. The key is a single 32-byte hex secret configured in `.env.local`, verified with `crypto.timingSafeEqual`.

**What's missing:**
- No per-operator key issuance (all operators share one secret)
- No role separation (any holder of ADMIN_API_KEY can do everything)
- No audit log entries for admin actions (admin provisioning calls are not recorded in `audit_log` with an operator identity)
- No key rotation mechanism

**Why deferred:** Single shared secret is sufficient for internal ops tooling at MVP scale. Multi-key + role-based admin auth is not justified pre-first-customer.

**Recovery plan:**
1. Create `admin_keys` table (id, label, key_hash, roles[], created_by, revoked_at)
2. Implement `POST /v1/admin/keys` bootstrap endpoint (seeded, not callable via API)
3. Replace single-secret check with DB lookup + argon2id verify, same pattern as institution API keys
4. Add `action: "admin.*"` audit log entries with operator identity

**Owner:** TBD
**Target:** Phase 3

---

## BigInt Precision in Position/Loan Amounts

**Status:** Tech debt — capped at `Number.MAX_SAFE_INTEGER`

**What's in place:** All financial amount columns (`lending_positions.balance`, `borrowing_positions.balance`, `loans.principal_amount`, `loans.outstanding_balance`, `loans.collateral_amount`, `deposits.amount`, `withdrawals.amount`, `transfers.amount`, `payouts.amount`, `fx_quotes.from_amount`, `fx_quotes.to_amount`, `loan_draws.amount`, `loan_repayments.amount`) use Drizzle's `bigint({ mode: "number" })`. The DB stores a true `int8`; the ORM returns a JS `number` (IEEE-754 float64). Precision is lost for values above `2^53 - 1` ≈ `9,007,199,254,740,991` microunits ≈ 9 billion USDC.

**API surface:** The balance and loan endpoints serialize amounts as strings (`"balance": "1000000"`) to preserve precision for SDK consumers. This is the correct contract regardless of the underlying mode. The string serialization must be preserved even after migrating to `mode: "bigint"`.

**Why deferred:** Switching to `mode: "bigint"` requires updating every route handler that reads these columns (2d through 2g) to handle JS `BigInt` values rather than `number`. Doing this mid-phase would touch 15+ columns across 7+ routes and risk regressions. Cleaner to do as a single 2h migration sweep.

**Recovery plan:**
1. In 2h cleanup: change all financial amount columns to `mode: "bigint"` in `src/db/schema.ts`
2. Update every route handler that maps these columns to use `BigInt(value).toString()` or `value.toString()` (already the correct pattern in balance endpoint — `BigInt(r.balance)`)
3. Update tests that prime mock DB values to use `BigInt` literals instead of `number` literals
4. Add boundary tests at `2^53` and `2^62` (practical upper bound for Algorand microalgos)

**Owner:** TBD — 2h cleanup sweep
**Target:** Before any production deploy where balances could approach 9B USDC equivalent

---

## Tech Debt — Redis client centralization

**Status:** Three separate ioredis instantiations across codebase
**What:** `src/queues/kyb-mock-completion.ts`, `src/services/kyb/mock-provider.ts`, and `src/queues/index.ts` each create their own `new IORedis()` with duplicated `tls: {}` config.
**Fix:** Create `src/lib/redis.ts` exporting a single configured client. All queue/worker code imports from there.
**Owner:** TBD
**Target:** 2h or Phase 3

---

## Mainnet Migration

**Status:** All contracts deployed against testnet mock assets

### Redeploy contracts against Circle USDC mainnet (ID 31566704)

The LendingPool V2 and all related contracts are deployed against **Irion Test USDC (758916950)**, a mock asset created by the deployer account. Circle's testnet USDC faucet is rate-limited, making it impractical for development.

**Required steps for mainnet:**
1. Redeploy all 6 contracts against Circle USDC mainnet asset ID **31566704**
2. Update all environment variables (`LENDING_POOL_V2_USDC_APP_ID`, `LENDING_POOL_V2_USDC_ADDRESS`, `TEST_USDC_ASSET_ID` → `USDC_ASSET_ID`)
3. Re-run full integration test suite against mainnet or testnet with real USDC
4. Coordinate with Circle if institutional volume requires faucet bypass for testnet staging

**Asset reference:**
| Network | Asset ID | Name | Creator |
|---------|----------|------|---------|
| Testnet (mock) | 758916950 | Irion Test USDC | Deployer (NICKXD...) |
| Testnet (real) | 10458941 | USDC | Circle (VETIGP...) |
| Mainnet | 31566704 | USDC | Circle |

**Owner:** TBD
**Target:** Pre-mainnet launch

---

## Orphan sub-org cleanup

**Status:** `turnkey_sub_org_id` never persisted to `institutions` table

Every institution created via `POST /v1/accounts` gets a Turnkey sub-org, but the ID is never stored. This means:
- Institutions created before this fix have dangling sub-orgs with no DB link
- No way to reconcile which Turnkey sub-org belongs to which institution
- `POST /v1/accounts/:id/wallets` relies on the sub-org ID being returned in the institution row — it's currently lost after creation

**Recovery plan:**
1. Backfill script in 2h: read Turnkey's org list via API, reconcile against `institutions` by name pattern or creation timestamp
2. Add `turnkey_sub_org_id` column to `institutions` — populated immediately after `createSubOrganization` succeeds
3. Nightly reconciliation job to detect future orphans

**Owner:** TBD
**Target:** 2h cleanup sweep

---

## Turnkey Paid Tier Upgrade

**Status:** Running on free tier — signing quota exhausted during development

The Turnkey free tier has a limited signing quota that was exhausted during repeated smoke test runs. Error code 8 (`Resource exhausted: Signing is disabled because your organization is over its allotted quota`) maps to `TURNKEY_QUOTA_EXCEEDED` (HTTP 429).

**Impact:**
- Development blocked until quota resets or plan is upgraded
- Free tier will not support production load — even a single institution with moderate deposit/withdrawal volume will exhaust the quota quickly
- Each wallet creation = 2 signing calls (opt-in × 2 assets); each deposit = 2 signing calls (axfer + appl)

**Required before mainnet:**
1. Upgrade Turnkey to paid tier with sufficient signing quota for expected TPS
2. Monitor quota usage via Turnkey dashboard; set alerts at 80% capacity
3. Consider implementing request queuing with backoff for quota-limited operations

**Owner:** TBD
**Target:** Before any production deploy

---

## Signing Provider Migration (Deviation 8)

**Status:** Migrated from Turnkey to algosdk in-process signing (2026-05-19)

### What changed

Switched from Turnkey (HSM-backed) to algosdk (in-process Ed25519 with envelope-encrypted private keys at rest).
- Turnkey free tier was structurally unfit for dev velocity
- algosdk provider uses AES-256-GCM encryption with `ENCRYPTION_MASTER_KEY` env var
- Signing provider abstraction in `src/services/signing/` allows future HSM swap

### Pre-mainnet requirements (HSM-backed signing)

Before deploying to mainnet with real funds, swap the signing provider:

1. **SIGNING_PROVIDER swap:** Change `SIGNING_PROVIDER=algosdk` → `SIGNING_PROVIDER=turnkey` (or other HSM)
2. **Master key rotation:** Generate new `ENCRYPTION_MASTER_KEY`, re-encrypt all private keys
3. **Worker process separation:** Move BullMQ workers from `RUN_WORKERS_INLINE=true` to separate process
4. **Wallet key migration:** Generate new HSM wallets, transfer assets on-chain, archive algosdk wallets
5. **Key rotation policy:** Implement automated master key rotation (column `encryption_key_version` exists)

**Owner:** TBD
**Target:** Pre-mainnet

---

## Worker Process Separation

**Status:** Workers run inline with API (`RUN_WORKERS_INLINE=true` in .env.local)

For production/mainnet, workers should run in a separate process:
- Prevents worker crashes from taking down API
- Independent scaling of worker vs API
- Better resource isolation

**Required:**
1. Remove `RUN_WORKERS_INLINE` or set to `false`
2. Start worker separately: `pnpm worker`
3. Add health check endpoint for workers
4. Configure separate scaling policies

**Owner:** TBD
**Target:** Pre-mainnet

---

## Algod Pending-Info Round Window

**Status:** Indexer fallback works but adds ~2-5s latency per deposit/withdrawal confirmation

`algod.pendingTransactionInformation(txHash)` only tracks transactions in the last ~1000 confirmed rounds. For transactions confirmed beyond that window, the API returns `{}` with `undefined` fields (not a 404 error). The current fallback to `indexer.lookupTransactionByID(txHash)` works correctly but introduces 2-5 seconds of additional latency per confirmation poll cycle.

**Impact:**
- Each confirmation poll that misses the pending pool adds an indexer round-trip
- Under load with many concurrent deposits/withdrawals, this compounds
- Public indexer endpoints (AlgoNode) may rate-limit under sustained polling

**Pre-mainnet options:**
1. **Dedicated archival node:** Run own algod with extended transaction history
2. **Paid algod provider:** Nodely, PureStake, or AlgoNode paid tier with archival access
3. **Hybrid approach:** Check pending pool first (fast), only hit indexer after N failed polls (reduces indexer calls)

**Current fallback code:** `src/queues/processors/deposit-confirmation.ts` — see `pendingTransactionInformation` with indexer fallback and empty-response check.

**Owner:** TBD
**Target:** Pre-mainnet

---

## Skipped Wallet Integration Tests

**Status:** 2 tests skipped in `accounts-wallet.test.ts` (tests 8-9)

Tests 8 ("Audit log entry written") and 9 ("Wallet opt-in signTransaction called") are skipped because the mock setup doesn't trigger the full opt-in code path in `accounts.ts`. The signing provider and algorand service are singletons initialized before tests run, making it difficult to mock the opt-in flow without restructuring the test setup.

**Skipped tests:**
- `src/tests/accounts-wallet.test.ts:396` — "8. Audit log entry written with action 'wallet.created'"
- `src/tests/accounts-wallet.test.ts:423` — "9. Wallet opt-in: signTransaction called for TEST_USDC (758916950), response includes optedInAssets"

**Recovery plan:**
1. Refactor `accounts.ts` to accept signing provider and algorand service as parameters (dependency injection)
2. Update test mocks to inject mock instances per-test
3. Unskip both tests and verify opt-in flow

**Owner:** TBD
**Target:** 2d.6 or 2h cleanup

---

## Withdrawal Position Balance Reconciliation

**Status:** Preflight 3 detects DB vs on-chain LP token balance mismatch → returns 500 `POSITION_BALANCE_MISMATCH`

When the DB `lending_positions.balance` doesn't match the wallet's on-chain LP token balance, the withdrawal route logs to Sentry and rejects the request. This is a safety mechanism to prevent withdrawals when the system's state is inconsistent.

**What's missing:**
- No automated reconciliation job to fix mismatches
- No admin endpoint to force-reconcile a specific institution's position
- Sentry integration is not yet configured (try/catch silently ignores)

**Recovery plan:**
1. Implement nightly reconciliation job: scan all lending_positions, compare against on-chain LP balances, flag mismatches
2. Add `POST /v1/admin/accounts/:id/reconcile-positions` endpoint for manual reconciliation
3. Configure Sentry DSN in production env

**Owner:** TBD
**Target:** Pre-mainnet