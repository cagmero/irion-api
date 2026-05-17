import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as Sentry from "@sentry/node";
import { problemDetails, type ErrorCode, CODE_STATUS } from "../lib/errors.js";

export function setupSentry(app: FastifyInstance) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        const headers = event.request.headers as Record<string, string>;
        delete headers["authorization"];
        delete headers["cookie"];
        delete headers["x-api-key"];
        delete headers["irion-signature"];
      }
      return event;
    },
  });

  app.addHook("onRequest", (request) => {
    Sentry.getCurrentScope().setUser({
      id: request.id,
      ip: request.ip,
    });
    Sentry.getCurrentScope().setContext("request", {
      method: request.method,
      url: request.url,
      headers: {
        "user-agent": request.headers["user-agent"],
        "x-forwarded-for": request.headers["x-forwarded-for"],
      },
    });
  });

  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error.validation || error.validationContext) {
      const body = problemDetails(request, "VALIDATION_FAILED", error.message);
      request.log.warn({ err: error, requestId }, "validation error");
      return reply.status(422).send(body);
    }

    const errorCode = (error as Error & { code?: ErrorCode }).code;
    if (errorCode && errorCode in CODE_STATUS) {
      const status = CODE_STATUS[errorCode as ErrorCode];
      const body = problemDetails(request, errorCode as ErrorCode, error.message);
      request.log.error({ err: error, requestId, errorCode }, "business error");
      Sentry.captureException(error, { extra: { errorCode, requestId } });
      return reply.status(status).send(body);
    }

    if (error.statusCode && error.statusCode < 500) {
      const body = problemDetails(request, "AUTH_FAILED", error.message);
      return reply.status(error.statusCode).send(body);
    }

    Sentry.captureException(error, { extra: { requestId } });
    request.log.error({ err: error, requestId }, "unhandled error");
    const body = problemDetails(request, "INTERNAL_ERROR", "An unexpected error occurred");
    return reply.status(500).send(body);
  });

  app.addHook("onClose", () => {
    Sentry.close(2000);
  });
}