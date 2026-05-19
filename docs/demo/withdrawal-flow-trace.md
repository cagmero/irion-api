# Withdrawal Flow Trace — 2d.6 Smoke Test

**Date:** 2026-05-19
**Network:** Algorand Testnet (AlgoNode)
**Server:** http://localhost:4000

## Full Sequence

### Step 1: Provision Institution
```
POST /v1/accounts → 201
{
  "id": "f82e3874-7b4c-42e8-a7c9-d0ca22692ac6",
  "name": "Withdrawal Smoke 1779230328057",
  "status": "pending",
  "client_id": "...",
  "client_secret": "...",
  "hmac_secret": "..."
}
POST /v1/accounts/f82e3874.../kyb/approve → 200 (admin)
```

### Step 2: Authenticate
```
POST /v1/auth/token → 200
{ "access_token": "eyJhbGciOiJIUzI1NiIs..." }
```

### Step 3: Create Wallet + Auto Opt-in
```
POST /v1/accounts/f82e3874.../wallets → 201
{
  "walletId": "bafcb7c8-f1ad-45ce-9fa4-01eefba072ca",
  "algorandAddress": "CAH4I7PBTEODOOKLFMWZ52EKQBLZHR7X2HDGC5JJN53CHBUL2Z6CHZCTAQ",
  "label": "Withdrawal Test Wallet",
  "isPrimary": true,
  "optedInAssets": [758916950, 762580194]
}
```
- Opt-in to TEST_USDC (758916950): confirmed on-chain
- Opt-in to Senior LP (762580194): confirmed on-chain

### Step 4: Fund Wallet
```
Deployer: NICKXD44FJQJZ2O5QLHS4FQSRX6WHHTSZG6HBQK4TJIOMHNVUSML33XITQ
Transfer: 1,000,000 TEST_USDC → CAH4I7PBTEODOOKLFMWZ52EKQBLZHR7X2HDGC5JJN53CHBUL2Z6CHZCTAQ
Fund txHash: ITDFZ6SRBFBWC6BZUQOG5V65X7AMVTRRQUHST3C7OZAIUP7AGC2Q
```

### Step 5: Deposit 1 TEST_USDC
```
POST /v1/deposits → 202
{
  "depositId": "a1d77139-c0bf-4b84-aaf4-88e56137d595",
  "txHash": "OYDSQIQYMFPCDHYI2KPGN5A6F2FAF7A7LCSV2437DIO2SLHPGHWQ",
  "status": "submitted"
}
```
- Deposit txn confirmed on-chain
- deposit-confirmation worker processed and completed
- LP tokens minted: 1,000,000 (asset 762580194)

### Step 5b: Wait for LP Token Mint
```
LP token balance: 1,000,000
```

### Step 6: Withdraw 0.5 TEST_USDC
```
POST /v1/withdrawals → 202
{
  "withdrawalId": "1aa21905-22d6-4729-9ecd-2b30ca38639e",
  "txHash": "LENZNOXFMQBZXZLQEX2I4MBOFMGLQIR4TE6HG35JNBB6URBNDGSQ",
  "status": "submitted"
}
```

**Preflight checks passed:**
1. DB position balance: 1,000,000 ≥ 500,000 ✓
2. On-chain LP token balance: 1,000,000 ≥ 500,000 ✓
3. DB vs on-chain match: 1,000,000 == 1,000,000 ✓

**Atomic group submitted:**
- txn[0]: axfer — 500,000 LP tokens from wallet → pool (burn)
- txn[1]: appl — withdraw(tranche=0, lp_amount=500,000) — pool sends 500,000 USDC back

### Step 7: Withdrawal Confirmation
```
Withdrawal txn confirmed at round 63542509
withdrawal-confirmation worker completed
```

### Step 8: Final State Verification

**On-chain balances:**
| Asset | Before Deposit | After Deposit | After Withdrawal |
|-------|---------------|---------------|------------------|
| TEST_USDC (758916950) | 1,000,000 | 0 | 500,000 |
| Senior LP (762580194) | 0 | 1,000,000 | 500,000 |

**Database state:**
```sql
-- Deposits
SELECT id, status, tx_hash, amount FROM deposits ORDER BY created_at DESC LIMIT 1;
-- Result: a1d77139... | completed | OYDSQIQYMF... | 1000000

-- Withdrawals
SELECT id, status, tx_hash, amount FROM withdrawals ORDER BY created_at DESC LIMIT 1;
-- Result: 1aa21905... | completed | LENZNOXFMQB... | 500000

-- Lending Positions
SELECT * FROM lending_positions WHERE institution_id = 'f82e3874...';
-- Result: balance=500000, asset_id=758916950
```

**Balance endpoint:**
```
GET /v1/accounts/f82e3874.../balance → 200
{
  "lending": [{
    "assetId": 758916950,
    "balance": "500000",
    "totalValue": "500000"
  }]
}
```

## Worker Logs
```
[deposit-confirmation] Processing deposit a1d77139-c0bf-4b84-aaf4-88e56137d595, txHash: OYDSQIQYMFPCDHYI2KPGN5A6F2FAF7A7LCSV2437DIO2SLHPGHWQ
[deposit-confirmation] job 16 completed
[withdrawal-confirmation] job 1 completed
```

## Server Request Timeline
```
req-2: POST /v1/accounts → 201 (2075ms)
req-3: POST /v1/accounts/:id/kyb/approve → 200 (566ms)
req-4: POST /v1/auth/token → 200 (651ms)
req-5: POST /v1/accounts/:id/wallets → 201 (3108ms)
req-6: POST /v1/deposits → 202 (2964ms)
req-7: POST /v1/withdrawals → 202 (2707ms)
req-8: GET /v1/accounts/:id/balance → 200 (548ms)
```

## Pera Explorer Links
- Deposit: https://testnet.explorer.perawallet.app/tx/OYDSQIQYMFPCDHYI2KPGN5A6F2FAF7A7LCSV2437DIO2SLHPGHWQ
- Withdrawal: https://testnet.explorer.perawallet.app/tx/LENZNOXFMQBZXZLQEX2I4MBOFMGLQIR4TE6HG35JNBB6URBNDGSQ
- Pool App: https://testnet.explorer.perawallet.app/application/762580175
