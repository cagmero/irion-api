export class DiditService {
  private baseUrl: string;
  private clientId: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = process.env.DIDIT_API_BASE_URL as string;
    this.clientId = process.env.DIDIT_CLIENT_ID as string;
    this.apiKey = process.env.DIDIT_API_KEY as string;
  }

  /**
   * Initialize a KYB session for an institution
   */
  async createSession(institutionId: string, email: string, legalName: string): Promise<{ sessionId: string; sessionUrl: string }> {
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
  async getSession(sessionId: string): Promise<any> {
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

export const diditService = new DiditService();
