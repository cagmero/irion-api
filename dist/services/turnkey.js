"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turnkeyService = exports.TurnkeyService = void 0;
const http_1 = require("@turnkey/http");
const api_key_stamper_1 = require("@turnkey/api-key-stamper");
// Assuming we use standard Turnkey client
// Make sure to install @turnkey/http @turnkey/api-key-stamper if not already installed.
// We'll wrap it in a service class for dependency injection/easier testing
class TurnkeyService {
    client;
    organizationId;
    parentWalletId;
    constructor() {
        this.organizationId = process.env.TURNKEY_ORG_ID;
        this.parentWalletId = process.env.TURNKEY_PARENT_WALLET_ID;
        const stamper = new api_key_stamper_1.ApiKeyStamper({
            apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
            apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
        });
        this.client = new http_1.TurnkeyClient({ baseUrl: process.env.TURNKEY_API_BASE_URL }, stamper);
    }
    /**
     * Create a new sub-wallet for an institution
     */
    async createSubWallet(institutionName) {
        const timestamp = Date.now();
        const walletName = `Wallet - ${institutionName} - ${timestamp}`;
        const response = await this.client.createWallet({
            type: "ACTIVITY_TYPE_CREATE_WALLET",
            timestampMs: String(Date.now()),
            organizationId: this.organizationId,
            parameters: {
                walletName: walletName,
                accounts: [
                    {
                        curve: "CURVE_ED25519", // Algorand uses ed25519
                        pathFormat: "PATH_FORMAT_BIP32",
                        path: "m/44'/283'/0'/0/0", // Algorand derivation path
                        addressFormat: "ADDRESS_FORMAT_COMPRESSED",
                    },
                ],
            },
        });
        const walletId = response.activity.result.createWalletResult?.walletId;
        const address = response.activity.result.createWalletResult?.addresses?.[0];
        if (!walletId || !address) {
            throw new Error("Failed to extract wallet ID or address from Turnkey response");
        }
        return { walletId, address };
    }
    /**
     * Sign a raw transaction payload (Algorand msgpack)
     */
    async signTransaction(walletId, address, unsignedPayload) {
        const response = await this.client.signRawPayload({
            type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
            organizationId: this.organizationId,
            timestampMs: String(Date.now()),
            parameters: {
                signWith: address,
                payload: unsignedPayload.toString("hex"),
                encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
                hashFunction: "HASH_FUNCTION_NOT_APPLICABLE", // For Algorand, we hash the msgpack locally before signing usually, but turnkey supports signing the raw payload directly if it's small, or we pass the hash.
                // Usually Algorand requires prefixing "TX" before hashing.
            },
        });
        const result = response.activity.result.signRawPayloadResult;
        const r = result?.r;
        const s = result?.s;
        if (!r || !s) {
            throw new Error("Failed to sign transaction with Turnkey: missing r or s in signature");
        }
        const signature = r + s; // Simplified, in reality Algorand needs proper extraction
        return signature;
    }
}
exports.TurnkeyService = TurnkeyService;
exports.turnkeyService = new TurnkeyService();
//# sourceMappingURL=turnkey.js.map