import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as Sentry from "@sentry/node";
import { problemDetails, isApiError, ApiError, type ErrorCode, CODE_STATUS } from "../lib/errors.js";

const REDACTED = "[REDACTED]";

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return REDACTED;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = k.toLowerCase();
      if (
        keyLower.includes("secret") ||
        keyLower.includes("password") ||
        keyLower.includes("token") ||
        keyLower.includes("mnemonic") ||
        keyLower.includes("private_key") ||
        keyLower.includes("private-key") ||
        keyLower === "authorization" ||
        keyLower === "x-api-key" ||
        keyLower === "irion-signature" ||
        keyLower === "cookie"
      ) {
        redacted[k] = REDACTED;
      } else {
        redacted[k] = redactValue(v);
      }
    }
    return redacted;
  }
  return value;
}

function redactEvent(event: Sentry.Event): Sentry.Event {
  if (event.request?.headers) {
    const headers = event.request.headers as Record<string, string>;
    delete headers["authorization"];
    delete headers["x-api-key"];
    delete headers["irion-signature"];
    delete headers["cookie"];
  }

  if (event.request?.data && typeof event.request.data === "object") {
    event.request.data = redactValue(event.request.data) as Record<string, unknown>;
  }

  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.data && typeof crumb.data === "object") {
        crumb.data = redactValue(crumb.data) as Record<string, unknown>;
      }
    }
  }

  return event;
}

function beforeSendHook(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  return redactEvent(event) as Sentry.ErrorEvent;
}

export function setupSentry(app: FastifyInstance) {
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

  app.addHook("onRequest", async (request: FastifyRequest) => {
    Sentry.getCurrentScope().setTag("request_id", request.id);
    Sentry.getCurrentScope().setUser({
      id: request.id,
      ip: request.ip,
    });
    Sentry.getCurrentScope().setContext("request", {
      method: request.method,
      url: request.url,
      headers: {
        "user-agent": request.headers["user-agent"] as string ?? "unknown",
        "x-forwarded-for": request.headers["x-forwarded-for"] as string ?? "unknown",
      },
    });
  });

  app.setErrorHandler(async (error, request: FastifyRequest, reply: FastifyReply) => {
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
        ...problemDetails(request, "VALIDATION_FAILED", error.message),
        errors: validationErrors,
      };
      (reply as any).header("Content-Type", "application/problem+json");
      request.log.warn({ err: error, requestId, validationErrors }, "validation error");
      return reply.status(422).send(body);
    }

    // ApiError (our custom error class)
    if (isApiError(error)) {
      const status = CODE_STATUS[error.code];
      const body = problemDetails(request, error.code, error.detail);
      if (error.extras) {
        Object.assign(body, error.extras);
      }
      (reply as any).header("Content-Type", "application/problem+json");
      request.log.error({ err: error, requestId, code: error.code }, "api error");
      return reply.status(status).send(body);
    }

    // Error with code property (legacy format)
    const errorCode = (error as Error & { code?: ErrorCode }).code;
    if (errorCode && errorCode in CODE_STATUS) {
      const status = CODE_STATUS[errorCode as ErrorCode];
      const body = problemDetails(request, errorCode as ErrorCode, error.message);
      (reply as any).header("Content-Type", "application/problem+json");
      request.log.error({ err: error, requestId, errorCode }, "business error");
      return reply.status(status).send(body);
    }

    // Database errors - map PG error codes
    const pgCode = (error as Error & { code?: string }).code;
    if (pgCode === "23505") {
      const body = problemDetails(request, "INSTITUTION_ALREADY_EXISTS", "Resource already exists");
      (reply as any).header("Content-Type", "application/problem+json");
      request.log.error({ err: error, requestId, pgCode }, "database unique violation");
      return reply.status(409).send(body);
    }
    if (pgCode === "23503") {
      const body = problemDetails(request, "INSTITUTION_NOT_FOUND", "Referenced resource not found");
      (reply as any).header("Content-Type", "application/problem+json");
      request.log.error({ err: error, requestId, pgCode }, "database foreign key violation");
      return reply.status(404).send(body);
    }

    // Client errors (4xx status codes)
    if (error.statusCode && error.statusCode < 500) {
      const body = problemDetails(request, "AUTH_FAILED", error.message);
      (reply as any).header("Content-Type", "application/problem+json");
      return reply.status(error.statusCode).send(body);
    }

    // Everything else - INTERNAL_ERROR
    Sentry.captureException(error, { extra: { requestId } });
    request.log.error({ err: error, requestId }, "unhandled error");
    const body = problemDetails(request, "INTERNAL_ERROR", "An unexpected error occurred");
    (reply as any).header("Content-Type", "application/problem+json");
    return reply.status(500).send(body);
  });

  app.addHook("onClose", async () => {
    await Sentry.close(2000);
  });
}