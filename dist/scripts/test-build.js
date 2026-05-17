"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_js_1 = require("../app.js");
async function run() {
    try {
        const app = await (0, app_js_1.buildApp)();
        console.log("authenticate type =", typeof app.authenticate);
        console.log("idempotency type =", typeof app.idempotency);
        await app.close();
    }
    catch (e) {
        console.error("Error building app:", e.message);
        console.error("Stack:", e.stack?.split("\n").slice(0, 5).join("\n"));
    }
}
run().catch((e) => { console.error(e.message); process.exit(1); });
//# sourceMappingURL=test-build.js.map