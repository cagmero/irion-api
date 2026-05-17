"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const secrets_js_1 = require("../lib/secrets.js");
async function run() {
    const app = (0, fastify_1.default)({ logger: false });
    const jwtSecret = (0, secrets_js_1.getSecret)("JWT_SECRET");
    const masterKey = (0, secrets_js_1.getSecret)("WEBHOOK_SIGNING_SECRET");
    await app.register(jwt_1.default, {
        secret: jwtSecret,
        sign: { iss: "irion-api", aud: "irion-api-v1" },
        verify: { algorithms: ["HS256"], allowedIss: ["irion-api"], allowedAud: ["irion-api-v1"] },
    });
    app.decorate("authenticate", async (request, reply) => {
        console.log("authenticate called!");
        request.institutionId = "test-inst";
    });
    app.post("/test", { preHandler: [app.authenticate] }, async (request, reply) => {
        return { institutionId: request.institutionId };
    });
    await app.ready();
    console.log("authenticate after ready:", typeof app.authenticate);
    await app.close();
}
run().catch((e) => { console.error(e.message); process.exit(1); });
//# sourceMappingURL=test-decorate.js.map