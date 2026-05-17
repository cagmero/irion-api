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
dotenv.config({ path: "./.env.local" });
const pg_1 = __importDefault(require("pg"));
const pool = new pg_1.default.Pool({ connectionString: process.env.DATABASE_URL });
const sql = `
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_ips text[] DEFAULT NULL;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS hmac_secret bytea DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_allowed_ips ON api_keys USING GIN(allowed_ips) WHERE allowed_ips IS NOT NULL;
`;
async function run() {
    const client = await pool.connect();
    try {
        await client.query(sql);
        const result = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'api_keys'
      AND column_name IN ('allowed_ips', 'hmac_secret')
    `);
        console.log('Columns verified:');
        console.table(result.rows);
        const indexResult = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'api_keys' AND indexname = 'idx_api_keys_allowed_ips'
    `);
        console.log('GIN index:');
        console.table(indexResult.rows);
    }
    finally {
        client.release();
        await pool.end();
    }
}
run().catch(e => { console.error(e); process.exit(1); });
//# sourceMappingURL=apply-migration.js.map