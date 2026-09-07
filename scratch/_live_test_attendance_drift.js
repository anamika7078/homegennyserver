/**
 * Live HTTP verification that a day marked after payroll has run cannot be
 * lost quietly.
 *
 * Payroll counts attendance once, at the moment it runs. A day marked
 * afterwards used to sit in the table reaching nobody — not the payslip, not
 * the client's invoice — and the call that recorded it returned a bare 200, so
 * it looked finished. A staff member worked three days, was paid for one, and
 * the only way to find out was to compare the two tables by hand.
 *
 * Two things now stop that, and this checks both:
 *   - GET /finance/payroll/attendance-drift reports the difference, and says
 *     whether re-running payroll would fix it or the invoice has gone too far.
 *   - POST /attendance/mark returns a warning when the day is already too late
 *     to be paid on its own.
 *
 * Builds its own placement, attendance and payroll, and removes all of it.
 *
 *   node scratch/_live_test_attendance_drift.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const HR_PHONE = '9800000008';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

// Far enough back that no real billing lives here. 2/2026 and 3/2026 and
// 4/2026 belong to the unit-code, F1 and F09 suites.
const MONTH = 6;
const YEAR = 2026;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  const payload =
    json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}

async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.status === 200 || r.status === 201) {
      const t = r.body?.access_token || r.body?.accessToken;
      if (t) return t;
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { staffId: null, placementId: null, employeeId: null, customerId: null };

  try {
    const finance = await login(FINANCE_PHONE);
    console.log('logged in as FINANCE\n');

    // ── a placement of our own, so nothing real is touched ────────────────
    const branch = await db.query(`SELECT id FROM branches ORDER BY created_at LIMIT 1`);
    const cust = await db.query(`SELECT id FROM finance_customers ORDER BY created_at LIMIT 1`);
    if (!branch.rows.length || !cust.rows.length) {
      console.log('no branch or customer in this database — nothing to test against');
      return;
    }
    made.customerId = cust.rows[0].id;

    const staff = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, full_name, mobile, branch_id, series,
                                     pipeline_stage, date_of_birth, address, verified_docs,
                                     pv_status, restricted_list, restrictions, metadata,
                                     deposit_amount, deposit_paid, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Drift Test Staff', $2, $3, 'MAID', 'S5_DEPLOY',
               '1995-01-01', 'Drift test', '{}'::jsonb, 'IN_PROGRESS', false,
               '{}'::jsonb, '{}'::jsonb, 500, true, now(), now())
       RETURNING id`,
      [`DRIFT${Date.now().toString().slice(-6)}`, `98${Date.now().toString().slice(-8)}`, branch.rows[0].id],
    );
    made.staffId = staff.rows[0].id;

    const placement = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               staff_salary, management_fee, shift_hours, trial_start_date,
                               confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', 18000, 2000, 8,
               CURRENT_DATE, now(), now(), now())
       RETURNING id`,
      [made.staffId, made.customerId, branch.rows[0].id],
    );
    made.placementId = placement.rows[0].id;

    const markDay = async (day) => {
      await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, placement_id, branch_id, attendance_date, status, hours_worked,
            marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', 8, $1, now(), now())
         ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING`,
        [made.staffId, made.placementId, branch.rows[0].id, YEAR, MONTH, day],
      );
    };

    // ── two days, then payroll, then a third day ──────────────────────────
    console.log('[1] Two days worked, payroll run, then a third day marked');
    await markDay(1);
    await markDay(2);

    const staffCode = (await db.query(
      `SELECT staff_code FROM staff_applicants WHERE id = $1`, [made.staffId],
    )).rows[0].staff_code;

    const ran = await req('POST', '/finance/payroll/attendance-generate', {
      token: finance, body: { code: staffCode, month: MONTH, year: YEAR },
    });
    check('payroll runs on the two days', ran.status === 200 || ran.status === 201, ran.status);

    const afterRun = await req('GET',
      `/finance/payroll/attendance-drift?month=${MONTH}&year=${YEAR}`, { token: finance });
    check('drift check answers', afterRun.status === 200, afterRun.status);
    const clean = (afterRun.body?.items ?? []).find((i) => i.placement_id === made.placementId);
    check('with payroll in step, this placement is not reported', !clean, clean);

    // The day that arrives late — the whole point.
    await markDay(3);

    const afterLate = await req('GET',
      `/finance/payroll/attendance-drift?month=${MONTH}&year=${YEAR}`, { token: finance });
    const drifted = (afterLate.body?.items ?? []).find((i) => i.placement_id === made.placementId);
    check('the late day is reported as drift', !!drifted, afterLate.body?.items?.length);
    check('it counts three days of attendance against one payroll of two',
      drifted?.attendance === 3 && drifted?.payroll === 2, {
        attendance: drifted?.attendance, payroll: drifted?.payroll });
    check('and says exactly one day is short', drifted?.missing === 1, drifted?.missing);
    check('it reads as "1 day short", not "1 days"',
      drifted?.shortfall === '1 day short', drifted?.shortfall);
    check('a PENDING payroll on no invoice is reported as fixable',
      drifted?.fixable === true, { fixable: drifted?.fixable, reason: drifted?.reason });

    // ── once approved, the figure is locked and it says so ────────────────
    console.log('\n[2] Approval locks the figure, and the report says why');
    const payrollId = (await db.query(
      `SELECT id FROM payroll_records WHERE placement_id = $1 AND period_month = $2 AND period_year = $3`,
      [made.placementId, MONTH, YEAR],
    )).rows[0]?.id;
    if (payrollId) {
      const approved = await req('POST', `/finance/payroll/${payrollId}/approve`, { token: finance });
      check('payroll approves', approved.status === 200 || approved.status === 201, approved.status);

      const afterApprove = await req('GET',
        `/finance/payroll/attendance-drift?month=${MONTH}&year=${YEAR}`, { token: finance });
      const locked = (afterApprove.body?.items ?? []).find((i) => i.placement_id === made.placementId);
      check('still reported after approval', !!locked);
      check('but no longer fixable on its own', locked?.fixable === false, locked?.fixable);
      check('and the reason names approval',
        /APPROVED|approval/i.test(locked?.reason ?? ''), locked?.reason);
    }

    // ── the warning at the moment of marking ──────────────────────────────
    console.log('\n[3] Marking a late day warns instead of returning a bare 200');
    const hr = await login(HR_PHONE);
    const cat = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
    const emp = await db.query(
      `INSERT INTO employees
         (id, employee_id, staff_applicant_id, full_name, mobile, date_of_birth, gender,
          address, city, state, pincode, emergency_contact, joining_date, branch_id,
          department, designation, category_id, employment_type, salary, status,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'Drift Test Staff', $3, '1995-01-01', 'Female',
               'Drift test', 'Delhi', 'Delhi', '110001', '{}'::jsonb, CURRENT_DATE, $4,
               'Home', 'Maid', $5, 'Full Time', 18000, 'Active', now(), now())
       RETURNING id`,
      [
        `DRIFTE${Date.now().toString().slice(-6)}`, made.staffId,
        `97${Date.now().toString().slice(-8)}`, branch.rows[0].id, cat.rows[0].id,
      ],
    );
    made.employeeId = emp.rows[0].id;

    const late = await req('POST', '/attendance/mark', {
      token: hr,
      body: {
        employeeId: made.employeeId,
        date: `${YEAR}-0${MONTH}-04`,
        status: 'Present',
        placementId: made.placementId,
      },
    });
    check('the day is still recorded', late.status === 200 || late.status === 201, late.status);
    check('and it warns that payroll has already run', !!late.body?.payrollWarning,
      late.body?.payrollWarning);
    check('the warning says what to do next', !!late.body?.payrollWarning?.action,
      late.body?.payrollWarning);

    // A month payroll has never touched must not warn — a false alarm on every
    // ordinary day would train everyone to ignore it.
    const ordinary = await req('POST', '/attendance/mark', {
      token: hr,
      body: {
        employeeId: made.employeeId,
        date: '2026-11-12',
        status: 'Present',
        placementId: made.placementId,
      },
    });
    check('a month with no payroll does not warn',
      !ordinary.body?.payrollWarning, ordinary.body?.payrollWarning);
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.employeeId) {
        await db.query(`DELETE FROM attendance WHERE employee_id = $1::uuid`, [made.employeeId]);
        await db.query(`DELETE FROM employees WHERE id = $1::uuid`, [made.employeeId]);
      }
      if (made.placementId) {
        await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE placement_id = $1::uuid`,
          [made.placementId]);
        await db.query(`DELETE FROM payroll_records WHERE placement_id = $1::uuid`, [made.placementId]);
        await db.query(`DELETE FROM staff_daily_attendance WHERE placement_id = $1::uuid`,
          [made.placementId]);
        await db.query(`DELETE FROM placements WHERE id = $1::uuid`, [made.placementId]);
      }
      if (made.staffId) {
        await db.query(`DELETE FROM staff_applicants WHERE id = $1::uuid`, [made.staffId]);
      }
      // Anything a crashed earlier run left behind.
      await db.query(`DELETE FROM employees WHERE employee_id LIKE 'DRIFTE%'`);
      await db.query(`DELETE FROM staff_applicants WHERE staff_code LIKE 'DRIFT%'`);
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) process.exitCode = 1;
  }
}

main();
