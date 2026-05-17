import { FastifyInstance } from "fastify";
import { accountsRoutes } from "./accounts";
import { authRoutes } from "./auth";
import { loansRoutes } from "./loans";
import { transfersRoutes } from "./transfers";
import { webhooksRoutes } from "./webhooks";
import { fxRoutes } from "./fx";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(accountsRoutes, { prefix: "/v1/accounts" });
  await app.register(loansRoutes, { prefix: "/v1/loans" });
  await app.register(transfersRoutes, { prefix: "/v1" }); // Handles /transfers, /deposits, /withdrawals, /payouts
  await app.register(fxRoutes, { prefix: "/v1/fx" });
  await app.register(webhooksRoutes, { prefix: "/v1/webhooks" });
}
