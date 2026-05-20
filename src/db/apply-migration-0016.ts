import * as dotenv from "dotenv";
dotenv.config({ path: "./.env.local" });
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS dlq_at timestamp;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS next_retry_at timestamp;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS signing_key_version integer NOT NULL DEFAULT 1;
`;

async function run() {
  const client = await pool.connect();
  try {
    await client.query(sql);
    const result = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name IN ('webhook_deliveries', 'webhooks')
      AND column_name IN ('dlq_at', 'next_retry_at', 'last_error', 'signing_key_version')
      ORDER BY table_name, column_name
    `);
    console.log("Migration 0016 applied:");
    console.table(result.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
