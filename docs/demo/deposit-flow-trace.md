# Deposit Flow — Live Trace (2d.5)

**Date:** 2026-05-19  
**Network:** Algorand Testnet  
**Pool App ID:** 762580175  
**TEST_USDC ASA:** 758916950  
**Senior LP Token:** 762580194  

## Confirmed Deposit Transaction

- **TxHash:** `MRICPHERRJQYYS3PAWK3YF72TQDSWJEMMFTIGWOH2GZA7YMR4UXA`
- **Explorer:** https://testnet.explorer.perawallet.app/tx/MRICPHERRJQYYS3PAWK3YF72TQDSWJEMMFTIGWOH2GZA7YMR4UXA
- **Confirmed Round:** 63538947

## Smoke Test Output (8/8 Steps Green)

```
============================================================
 DEPOSIT SMOKE TEST — 2d.5 (full 8-step)
  Server : http://localhost:4000
  Network: Algorand Testnet (AlgoNode)
  Asset  : TEST_USDC ASA 758916950
  Pool   : App 762580175
============================================================

Step 1: POST /v1/accounts — provision institution
  HTTP status  : 201
  id           : 5a99ec16-3734-49ae-bca8-9a815765f05b
  ✓ POST /v1/accounts → 201
  ✓ institution.id present
  ✓ hmac_secret present (one-time)
  ✓ KYB approved via admin endpoint

Step 2: POST /v1/auth/token — authenticate
  HTTP status: 200
  ✓ POST /v1/auth/token → 200
  ✓ JWT present
  ✓ JWT has 3 parts

Step 3: POST /v1/accounts/:id/wallets — create wallet + auto opt-in
  HTTP status     : 201
  algorandAddress : RTFF7XGN4ASHIM77MEY2XGB4BS6QPEK3EF2SL4CY5XDPUWTDH6MSUD7SMY
  optedInAssets   : [758916950, 762580194]
  ✓ POST /v1/wallets → 201
  ✓ algorandAddress present
  ✓ address is 58 chars
  ✓ optedInAssets is array
  ✓ opted into TEST_USDC (758916950)
  ✓ opted into senior LP (762580194)

Step 3b: Verify opt-in transactions confirmed on-chain
  TEST_USDC opt-in   : ✓ confirmed
  SeniorLP opt-in    : ✓ confirmed
  ✓ TEST_USDC opt-in confirmed on-chain
  ✓ senior LP opt-in confirmed on-chain

Step 4: Fund institution wallet with 1 TEST_USDC from deployer
  Deployer : NICKXD44FJQJZ2O5QLHS4FQSRX6WHHTSZG6HBQK4TJIOMHNVUSML33XITQ
  Recipient: RTFF7XGN4ASHIM77MEY2XGB4BS6QPEK3EF2SL4CY5XDPUWTDH6MSUD7SMY
  Fund txHash : R5BGXA3DFYU4ZACKWIY3YFV2VONK54RIEEJND6ZKVELGE26BAL7A
  ✓ Fund txn confirmed
  Wallet TEST_USDC balance: 1000000
  ✓ Wallet received 1000000 TEST_USDC

Step 5: POST /v1/deposits → sign + submit atomic group
  HTTP status : 202
  depositId   : 35830492-2bfb-425a-a664-13769f9a7a49
  txHash      : MRICPHERRJQYYS3PAWK3YF72TQDSWJEMMFTIGWOH2GZA7YMR4UXA
  status      : submitted
  explorerUrl : https://testnet.explorer.perawallet.app/tx/MRICPHERRJQYYS3PAWK3YF72TQDSWJEMMFTIGWOH2GZA7YMR4UXA
  ✓ POST /v1/deposits → 202
  ✓ depositId present
  ✓ txHash present
  ✓ status = submitted
  ✓ explorerUrl contains txHash

Step 6: Wait for on-chain confirmation via algod
  ✓ Confirmed at round 63538947
  ✓ Txn confirmed at round 63538947

Step 7: Poll GET /v1/accounts/:id/balance until lending_positions updated
  ✓ lending_position for TEST_USDC (758916950) exists
  ✓ balance ≥ 1000000 microunits

Step 8: Verify audit log entries + webhook Irion-Signature
  deposit.initiated  : written at Step 5 (POST /v1/deposits)
  deposit.submitted  : written at Step 5 (after algod submit)
  deposit.confirmed  : written by BullMQ worker (Step 7 confirms it ran)
  ✓ Irion-Signature is 64-char hex HMAC-SHA256
```

## Atomic Group Composition

| Txn | Type | From | To | Amount | Fee |
|-----|------|------|----|--------|-----|
| 0 | axfer | Wallet | Pool App | 1,000,000 TEST_USDC | 1,000 µALGO |
| 1 | appl  | Wallet | LendingPoolV2 | deposit(SENIOR) | 3,000 µALGO (covers inner txn) |

## Inner Transaction (emitted by pool contract)

| Txn | Type | From | To | Amount | Fee |
|-----|------|------|----|--------|-----|
| 0 (inner) | axfer | Pool App | Wallet | LP tokens minted | 0 µALGO (fee pooled) |

## Key Implementation Details

- **Fee pooling:** App call fee = 3,000 µALGO (covers outer + 1 inner txn)
- **Indexer fallback:** `pendingTransactionInformation` returns `{}` for txns outside ~1000-round window; fallback to indexer required
- **BigInt conversion:** Indexer returns `confirmedRound` as BigInt → convert to Number for DB storage
- **BullMQ lockDuration:** 70,000ms (must exceed 60s poll timeout)
- **Signing provider:** algosdk in-process with AES-256-GCM encrypted keys at rest
