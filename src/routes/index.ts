import { FastifyInstance } from "fastify";
import { accountsRoutes } from "./accounts";
import { authRoutes } from "./auth";
import { loansRoutes } from "./loans";
import { transfersRoutes } from "./transfers";
import { withdrawalsRoutes } from "./withdrawals";
import { webhooksRoutes } from "./webhooks";
import { payoutsRoutes } from "./payouts";
import { fxRoutes } from "./fx";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(accountsRoutes, { prefix: "/v1/accounts" });
  await app.register(loansRoutes, { prefix: "/v1/loans" });
  await app.register(transfersRoutes, { prefix: "/v1" }); // Handles /transfers, /deposits, /payouts
  await app.register(payoutsRoutes, { prefix: "/v1" });   // Handles /payouts
  await app.register(withdrawalsRoutes, { prefix: "/v1" }); // Handles /withdrawals
  await app.register(fxRoutes, { prefix: "/v1/fx" });
  await app.register(webhooksRoutes, { prefix: "/v1/webhooks" });
}
