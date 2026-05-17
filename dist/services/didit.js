"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diditService = exports.DiditService = void 0;
class DiditService {
    baseUrl;
    clientId;
    apiKey;
    constructor() {
        this.baseUrl = process.env.DIDIT_API_BASE_URL;
        this.clientId = process.env.DIDIT_CLIENT_ID;
        this.apiKey = process.env.DIDIT_API_KEY;
    }
    /**
     * Initialize a KYB session for an institution
     */
    async createSession(institutionId, email, legalName) {
        const response = await fetch(`${this.baseUrl}/v1/session`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                vendorData: institutionId,
                callbackUrl: `${process.env.API_BASE_URL}/v1/webhooks/didit`,
                applicant: {
                    email,
                    legalName,
                }
            }),
        });
        if (!response.ok) {
            throw new Error(`Didit API error: ${response.statusText}`);
        }
        const data = await response.json();
        return {
            sessionId: data.sessionId,
            sessionUrl: data.sessionUrl,
        };
    }
    /**
     * Get the current status and details of a KYB session
     */
    async getSession(sessionId) {
        const response = await fetch(`${this.baseUrl}/v1/session/${sessionId}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
            },
        });
        if (!response.ok) {
            throw new Error(`Didit API error: ${response.statusText}`);
        }
        return response.json();
    }
}
exports.DiditService = DiditService;
exports.diditService = new DiditService();
//# sourceMappingURL=didit.js.map