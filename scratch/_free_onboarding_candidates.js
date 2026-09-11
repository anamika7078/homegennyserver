/**
 * Give the S5 candidates back that failed test runs took.
 *
 * Onboarding a candidate writes an `employees` row, and while that row exists
 * the candidate no longer shows up in `/employees/pending-onboarding`. The HR
 * suite used to clean that row up only when it reached the end of a passing
 * run — a failure jumped past it — so every red run quietly retired one of the
 * handful of S5 candidates the database has. Eventually none were left, and
 * the suite failed on its first assertion, which looks like a broken endpoint
 * rather than an empty pool.
 *
 * The suite now cleans up either way. This script clears the backlog left by
 * the runs that came before that fix.
 *
 * It only ever touches employee records that:
 *   - belong to a staff applicant (`staff_applicant_id` is set — a directly
 *     hired office employee has none and is never in scope),
 *   - have no payslips and no payroll of their own (and no attendance either,
 *     unless --with-attendance says to clear unpaid days as well), and
 *   - whose applicant is still sitting at S5_DEPLOY.
 *
 * Anything with real work recorded against it is left alone and reported, so
 * this can never quietly delete an employee who has actually been paid.
 *
 *   node scratch/_free_onboarding_candidates.js                    # what it would do
 *   node scratch/_free_onboarding_candidates.js --apply            # do it
 *   node scratch/_free_onboarding_candidates.js --with-attendance  # unpaid days too
 */
require('dotenv').config();
const { Client } = require('pg');

const MANAGED_HOST = /render\.com|amazonaws|azure|googleapis|neon\.tech|supabase|planetscale/i;
const APPLY = process.argv.includes('--apply');
/**
 * Also clear the HR attendance ledger for the candidates being freed.
 *
 * A suite that marks a day and then fails leaves that row behind, and the next
 * run counts it as real work and refuses to touch the candidate. Attendance
 * with no payslip and no payroll behind it has never been paid for — for an
 * S5 candidate that is test residue, not a record of work. Anything that has
 * reached payroll is still refused, with or without this flag.
 */
const WITH_ATTENDANCE = process.argv.includes('--with-attendance');

async function main() {
  const url = process.env.DATABASE_URL || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!host) throw new Error('DATABASE_URL is not a URL');
  if (MANAGED_HOST.test(host)) {
    throw new Error(`refusing to run against a managed host (${host})`);
  }

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query(`
      SELECT e.id AS employee_id, e.full_name, sa.staff_code,
             (SELECT count(*) FROM payslip_documents pd WHERE pd.employee_id = e.id)::int AS payslips,
             (SELECT count(*) FROM attendance a WHERE a.employee_id = e.id)::int AS attendance,
             (SELECT count(*) FROM payroll_records pr WHERE pr.staff_id = sa.id)::int AS payroll
      FROM employees e
      JOIN staff_applicants sa ON sa.id = e.staff_applicant_id
      WHERE e.deleted_at IS NULL
        AND sa.pipeline_stage = 'S5_DEPLOY'
      ORDER BY sa.staff_code
    `);

    if (!rows.length) {
      console.log('No onboarded S5 candidates found — nothing to free.');
      return;
    }

    // Payslips and payroll always block: money has changed hands. Attendance
    // blocks too, unless --with-attendance says to treat an unpaid day as the
    // test residue it almost certainly is.
    const blocked = (r) => r.payslips || r.payroll || (r.attendance && !WITH_ATTENDANCE);
    const free = rows.filter((r) => !blocked(r));
    const busy = rows.filter(blocked);

    console.log(`\n${rows.length} S5 candidate(s) currently hold an employee record.\n`);
    for (const r of free) {
      const extra = r.attendance ? ` — and ${r.attendance} unpaid attendance row(s)` : '';
      console.log(`  free   ${r.staff_code.padEnd(14)} ${r.full_name}${extra}`);
    }
    for (const r of busy) {
      console.log(
        `  KEEP   ${r.staff_code.padEnd(14)} ${r.full_name} — ` +
        `${r.payslips} payslip(s), ${r.attendance} attendance, ${r.payroll} payroll`,
      );
    }

    if (!free.length) {
      if (!WITH_ATTENDANCE && busy.some((r) => r.attendance && !r.payslips && !r.payroll)) {
        console.log('');
        console.log('Some are held only by unpaid attendance rows. If those are leftovers');
        console.log('from a failed run rather than real days, re-run with --with-attendance.');
      }
      console.log('\nNothing can be freed without destroying real work. Seed a new candidate instead:');
      console.log('  node scratch/_seed_staff_s4.js --name <Name> --deploy');
      return;
    }

    if (!APPLY) {
      console.log(`\n${free.length} candidate(s) would be freed. Re-run with --apply to do it.`);
      return;
    }

    const ids = free.map((r) => r.employee_id);
    await db.query('BEGIN');
    // audit_logs points at the employee; the pipeline_events EMPLOYEE_ONBOARDED
    // row is append-only by design and deliberately stays — the suite proves a
    // repeat onboarding is refused on its own terms, not by the event's absence.
    if (WITH_ATTENDANCE) {
      await db.query(`DELETE FROM attendance WHERE employee_id = ANY($1::uuid[])`, [ids]);
    }
    await db.query(
      `DELETE FROM audit_logs WHERE entity_type = 'employee' AND entity_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
    await db.query('COMMIT');
    console.log(`\nFreed ${ids.length} candidate(s). They are back in /employees/pending-onboarding.`);
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch { /* not in a transaction */ }
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
});
