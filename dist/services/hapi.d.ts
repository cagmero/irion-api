export declare class HapiService {
    /**
     * STUBBED: Screen an Algorand address using Hapi protocol.
     * Returns a mock risk score for MVP.
     */
    getRiskScore(address: string): Promise<{
        riskScore: number;
        isHighRisk: boolean;
        details: any;
    }>;
}
export declare const hapiService: HapiService;
//# sourceMappingURL=hapi.d.ts.map