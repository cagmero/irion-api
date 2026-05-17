"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const idempotency_js_1 = __importDefault(require("../plugins/idempotency.js"));
async function run() {
    const app = (0, fastify_1.default)({ logger: false });
    app.decorate("institutionId", "test-inst-123");
    app.decorate("authenticate", async (request, reply) => {
        request.institutionId = "test";
    });
    console.log("before register: has idempotency =", app.hasDecorator("idempotency"));
    try {
        await app.register(idempotency_js_1.default);
        console.log("after register: has idempotency =", app.hasDecorator("idempotency"));
        console.log("idempotency type =", typeof app.idempotency);
    }
    catch (e) {
        console.error("Error:", e.message);
    }
    await app.close();
}
run().catch((e) => { console.error(e.message); process.exit(1); });
//# sourceMappingURL=test-idempotency.js.map