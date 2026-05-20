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

  step("1", "Provision institution + wallet");
  const acct = await (await fetch(`${BASE}/v1/accounts`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: `Payout ${Date.now()}` }),
  })).json();
  await fetch(`${BASE}/v1/accounts/${acct.id}/kyb/approve`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY }, body: "{}" });
  const h = Buffer.from(acct.hmac_secret as string, "hex");
  const tok = (await (await fetch(`${BASE}/v1/auth/token`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: acct.client_id, client_secret: acct.client_secret }),
  })).json()).access_token;

  const wSig = crypto.createHmac("sha256", h).update(JSON.stringify({ label: "P" })).digest("hex");
  const w = await (await fetch(`${BASE}/v1/accounts/${acct.id}/wallets`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "Irion-Signature": wSig },
    body: JSON.stringify({ label: "P" }),
  })).json();
  assert(!!w.algorandAddress, "Wallet created");

  step("2", "Fund wallet with 0.5 USDC");
  let sp = await algod.getTransactionParams().do();
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: deployer.addr.toString(), receiver: w.algorandAddress,
      assetIndex: USDC, amount: BigInt(500_000), suggestedParams: sp,
    }).signTxn(deployer.sk)
  ).do()).txid, 5);

  step("3", "Create external destination keypair + opt into USDC");
  const dest = algosdk.generateAccount();
  const destAddr = dest.addr.toString();
  console.log("  Destination:", destAddr);

  sp = await algod.getTransactionParams().do();
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: deployer.addr.toString(), receiver: destAddr, amount: 300_000, suggestedParams: sp,
    }).signTxn(deployer.sk)
  ).do()).txid, 5);

  sp = await algod.getTransactionParams().do();
  await algosdk.waitForConfirmation(algod, (await algod.sendRawTransaction(
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: destAddr, receiver: destAddr, assetIndex: USDC, amount: 0, suggestedParams: sp,
    }).signTxn(dest.sk)
  ).do()).txid, 5);

  step("4", "Payout 0.05 USDC to external address");
  const tBody = JSON.stringify({ fromWalletId: w.walletId, destinationAddress: destAddr, assetId: USDC, amount: "50000", memo: "test payout" });
  const tSig = crypto.createHmac("sha256", h).update(tBody).digest("hex");
  const tR = await fetch(`${BASE}/v1/payouts`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "irion-signature": tSig, "irion-timestamp": new Date().toISOString() },
    body: tBody,
  });
  const tB = await tR.json();
  assert(tR.status === 202, `Payout accepted (${tR.status})`);
  console.log("  TxHash:", tB.txHash);
  console.log("  Pera: https://testnet.explorer.perawallet.app/tx/" + tB.txHash);

  step("5", "Verify");
  await wait(8000);
  const bal = Number((await algod.accountInformation(destAddr).do()).assets?.find((x: any) => Number(x["asset-id"] ?? x.assetId) === USDC)?.amount ?? 0);
  console.log("  Destination USDC:", bal);
  assert(bal === 50000, `Received 50000 (got ${bal})`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(" PAYOUT SMOKE TEST PASSED");
  console.log("=".repeat(60));
  console.log("  Pera: https://testnet.explorer.perawallet.app/tx/" + tB.txHash);
}

main().catch(e => { console.error("\n✗ FAILED:", e.message ?? e); process.exit(1); });
