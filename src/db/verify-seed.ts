import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import postgres from "postgres";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set in .env.local");
  const sql = postgres(dbUrl, { max: 1 });

  const rows = await sql`
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

  const colResult = await sql`
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