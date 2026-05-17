"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const sentry_js_1 = require("../plugins/sentry.js");
const rate_limit_js_1 = require("../plugins/rate-limit.js");
const auth_js_1 = __importDefault(require("../plugins/auth.js"));
const idempotency_js_1 = __importDefault(require("../plugins/idempotency.js"));
async function testApp() {
    const app = (0, fastify_1.default)({ logger: false });
    try {
        console.log("1. setupSentry...");
        (0, sentry_js_1.setupSentry)(app);
        console.log("   OK");
        console.log("2. cors...");
        await app.register(cors_1.default, { origin: "*" });
        console.log("   OK");
        console.log("3. helmet...");
        await app.register(helmet_1.default);
        console.log("   OK");
        console.log("4. setupRateLimiter...");
        await (0, rate_limit_js_1.setupRateLimiter)(app);
        console.log("   OK");
        console.log("5. swagger...");
        await app.register(swagger_1.default, { openapi: { info: { title: "test", version: "1.0.0" } } });
        console.log("   OK");
        console.log("6. swagger-ui...");
        await app.register(swagger_ui_1.default, { routePrefix: "/docs" });
        console.log("   OK");
        console.log("7. authPlugin...");
        await app.register(auth_js_1.default);
        console.log("   OK");
        console.log("8. idempotencyPlugin...");
        await app.register(idempotency_js_1.default);
        console.log("   OK");
        console.log("All plugins loaded!");
        await app.close();
    }
    catch (e) {
        console.error("FAILED:", e.message);
    }
}
testApp();
//# sourceMappingURL=test-plugins-stepwise.js.map