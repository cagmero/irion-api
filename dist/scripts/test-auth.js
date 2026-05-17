"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const auth_js_1 = __importDefault(require("../plugins/auth.js"));
async function run() {
    const app = (0, fastify_1.default)({ logger: false });
    console.log("before register: has authenticate =", app.hasDecorator("authenticate"));
    await app.register(auth_js_1.default);
    console.log("after register, before ready: has authenticate =", app.hasDecorator("authenticate"));
    await app.ready();
    console.log("after ready: has authenticate =", app.hasDecorator("authenticate"));
    console.log("authenticate type =", typeof app.authenticate);
    await app.close();
}
run().catch((e) => { console.error(e.message); process.exit(1); });
//# sourceMappingURL=test-auth.js.map