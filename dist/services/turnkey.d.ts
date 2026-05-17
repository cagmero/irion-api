export declare class TurnkeyService {
    private client;
    private organizationId;
    private parentWalletId;
    constructor();
    /**
     * Create a new sub-wallet for an institution
     */
    createSubWallet(institutionName: string): Promise<{
        walletId: string;
        address: string;
    }>;
    /**
     * Sign a raw transaction payload (Algorand msgpack)
     */
    signTransaction(walletId: string, address: string, unsignedPayload: Buffer): Promise<string>;
}
export declare const turnkeyService: TurnkeyService;
//# sourceMappingURL=turnkey.d.ts.map