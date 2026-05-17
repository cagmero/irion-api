import * as dotenv from "dotenv";
dotenv.config({ path: "./.env.local" });
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error(e); process.exit(1); });