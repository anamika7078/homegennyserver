/**
 * Live HTTP test for the field-attendance projection (pipeline -> HR ledger).
 *
 * The point being proved: a deployed staff member who marks every day from the
 * mobile app used to have zero rows in `attendance`, which is the only table
 * employee payroll counts — so their payroll run failed with "No billable
 * attendance days". This checks the days now cross over, that HR's own
 * corrections survive a re-run, and that payroll actually pays out.
 *
 *   node scratch/_live_test_attendance_projection.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const HR_PHONE = '9800000008';
const HR_PASSWORD = 'HomeGenny@2024';
// Running payroll is a FINANCE action, so section [3] needs its own token.
const FINANCE_PHONE = '9800000004';

// A month far enough out that no real data lives there.
const YEAR = 2031;
const MONTH = 3;
const FIELD_DAYS = ['2031-03-03', '2031-03-04', '2031-03-05', '2031-03-06'];
const HR_OWNED_DAY = '2031-03-10';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  }
}

/**
 * The API rate-limits auth, and running these suites back to back trips it.
 * That is the throttler working, not a failure — so back off and retry rather
 * than reporting a false red.
 */
async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 6) {
    const waitMs = 5000 * (attempt + 1);
    console.log(`      (rate limited, waiting ${waitMs / 1000}s…)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}

async function req(method, path, { token, body } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  const payload =
    json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload, raw: json };
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const login = await req('POST', '/auth/login', {
    body: { phone: HR_PHONE, password: HR_PASSWORD },
  });
  const token = login.body?.access_token || login.body?.data?.access_token;
  if (!token) {
    console.log('could not log in as HR — aborting', login.status, login.raw);
    process.exit(1);
  }
  console.log(`logged in as HR (${HR_PHONE})`);

  // ── set up: onboard a candidate so there is a linked employee ────────────
  const pending = await req('GET', '/employees/pending-onboarding', { token });
  const target = (pending.body?.items ?? [])[0];
  if (!target) {
    console.log('no S5 candidate available to onboard — aborting');
    process.exit(1);
  }
  const cat = await db.query('SELECT id FROM employee_categories LIMIT 1');
  const onboarded = await req('POST', '/employees/onboard-from-pipeline', {
    token,
    body: {
      staffApplicantId: target.id,
      department: 'Field Operations',
      designation: 'Housemaid',
      categoryId: cat.rows[0].id,
      employmentType: 'Full Time',
      salary: 30000,
      joiningDate: '2031-01-01',
      gender: 'Female',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110001',
    },
  });
  const employeeId = onboarded.body?.employee?.id;
  if (!employeeId) {
    console.log('onboarding failed — aborting', onboarded.status, onboarded.raw);
    process.exit(1);
  }
  console.log(`set up: ${target.staffCode} -> employee ${onboarded.body.employee.employeeId}`);

  const branch = await db.query('SELECT branch_id FROM staff_applicants WHERE id = $1', [target.id]);
  const branchId = branch.rows[0].branch_id;

  async function cleanup() {
    await db.query('DELETE FROM employee_payrolls WHERE employee_id = $1', [employeeId]);
    // Payroll now lands in payroll_records against the placement (§B6). Left
    // behind, it makes the next suite's run refuse as a duplicate.
    await db.query(
      `UPDATE payroll_records SET client_invoice_id = NULL
        WHERE placement_id IN (SELECT id FROM placements WHERE staff_id = $1)`,
      [target.id],
    );
    await db.query(
      `DELETE FROM payroll_records
        WHERE placement_id IN (SELECT id FROM placements WHERE staff_id = $1)`,
      [target.id],
    );
    await db.query('DELETE FROM attendance WHERE employee_id = $1', [employeeId]);
    await db.query(
      "DELETE FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date >= '2031-01-01'",
      [target.id],
    );
    await db.query("DELETE FROM audit_logs WHERE entity_id = $1 AND entity_type = 'employee'", [
      employeeId,
    ]);
    await db.query('DELETE FROM employees WHERE id = $1', [employeeId]);
  }

  try {
    // ── simulate the staff member's own mobile check-ins ───────────────────
    for (const day of FIELD_DAYS) {
      await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::date, 'PRESENT', $1, now(), now())
         ON CONFLICT (staff_id, attendance_date) DO UPDATE SET status = 'PRESENT'`,
        [target.id, branchId, day],
      );
    }

    // ── 1. before the projection, the HR ledger is empty ───────────────────
    console.log('\n[1] Baseline — field days exist, HR ledger does not');
    const before = await db.query(
      'SELECT COUNT(*)::int AS n FROM attendance WHERE employee_id = $1',
      [employeeId],
    );
    check('HR ledger has no rows for this employee yet', before.rows[0].n === 0, before.rows[0]);

    // Calling the retired HR payroll endpoint still runs the projection before
    // it refuses, which is what this step is here to trigger. The refusal
    // itself is asserted below.
    const retired = await req(
      'POST',
      `/attendance/${employeeId}/generate-payroll?month=${MONTH}&year=${YEAR}`,
      { token, body: { month: MONTH, year: YEAR } },
    );
    check(
      'the retired HR payroll endpoint refuses, and says why',
      /retired/i.test(JSON.stringify(retired.raw ?? '')),
      retired.raw,
    );
    check(
      'it does not fail with "No billable attendance days"',
      !/no billable attendance days/i.test(JSON.stringify(retired.raw ?? '')),
      retired.raw,
    );

    // ── 2. the days landed in the HR ledger ────────────────────────────────
    console.log('\n[2] Field days projected into the HR ledger');
    const projected = await db.query(
      `SELECT date::text AS d, status, marked_by, notes
         FROM attendance WHERE employee_id = $1 ORDER BY date`,
      [employeeId],
    );
    check(
      `all ${FIELD_DAYS.length} field days are present`,
      projected.rows.length === FIELD_DAYS.length,
      projected.rows.map((r) => r.d),
    );
    check(
      'dates match exactly (no off-by-one)',
      JSON.stringify(projected.rows.map((r) => r.d)) === JSON.stringify(FIELD_DAYS),
      projected.rows.map((r) => r.d),
    );
    check(
      'PRESENT mapped to the HR label "Present"',
      projected.rows.every((r) => r.status === 'Present'),
      projected.rows.map((r) => r.status),
    );
    check(
      'projected rows carry no marked_by, so they are recognisable as system rows',
      projected.rows.every((r) => r.marked_by === null),
      projected.rows.map((r) => r.marked_by),
    );

    // ── 3. payroll actually paid for those days ────────────────────────────
    //
    // Payroll now runs on the placement (§B6): `employee_payrolls` is retired,
    // and `payroll_records` reads `staff_daily_attendance` — the field ledger —
    // directly. So the "no billable days" regression this projection was built
    // to fix is now structurally impossible for placement payroll. The
    // projection still earns its keep by making those days visible in HR's own
    // attendance views, which is what section [2] asserts.
    console.log('\n[3] Payroll counted them');

    const placement = await db.query(
      `SELECT p.id
         FROM placements p
         JOIN employees e ON e.staff_applicant_id = p.staff_id
        WHERE e.id = $1 AND p.status = 'CONFIRMED'
        ORDER BY p.created_at DESC LIMIT 1`,
      [employeeId],
    );
    check('the employee is placed with a client', placement.rowCount === 1, placement.rows);

    if (placement.rowCount === 1) {
      const placementId = placement.rows[0].id;
      await db.query(
        `DELETE FROM payroll_records WHERE placement_id = $1 AND period_month = $2 AND period_year = $3`,
        [placementId, MONTH, YEAR],
      );

      const finLogin = await req('POST', '/auth/login', {
        body: { phone: FINANCE_PHONE, password: HR_PASSWORD },
      });
      const finToken = finLogin.body?.access_token || finLogin.body?.data?.access_token;
      check('logged in as Finance to run payroll', !!finToken, finLogin.raw);

      // The attendance path, not /payroll/run — that one counts approved
      // shift_logs, whereas the field check-ins this test creates live in
      // staff_daily_attendance. This is also the route the employee code now
      // resolves through, since HR payroll is retired (§B6).
      const ran = await req('POST', '/finance/payroll/attendance-generate', {
        token: finToken,
        body: { code: target.staffCode, month: MONTH, year: YEAR },
      });

      const payrollRow = await db.query(
        `SELECT shift_days, gross_salary, net_salary FROM payroll_records
          WHERE placement_id = $1 AND period_month = $2 AND period_year = $3`,
        [placementId, MONTH, YEAR],
      );
      check(
        `payroll recorded ${FIELD_DAYS.length} billable days`,
        Number(payrollRow.rows[0]?.shift_days) === FIELD_DAYS.length,
        payrollRow.rows[0] ?? ran.raw,
      );
      check(
        'gross salary is greater than zero',
        Number(payrollRow.rows[0]?.gross_salary) > 0,
        payrollRow.rows[0] ?? ran.raw,
      );
    }

    // ── 4. an HR correction outranks the field record ──────────────────────
    console.log('\n[4] HR corrections are never overwritten by a re-run');
    const correctedDay = FIELD_DAYS[0];
    const corrected = await req('POST', '/attendance/mark', {
      token,
      body: {
        employeeId,
        date: correctedDay,
        status: 'Absent',
        notes: 'Client reported no-show',
        overrideSelfCheckIn: true,
      },
    });
    check('HR can correct a projected day', [200, 201].includes(corrected.status), corrected.raw);

    // Put the field record back to PRESENT, so a naive re-run would clobber it.
    await db.query(
      `UPDATE staff_daily_attendance SET status = 'PRESENT'
        WHERE staff_id = $1 AND attendance_date = $2::date`,
      [target.id, correctedDay],
    );

    const resync = await req('POST', '/attendance/sync-from-pipeline', {
      token,
      body: { month: MONTH, year: YEAR, employeeId },
    });
    check('re-sync returns 200/201', [200, 201].includes(resync.status), resync.raw);
    check(
      'the HR-marked day is reported as skipped, not silently overwritten',
      Number(resync.body?.skippedManual) >= 1,
      resync.body,
    );

    const afterResync = await db.query(
      'SELECT status, marked_by FROM attendance WHERE employee_id = $1 AND date = $2::date',
      [employeeId, correctedDay],
    );
    check(
      "HR's Absent survived the re-run",
      afterResync.rows[0]?.status === 'Absent',
      afterResync.rows[0],
    );
    check(
      'and it still carries the HR user who marked it',
      afterResync.rows[0]?.marked_by !== null,
      afterResync.rows[0],
    );

    // ── 5. a day HR marked with no field record stays put ──────────────────
    console.log('\n[5] A purely HR-marked day is left alone');
    await req('POST', '/attendance/mark', {
      token,
      body: { employeeId, date: HR_OWNED_DAY, status: 'Leave', notes: 'Approved leave' },
    });
    await req('POST', '/attendance/sync-from-pipeline', {
      token,
      body: { month: MONTH, year: YEAR, employeeId },
    });
    const hrOnly = await db.query(
      'SELECT status FROM attendance WHERE employee_id = $1 AND date = $2::date',
      [employeeId, HR_OWNED_DAY],
    );
    check('HR-only Leave day is untouched', hrOnly.rows[0]?.status === 'Leave', hrOnly.rows[0]);

    // ── 6. re-running changes nothing (idempotent) ─────────────────────────
    console.log('\n[6] Re-running is idempotent');
    const countBefore = await db.query(
      'SELECT COUNT(*)::int AS n FROM attendance WHERE employee_id = $1',
      [employeeId],
    );
    const again = await req('POST', '/attendance/sync-from-pipeline', {
      token,
      body: { month: MONTH, year: YEAR, employeeId },
    });
    const countAfter = await db.query(
      'SELECT COUNT(*)::int AS n FROM attendance WHERE employee_id = $1',
      [employeeId],
    );
    check('no duplicate rows created', countBefore.rows[0].n === countAfter.rows[0].n, {
      before: countBefore.rows[0].n,
      after: countAfter.rows[0].n,
    });
    check('nothing new inserted on the second pass', Number(again.body?.inserted) === 0, again.body);

    // ── 7. an unlinked employee is not touched ─────────────────────────────
    console.log('\n[7] Direct hires are outside the projection');
    const office = await db.query(
      'SELECT id FROM employees WHERE staff_applicant_id IS NULL AND deleted_at IS NULL LIMIT 1',
    );
    if (office.rows.length) {
      const officeBefore = await db.query(
        'SELECT COUNT(*)::int AS n FROM attendance WHERE employee_id = $1',
        [office.rows[0].id],
      );
      await req('POST', '/attendance/sync-from-pipeline', {
        token,
        body: { month: MONTH, year: YEAR },
      });
      const officeAfter = await db.query(
        'SELECT COUNT(*)::int AS n FROM attendance WHERE employee_id = $1',
        [office.rows[0].id],
      );
      check(
        'no rows invented for an employee with no pipeline record',
        officeBefore.rows[0].n === officeAfter.rows[0].n,
        { before: officeBefore.rows[0].n, after: officeAfter.rows[0].n },
      );
    } else {
      console.log('      (no direct-hire employee in this database — skipped)');
    }
  } finally {
    console.log('\ncleaning up test rows...');
    await cleanup();
    console.log('done');
  }

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
