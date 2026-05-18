import type { KybProvider, KybSession, KybSessionStatus } from "./types.js";
export declare class MockKybProvider implements KybProvider {
    private webhookSecret;
    private delaySeconds;
    constructor();
    createKybSession(institutionId: string, institutionName: string): Promise<KybSession>;
    getSessionStatus(sessionId: string): Promise<KybSessionStatus>;
    verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean;
    private enqueueMockCompletion;
}
//# sourceMappingURL=mock-provider.d.ts.map