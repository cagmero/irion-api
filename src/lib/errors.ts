import { FastifyRequest, FastifyReply } from "fastify";

export const CODE_STATUS = {
  AUTH_FAILED: 401,
  INVALID_TOKEN: 401,
  EXPIRED_TOKEN: 401,
  INVALID_SIGNATURE: 401,
  MISSING_SIGNATURE: 401,
  IP_BLOCKED: 403,
  INVALID_CREDENTIALS: 401,
  MISSING_IDEMPOTENCY_KEY: 400,
  IDEMPOTENCY_MISMATCH: 422,
  IDEMPOTENCY_KEY_TOO_LONG: 400,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 422,
  INVALID_BODY: 422,
  INVALID_PARAMS: 422,
  INSTITUTION_NOT_FOUND: 404,
  WALLET_NOT_FOUND: 404,
  LOAN_NOT_FOUND: 404,
  WEBHOOK_NOT_FOUND: 404,
  FX_QUOTE_NOT_FOUND: 404,
  FX_QUOTE_EXPIRED: 410,
  WALLET_ALREADY_EXISTS: 409,
  LOAN_NOT_ACTIVE: 422,
  INSUFFICIENT_BALANCE: 422,
  KYB_NOT_APPROVED: 403,
  WALLET_SCREENING_FAILED: 422,
  TURNKEY_ERROR: 502,
  DIDIT_ERROR: 502,
  ALGORAND_SUBMIT_FAILED: 502,
  TINYMAN_ERROR: 502,
  INTERNAL_ERROR: 500,
  DATABASE_ERROR: 500,
  REDIS_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof CODE_STATUS;

const CODE_DETAIL: Record<ErrorCode, string> = {
  AUTH_FAILED: "Authentication failed",
  INVALID_TOKEN: "Token is invalid or malformed",
  EXPIRED_TOKEN: "Token has expired",
  INVALID_SIGNATURE: "HMAC signature verification failed",
  MISSING_SIGNATURE: "Irion-Signature header is required",
  IP_BLOCKED: "IP address is not in the allowed list",
  INVALID_CREDENTIALS: "Invalid client credentials",
  MISSING_IDEMPOTENCY_KEY: "Idempotency-Key header is required",
  IDEMPOTENCY_MISMATCH: "Idempotency key reused with different request body",
  IDEMPOTENCY_KEY_TOO_LONG: "Idempotency-Key exceeds maximum length of 255 characters",
  RATE_LIMITED: "Rate limit exceeded",
  VALIDATION_FAILED: "Request validation failed",
  INVALID_BODY: "Request body is invalid",
  INVALID_PARAMS: "Request parameters are invalid",
  INSTITUTION_NOT_FOUND: "Institution not found",
  WALLET_NOT_FOUND: "Wallet not found",
  LOAN_NOT_FOUND: "Loan not found",
  WEBHOOK_NOT_FOUND: "Webhook not found",
  FX_QUOTE_NOT_FOUND: "FX quote not found",
  FX_QUOTE_EXPIRED: "FX quote has expired",
  WALLET_ALREADY_EXISTS: "Wallet already exists for this institution",
  LOAN_NOT_ACTIVE: "Loan is not in an active state",
  INSUFFICIENT_BALANCE: "Insufficient balance for this operation",
  KYB_NOT_APPROVED: "Institution has not completed KYB approval",
  WALLET_SCREENING_FAILED: "Wallet failed risk screening",
  TURNKEY_ERROR: "Turnkey service returned an error",
  DIDIT_ERROR: "Didit service returned an error",
  ALGORAND_SUBMIT_FAILED: "Failed to submit transaction to Algorand",
  TINYMAN_ERROR: "Tinyman service returned an error",
  INTERNAL_ERROR: "An unexpected error occurred",
  DATABASE_ERROR: "Database operation failed",
  REDIS_ERROR: "Redis operation failed",
};

const BASE_URI = "https://irion-api.example.com/errors";

export function problemDetails(
  request: FastifyRequest | { url?: string; id?: string },
  code: ErrorCode,
  detail?: string
): Record<string, unknown> {
  return {
    type: `${BASE_URI}/${code.toLowerCase()}`,
    title: CODE_DETAIL[code],
    status: CODE_STATUS[code],
    detail: detail ?? CODE_DETAIL[code],
    instance: request.url ?? "/",
    requestId: (request as FastifyRequest).id,
  };
}

export function sendError(reply: FastifyReply, code: ErrorCode, detail?: string): void {
  const status = CODE_STATUS[code];
  const body = problemDetails(reply.request, code, detail);
  reply.status(status).send(body);
}

export function throwError(code: ErrorCode, detail?: string): never {
  const err = new Error(detail ?? CODE_DETAIL[code]) as Error & { code: ErrorCode };
  err.code = code;
  throw err;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      kid: string;
      iss: string;
      aud: string;
      iat: number;
      exp: number;
    };
    user: {
      sub: string;
      kid: string;
      iss: string;
      aud: string;
      iat: number;
      exp: number;
    };
  }
}