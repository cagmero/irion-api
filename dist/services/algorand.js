"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.algorandService = exports.AlgorandService = void 0;
const algokit_utils_1 = require("@algorandfoundation/algokit-utils");
const algosdk_1 = __importDefault(require("algosdk"));
const secrets_js_1 = require("../lib/secrets.js");
class AlgorandService {
    client;
    _deployerAccount;
    constructor() {
        this.client = algokit_utils_1.AlgorandClient.fromConfig({
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
    getDeployerAccount() {
        if (this._deployerAccount)
            return this._deployerAccount;
        const mnemonic = (0, secrets_js_1.getSecret)("DEPLOYER_MNEMONIC");
        this._deployerAccount = algosdk_1.default.mnemonicToSecretKey(mnemonic);
        return this._deployerAccount;
    }
    get deployerAccount() {
        return this.getDeployerAccount();
    }
    async getLatestRound() {
        const status = await this.client.client.algod.status().do();
        return Number(status.lastRound);
    }
    async submitSignedTransaction(signedTxn) {
        const response = await this.client.client.algod.sendRawTransaction(signedTxn).do();
        return response.txid;
    }
}
exports.AlgorandService = AlgorandService;
exports.algorandService = new AlgorandService();
//# sourceMappingURL=algorand.js.map