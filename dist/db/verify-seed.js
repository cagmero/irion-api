"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: ".env.local" });
const postgres_1 = __importDefault(require("postgres"));
async function main() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl)
        throw new Error("DATABASE_URL not set in .env.local");
    const sql = (0, postgres_1.default)(dbUrl, { max: 1 });
    const rows = await sql `
    SELECT
      (SELECT COUNT(*) FROM institutions)                          AS institutions,
      (SELECT COUNT(*) FROM api_keys)                              AS api_keys,
      (SELECT COUNT(*) FROM wallets)                              AS wallets,
      (SELECT COUNT(*) FROM webhooks)                             AS webhooks,
      (SELECT COUNT(*) FROM lending_positions)                    AS lending_positions,
      (SELECT COUNT(*) FROM borrowing_positions)                 AS borrowing_positions,
      (SELECT COUNT(*) FROM loans)                                AS loans,
      (SELECT COUNT(*) FROM loan_draws)                           AS loan_draws,
      (SELECT COUNT(*) FROM loan_repayments)                      AS loan_repayments,
      (SELECT COUNT(*) FROM credit_profiles)                      AS credit_profiles
  `;
    const colResult = await sql `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'api_keys'
    AND column_name IN ('allowed_ips', 'hmac_secret')
  `;
    console.log('Row counts:');
    for (const [k, v] of Object.entries(rows[0])) {
        console.log(`  ${k}: ${v}`);
    }
    console.log('New api_keys columns:', colResult.map(r => r.column_name).join(', '));
    await sql.end();
}
main().catch(e => { console.error(e); process.exit(1); });
//# sourceMappingURL=verify-seed.js.map