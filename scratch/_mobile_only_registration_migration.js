/**
 * Mobile-number-only registration — docs/MOBILE_BRIEF_REGISTRATION.md (2026-10-21).
 *
 * A new app user signs up with a mobile number and an OTP, nothing else:
 *   staff_applicants   name / DOB / address / series are filled by the RM at S1
 *                      ("Complete S1"), so they are empty until then
 *   finance_customers  address / PAN are filled when the client asks for staff
 *                      (or by the RM / Finance), so they are empty until then
 *
 * Only DROP NOT NULL — no row is changed, nothing is dropped, and it is
 * re-runnable (dropping a constraint that is already gone is a no-op).
 * PAN stays UNIQUE: Postgres allows any number of NULLs under a unique index.
 * Both are declared in schema.prisma, so a `db push` has nothing to change.
 *
 * ALTER TABLE needs the table owner — on the server that is `postgres`, not
 * the app user, so pass MIGRATION_DATABASE_URL there:
 *
 *   node scratch/_mobile_only_registration_migration.js
 *   MIGRATION_DATABASE_URL=postgresql://postgres:...@postgres:5432/homegenny node scratch/_mobile_only_registration_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'staff_applicants: series, full_name, date_of_birth, address nullable',
    sql: `ALTER TABLE staff_applicants
            ALTER COLUMN series        DROP NOT NULL,
            ALTER COLUMN full_name     DROP NOT NULL,
            ALTER COLUMN date_of_birth DROP NOT NULL,
            ALTER COLUMN address       DROP NOT NULL`,
  },
  {
    label: 'finance_customers: address, pan_card nullable',
    sql: `ALTER TABLE finance_customers
            ALTER COLUMN address  DROP NOT NULL,
            ALTER COLUMN pan_card DROP NOT NULL`,
  },
];

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }
  console.log(`Target: ${new URL(url).hostname} as ${new URL(url).username}\n`);
  // SSL only for managed hosts; inside the compose network the host is `postgres` with no SSL.
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const c = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');
    const { rows } = await c.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE (table_name = 'staff_applicants' AND column_name IN ('series','full_name','date_of_birth','address'))
           OR (table_name = 'finance_customers' AND column_name IN ('address','pan_card'))
        ORDER BY table_name, column_name`,
    );
    for (const r of rows) console.log(`  check ${r.table_name}.${r.column_name} nullable=${r.is_nullable}`);
    console.log('\nMigration applied.\n');
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
