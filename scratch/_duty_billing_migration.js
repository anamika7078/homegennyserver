/**
 * Per-duty billing (24×7 live-in) — additive only, safe to re-run.
 *
 * A live-in placement is priced per duty: the staff member earns a fixed rate
 * per 24-hour duty and the client is billed a fixed rate per duty. The monthly
 * model divided a monthly salary by the days in the month, so the same duty
 * paid differently in February and October; the hourly model would have to
 * price a 24-hour duty as 24 slices of a rounded hourly rate.
 *
 * Also adds the per-placement ESIC/PF switches: statutory used to be applied
 * to every placement, which is not how every engagement is contracted.
 *
 *   placements      rate_basis, duty_rate, duty_billing_rate,
 *                   esic_applicable, pf_applicable, covers_placement_id
 *   payroll_records rate_basis, duties, duty_rate, duty_billing_rate
 *
 * Nothing existing changes meaning: rate_basis NULL means "as before" (monthly
 * for PERMANENT, hourly for TEMPORARY) and both switches default to on.
 *
 *   node scratch/_duty_billing_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  { label: 'placements.rate_basis', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_basis VARCHAR(20)` },
  {
    label: 'placements.rate_basis CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE placements ADD CONSTRAINT placements_rate_basis_chk
              CHECK (rate_basis IS NULL OR rate_basis IN ('MONTHLY','HOURLY','PER_DUTY'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  { label: 'placements.duty_rate', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS duty_rate NUMERIC(10,2)` },
  { label: 'placements.duty_billing_rate', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS duty_billing_rate NUMERIC(10,2)` },
  { label: 'placements.esic_applicable', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS esic_applicable BOOLEAN NOT NULL DEFAULT true` },
  { label: 'placements.pf_applicable', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS pf_applicable BOOLEAN NOT NULL DEFAULT true` },
  {
    /* A relief/substitute placement names the post it is covering. */
    label: 'placements.covers_placement_id',
    sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS covers_placement_id UUID`,
  },
  {
    /* "A temporary placement needs an hourly rate" was true while temporary
       meant hourly. A relief placement priced per duty has a duty rate
       instead, and the old rule refused to store it. Recreated, not dropped:
       an unpriced temporary placement is still refused. */
    label: 'placements_temporary_needs_rate allows PER_DUTY',
    sql: `DO $$ BEGIN
            ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_temporary_needs_rate;
            ALTER TABLE placements ADD CONSTRAINT placements_temporary_needs_rate
              CHECK (placement_type = 'PERMANENT'
                     OR hourly_rate IS NOT NULL
                     OR (rate_basis = 'PER_DUTY' AND duty_rate IS NOT NULL));
          END $$`,
  },
  { label: 'payroll_records.rate_basis', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS rate_basis VARCHAR(20)` },
  { label: 'payroll_records.duties', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS duties NUMERIC(6,1)` },
  { label: 'payroll_records.duty_rate', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS duty_rate NUMERIC(10,2)` },
  { label: 'payroll_records.duty_billing_rate', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS duty_billing_rate NUMERIC(10,2)` },
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
  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'placements' AND column_name IN
               ('rate_basis','duty_rate','duty_billing_rate','esic_applicable','pf_applicable','covers_placement_id'))
         OR (table_name = 'payroll_records' AND column_name IN ('rate_basis','duties','duty_rate','duty_billing_rate'))
      ORDER BY 1, 2`,
  );
  console.log(`\n${cols.rows.length}/10 columns present`);
  await db.end();
  process.exit(cols.rows.length === 10 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
