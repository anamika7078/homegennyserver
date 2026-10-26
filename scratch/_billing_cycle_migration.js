/**
 * Per-client billing cycle — additive, safe to re-run.
 *
 * Each client is invoiced on their own cycle. A DRAFT invoice is raised the
 * morning after each period closes; Finance approves and sends it as before.
 *
 *   MONTHLY      1st–last day                     (default — what every client had)
 *   FORTNIGHTLY  1st–15th, 16th–last day
 *   WEEKLY       1–7, 8–14, 15–21, 22–last day   (never crosses into next month)
 *   MANUAL       nothing automatic; Finance raises invoices by hand
 *
 *   node scratch/_billing_cycle_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'finance_customers.billing_cycle',
    sql: `ALTER TABLE finance_customers ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY'`,
  },
  {
    label: 'billing_cycle CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE finance_customers ADD CONSTRAINT finance_customers_billing_cycle_chk
              CHECK (billing_cycle IN ('MONTHLY','FORTNIGHTLY','WEEKLY','MANUAL'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  // SSL only for hosted databases that require it (Render). The dev server runs
  // postgres in a sibling container without SSL, so "not localhost" is not enough.
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const db = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await db.connect();
  console.log(`Migrating ${new URL(url).hostname}/${new URL(url).pathname.slice(1)}`);
  for (const step of STEPS) {
    await db.query(step.sql);
    console.log(`  ok  ${step.label}`);
  }
  const r = await db.query(`SELECT billing_cycle, COUNT(*)::int n FROM finance_customers GROUP BY 1`);
  console.log('\n', r.rows);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
