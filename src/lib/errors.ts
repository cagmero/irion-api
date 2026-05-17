import { FastifyRequest, FastifyReply } from "fastify";

export const CODE_STATUS = {
  // Auth errors (401)
  AUTH_FAILED: 401,
  INVALID_TOKEN: 401,
  EXPIRED_TOKEN: 401,
  INVALID_SIGNATURE: 401,
  MISSING_SIGNATURE: 401,
  INVALID_CREDENTIALS: 401,

  // Permission errors (403)
  IP_BLOCKED: 403,
  KYB_NOT_APPROVED: 403,
  INSUFFICIENT_PERMISSIONS: 403,

  // Not found errors (404)
  INSTITUTION_NOT_FOUND: 404,
  WALLET_NOT_FOUND: 404,
  LOAN_NOT_FOUND: 404,
  WEBHOOK_NOT_FOUND: 404,
  FX_QUOTE_NOT_FOUND: 404,
  TRANSFER_NOT_FOUND: 404,
  ACCOUNT_NOT_FOUND: 404,
  DEPOSIT_NOT_FOUND: 404,
  WITHDRAWAL_NOT_FOUND: 404,
  PAYOUT_NOT_FOUND: 404,

  // Conflict errors (409)
  WALLET_ALREADY_EXISTS: 409,
  INSTITUTION_ALREADY_EXISTS: 409,
  API_KEY_ALREADY_EXISTS: 409,

  // Gone errors (410)
  FX_QUOTE_EXPIRED: 410,

  // Validation errors (422)
  VALIDATION_FAILED: 422,
  INVALID_BODY: 422,
  INVALID_PARAMS: 422,
  IDEMPOTENCY_MISMATCH: 422,
  LOAN_NOT_ACTIVE: 422,
  INSUFFICIENT_BALANCE: 422,
  WALLET_SCREENING_FAILED: 422,
  COLLATERAL_INSUFFICIENT: 422,
  LOAN_ALREADY_REPAID: 422,
  INVALID_ASSET_ID: 422,

  // Client errors (400)
  MISSING_IDEMPOTENCY_KEY: 400,
  IDEMPOTENCY_KEY_TOO_LONG: 400,
  IDEMPOTENCY_IN_PROGRESS: 409,
  INVALID_SIGNATURE_FORMAT: 400,

  // Rate limiting (429)
  RATE_LIMITED: 429,

  // Server errors (502)
  TURNKEY_ERROR: 502,
  DIDIT_ERROR: 502,
  ALGORAND_SUBMIT_FAILED: 502,
  TINYMAN_ERROR: 502,
  RANGE_ERROR: 502,
  HAPI_ERROR: 502,
  EXTERNAL_SERVICE_ERROR: 502,

  // Internal errors (500)
  INTERNAL_ERROR: 500,
  DATABASE_ERROR: 500,
  REDIS_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof CODE_STATUS;

const CODE_DETAIL: Record<ErrorCode, string> = {
  // Auth errors (401)
  AUTH_FAILED: "Authentication failed",
  INVALID_TOKEN: "Token is invalid or malformed",
  EXPIRED_TOKEN: "Token has expired",
  INVALID_SIGNATURE: "HMAC signature verification failed",
  MISSING_SIGNATURE: "Irion-Signature header is required",
  INVALID_CREDENTIALS: "Invalid client credentials",

  // Permission errors (403)
  IP_BLOCKED: "IP address is not in the allowed list",
  KYB_NOT_APPROVED: "Institution has not completed KYB approval",
  INSUFFICIENT_PERMISSIONS: "Insufficient permissions for this operation",

  // Not found errors (404)
  INSTITUTION_NOT_FOUND: "Institution not found",
  WALLET_NOT_FOUND: "Wallet not found",
  LOAN_NOT_FOUND: "Loan not found",
  WEBHOOK_NOT_FOUND: "Webhook not found",
  FX_QUOTE_NOT_FOUND: "FX quote not found",
  TRANSFER_NOT_FOUND: "Transfer not found",
  ACCOUNT_NOT_FOUND: "Account not found",
  DEPOSIT_NOT_FOUND: "Deposit not found",
  WITHDRAWAL_NOT_FOUND: "Withdrawal not found",
  PAYOUT_NOT_FOUND: "Payout not found",

  // Conflict errors (409)
  WALLET_ALREADY_EXISTS: "Wallet already exists for this institution",
  INSTITUTION_ALREADY_EXISTS: "Institution already exists",
  API_KEY_ALREADY_EXISTS: "API key already exists",

  // Gone errors (410)
  FX_QUOTE_EXPIRED: "FX quote has expired",

  // Validation errors (422)
  VALIDATION_FAILED: "Request validation failed",
  INVALID_BODY: "Request body is invalid",
  INVALID_PARAMS: "Request parameters are invalid",
  IDEMPOTENCY_MISMATCH: "Idempotency key reused with different request body",
  LOAN_NOT_ACTIVE: "Loan is not in an active state",
  INSUFFICIENT_BALANCE: "Insufficient balance for this operation",
  WALLET_SCREENING_FAILED: "Wallet failed risk screening",
  COLLATERAL_INSUFFICIENT: "Collateral is insufficient for this operation",
  LOAN_ALREADY_REPAID: "Loan has already been repaid",
  INVALID_ASSET_ID: "Invalid asset ID",

  // Client errors (400)
  MISSING_IDEMPOTENCY_KEY: "Idempotency-Key header is required",
  IDEMPOTENCY_KEY_TOO_LONG: "Idempotency-Key exceeds maximum length of 255 characters",
  IDEMPOTENCY_IN_PROGRESS: "Another request with this idempotency key is still in progress",
  INVALID_SIGNATURE_FORMAT: "Irion-Signature header has invalid format (expected hex)",

  // Rate limiting (429)
  RATE_LIMITED: "Rate limit exceeded",

  // Server errors (502)
  TURNKEY_ERROR: "Turnkey service returned an error",
  DIDIT_ERROR: "Didit service returned an error",
  ALGORAND_SUBMIT_FAILED: "Failed to submit transaction to Algorand",
  TINYMAN_ERROR: "Tinyman service returned an error",
  RANGE_ERROR: "Range service returned an error",
  HAPI_ERROR: "HAPI service returned an error",
  EXTERNAL_SERVICE_ERROR: "External service returned an error",

  // Internal errors (500)
  INTERNAL_ERROR: "An unexpected error occurred",
  DATABASE_ERROR: "Database operation failed",
  REDIS_ERROR: "Redis operation failed",
};

export class ApiError extends Error {
  code: ErrorCode;
  detail: string;
  extras?: Record<string, unknown>;

  constructor(code: ErrorCode, detail: string, extras?: Record<string, unknown>) {
    super(detail);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
    this.extras = extras;
    Error.captureStackTrace(this, ApiError);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError && "code" in error;
}

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