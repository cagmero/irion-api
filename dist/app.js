"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const sentry_js_1 = require("./plugins/sentry.js");
const rate_limit_js_1 = require("./plugins/rate-limit.js");
const auth_js_1 = __importDefault(require("./plugins/auth.js"));
const idempotency_js_1 = __importDefault(require("./plugins/idempotency.js"));
const index_js_1 = require("./routes/index.js");
async function buildApp() {
    const app = (0, fastify_1.default)({
        logger: true,
    });
    (0, sentry_js_1.setupSentry)(app);
    await app.register(cors_1.default, {
        origin: process.env.CORS_ORIGINS?.split(",") || "*",
    });
    await app.register(helmet_1.default);
    (0, rate_limit_js_1.setupRateLimiter)(app);
    await app.register(swagger_1.default, {
        openapi: {
            info: {
                title: "Irion B2B API",
                description: "API for Irion Network's B2B Neobank platform",
                version: "1.0.0",
            },
            components: {
                securitySchemes: {
                    bearerAuth: {
                        type: "http",
                        scheme: "bearer",
                    },
                },
            },
            security: [{ bearerAuth: [] }],
        },
    });
    await app.register(swagger_ui_1.default, {
        routePrefix: "/docs",
    });
    await app.register(auth_js_1.default);
    await app.register(idempotency_js_1.default);
    app.get("/health", { config: { rateLimitTier: "public" } }, async () => {
        return { status: "ok", time: new Date().toISOString() };
    });
    await (0, index_js_1.registerRoutes)(app);
    return app;
}
//# sourceMappingURL=app.js.map