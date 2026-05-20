# Architecture

## Data Flow

Every authenticated API request follows this pipeline:

```
Client → Fastify → Auth Plugin → Route Handler → Service → DB/Worker/Algod
```

### Auth Pipeline

1. **JWT verification** (`@fastify/jwt`) — extracts `sub` (institutionId) and `kid` (apiKeyId) from Bearer token
2. **API key validation** — looks up `apiKeys` table by `kid`, checks status, IP allowlist
3. **HMAC body signing** — for POST/PUT/PATCH, computes HMAC-SHA256 over raw body using the institution's `hmac_secret`, compares via `crypto.timingSafeEqual`
4. **Rate limiting** — Upstash Redis-backed sliding window
5. **Idempotency** — `Idempotency-Key` header deduplicates within configurable window

### Admin endpoints

Endpoints prefixed with `/v1/admin/` use `X-Admin-Key` header instead of JWT+HMAC. Used for institution onboarding and sandbox operations.

## Route Modules (7)

| Module | Prefix | Key Endpoints |
|--------|--------|--------------|
| accounts | /v1/accounts | POST onboard, GET balance, POST wallet, POST kyb/approve |
| auth | /v1/auth | POST token |
| loans | /v1/loans | POST originate, GET list, POST repay, POST draw |
| transfers | /v1 | POST deposits, POST transfers, GET deposits/:id |
| withdrawals | /v1 | POST withdrawals |
| payouts | /v1 | POST payouts |
| fx | /v1/fx | POST quote, POST execute |
| webhooks | /v1/webhooks | POST create, GET list, DELETE, rotate-secret |
| admin | /v1/admin | POST fund-wallet, POST delete-institution |

## BullMQ Worker Chain (11 workers)

```
deposit-confirmation          ─→ POST /v1/deposits 202 → confirms algod txn
withdrawal-confirmation       ─→ POST /v1/withdrawals 202 → confirms algod txn
loan-origination-step-1       ─→ POST /v1/loans → submits to LoanFactory
loan-origination-confirmation ─→ polls algod for Step 1 confirmation
revolving-origination          ─→ submits REVOLVING loan
term-origination               ─→ submits TERM loan
installment-origination        ─→ submits INSTALLMENT loan
loan-draw                      ─→ submits draw on revolving line
loan-repay                     ─→ submits repayment
vault-release-compensator      ─→ releases collateral on compensation path
webhook-delivery               ─→ delivers event to registered webhook URL
```

Workers run inline by default (same process). Separate worker process supported via `RUN_WORKERS_INLINE=false`.

## Signing Provider Abstraction

```
interface SigningProvider {
  createWallet(institutionId, label) → { walletId, algorandAddress }
  signTransaction(walletId, unsignedTxn) → signedTxn
  getAddress(walletId) → string
}
```

Two implementations:
- **algosdk** (default for dev): in-process Ed25519 key generation, keys envelope-encrypted with AES-256-GCM
- **Turnkey** (production): HSM-backed, keys never leave Turnkey's secure enclaves

Swap via `SIGNING_PROVIDER=turnkey` env var.

## Database Schema (19 tables)

| Table | Purpose |
|-------|---------|
| institutions | Core institution record (status: pending/active/suspended) |
| api_keys | Client credentials (Argon2id hash, HMAC secret, IP allowlist) |
| kyb_verifications | KYB provider sessions and status |
| wallets | Custodial wallet records (address, encrypted SK, provider) |
| credit_profiles | On-chain credit score mirror |
| deposits / withdrawals | Asset movement records with txHash |
| lending_positions / borrowing_positions | Position tracking (reconciled with on-chain) |
| loans | All 4 loan types, status lifecycle |
| loan_draws / loan_repayments | Draw and repay records per loan |
| installments | Per-installment schedule for INSTALLMENT loans |
| transfers | On-chain asset transfers (internal and external) |
| payouts | External payout records with encrypted bank details |
| fx_quotes | FX quotes from Tinyman (with expiry tracking) |
| webhooks / webhook_deliveries | Webhook registration and delivery state |
| audit_log | Immutable event log for every operation |
| idempotency_keys | Idempotency key deduplication |

## Idempotency Key Flow

```
1. Client sends Idempotency-Key header
2. Server checks idempotency_keys table for (key, institutionId)
3. If found and same body hash → return cached response
4. If found and different body hash → return 422 IDEMPOTENCY_MISMATCH
5. If not found → execute request, store response
```
