"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = require("./app");
async function start() {
    const app = await (0, app_1.buildApp)();
    try {
        const port = parseInt(process.env.PORT || "4000", 10);
        const host = process.env.HOST || "0.0.0.0";
        await app.listen({ port, host });
        console.log(`🚀 Server listening on http://${host}:${port}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
start();
//# sourceMappingURL=index.js.map