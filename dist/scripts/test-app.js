"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const auth_js_1 = __importDefault(require("../plugins/auth.js"));
const idempotency_js_1 = __importDefault(require("../plugins/idempotency.js"));
const accounts_js_1 = require("../routes/accounts.js");
const auth_js_2 = require("../routes/auth.js");
async function run() {
    const app = (0, fastify_1.default)({ logger: false });
    await app.register(auth_js_1.default);
    await app.register(idempotency_js_1.default);
    await app.register(auth_js_2.authRoutes, { prefix: "/v1/auth" });
    await app.register(accounts_js_1.accountsRoutes, { prefix: "/v1/accounts" });
    await app.ready();
    console.log("authenticate type =", typeof app.authenticate);
    console.log("idempotency type =", typeof app.idempotency);
    await app.close();
}
run().catch((e) => { console.error(e.message); process.exit(1); });
//# sourceMappingURL=test-app.js.map