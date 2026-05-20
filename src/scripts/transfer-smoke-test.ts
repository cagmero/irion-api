import crypto from "crypto";
import algosdk from "algosdk";
const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const USDC = 758916950;
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", 443);

function assert(c: boolean, m: string) { if (!c) { console.error(`  ✗ ${m}`); process.exit(1); } console.log(`  ✓ ${m}`); }
function step(n: string, t: string) { console.log(`\n${"=".repeat(60)}\n${n}: ${t}\n${"=".repeat(60)}`); }
async function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC!);

  step("1", "Provision institution");
  const acct = await (await fetch(`${BASE}/v1/accounts`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: `Tx ${Date.now()}` }),
  })).json();
  await fetch(`${BASE}/v1/accounts/${acct.id}/kyb/approve`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY }, body: "{}" });
  const h = Buffer.from(acct.hmac_secret as string, "hex");
  const tok = (await (await fetch(`${BASE}/v1/auth/token`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: acct.client_id, client_secret: acct.client_secret }),
  })).json()).access_token;
  assert(!!tok, "Auth OK");

  // Wallet A1 (primary)
  const wSig = crypto.createHmac("sha256", h).update(JSON.stringify({ label: "A1" })).digest("hex");
  const w1 = await (await fetch(`${BASE}/v1/accounts/${acct.id}/wallets`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "Irion-Signature": wSig },
    body: JSON.stringify({ label: "A1" }),
  })).json();
  assert(!!w1.algorandAddress, "Wallet A1 created");
  console.log("  A1:", w1.walletId);

  // Fund A1 with 0.5 USDC
  let sp = await algod.getTransactionParams().do();
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: deployer.addr.toString(), receiver: w1.algorandAddress,
      assetIndex: USDC, amount: BigInt(500_000), suggestedParams: sp,
    }).signTxn(deployer.sk)
  ).do()).txid, 5);

  // Create wallet A2 manually (generate key, fund, opt-in, insert into DB)
  step("2", "Create wallet A2");
  const a2 = algosdk.generateAccount();
  const a2Addr = a2.addr.toString();
  sp = await algod.getTransactionParams().do();

  // Fund A2 with 0.5 ALGO
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: deployer.addr.toString(), receiver: a2Addr, amount: 500_000, suggestedParams: sp,
    }).signTxn(deployer.sk)
  ).do()).txid, 5);

  // Opt A2 into USDC
  sp = await algod.getTransactionParams().do();
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: a2Addr, receiver: a2Addr, assetIndex: USDC, amount: 0, suggestedParams: sp,
    }).signTxn(a2.sk)
  ).do()).txid, 5);

  // Insert A2 into DB via direct psql
  const w2Id = crypto.randomUUID();
  const { execSync } = require("child_process");
  execSync(`PGPASSWORD='thispasswordisforirionb2b' psql -h db.akbbeepcsrsalzuofncn.supabase.co -p 5432 -U postgres -d postgres -c "INSERT INTO wallets (id, institution_id, label, is_primary, turnkey_wallet_id, turnkey_address, algorand_address, opted_in_assets, signing_provider) VALUES ('${w2Id}', '${acct.id}', 'A2', false, 'manual', '${a2Addr}', '${a2Addr}', '{${USDC}}', 'algosdk')"`);
  console.log("  A2:", w2Id);

  step("3", "Transfer 0.05 USDC A1 → A2");
  const tPayload = { fromWalletId: w1.walletId, toWalletId: w2Id, assetId: USDC, amount: "50000" };
  const tBody = JSON.stringify(tPayload);
  const tSig = crypto.createHmac("sha256", h).update(tBody).digest("hex");
  const tR = await fetch(`${BASE}/v1/transfers`, { method: "POST",
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${tok}`,
      "irion-signature": tSig, "irion-timestamp": new Date().toISOString(),
    },
    body: tBody,
  });
  const tB = await tR.json();
  assert(tR.status === 202, `Transfer accepted (${tR.status})`);
  console.log("  TxHash:", tB.txHash);
  console.log("  Pera: https://testnet.explorer.perawallet.app/tx/" + tB.txHash);

  step("4", "Verify");
  await wait(8000);
  const balA2 = Number((await algod.accountInformation(a2Addr).do()).assets?.find((x: any) => Number(x["asset-id"] ?? x.assetId) === USDC)?.amount ?? 0);
  console.log("  A2 USDC:", balA2);
  assert(balA2 === 50000, `A2 = 50000 (got ${balA2})`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(" TRANSFER SMOKE TEST PASSED");
  console.log("=".repeat(60));
  console.log("  Pera: https://testnet.explorer.perawallet.app/tx/" + tB.txHash);
}

main().catch(e => { console.error("\n✗ FAILED:", e.message ?? e); process.exit(1); });
