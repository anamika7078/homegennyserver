/**
 * Add payroll_records.other_charges.
 *
 * The cost sheet's CTC is
 *
 *   gross + employer PF + employer ESIC + (relieving + LWF + uniform) + fee
 *
 * and the invoice was built from the first two and the last — the bracket had
 * nowhere to live, so every invoice raised from a wage-form placement came out
 * about 21% under the agreed CTC. This is where that bracket goes: what the
 * client owes for the period beyond wages, statutory contributions and the
 * management fee.
 *
 * Additive and idempotent: a new column with a default, nothing dropped or
 * rewritten. Existing rows get 0, which is right — they were raised before
 * these charges were billed at all.
 *
 *   node scratch/_other_charges_migration.js            # say what it would do
 *   node scratch/_other_charges_migration.js --apply
 */
require('dotenv').config();
const { Client } = require('pg');

const MANAGED_HOST = /render\.com|amazonaws|azure|googleapis|neon\.tech|supabase|planetscale/i;
const APPLY = process.argv.includes('--apply');

async function main() {
  const url = process.env.DATABASE_URL || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!host) throw new Error('DATABASE_URL is not a URL');
  if (MANAGED_HOST.test(host)) throw new Error(`refusing to migrate a managed host (${host})`);

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const existing = await db.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'payroll_records' AND column_name = 'other_charges'`);

    if (existing.rowCount) {
      console.log(`\npayroll_records.other_charges already exists (${existing.rows[0].data_type}) — nothing to do.\n`);
      return;
    }

    const rows = (await db.query('SELECT count(*)::int AS n FROM payroll_records')).rows[0].n;
    console.log(`\ndatabase ${host}`);
    console.log(`  ALTER TABLE payroll_records ADD COLUMN other_charges numeric(12,2) NOT NULL DEFAULT 0`);
    console.log(`  ${rows} existing payroll row(s) would get 0`);

    if (!APPLY) {
      console.log('\ndry run — nothing changed. Re-run with --apply.\n');
      return;
    }

    await db.query('BEGIN');
    try {
      await db.query(
        `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS other_charges numeric(12,2) NOT NULL DEFAULT 0`);
      await db.query(
        `COMMENT ON COLUMN payroll_records.other_charges IS
         'Agreed charges beyond wages, employer PF/ESIC and the management fee - relieving, LWF and uniform from the placement wage breakup. Part of what the client owes; not paid to the staff member.'`);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    console.log('\ncolumn added.\n');
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
});
