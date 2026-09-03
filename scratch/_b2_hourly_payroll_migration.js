/**
 * B2 — payroll records remember the hours behind an hourly charge.
 *
 * `shift_days` was enough while everything was billed monthly and pro-rated by
 * days. An hourly placement is billed on hours, and a client checking a line
 * should be able to see the arithmetic: "12 hours × ₹150 = ₹1,800", not a total
 * they have to take on trust.
 *
 * The rate is stored on the payroll row, not read back from the placement, so
 * an invoice issued today still explains itself after the client renegotiates.
 *
 * Additive: existing rows are permanent placements and leave these null.
 *
 * See docs/HOURLY_MULTI_CLIENT_PLAN.md §B2.
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'payroll_records.placement_type',
    sql: `ALTER TABLE payroll_records
          ADD COLUMN IF NOT EXISTS placement_type VARCHAR(20) NOT NULL DEFAULT 'PERMANENT'`,
  },
  {
    label: 'payroll_records.hours_worked',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS hours_worked NUMERIC(6,1)`,
  },
  {
    label: 'payroll_records.hourly_rate  (the rate as it stood that month)',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2)`,
  },
  {
    label: 'payroll_records.hourly_fee',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS hourly_fee NUMERIC(10,2)`,
  },
  {
    label: 'payroll_records.management_fee  (what this client was charged)',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS management_fee NUMERIC(10,2)`,
  },
  {
    // Statutory is computed once on the month's whole earnings and then split
    // across clients by their share. Recording the share makes an invoice
    // checkable on its own, without recomputing the other clients.
    label: 'payroll_records.statutory_share  (this client’s portion of one ESIC/PF figure)',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS statutory_share NUMERIC(6,4)`,
  },
  {
    label: 'payroll_records type CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_type_check
              CHECK (placement_type IN ('PERMANENT','TEMPORARY'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');
    console.log('\nB2 migration applied — payroll rows can now show their working.\n');
  } catch (err) {
    await c.query('ROLLBACK');
    console.error('\nRolled back — nothing was changed.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
