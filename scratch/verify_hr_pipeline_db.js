/**
 * READ-ONLY preflight for the HR <-> pipeline bridge.
 *
 * Writes nothing. Run it against any database (local or production) to see
 * exactly what that database still needs before the feature works there.
 *
 *   DATABASE_URL="postgres://..." node scratch/verify_hr_pipeline_db.js
 */
const { Client } = require('pg');
require('dotenv').config();

const ok = (s) => `  OK       ${s}`;
const missing = (s) => `  MISSING  ${s}`;
const note = (s) => `  NOTE     ${s}`;

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const m = url.match(/^(\w+):\/\/([^:]+):[^@]*@([^/]+)\/([^?]+)/);
  console.log(
    'database: ' + (m ? `${m[1]}://${m[2]}:***@${m[3]}/${m[4]}` : url.replace(/:[^:@]*@/, ':***@')),
  );
  console.log('');

  const c = new Client({
    connectionString: url,
    // Same SSL rule as the other deploy scripts in this folder.
    ssl: /render\.com|dpg-|sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();

  const problems = [];

  // ── 1. schema objects the feature depends on ────────────────────────────
  console.log('[1] Schema');

  const col = await c.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'employees' AND column_name = 'staff_applicant_id'`);
  if (col.rowCount) console.log(ok('employees.staff_applicant_id exists'));
  else {
    console.log(missing('employees.staff_applicant_id — run scratch/migrate_hr_pipeline_link.js'));
    problems.push('column');
  }

  const uniq = await c.query(`
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'employees' AND indexname = 'employees_staff_applicant_id_key'`);
  if (uniq.rowCount) console.log(ok('unique index on staff_applicant_id'));
  else {
    console.log(missing('employees_staff_applicant_id_key — run the migration script'));
    problems.push('unique index');
  }

  const fk = await c.query(`
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_staff_applicant_id_fkey'`);
  if (fk.rowCount) console.log(ok('foreign key to staff_applicants'));
  else {
    console.log(missing('employees_staff_applicant_id_fkey — run the migration script'));
    problems.push('foreign key');
  }

  // The projection upserts with ON CONFLICT (employee_id, date); without this
  // index that statement is a hard error, not a slow query.
  const attUniq = await c.query(`
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'attendance' AND indexdef ILIKE '%UNIQUE%(employee_id, date)%'`);
  if (attUniq.rowCount) console.log(ok('unique index on attendance(employee_id, date)'));
  else {
    console.log(
      missing('attendance(employee_id, date) unique index — the projection cannot upsert without it'),
    );
    problems.push('attendance unique index');
  }

  if (problems.length) {
    console.log('\n=> Not ready. Run:  node scratch/migrate_hr_pipeline_link.js');
    await c.end();
    process.exit(1);
  }

  // ── 2. how much is linked ───────────────────────────────────────────────
  console.log('\n[2] Linkage');
  const linked = await c.query(`
    SELECT COUNT(*) FILTER (WHERE staff_applicant_id IS NOT NULL)::int AS linked,
           COUNT(*) FILTER (WHERE staff_applicant_id IS NULL)::int     AS unlinked
      FROM employees WHERE deleted_at IS NULL`);
  console.log(note(`${linked.rows[0].linked} employee(s) linked to a pipeline record`));
  console.log(note(`${linked.rows[0].unlinked} employee(s) unlinked (direct hires, or not yet matched)`));

  const pending = await c.query(`
    SELECT COUNT(*)::int AS n
      FROM staff_applicants sa
      LEFT JOIN employees e ON e.staff_applicant_id = sa.id
     WHERE sa.pipeline_stage = 'S5_DEPLOY' AND sa.deleted_at IS NULL
       AND sa.terminal_outcome IS NULL AND e.id IS NULL`);
  console.log(note(`${pending.rows[0].n} deployed candidate(s) waiting to be onboarded by HR`));

  // ── 3. field attendance that payroll cannot see yet ─────────────────────
  console.log('\n[3] Attendance catch-up');
  console.log(
    note('The projection covers the last 3 days every 10 min and 45 days nightly.'),
  );
  console.log(note('Anything older has to be pulled across once, per month:'));

  const backlog = await c.query(`
    SELECT EXTRACT(YEAR  FROM sda.attendance_date)::int AS year,
           EXTRACT(MONTH FROM sda.attendance_date)::int AS month,
           COUNT(*)::int AS days
      FROM staff_daily_attendance sda
      JOIN employees e ON e.staff_applicant_id = sda.staff_id
      LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = sda.attendance_date
     WHERE e.deleted_at IS NULL
       AND a.id IS NULL
       AND sda.attendance_date < CURRENT_DATE - INTERVAL '45 days'
     GROUP BY 1, 2 ORDER BY 1 DESC, 2 DESC`);

  if (backlog.rowCount === 0) {
    console.log(ok('nothing older than the nightly window is missing — no catch-up needed'));
  } else {
    console.log('');
    for (const r of backlog.rows) {
      console.log(
        `    ${String(r.month).padStart(2, '0')}/${r.year} — ${r.days} field day(s) not in the payroll ledger`,
      );
    }
    console.log('\n  For each month above, once:');
    console.log(
      "    curl -X POST <API>/v1/attendance/sync-from-pipeline -H 'Authorization: Bearer <HR token>' \\",
    );
    console.log("         -H 'Content-Type: application/json' -d '{\"month\":M,\"year\":YYYY}'");
  }

  console.log('\n=> Schema is ready.');
  await c.end();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
