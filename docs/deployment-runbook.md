# Deployment Runbook

**Last updated:** 2026-05-20
**Repo:** `irion-api/` — Fastify REST server for Irion B2B Neobank

## Prerequisites

- Node.js >= 20
- PostgreSQL 15+ (Supabase or local)
- Redis 7+ (Upstash or local, for BullMQ)
- Algorand TestNet/MainNet node (AlgoNode free tier works)
- Turnkey account (for wallet creation/signing — or use algosdk dev mode)
- AlgoKit CLI (optional, for contract deployment only)

## Step 1: Environment Variables

Copy `.env.example` to `.env.local` and fill every value:

```bash
cp .env.example .env.local
```

### Required env vars table

| Var | Source | Example |
|-----|--------|---------|
| `DATABASE_URL` | Supabase → Settings → Database | `postgresql://...` |
| `REDIS_URL` | Upstash → REST API | `rediss://default:...` |
| `JWT_SECRET` | `openssl rand -hex 32` | `3531ace4...` |
| `ADMIN_API_KEY` | `openssl rand -hex 32` | `a20d880d...` |
| `WEBHOOK_SIGNING_SECRET` | `openssl rand -hex 32` | `3531ace4...` |
| `DEPLOYER_MNEMONIC` | Algorand account mnemonic | `announce feed swing...` |
| `GOVERNANCE_APP_ID` | From contract deployment | `762889174` |
| `LENDING_POOL_V2_USDC_APP_ID` | From contract deployment | `762889263` |
| `VAULT_APP_ID` | From contract deployment | `762889316` |
| `CREDIT_ORACLE_APP_ID` | From contract deployment | `762892340` |
| `LOAN_FACTORY_APP_ID` | From contract deployment | `762889354` |
| `TEST_USDC_ASSET_ID` | Created during bootstrap | `758916950` |
| `TURNKEY_API_PRIVATE_KEY` | Turnkey dashboard | `58188ae1...` |
| `ENCRYPTION_MASTER_KEY` | `openssl rand -base64 32` | `Uyqz9y4...` |

Full reference: `contract-deployments.md` for contract IDs on testnet.

## Step 2: Database Setup

```bash
# Migrations are manual SQL files in src/db/migrations/
# Run in order:
psql $DATABASE_URL -f src/db/migrations/0000_ancient_dreadnoughts.sql
psql $DATABASE_URL -f src/db/migrations/0001_add_allowed_ips_and_hmac_secret.sql
# ... all 16 migrations in sequence
psql $DATABASE_URL -f src/db/migrations/0016_webhook_hardening.sql

# Verify tables:
psql $DATABASE_URL -c "\dt"  # Should show ~19 tables
```

**Expected output:**
```
              List of relations
 Schema |        Name         | Type | Owner
--------+---------------------+------+-------
 public | institutions        | table | ...
 public | api_keys            | table | ...
 public | kyb_verifications   | table | ...
 public | wallets             | table | ...
 public | deposits            | table | ...
 public | withdrawals         | table | ...
 public | loans               | table | ...
 public | transfers           | table | ...
 public | fx_quotes           | table | ...
 public | webhooks            | table | ...
 public | webhook_deliveries  | table | ...
 ... (19 total)
```

### Seed data (optional dev script)

```bash
npx tsx --env-file=.env.local src/db/seed.ts
```

This creates a test institution with API keys for development.

## Step 3: Contract Deployment

Contracts live in `irion-contracts/`. See `docs/contract-deployments.md` for current IDs.

Deployment order (mandatory):
1. Governance
2. AccountRegistry
3. LendingPool V2 (USDC) — creates LP tokens
4. Vault — opt-in to LP token
5. CreditOracle
6. LoanFactory — register pool

**Cross-contract wiring** (set after all deployed):
```bash
# Example: LoanFactory.set_pool_registry(LendingPool, USDC asset)
# Example: Vault.set_lending_pool(LendingPool)
```

## Step 4: Start Server

```bash
# Development (workers inline):
pnpm dev

# Expected startup output:
# Server listening at http://0.0.0.0:4000
# Starting inline workers...
```

Verify health:
```bash
curl http://localhost:4000/health
# {"status":"ok","time":"2026-05-20T..."}
```

## Step 5: Smoke Tests (in order)

Each test creates a fresh institution. Run against the running server.

```bash
# 1. Basic auth + account creation
npx tsx --env-file=.env.local src/scripts/kyb-smoke-test.ts

# 2. Wallet creation + opt-in
npx tsx --env-file=.env.local src/scripts/wallet-creation-smoke-test.ts

# 3. Deposit flow (requires on-chain funding)
npx tsx --env-file=.env.local src/scripts/deposit-smoke-test.ts

# 4. Withdrawal flow
npx tsx --env-file=.env.local src/scripts/withdrawal-smoke-test.ts

# 5. All 4 loan types
npx tsx --env-file=.env.local src/scripts/loan-smoke-test.ts

# 6. Internal transfers
npx tsx --env-file=.env.local src/scripts/transfer-smoke-test.ts

# 7. External payouts
npx tsx --env-file=.env.local src/scripts/payout-smoke-test.ts

# 8. FX quote + execute
npx tsx --env-file=.env.local src/scripts/fx-smoke-test.ts

# 9. Webhook registration + delivery (requires webhook.site or local listener)
npx tsx --env-file=.env.local src/scripts/webhook-smoke-test.ts

# 10. Full lifecycle (all 12 criteria)
npx tsx --env-file=.env.local src/scripts/acceptance-smoke.ts
```

### Smoke test troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `fetch failed` / ECONNREFUSED | Server not running | `pnpm dev` first |
| `401 INVALID_SIGNATURE` | HMAC secret mismatch | Check institution was created with same server |
| `422 INVALID_ASSET_ID` | Wallet not opted into asset | Check `optedInAssets` in wallet response |
| `502 ALGORAND_SUBMIT_FAILED` | AlgoNode timeout | Retry; check testnet status at status.algonode.cloud |
| `429 TURNKEY_QUOTA_EXCEEDED` | Free tier exhausted | Wait for reset or set `SIGNING_PROVIDER=algosdk` |
| `500 POSITION_BALANCE_MISMATCH` | DB != on-chain | Manual reconcile via admin endpoint |

## Step 6: Run Test Suite

```bash
# Unit tests (mocked — no server needed)
pnpm test

# Expected: 280+ passed, 3 skipped
# Test Files 22 passed (22)
# Tests 280 passed | 3 skipped (283)
```

## Step 7: Verify Webhook Delivery

1. Register a webhook pointing to webhook.site:
```bash
curl -X POST http://localhost:4000/v1/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://webhook.site/YOUR-UUID","events":["deposit.confirmed"]}'
```

2. Trigger a deposit (or any event)
3. Check webhook.site for delivery — look for:
   - `Irion-Signature: t=...,v1=...` header
   - `Idempotency-Key:` header
   - `Irion-Event: deposit.confirmed` header
4. Verify the signature by recomputing HMAC-SHA256 over `timestamp.body` with the webhook secret

## Step 8: API Documentation

```bash
# Regenerate OpenAPI spec:
npx tsx --env-file=.env.local src/scripts/generate-openapi.ts
# Written to ../openapi.yaml

# View interactive docs (when server is running):
open http://localhost:4000/docs
```

## Worker Architecture

All BullMQ workers run inline during development (`RUN_WORKERS_INLINE=true`).

| Queue | Worker | Trigger | Retries | Notes |
|-------|--------|---------|---------|-------|
| webhook-delivery | `webhook-delivery.ts` | Any event emission | 5 (1m,5m,15m,1h,6h) | DLQ after 5 failures |
| deposit-confirmation | `deposit-confirmation.ts` | POST /v1/deposits → algod submit | 10 | Polls every 2s |
| withdrawal-confirmation | `withdrawal-confirmation.ts` | POST /v1/withdrawals → algod submit | 10 | Polls every 2s |
| loan-origination-step-1 | `loan-origination-step-1.ts` | POST /v1/loans → pending | 3 | Locks collateral in Vault |
| loan-origination-confirm | `loan-origination-confirmation.ts` | Step 1 success | 10 | Confirms borrow txn |
| kyb-mock-completion | `kyb-mock-completion.ts` | KYB approval delay | 3 | Fires mock Didit webhook |

**For production**: set `RUN_WORKERS_INLINE=false`, start workers in separate process.

## Maintenance

### Rotating webhook signing secrets

Each webhook has a per-endpoint secret returned at creation. Rotate with:
```bash
curl -X POST http://localhost:4000/v1/webhooks/$ID/rotate-secret \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

The old secret remains valid for 24h (grace period with dual signatures).

### Checking dead letter queue

```bash
# List deliveries with failures
curl -X GET http://localhost:4000/v1/webhooks/deliveries \
  -H "Authorization: Bearer $TOKEN"
# Look for entries with dlq_at set and status=failed
```

### DB migrations

Migrations are manual SQL files in `src/db/migrations/`. Apply in order:
```bash
psql $DATABASE_URL -f src/db/migrations/0016_webhook_hardening.sql
```

To apply a pending migration:
1. Read the SQL file
2. Run `psql $DATABASE_URL -f src/db/migrations/NNNN_name.sql`
3. Verify: `psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name='<table>'"`

## Production Checklist

- [ ] `SIGNING_PROVIDER=turnkey` (not algosdk)
- [ ] `RUN_WORKERS_INLINE=false` (separate worker processes)
- [ ] Real KYB provider (`KYB_PROVIDER=didit`)
- [ ] Real wallet screening (`RANGE_API_KEY` and `HAPI_API_KEY`)
- [ ] Circle USDC mainnet asset ID (31566704) instead of mock
- [ ] JWT_SECRET, ADMIN_API_KEY, WEBHOOK_SIGNING_SECRET rotated from defaults
- [ ] Sentry DSN configured and tested
- [ ] Rate limits tuned for expected traffic
- [ ] Workers on separate scaling plan (webhook-delivery needs highest concurrency)
- [ ] Nightly reconciliation cron (`irion-workers/`)
