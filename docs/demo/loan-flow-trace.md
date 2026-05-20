# Loan Origination Flow Trace — 2e.1 Smoke Test

**Date:** 2026-05-20
**Network:** Algorand Testnet (AlgoNode)
**Contracts:** LendingPool v2=762889263 (patched), Vault=762889316 (patched)

## Flow

### Step 1: Provision Institution → Wallet → Fund
```
POST /v1/accounts → 201
POST /v1/auth/token → 200  
POST /v1/accounts/:id/wallets → 201 (opt-in TEST_USDC confirmed)
Fund: 4,500,000 TEST_USDC from deployer to wallet
Deposit: 2,000,000 TEST_USDC to LendingPool (provides pool liquidity)
```

### Step 2: POST /v1/loans → 202
```
Body: walletId, loanType=OVERCOLLATERALIZED, collateralAmount=1500000, borrowAmount=1000000
Response: 202 { id, status: "pending" }
```

### Step 3: Worker — Vault Collateral Lock (governance bridge)
```
Atomic group:
  txn[0]: axfer — wallet → Vault app address (1,500,000 TEST_USDC)
  txn[1]: appl — Vault.create_oracle_entry (governance-signed)
```
Result: Vault entries counter = 3 (1.5 USDC collateral locked on-chain)

### Step 4: Worker — Direct LendingPool.borrow() (governance-signed)
```
txn: appl — LendingPool.borrow(1000000, wallet_address) from deployer
```
Result: wallet receives 1,000,000 TEST_USDC

### Step 5: State Machine
```
pending → collateral_locked → submitted → active
```

### On-Chain Verification
- **Vault holds collateral:** Vault entries counter = 3 (vault entry created)
- **Wallet USDC:** started 4.5M, deposited 2M, locked 1.5M to vault, received 1M borrow = 2M final
- **Borrow tx:** https://testnet.explorer.perawallet.app/tx/6XZWL6VZUMUNNG4AGYPZFF6QTLQJCXCZ3KFKGKUJOFR4UJ6BQEMA

### DB State
```
loans: 311a4185... | active | overcollateralized | vault=0 | collateral=1500000 | principal=1000000
borrowing_positions: institution=fc3e0ef6... | asset=758916950 | balance=1000000
```

### Contract Bugs Discovered (all patched or documented)
1. **LendingPool assert_loan_factory** — PATCHED (redeployed)
2. **Vault assert_loan_factory_or_governance** — PATCHED (redeployed)
3. **CreditOracle assert_authorized** — DOCUMENTED (blocks LoanFactory → Oracle, MVP works around via governance borrow)
