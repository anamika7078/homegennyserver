/**
 * Additive migration: link the HR `employees` record to its originating
 * `staff_applicants` pipeline row (S5_DEPLOY -> employee onboarding).
 *
 * Idempotent and non-destructive — adds one nullable column plus its FK and
 * unique index, nothing is dropped or rewritten. Safe to re-run.
 *
 *   node scratch/migrate_hr_pipeline_link.js
 */
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  // Same SSL rule the other deploy scripts use (render_pre_migrate.js,
  // apply_security_triggers.js) — managed Postgres refuses plaintext, local
  // Postgres refuses SSL, so the connection string decides.
  const c = new Client({
    connectionString: url,
    ssl: /render\.com|dpg-|sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  const target = url.match(/@([^/]+)\/([^?]+)/);
  console.log('target database:', target ? target[1] + '/' + target[2] : '(unparsed)');

  await c.query(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS staff_applicant_id UUID;
  `);
  console.log('employees.staff_applicant_id ready');

  // Nullable + UNIQUE: Postgres treats NULLs as distinct, so unlimited direct
  // hires coexist while each applicant can be converted at most once.
  await c.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS employees_staff_applicant_id_key
      ON employees(staff_applicant_id);
  `);
  console.log('employees_staff_applicant_id_key ready');

  await c.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'employees_staff_applicant_id_fkey'
      ) THEN
        ALTER TABLE employees
          ADD CONSTRAINT employees_staff_applicant_id_fkey
          FOREIGN KEY (staff_applicant_id) REFERENCES staff_applicants(id)
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
  console.log('employees_staff_applicant_id_fkey ready');

  // Backfill: before this column existed, the only (fragile) link between the
  // two worlds was `linkStaffAccount` matching by mobile and stamping the same
  // users.id on both rows. That shared user_id is trustworthy where it exists,
  // so adopt it — but only where exactly one applicant claims it, and never
  // overwrite a link that is already set.
  const backfill = await c.query(`
    UPDATE employees e
       SET staff_applicant_id = sa.id
      FROM staff_applicants sa
     WHERE e.staff_applicant_id IS NULL
       AND e.user_id IS NOT NULL
       AND sa.user_id = e.user_id
       AND sa.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM employees e2
          WHERE e2.staff_applicant_id = sa.id
       )
       AND (
         SELECT COUNT(*) FROM staff_applicants sa2
          WHERE sa2.user_id = e.user_id AND sa2.deleted_at IS NULL
       ) = 1;
  `);
  console.log(`backfilled ${backfill.rowCount} employee(s) from shared user_id`);

  const remaining = await c.query(`
    SELECT COUNT(*)::int AS n FROM employees
     WHERE staff_applicant_id IS NULL AND deleted_at IS NULL;
  `);
  console.log(`${remaining.rows[0].n} employee(s) still unlinked (direct hires, or needs manual review)`);

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
