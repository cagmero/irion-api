export type KybStatus = "initiated" | "pending" | "approved" | "rejected";

export interface KybSession {
  diditSessionId: string;
  verificationUrl: string;
}

export interface KybSessionStatus {
  status: KybStatus;
  details: Record<string, unknown>;
}

export interface KybProvider {
  createKybSession(institutionId: string, institutionName: string): Promise<KybSession>;
  getSessionStatus(sessionId: string): Promise<KybSessionStatus>;
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean;
}