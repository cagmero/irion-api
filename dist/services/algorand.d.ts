import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import algosdk from "algosdk";
export declare class AlgorandService {
    client: AlgorandClient;
    private _deployerAccount;
    constructor();
    private getDeployerAccount;
    get deployerAccount(): algosdk.Account;
    getLatestRound(): Promise<number>;
    submitSignedTransaction(signedTxn: Uint8Array): Promise<string>;
}
export declare const algorandService: AlgorandService;
//# sourceMappingURL=algorand.d.ts.map