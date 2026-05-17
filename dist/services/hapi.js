"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hapiService = exports.HapiService = void 0;
class HapiService {
    /**
     * STUBBED: Screen an Algorand address using Hapi protocol.
     * Returns a mock risk score for MVP.
     */
    async getRiskScore(address) {
        // Mock network call
        await new Promise(resolve => setTimeout(resolve, 300));
        // Stub implementation: deterministic based on address string length (just for testing)
        const riskScore = address.length % 2 === 0 ? 10 : 85;
        return {
            riskScore,
            isHighRisk: riskScore > 75,
            details: {
                lastChecked: new Date().toISOString(),
                provider: "HAPI",
                mocked: true
            }
        };
    }
}
exports.HapiService = HapiService;
exports.hapiService = new HapiService();
//# sourceMappingURL=hapi.js.map