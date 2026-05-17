"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_js_1 = require("../app.js");
async function run() {
    const app = await (0, app_js_1.buildApp)();
    console.log("authenticate:", typeof app.authenticate);
    console.log("idempotency:", typeof app.idempotency);
    await app.close();
}
run().catch((e) => { console.error(e); process.exit(1); });
//# sourceMappingURL=test-decorators.js.map