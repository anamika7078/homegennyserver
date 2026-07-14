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
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.warn('[render_pre_migrate] non-fatal:', err.message);
});
