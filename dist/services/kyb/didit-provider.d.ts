import type { KybProvider, KybSession, KybSessionStatus } from "./types.js";
export declare class DiditKybProvider implements KybProvider {
    private baseUrl;
    private apiKey;
    private workflowId;
    private webhookSecret;
    constructor();
    createKybSession(institutionId: string, institutionName: string): Promise<KybSession>;
    getSessionStatus(sessionId: string): Promise<KybSessionStatus>;
    verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean;
}
//# sourceMappingURL=didit-provider.d.ts.map