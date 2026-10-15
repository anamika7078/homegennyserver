/**
 * Add payroll_records.nfh_days and payroll_records.nfh_charges.
 *
 * National and festival holidays are billed at actuals — nobody knows in
 * advance who will work one — so Finance enters the count when it runs
 * payroll, and the charge is worked out from the placement's own wage terms:
 * two days' wage for the holiday, employer ESIC on that, and the service
 * charge on the two together. See nfhClaimPerDay in wage-calculator.util.ts.
 *
 * Both are recorded on the payroll row for the same reason other_charges is:
 * what was billed has to stay fixed even if the wage terms change later.
 *
 * Additive and idempotent. Existing rows get 0, which is right — no holiday
 * was ever billed before this.
 *
 *   node scratch/_nfh_charges_migration.js            # say what it would do
 *   node scratch/_nfh_charges_migration.js --apply
 */
require('dotenv').config();
const { Client } = require('pg');

const MANAGED_HOST = /render\.com|amazonaws|azure|googleapis|neon\.tech|supabase|planetscale/i;
const APPLY = process.argv.includes('--apply');

const COLUMNS = [
  ['nfh_days', 'integer NOT NULL DEFAULT 0',
   'National and festival holidays worked in the period, entered by Finance when payroll is run.'],
  ['nfh_charges', 'numeric(12,2) NOT NULL DEFAULT 0',
   'What those holidays are billed at: two days wage each, employer ESIC on it, and the service charge on the two together. Client charge; see nfhClaimPerDay.'],
];

async function main() {
  const url = process.env.DATABASE_URL || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!host) throw new Error('DATABASE_URL is not a URL');
  if (MANAGED_HOST.test(host)) throw new Error(`refusing to migrate a managed host (${host})`);

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const present = (await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'payroll_records' AND column_name = ANY($1)`,
      [COLUMNS.map((c) => c[0])])).rows.map((r) => r.column_name);

    const missing = COLUMNS.filter(([name]) => !present.includes(name));
    console.log(`\ndatabase ${host}`);
    if (!missing.length) {
      console.log('  both columns already exist — nothing to do.\n');
      return;
    }
    const rows = (await db.query('SELECT count(*)::int AS n FROM payroll_records')).rows[0].n;
    for (const [name, type] of missing) {
      console.log(`  ALTER TABLE payroll_records ADD COLUMN ${name} ${type}`);
    }
    console.log(`  ${rows} existing payroll row(s) would get 0`);

    if (!APPLY) {
      console.log('\ndry run — nothing changed. Re-run with --apply.\n');
      return;
    }

    await db.query('BEGIN');
    try {
      for (const [name, type, comment] of missing) {
        await db.query(`ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS ${name} ${type}`);
        await db.query(`COMMENT ON COLUMN payroll_records.${name} IS '${comment.replace(/'/g, "''")}'`);
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    console.log(`\n${missing.length} column(s) added.\n`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
});
