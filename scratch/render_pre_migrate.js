/**
 * Render / production pre-migrate helper.
 * Clears known failed migration states and marks partially-applied migrations as applied.
 */
const { execSync } = require('child_process');
const { Client } = require('pg');

const ROLLED_BACK = [
  '20260518000000_enterprise_extensions',
  '20260528000000_admin_security_triggers',
  '20260710112100_add_employee_tables',
  '20260817071500_agreements_client_fk_fix',
];

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

async function tableExists(client, name) {
  const res = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name],
  );
  return Boolean(res.rows[0]?.exists);
}

async function migrationPending(client, name) {
  const res = await client.query(
    `SELECT finished_at, rolled_back_at
     FROM _prisma_migrations
     WHERE migration_name = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [name],
  );
  const row = res.rows[0];
  if (!row) return false;
  return row.finished_at === null && row.rolled_back_at === null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[render_pre_migrate] DATABASE_URL not set — skipping');
    return;
  }

  for (const name of ROLLED_BACK) {
    run(`npx prisma migrate resolve --rolled-back ${name}`);
  }

  const client = new Client({
    connectionString: url,
    ssl: /render\.com|dpg-|sslmode=require/i.test(url)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  try {
    const employeesExists = await tableExists(client, 'employees');
    const employeeMigrationPending = await migrationPending(client, '20260710112100_add_employee_tables');

    if (employeesExists && employeeMigrationPending) {
      console.log('[render_pre_migrate] employees table exists — marking add_employee_tables as applied');
      run('npx prisma migrate resolve --applied 20260710112100_add_employee_tables');
    }

    await ensureHrTables(client);
    await ensureAgreementsClientIdNullable(client);
  } finally {
    await client.end();
  }
}

/**
 * A1 (Employment Agreement) is staff-level and client-independent — only A2/SOW
 * and A3/Indemnity are client-specific (see MOBILE_BRIEF_PLACEMENT_S5_ONLY.md).
 * agreements.client_id was NOT NULL, so POST /agreements with just {staff_id, type: "A1"}
 * (no client yet) 500'd on a raw Postgres NOT NULL violation. Idempotent — safe to
 * run on every deploy.
 */
async function ensureAgreementsClientIdNullable(client) {
  const exists = await tableExists(client, 'agreements');
  if (!exists) return;
  await client.query(`ALTER TABLE agreements ALTER COLUMN client_id DROP NOT NULL`);
  console.log('[render_pre_migrate] agreements.client_id is nullable');
}

async function ensureHrTables(client) {
  const payrollsExists = await tableExists(client, 'employee_payrolls');
  if (payrollsExists) return;

  const employeesExists = await tableExists(client, 'employees');
  if (!employeesExists) {
    console.warn('[render_pre_migrate] employees table missing — skipping employee_payrolls');
    return;
  }

  console.log('[render_pre_migrate] Creating employee_payrolls table...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS employee_payrolls (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      period_month  INT NOT NULL,
      period_year   INT NOT NULL,
      present_days  DECIMAL(5,2) NOT NULL,
      gross_salary  DECIMAL(10,2) NOT NULL,
      deductions    JSONB NOT NULL DEFAULT '{}',
      net_salary    DECIMAL(10,2) NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      disbursed_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(employee_id, period_month, period_year)
    )
  `);
  console.log('[render_pre_migrate] employee_payrolls ready');
}

main().catch((err) => {
  console.warn('[render_pre_migrate] non-fatal:', err.message);
});
