# Contract Deployments

## Pre-patch Deployment IDs (2026-05-19)

These IDs are for the pre-patch contracts deployed on 2026-05-16.
The `assert_loan_factory` bug exists in the original LendingPool and Vault deployments.

| Contract | App ID | Notes |
|----------|--------|-------|
| Governance | 762580080 | Unchanged |
| AccountRegistry | 762580157 | Unchanged |
| LendingPool V2 (USDC) | 762580175 | **Has assert bug** — replaced |
| Senior LP Token | 762580194 | Recreated if LendingPool redeployed |
| Junior LP Token | 762580196 | Recreated if LendingPool redeployed |
| LendingPool V2 (ALGO) | 762580199 | Unchanged (not used) |
| Vault | 762580229 | **Has assert bug** — replaced |
| CreditOracle | 762580249 | Unchanged (uses Txn.sender, correct) |
| LoanFactory | 762580267 | Unchanged |

## Post-patch Deployment IDs

Deployed 2026-05-20 with `assert_loan_factory` fix (`txn ApplicationID` → `global CallerApplicationID`).
Both LendingPool and Vault have the corrected assertion.

| Contract | App ID | Notes |
|----------|--------|-------|
| Governance | 762889174 | New (redeployed alongside LendingPool/Vault) |
| AccountRegistry | 762889254 | New (redeployed alongside) |
| LendingPool V2 (USDC) | **762889263** | **Patched — assert_loan_factory fixed** |
| Senior LP Token | **762889282** | New (created by new LendingPool) |
| Junior LP Token | **762889284** | New (created by new LendingPool) |
| LendingPool V2 (ALGO) | 762889287 | New (same fix, not used yet) |
| Vault | **762889316** | **Patched — assert_loan_factory_or_governance fixed** |
| CreditOracle | 762889336 → **762892340** | **Patched** (assert_authorized fixed) |
| LoanFactory | 762889354 | New (correct) |
