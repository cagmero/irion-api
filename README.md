# Irion Network API

> **B2B Neobank API on Algorand.** One API surface for institutional deposits, lending (4 types), settlement, payouts, and FX — all on-chain on Algorand testnet.
>
> Originally launched as a B2C BNPL application (live at [irion.network](https://irion.network)). Pivoted to B2B based on TAM analysis and regulatory clarity. The custody, smart contract infrastructure, and KYB integration carried over.

---

## Table of Contents

- [Problem](#problem)
- [Solution](#solution)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Smart Contracts](#smart-contracts-algorand-testnet)
- [Setup](#setup)
- [API Endpoints](#api-endpoints)
- [On-Chain Proof (Testnet)](#on-chain-proof-testnet)
- [Project Status](#project-status)
- [Phase 3 Roadmap](#phase-3-roadmap)
- [License](#license)

---

## Problem

B2B fintech operations on crypto rails are fragmented. Every institution rebuilds from scratch:

- **Custody** — key generation, storage, HSM integration, signing logic
- **KYB/KYC** — document verification, sanctions screening, beneficial ownership checks
- **Lending mechanics** — vault contracts, liquidation logic, interest accrual
- **Settlement** — internal transfers, external payouts, FX hedging
- **Compliance** — wallet screening, audit trails, regulatory reporting

Each integration takes 6–12 months and millions in engineering cost. Bridge, Layer2 Financial, and a handful of stealth players are tackling this on EVM chains — nobody serious has shipped on Algorand.

## Solution

One API surface. Institutions onboard in under a minute via our REST API and get:

| Capability | Description |
|-----------|-------------|
| **Custodial wallets** | Ed25519 key pairs, envelope-encrypted with AES-256-GCM. algosdk in-process for dev, Turnkey HSM for production. |
| **Lending pool deposits** | Deposit TEST_USDC into the senior tranche of LendingPool V2, earn protocol yield. |
| **4 loan types** | Overcollateralized (vault-locked), Revolving (credit line), Term (fixed maturity), Installment (amortized schedule). All backed by on-chain contracts. |
| **Settlement primitives** | Internal transfers between institution wallets, external payouts with compliance screening, FX quotes via Tinyman pools. |
| **Webhook hardening** | HMAC-SHA256 signed deliveries with `t=<ts>,v1=<sig>` format. Timestamp replay protection (±5 min window), DLQ after 5 failures, 24h signature rotation grace period with dual `v0`/`v1` signatures. |
| **Full audit log** | Every API call and on-chain confirmation traced to an immutable audit trail. |

---

## Architecture

```
                         ┌──────────────────────────────────────┐
                         │         Institutional Client          │
                         │    (Stripe-style API integration)     │
                         └──────────────┬───────────────────────┘
                                        │ HTTPS + HMAC-SHA256 + JWT
                                        ▼
                         ┌──────────────────────────────────────┐
                         │           Fastify API Layer           │
                         │  • JWT auth (HS256, 15-min expiry)   │
                         │  • HMAC body signing (sha256, raw)   │
                         │  • Idempotency keys + rate limiting  │
                         │  • RFC 7807 problem details errors   │
                         │  • OpenAPI 3.x spec                  │
                         └──────────────┬───────────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
       ┌─────────────┐          ┌──────────────┐          ┌──────────────┐
       │   Postgres  │          │    Redis      │          │   BullMQ     │
       │  (Supabase) │          │  (Upstash /   │          │  Workers     │
       │  19 tables  │          │   local)      │          │  (11 inline  │
       │  + audit    │          │  cache +      │          │   for MVP)   │
       │  + 16 migr. │          │  idempotency  │          │              │
       └─────────────┘          └──────────────┘          └──────┬───────┘
                                                                │
                                                                ▼
                         ┌──────────────────────────────────────┐
                         │        Algorand Testnet (algod)       │
                         │                                      │
                         │  ┌────────────────────────────────┐  │
                         │  │   LendingPool V2 (762889263)   │  │
                         │  │   LoanFactory    (762889354)   │  │
                         │  │   Vault           (762889316)  │  │
                         │  │   CreditOracle   (762892340)   │  │
                         │  │   Governance    (762889174)    │  │
                         │  │   Senior LP ASA (762889282)    │  │
                         │  └────────────────────────────────┘  │
                         └──────────────────────────────────────┘
```

### Auth Flow

```
1. POST /v1/accounts              → returns client_id + client_secret + hmac_secret
2. POST /v1/auth/token            → returns JWT (HS256, 900s TTL)
3. All subsequent requests:
   - Header: Authorization: Bearer <jwt>
   - POST/PUT/PATCH: Header: irion-signature: <hex> (HMAC-SHA256 over raw body)
```

### Worker Chain

BullMQ processes on-chain confirmations asynchronously. 11 workers handle: deposit confirmation, withdrawal confirmation, loan origination (4 types × 2 steps each), loan draw, loan repay, vault release, and webhook delivery. Workers run inline during development/demo, separable for production.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **API framework** | Fastify v4, TypeScript strict mode |
| **Database** | Postgres on Supabase (19 tables, 16 migrations, Drizzle ORM) |
| **Cache + idempotency** | Upstash Redis (REST + TCP) / local Redis for dev |
| **Workers** | BullMQ (11 workers, inline for MVP, separable) |
| **Crypto signing** | algosdk v3 in-process + envelope encryption (AES-256-GCM). Turnkey HSM adapter for production. |
| **KYB** | Provider-agnostic interface. Mock provider for demo, Didit adapter for production (document upload, beneficial ownership, sanctions screening). |
| **Wallet screening** | Composite provider pattern — Hapi + Range stubs, ready for API keys. |
| **FX / DEX** | Tinyman SDK for real pool quotes (testnet pool absent → mocked execution per Decision C). |
| **Observability** | Sentry error tracking, structured JSON logging (pino), RFC 7807 problem details. |
| **Contract language** | PuyaTS (Algorand TypeScript), compiled to TEAL via `algokit project run build`. |
| **Testing** | Vitest, 341 unit + integration tests. 15 smoke test scripts exercising live testnet. |

---

## Smart Contracts (Algorand Testnet)

All contracts deployed on Algorand Testnet. View each on [Lora Explorer](https://lora.algokit.io/testnet).

| Contract | App ID | Lora Link | Source |
|----------|--------|-----------|--------|
| LendingPool V2 (USDC) | `762889263` | [view](https://lora.algokit.io/testnet/application/762889263) | [`lending_pool_v2/contract.algo.ts`](https://github.com/user/irion-contracts/blob/main/projects/irion-contracts/smart_contracts/lending_pool_v2/contract.algo.ts) |
| LoanFactory | `762889354` | [view](https://lora.algokit.io/testnet/application/762889354) | [`loan_factory/contract.algo.ts`](https://github.com/user/irion-contracts/blob/main/projects/irion-contracts/smart_contracts/loan_factory/contract.algo.ts) |
| Vault | `762889316` | [view](https://lora.algokit.io/testnet/application/762889316) | [`vault/contract.algo.ts`](https://github.com/user/irion-contracts/blob/main/projects/irion-contracts/smart_contracts/vault/contract.algo.ts) |
| CreditOracle | `762892340` | [view](https://lora.algokit.io/testnet/application/762892340) | [`credit_oracle/contract.algo.ts`](https://github.com/user/irion-contracts/blob/main/projects/irion-contracts/smart_contracts/credit_oracle/contract.algo.ts) |
| Governance | `762889174` | [view](https://lora.algokit.io/testnet/application/762889174) | [`governance/contract.algo.ts`](https://github.com/user/irion-contracts/blob/main/projects/irion-contracts/smart_contracts/governance/contract.algo.ts) |
| AccountRegistry | `762889254` | [view](https://lora.algokit.io/testnet/application/762889254) | [`account_registry/contract.algo.ts`](https://github.com/user/irion-contracts/blob/main/projects/irion-contracts/smart_contracts/account_registry/contract.algo.ts) |
| Senior LP Token (ASA) | `762889282` | [view](https://lora.algokit.io/testnet/asset/762889282) | — |
| TEST_USDC (sandbox) | `758916950` | [view](https://lora.algokit.io/testnet/asset/758916950) | — |

**Contract architecture diagram:**

```
                     ┌────────────────┐
                     │  Governance    │
                     │  (multisig     │
                     │   in Phase 3)  │
                     └───────┬───────┘
                             │ authority
       ┌─────────────────────┼────────────────────┐
       ▼                     ▼                    ▼
 ┌──────────┐          ┌────────────┐       ┌──────────────┐
 │  Vault   │          │    Loan    │ ←────▶│  Credit      │
 │          │          │  Factory   │  CPI  │  Oracle      │
 └─────┬────┘          └─────┬──────┘       └──────────────┘
       │                     │  CPI
       │                     ▼
       │               ┌────────────┐
       │  collateral   │  Lending   │
       └──────────────▶│   Pool V2  │
                       │ (senior +  │
                       │  junior)   │
                       └────────────┘
```

6 contract assertion bugs were patched during Phase 2 build. See [`../irion-contracts/README.md`](../irion-contracts/README.md#contract-patches-applied-during-phase-2) for details.

---

## Setup

### Prerequisites

- Node.js 20+
- Postgres (Supabase project or local)
- Redis (Upstash for production, local Docker for dev)
- Algorand testnet account with ~10+ ALGO for the deployer
- AlgoKit CLI (for contract builds): `npm install -g @algorandfoundation/algokit-cli`

### Quick start

```bash
# 1. Clone and install
git clone https://github.com/[user]/irion-network
cd irion-api
npm install

# 2. Configure environment
cp .env.example .env.local
# Required env vars:
#   DATABASE_URL — Supabase Postgres connection string
#   REDIS_URL — Redis connection string (redis://localhost:6379 for local)
#   DEPLOYER_MNEMONIC — 25-word testnet mnemonic with ~10+ ALGO
#   ADMIN_API_KEY — random hex key for admin endpoints
#   JWT_SECRET — random hex key for JWT signing
#   WEBHOOK_SIGNING_SECRET — random hex key for HMAC signing

# 3. Run database migrations
npm run db:migrate

# 4. Start API with inline workers
npm run dev

# → API available at http://localhost:4000
# → OpenAPI docs at http://localhost:4000/docs
```

### Demo console

```bash
cd apps/demo-console
npm install
cp .env.example .env.local
# Set NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev

# → Open http://localhost:3000
```

### Testing

```bash
# All unit + integration tests
npm test                                                            # 341 tests, 24 files

# Smoke tests against live testnet (requires funded deployer + env configured)
npx tsx src/scripts/acceptance-smoke.ts
```

### Full deployment

See [docs/deployment-runbook.md](./docs/deployment-runbook.md) — 8-step deployment from scratch with troubleshooting table.

---

## API Endpoints

### Core Flows

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/accounts` | Admin key | Create institution (returns client_id, client_secret, hmac_secret) |
| `POST` | `/v1/accounts/:id/kyb/approve` | Admin key | Sandbox KYB approval |
| `POST` | `/v1/auth/token` | Public | Exchange client credentials for JWT |
| `POST` | `/v1/accounts/:id/wallets` | JWT + HMAC | Provision Algorand wallet with ASA opt-ins |
| `GET` | `/v1/accounts/:id/balance` | JWT | Wallet lending/borrowing positions |

### Lending

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/deposits` | JWT + HMAC | Deposit to lending pool |
| `POST` | `/v1/withdrawals` | JWT + HMAC | Withdraw from lending pool |
| `POST` | `/v1/loans` | JWT + HMAC | Originate loan (4 types) |
| `GET` | `/v1/loans` | JWT | List active loans |
| `GET` | `/v1/loans/:id` | JWT | Get loan status + draws |
| `POST` | `/v1/loans/:id/repay` | JWT + HMAC | Repay loan |
| `POST` | `/v1/loans/:id/draw` | JWT + HMAC | Draw from revolving line |
| `GET` | `/v1/loans/:id/schedule` | JWT | Get installment schedule |

### Settlement

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/transfers` | JWT + HMAC | Transfer assets between wallets |
| `POST` | `/v1/payouts` | JWT + HMAC | External payout with screening |
| `POST` | `/v1/fx/quote` | JWT + HMAC | FX rate quote via Tinyman |
| `POST` | `/v1/fx/execute` | JWT + HMAC | Execute FX swap (mocked) |

### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/webhooks` | JWT + HMAC | Register webhook endpoint |
| `GET` | `/v1/webhooks` | JWT | List webhooks |
| `DELETE` | `/v1/webhooks/:id` | JWT | Delete webhook |
| `POST` | `/v1/webhooks/:id/rotate-secret` | JWT | Rotate HMAC signing secret |

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/admin/fund-wallet` | Admin key | Fund wallet with TEST_USDC from deployer |
| `POST` | `/v1/admin/delete-institution` | Admin key | Delete institution and all child records |

### Feed

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/transactions` | JWT | Unified transaction history (deposits, loans, transfers, etc.) |

Full OpenAPI 3.x spec at [`openapi.yaml`](../openapi.yaml).

---

## On-Chain Proof (Testnet)

Every operation produces a real Algorand testnet transaction. View confirmations on [Lora Explorer](https://lora.algokit.io/testnet).

### Example Lifecycle (Recorded Demo)

| Step | API Call | txHash | Lora Link |
|------|----------|--------|-----------|
| Fund wallet | `POST /v1/admin/fund-wallet` | `DUSP7YRRCBKZXPSCTHKTHQP5S5JM2LUG2LMX5O5NGCOUJYBT5J2Q` | [view](https://lora.algokit.io/testnet/transaction/DUSP7YRRCBKZXPSCTHKTHQP5S5JM2LUG2LMX5O5NGCOUJYBT5J2Q) |
| Deposit | `POST /v1/deposits` | `RND5BFOW4L75J7OXRY772LKOPA7WQ2VMRJFYPN3JEDPVQQXJJZAA` | [view](https://lora.algokit.io/testnet/transaction/RND5BFOW4L75J7OXRY772LKOPA7WQ2VMRJFYPN3JEDPVQQXJJZAA) |
| Originate loan | `POST /v1/loans` | (worker submits) | Confirmed via polled GET /v1/loans/:id |
| Repay loan | `POST /v1/loans/:id/repay` | (worker submits) | Confirmed via polled GET /v1/loans/:id |
| Wallet creation (funding) | `POST /v1/accounts/:id/wallets` | (deployer funds) | [example](https://lora.algokit.io/testnet/account/NICKXD44FJQJZ2O5QLHS4FQSRX6WHHTSZG6HBQK4TJIOMHNVUSML33XITQ) |

### Deployer Address

The protocol deployer on testnet:

| Field | Value |
|-------|-------|
| **Address** | `NICKXD44FJQJZ2O5QLHS4FQSRX6WHHTSZG6HBQK4TJIOMHNVUSML33XITQ` |
| **Lora** | [view](https://lora.algokit.io/testnet/account/NICKXD44FJQJZ2O5QLHS4FQSRX6WHHTSZG6HBQK4TJIOMHNVUSML33XITQ) |
| **TEST_USDC** | ~99,989,709 units (contract deployment funds) |
| **Created apps** | 110 (contract deployments + test instances) |

### Asset IDs

| Asset | ID | Lora |
|-------|----|------|
| TEST_USDC (sandbox stablecoin) | `758916950` | [view](https://lora.algokit.io/testnet/asset/758916950) |
| Senior LP Token | `762889282` | [view](https://lora.algokit.io/testnet/asset/762889282) |
| Junior LP Token | `762889284` | [view](https://lora.algokit.io/testnet/asset/762889284) |

---

## Project Status

**Phase 2 — Complete.** 14 sub-phases delivered:

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Environment scaffolding, bug fixes, cleanup | ✅ |
| 1 | 6 PuyaTS contracts, deployment script | ✅ |
| 2a | DB layer (19 tables, 16 migrations, Drizzle ORM) | ✅ |
| 2b | Plugins (JWT, HMAC, Sentry, idempotency, rate-limit) | ✅ |
| 2c | Services (Turnkey, KYB mock, wallet screening) | ✅ |
| 2d | Accounts, KYB, Wallets, API Keys, Deposits, Withdrawals | ✅ |
| 2e | 4 loan types (OC, Revolving, Term, Installment) | ✅ |
| 2f | Transfers, Payouts, FX swaps | ✅ |
| 2g | Webhook hardening (signatures, DLQ, rotation) | ✅ |
| 2h | Demo readiness, mainnet readiness (BigInt migration) | ✅ |

**341 tests** passing across 24 files. 7 route modules. 11 BullMQ workers. 6 contract patches surfaced and resolved during build. Full audit trail across every operation.

See [docs/phase-2-complete.md](./docs/phase-2-complete.md) for the complete milestone record.

---

## Phase 3 Roadmap

Organized by priority in [DEFERRED.md](./DEFERRED.md).

### P0 — Contracts
- **CreditOracle address convention** — unblocks INSTALLMENT on-chain repay (LoanFactory → Oracle inner txn address mismatch)
- **On-chain interest enforcement** — currently computed off-chain in `loan-math.ts`
- **On-chain credit_limit enforcement** — currently validated off-chain in route logic
- **Governance multisig** — replace deployer-signed bridge with proper multisig

### P1 — Infrastructure
- **HSM signing migration** — swap from algosdk in-process to Turnkey or self-hosted Vault
- **Worker host separation** — separate BullMQ workers into dedicated `irion-workers` process
- **Tinyman real execution** — currently quote-only (mocked execution per Decision C)
- **Mainnet deployment** — redeploy against Circle USDC (asset 31566704)

### P2 — Compliance
- **Real Didit KYB** — currently mocked; wire production Didit SDK
- **Hapi + Range screening** — currently stubbed; obtain API keys

### P3 — Post-MVP
- **Liquidator bot** — automated liquidation of overdue loans
- **Position reconciliation** — periodic jobs to reconcile DB ↔ on-chain balances
- **Multi-currency** — mainnet USDC pool, ALGO pool

---

## License

MIT — see [LICENSE](./LICENSE).
