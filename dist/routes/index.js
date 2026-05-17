"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const accounts_1 = require("./accounts");
const auth_1 = require("./auth");
const loans_1 = require("./loans");
const transfers_1 = require("./transfers");
const webhooks_1 = require("./webhooks");
const fx_1 = require("./fx");
async function registerRoutes(app) {
    await app.register(auth_1.authRoutes, { prefix: "/v1/auth" });
    await app.register(accounts_1.accountsRoutes, { prefix: "/v1/accounts" });
    await app.register(loans_1.loansRoutes, { prefix: "/v1/loans" });
    await app.register(transfers_1.transfersRoutes, { prefix: "/v1" }); // Handles /transfers, /deposits, /withdrawals, /payouts
    await app.register(fx_1.fxRoutes, { prefix: "/v1/fx" });
    await app.register(webhooks_1.webhooksRoutes, { prefix: "/v1/webhooks" });
}
//# sourceMappingURL=index.js.map