import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import algosdk from "algosdk";
import { getSecret } from "../lib/secrets.js";

export class AlgorandService {
  public client: AlgorandClient;

  private _deployerAccount: algosdk.Account | undefined;

  constructor() {
    this.client = AlgorandClient.fromConfig({
      algodConfig: {
        server: process.env.ALGOD_URL || "https://testnet-api.algonode.cloud",
        port: parseInt(process.env.ALGOD_PORT || "443", 10),
        token: process.env.ALGOD_TOKEN || "",
      },
      indexerConfig: {
        server: process.env.INDEXER_URL || "https://testnet-idx.algonode.cloud",
        port: parseInt(process.env.INDEXER_PORT || "443", 10),
        token: process.env.INDEXER_TOKEN || "",
      },
    });
  }

  private getDeployerAccount(): algosdk.Account {
    if (this._deployerAccount) return this._deployerAccount;
    const mnemonic = getSecret("DEPLOYER_MNEMONIC");
    this._deployerAccount = algosdk.mnemonicToSecretKey(mnemonic);
    return this._deployerAccount;
  }

  get deployerAccount(): algosdk.Account {
    return this.getDeployerAccount();
  }

  async getLatestRound(): Promise<number> {
    const status = await this.client.client.algod.status().do();
    return Number(status.lastRound);
  }

  async submitSignedTransaction(signedTxn: Uint8Array): Promise<string> {
    const response = await this.client.client.algod.sendRawTransaction(signedTxn).do();
    return response.txid;
  }
}

export const algorandService = new AlgorandService();