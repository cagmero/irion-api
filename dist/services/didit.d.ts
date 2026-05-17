export declare class DiditService {
    private baseUrl;
    private clientId;
    private apiKey;
    constructor();
    /**
     * Initialize a KYB session for an institution
     */
    createSession(institutionId: string, email: string, legalName: string): Promise<{
        sessionId: string;
        sessionUrl: string;
    }>;
    /**
     * Get the current status and details of a KYB session
     */
    getSession(sessionId: string): Promise<any>;
}
export declare const diditService: DiditService;
//# sourceMappingURL=didit.d.ts.map