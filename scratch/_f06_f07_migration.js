/**
 * F-06 / F-07 migration — additive only, safe to re-run.
 *
 *   F-07  Neither the enterprise batch nor the HR payroll stored the employer
 *         side of PF/ESIC, so the company's own statutory liability existed
 *         nowhere and the compliance report understated the real outflow.
 *   F-06  The ESIC challan and PF ECR read `payroll_records` alone. Bringing
 *         the other two engines into the filing needs their employer columns
 *         to exist first.
 *
 *   node scratch/_f06_f07_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    table: 'payroll_details',
    label: 'payroll_details.esic_employer',
    sql: `ALTER TABLE payroll_details ADD COLUMN IF NOT EXISTS esic_employer NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    table: 'payroll_details',
    label: 'payroll_details.pf_employer',
    sql: `ALTER TABLE payroll_details ADD COLUMN IF NOT EXISTS pf_employer NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'employee_payrolls.esic_employee',
    sql: `ALTER TABLE employee_payrolls ADD COLUMN IF NOT EXISTS esic_employee NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'employee_payrolls.esic_employer',
    sql: `ALTER TABLE employee_payrolls ADD COLUMN IF NOT EXISTS esic_employer NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'employee_payrolls.pf_employee',
    sql: `ALTER TABLE employee_payrolls ADD COLUMN IF NOT EXISTS pf_employee NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'employee_payrolls.pf_employer',
    sql: `ALTER TABLE employee_payrolls ADD COLUMN IF NOT EXISTS pf_employer NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'employee_payrolls period index',
    sql: `CREATE INDEX IF NOT EXISTS idx_employee_payrolls_period ON employee_payrolls(period_year, period_month)`,
  },
];

/**
 * Existing HR payroll rows carry the employee side inside the `deductions`
 * JSON but have nothing in the new columns. Lift what is already there so a
 * challan generated for a past month is not silently short. Employer figures
 * were never computed for those rows and are deliberately left at 0 rather
 * than back-calculated — a filing should not contain numbers nobody ever
 * agreed to. Re-running is a no-op.
 */
const BACKFILL = `
  UPDATE employee_payrolls
  SET esic_employee = COALESCE((deductions->>'esic')::numeric, 0),
      pf_employee   = COALESCE((deductions->>'pf')::numeric, 0)
  WHERE esic_employee = 0 AND pf_employee = 0
    AND deductions ? 'esic'
`;

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
    const res = await c.query(BACKFILL);
    console.log(`  ok    lifted employee-side figures onto ${res.rowCount} existing HR payroll row(s)`);
    await c.query('COMMIT');
    console.log('\nF06/F07 migration applied.');
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
