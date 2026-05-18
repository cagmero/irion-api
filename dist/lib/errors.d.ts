import { FastifyRequest, FastifyReply } from "fastify";
export declare const CODE_STATUS: {
    readonly AUTH_FAILED: 401;
    readonly INVALID_TOKEN: 401;
    readonly EXPIRED_TOKEN: 401;
    readonly INVALID_SIGNATURE: 401;
    readonly MISSING_SIGNATURE: 401;
    readonly INVALID_CREDENTIALS: 401;
    readonly IP_BLOCKED: 403;
    readonly KYB_NOT_APPROVED: 403;
    readonly INSUFFICIENT_PERMISSIONS: 403;
    readonly INSTITUTION_NOT_FOUND: 404;
    readonly WALLET_NOT_FOUND: 404;
    readonly LOAN_NOT_FOUND: 404;
    readonly WEBHOOK_NOT_FOUND: 404;
    readonly FX_QUOTE_NOT_FOUND: 404;
    readonly TRANSFER_NOT_FOUND: 404;
    readonly ACCOUNT_NOT_FOUND: 404;
    readonly DEPOSIT_NOT_FOUND: 404;
    readonly WITHDRAWAL_NOT_FOUND: 404;
    readonly PAYOUT_NOT_FOUND: 404;
    readonly WALLET_ALREADY_EXISTS: 409;
    readonly INSTITUTION_ALREADY_EXISTS: 409;
    readonly API_KEY_ALREADY_EXISTS: 409;
    readonly FX_QUOTE_EXPIRED: 410;
    readonly VALIDATION_FAILED: 422;
    readonly INVALID_BODY: 422;
    readonly INVALID_PARAMS: 422;
    readonly IDEMPOTENCY_MISMATCH: 422;
    readonly LOAN_NOT_ACTIVE: 422;
    readonly INSUFFICIENT_BALANCE: 422;
    readonly WALLET_SCREENING_FAILED: 422;
    readonly COLLATERAL_INSUFFICIENT: 422;
    readonly LOAN_ALREADY_REPAID: 422;
    readonly INVALID_ASSET_ID: 422;
    readonly MISSING_IDEMPOTENCY_KEY: 400;
    readonly IDEMPOTENCY_KEY_TOO_LONG: 400;
    readonly IDEMPOTENCY_IN_PROGRESS: 409;
    readonly INVALID_SIGNATURE_FORMAT: 400;
    readonly RATE_LIMITED: 429;
    readonly TURNKEY_ERROR: 502;
    readonly DIDIT_ERROR: 502;
    readonly ALGORAND_SUBMIT_FAILED: 502;
    readonly TINYMAN_ERROR: 502;
    readonly RANGE_ERROR: 502;
    readonly HAPI_ERROR: 502;
    readonly EXTERNAL_SERVICE_ERROR: 502;
    readonly INTERNAL_ERROR: 500;
    readonly DATABASE_ERROR: 500;
    readonly REDIS_ERROR: 500;
};
export type ErrorCode = keyof typeof CODE_STATUS;
export declare class ApiError extends Error {
    code: ErrorCode;
    detail: string;
    extras?: Record<string, unknown>;
    constructor(code: ErrorCode, detail: string, extras?: Record<string, unknown>);
}
export declare function isApiError(error: unknown): error is ApiError;
export declare function problemDetails(request: FastifyRequest | {
    url?: string;
    id?: string;
}, code: ErrorCode, detail?: string): Record<string, unknown>;
export declare function sendError(reply: FastifyReply, code: ErrorCode, detail?: string): void;
export declare function throwError(code: ErrorCode, detail?: string): never;
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
//# sourceMappingURL=errors.d.ts.map