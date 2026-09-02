/**
 * F-19 migration — additive only, safe to re-run.
 *
 * `payroll_details` records the aggregate loan/advance deduction but not which
 * loan it came from, so recovery could not be deferred to lock time without
 * losing the split for an employee with more than one loan. This adds the
 * breakdown the lock step replays, plus a flag so a batch can never be
 * recovered against twice.
 *
 * See F-19 in docs/FINANCE_MODULE_AUDIT.md.
 *
 *   node scratch/_f19_recovery_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    table: 'payroll_details',
    label: 'payroll_details.recovery_breakdown',
    sql: `ALTER TABLE payroll_details
          ADD COLUMN IF NOT EXISTS recovery_breakdown JSONB NOT NULL DEFAULT '{"loans":[],"advances":[]}'::jsonb`,
  },
  {
    table: 'payroll_processing_batches',
    label: 'payroll_processing_batches.recoveries_applied_at',
    sql: `ALTER TABLE payroll_processing_batches
          ADD COLUMN IF NOT EXISTS recoveries_applied_at TIMESTAMPTZ`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  // Managed Postgres (Render, Neon, RDS) refuses plaintext external connections.
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      // The enterprise batch-payroll tables are absent on some environments.
      // These columns are declared in schema.prisma, so they arrive with the
      // table whenever that module is deployed — skipping loses nothing.
      if (step.table) {
        const { rows } = await c.query('SELECT to_regclass($1) AS t', [step.table]);
        if (!rows[0].t) {
          console.log(`  skip  ${step.label} — table ${step.table} not in this database`);
          continue;
        }
      }
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');
    console.log('\nF19 migration applied.');
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
