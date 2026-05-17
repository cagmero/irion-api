"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSentry = setupSentry;
const Sentry = __importStar(require("@sentry/node"));
const errors_js_1 = require("../lib/errors.js");
const REDACTED = "[REDACTED]";
function redactValue(value) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string")
        return REDACTED;
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value))
        return value.map(redactValue);
    if (typeof value === "object") {
        const redacted = {};
        for (const [k, v] of Object.entries(value)) {
            const keyLower = k.toLowerCase();
            if (keyLower.includes("secret") ||
                keyLower.includes("password") ||
                keyLower.includes("token") ||
                keyLower.includes("mnemonic") ||
                keyLower.includes("private_key") ||
                keyLower.includes("private-key") ||
                keyLower === "authorization" ||
                keyLower === "x-api-key" ||
                keyLower === "irion-signature" ||
                keyLower === "cookie") {
                redacted[k] = REDACTED;
            }
            else {
                redacted[k] = redactValue(v);
            }
        }
        return redacted;
    }
    return value;
}
function redactEvent(event) {
    if (event.request?.headers) {
        const headers = event.request.headers;
        delete headers["authorization"];
        delete headers["x-api-key"];
        delete headers["irion-signature"];
        delete headers["cookie"];
    }
    if (event.request?.data && typeof event.request.data === "object") {
        event.request.data = redactValue(event.request.data);
    }
    if (event.breadcrumbs) {
        for (const crumb of event.breadcrumbs) {
            if (crumb.data && typeof crumb.data === "object") {
                crumb.data = redactValue(crumb.data);
            }
        }
    }
    return event;
}
function beforeSendHook(event) {
    return redactEvent(event);
}
function setupSentry(app) {
    const tracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE
        ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
        : process.env.NODE_ENV === "production" ? 0.1 : 1.0;
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
        tracesSampleRate,
        sendDefaultPii: false,
        beforeSend: beforeSendHook,
    });
    app.addHook("onRequest", async (request) => {
        Sentry.getCurrentScope().setTag("request_id", request.id);
        Sentry.getCurrentScope().setUser({
            id: request.id,
            ip: request.ip,
        });
        Sentry.getCurrentScope().setContext("request", {
            method: request.method,
            url: request.url,
            headers: {
                "user-agent": request.headers["user-agent"] ?? "unknown",
                "x-forwarded-for": request.headers["x-forwarded-for"] ?? "unknown",
            },
        });
    });
    app.setErrorHandler(async (error, request, reply) => {
        const requestId = request.id;
        // Fastify validation errors (from JSON Schema)
        if (error.validation || error.validationContext) {
            const validationErrors = Array.isArray(error.validation)
                ? error.validation.map((v) => ({
                    field: v.instancePath.replace(/^\//, "").replace(/\//g, ".") || "body",
                    message: v.message || "invalid",
                }))
                : [];
            const body = {
                ...(0, errors_js_1.problemDetails)(request, "VALIDATION_FAILED", error.message),
                errors: validationErrors,
            };
            reply.header("Content-Type", "application/problem+json");
            request.log.warn({ err: error, requestId, validationErrors }, "validation error");
            return reply.status(422).send(body);
        }
        // ApiError (our custom error class)
        if ((0, errors_js_1.isApiError)(error)) {
            const status = errors_js_1.CODE_STATUS[error.code];
            const body = (0, errors_js_1.problemDetails)(request, error.code, error.detail);
            if (error.extras) {
                Object.assign(body, error.extras);
            }
            reply.header("Content-Type", "application/problem+json");
            request.log.error({ err: error, requestId, code: error.code }, "api error");
            return reply.status(status).send(body);
        }
        // Error with code property (legacy format)
        const errorCode = error.code;
        if (errorCode && errorCode in errors_js_1.CODE_STATUS) {
            const status = errors_js_1.CODE_STATUS[errorCode];
            const body = (0, errors_js_1.problemDetails)(request, errorCode, error.message);
            reply.header("Content-Type", "application/problem+json");
            request.log.error({ err: error, requestId, errorCode }, "business error");
            return reply.status(status).send(body);
        }
        // Database errors - map PG error codes
        const pgCode = error.code;
        if (pgCode === "23505") {
            const body = (0, errors_js_1.problemDetails)(request, "INSTITUTION_ALREADY_EXISTS", "Resource already exists");
            reply.header("Content-Type", "application/problem+json");
            request.log.error({ err: error, requestId, pgCode }, "database unique violation");
            return reply.status(409).send(body);
        }
        if (pgCode === "23503") {
            const body = (0, errors_js_1.problemDetails)(request, "INSTITUTION_NOT_FOUND", "Referenced resource not found");
            reply.header("Content-Type", "application/problem+json");
            request.log.error({ err: error, requestId, pgCode }, "database foreign key violation");
            return reply.status(404).send(body);
        }
        // Client errors (4xx status codes)
        if (error.statusCode && error.statusCode < 500) {
            const body = (0, errors_js_1.problemDetails)(request, "AUTH_FAILED", error.message);
            reply.header("Content-Type", "application/problem+json");
            return reply.status(error.statusCode).send(body);
        }
        // Everything else - INTERNAL_ERROR
        Sentry.captureException(error, { extra: { requestId } });
        request.log.error({ err: error, requestId }, "unhandled error");
        const body = (0, errors_js_1.problemDetails)(request, "INTERNAL_ERROR", "An unexpected error occurred");
        reply.header("Content-Type", "application/problem+json");
        return reply.status(500).send(body);
    });
    app.addHook("onClose", async () => {
        await Sentry.close(2000);
    });
}
//# sourceMappingURL=sentry.js.map