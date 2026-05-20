# Phase 2 Complete — Irion B2B API

**Date:** 2026-05-20
**Repository:** `irion-api/` — Fastify REST server on Algorand TestNet

---

## Final Stats

| Metric | Value |
|--------|-------|
| Test files | 24 |
| Tests passing | 341 |
| Tests skipped | 3 (pre-existing, wallet opt-in mock gap) |
| DB tables | 19 |
| DB migrations | 16 |
| Route modules | 7 (accounts, auth, loans, transfers, payouts, withdrawals, fx, webhooks) |
| BullMQ workers | 11 (webhook-delivery, deposit-confirmation, withdrawal-confirmation, loan-origination-step-1, loan-origination-confirm, vault-release-compensator, loan-draw, loan-repay, revolving-origination, term-origination, installment-origination) |
| Smart contracts | 6 deployed + patched |
| OpenAPI routes documented | 24 route×method combinations |
| Smoke test scripts | 15 |
| BigInt columns migrated | 28 (`mode: "number"` → `mode: "bigint"`) |

---

## Architecture Summary

### Auth & API Security
OAuth2 JWT (HS256, 15-minute TTL) issued via `POST /v1/auth/token` against DB-backed API keys. All mutating requests require HMAC-SHA256 signature over raw body using per-institution secrets (AES-256-GCM encrypted at rest). IP allowlisting per API key. Admin operations gated by a single shared `ADMIN_API_KEY` secret verified with `crypto.timingSafeEqual`.

### Custody & Wallet Management
`POST /v1/accounts/:id/wallets` creates a Turnkey sub-organization and wallet, then opts into required assets (TEST_USDC, LP tokens). Signing uses the `algosdk` in-process provider (Ed25519 with AES-256-GCM envelope-encrypted private keys). The signing provider is abstracted behind `src/services/signing/` — production swaps to Turnkey HSM by changing `SIGNING_PROVIDER` env var.

### LendingPool
The central liquidity contract. Accepts deposits from wallets (mints LP tokens) and processes borrow/withdraw requests. Multi-tranche with a kinked interest rate curve. Deployed against Irion Test USDC (asset 758916950) — real Circle USDC mainnet (asset 31566704) uses the same ABI.

### LoanFactory
Originates 4 loan types as on-chain Box records: overcollateralized (collateral locked in Vault), revolving (credit line), term (fixed maturity), installment (amortization schedule). Each type has its own BullMQ worker for on-chain confirmation.

### Vault
Holds collateral assets for overcollateralized loans. Supports `create_oracle_entry` for vault creation and `release_collateral` for liquidation/dispute resolution. All vault operations are governance-signed via the deployer mnemonic bridge.

### CreditOracle
Tracks credit profiles per institution (borrow/repay history). Used by LoanFactory for underwriting. Currently works via governance-bridge direct calls — the LoanFactory → CreditOracle inner txn path has a known address-convention mismatch documented for Phase 3.

### Settlement
Three settlement primitives: internal transfers (same-institution wallets), external payouts (to any Algorand address with opt-in and screening), and FX swaps (quote + execute with 60s TTL, mock execution, real Tinyman rate feed where pool exists).

### Webhooks
Per-endpoint outbound webhooks with HMAC-SHA256 signing (`t=<ts>,v1=<hex>` format), Idempotency-Key headers, 5-stage exponential backoff (1m/5m/15m/1h/6h), dead-letter queue after 5 failures, and 24-hour rotation grace period with dual signatures.

---

## Honest Limitations

### KYB Mock
**Status:** `src/services/kyb/mock-provider.ts` — deterministic responses based on institution name pattern matching.
**Phase 3 path:** Replace with Didit provider (`src/services/kyb/didit-provider.ts`, scaffolded but unwired). Set `KYB_PROVIDER=didit` in production env. Verify webhook payload shape before switching.

### Algosdk In-Process Custody
**Status:** Private keys encrypted with AES-256-GCM master key, stored in `wallets` table. Signing happens in the API process.
**Phase 3 path:** Set `SIGNING_PROVIDER=turnkey`. Re-encrypt all keys with new master key. Generate HSM wallets, transfer assets, archive algosdk wallets.

### Wallet Screening Stub
**Status:** `src/services/hapi.ts` and `src/services/range.ts` return deterministic results from env-var-driven denylists.
**Phase 3 path:** Obtain Hapi + Range API keys, replace stubs with real HTTP calls. Composite pattern in `wallet-screening.ts` is production-ready.

### FX Execution Mocked
**Status:** `POST /v1/fx/execute` creates a DB transfer row and returns 202. No actual Tinyman swap occurs. Quote reads real Tinyman V1 pool when a pool exists for the asset pair.
**Phase 3 path:** Wire real Tinyman V2 swap. Requires pool liquidity for the asset pair. For mainnet Circle USDC (asset 31566704), the ALGO/USDC pool has deep liquidity.

### INSTALLMENT Repay DB-Tracked
**Status:** Repayments update the `installments` and `loans` tables in Postgres but the on-chain CreditOracle `update_on_repay` call fails due to address convention mismatch between LoanFactory and CreditOracle.
**Phase 3 path:** Coordinate LoanFactory + CreditOracle contract patch. Redeploy both. Call `LoanFactory.update_oracle()` with new CreditOracle ID.

### Governance Bridge for Vault Operations
**Status:** All governance-restricted operations (borrow, vault creation, CreditOracle updates) are signed by the deployer mnemonic loaded in the API server's `.env.local`.
**Phase 3 path:** Deploy GovernanceMultisig contract. Replace deployer signing with multisig approval flow.

---

## Demo Runbook

Perform a live demo from scratch against a running server:

```bash
# 1. Provision institution + KYB approval
curl -X POST http://localhost:4000/v1/accounts \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: <ADMIN_API_KEY>" \
  -d '{"name":"Demo Bank"}'
# → Note the id, client_id, client_secret, hmac_secret

curl -X POST http://localhost:4000/v1/accounts/<id>/kyb/approve \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: <ADMIN_API_KEY>" \
  -d '{}'

# 2. Authenticate
curl -X POST http://localhost:4000/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<client_id>","client_secret":"<client_secret>"}'
# → Note the access_token

# 3. Create wallet (auto opt-in to TEST_USDC + LP tokens)
curl -X POST http://localhost:4000/v1/accounts/<id>/wallets \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Irion-Signature: <hmac(body)>" \
  -d '{"label":"Demo Wallet"}'
# → Note the walletId, algorandAddress

# 4. Deposit USDC (requires funding wallet with TEST_USDC first)
# Fund from deployer, then:
curl -X POST http://localhost:4000/v1/deposits \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Irion-Signature: <hmac(body)>" \
  -d '{"assetId":758916950,"amount":"1000000"}'

# 5. Originate a loan
curl -X POST http://localhost:4000/v1/loans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Irion-Signature: <hmac(body)>" \
  -d '{"walletId":"<walletId>","loanType":"INSTALLMENT","borrowAssetId":758916950,"borrowAmount":"600000","installmentCount":3,"installmentIntervalRounds":100000,"interestRateBps":500}'

# 6. Transfer between wallets
curl -X POST http://localhost:4000/v1/transfers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Irion-Signature: <hmac(body)>" \
  -d '{"fromWalletId":"<walletId>","toWalletId":"<walletId2>","assetId":758916950,"amount":"50000"}'

# 7. Payout to external address
curl -X POST http://localhost:4000/v1/payouts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Irion-Signature: <hmac(body)>" \
  -d '{"walletId":"<walletId>","assetId":758916950,"amount":"25000","destinationAddress":"<algorand_address>"}'

# 8. FX quote
curl -X POST http://localhost:4000/v1/fx/quote \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Irion-Signature: <hmac(body)>" \
  -d '{"fromAssetId":758916950,"toAssetId":0,"fromAmount":"1000000"}'
```

HMAC signing helper (Node):
```ts
const sig = crypto.createHmac("sha256", Buffer.from(hmac_secret, "hex"))
  .update(JSON.stringify(body))
  .digest("hex");
```

### Demo Checklist
- [ ] Server running (`pnpm dev`, check `/health`)
- [ ] Deployer wallet funded with TEST_USDC
- [ ] All 6 smart contracts deployed and wired
- [ ] Database migrated (16 migrations applied)
- [ ] Worker inline mode enabled (`RUN_WORKERS_INLINE=true`)

---

## Phase 3 Priorities

### P0 — Pilot-Blocking
1. **Governance Multisig** — Replace deployer mnemonic bridge with proper multisig. Required before any real funds move through the protocol.
2. **Signing Provider to HSM** — Swap `algosdk` → `turnkey`. Required before mainnet with real assets.
3. **CreditOracle Repay Fix** — Patch LoanFactory + CreditOracle address convention. Required for INSTALLMENT/TERM/REVOLVING repay to work on-chain.

### P1 — Mainnet-Blocking
4. **Circle USDC Migration** — Redeploy contracts against mainnet USDC (asset 31566704). Update env vars. Re-run full acceptance suite.
5. **Worker Process Separation** — Move BullMQ workers to separate process (`RUN_WORKERS_INLINE=false`). Required for production reliability.
6. **Real KYB Provider** — Wire Didit or composite free-tier provider. Required for compliance.

### P2 — Post-MVP
7. **Real FX Execution** — Wire Tinyman V2 real swaps. Unlocks cross-currency settlement.
8. **Wallet Screening** — Activate Hapi + Range API keys. Required for AML compliance.
9. **Admin API Surface** — Multi-key admin auth with role separation and audit trail.
10. **Liquidator Bot** — Automated liquidation of undercollateralized positions (`irion-workers/`).
