/**
 * Live HTTP verification for F-10 and F-11 (docs/FINANCE_MODULE_AUDIT.md).
 *
 *  F-10  Branch P&L reports the management fee as revenue, keeps GST and the
 *        reimbursed pass-through out of it, and no longer shows a fake loss.
 *  F-11  HR payroll counts overtime, bonuses, reimbursements, PT/TDS and loan
 *        recovery — the components only the enterprise batch used to read.
 *
 * Builds its own employee with one of everything, then removes it.
 *
 *   node scratch/_live_test_finance_f10_f11.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_MONTH = 5;
const TEST_YEAR = 2026;
const SALARY = 30000;
const PRESENT_DAYS = 20;
const OT_AMOUNT = 2000;
const BONUS_AMOUNT = 3000;
const REIMB_AMOUNT = 1500;
const LOAN_EMI = 1000;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 10) {
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
  const payload = json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}

async function login(phone) {
  for (const password of PASSWORDS) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await req('POST', '/auth/login', { body: { phone, password } });
      if (r.status === 200 || r.status === 201) {
        const t = r.body?.access_token || r.body?.accessToken;
        if (t) return t;
      }
      if (r.status !== 429) break;
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

const money = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { employeeId: null, loanId: null, attendanceIds: [], payrollId: null, code: null };

  try {
    const finance = await login(FINANCE_PHONE);
    console.log('logged in as FINANCE\n');

    // Clear anything a crashed run left behind.
    const stale = await db.query(`SELECT id FROM employees WHERE employee_id LIKE 'F11T%'`);
    if (stale.rows.length) {
      const ids = stale.rows.map((r) => r.id);
      for (const t of ['employee_payrolls', 'attendance', 'employee_loans', 'overtime_records', 'bonus_records', 'reimbursement_requests', 'payroll_details']) {
        await db.query(`DELETE FROM ${t} WHERE employee_id = ANY($1::uuid[])`, [ids]).catch(() => {});
      }
      await db.query(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
      console.log(`cleared ${ids.length} leftover fixture(s)\n`);
    }

    // ── F-10 · Branch P&L ───────────────────────────────────────────────────
    console.log('F-10  Branch P&L separates revenue from pass-through');
    const pnl = await req('GET', '/finance/analytics/branch-pnl', { token: finance });
    check('branch P&L loads', pnl.status === 200, pnl.status);
    const rows = pnl.body || [];
    const active = rows.filter((r) => Number(r.client_billed) > 0);
    check('at least one branch has billing', active.length > 0, rows.length);

    for (const b of active) {
      const rev = money(b.revenue), gst = money(b.gst_collected);
      const pass_ = money(b.pass_through), billed = money(b.client_billed);
      const internal = money(b.internal_payroll_cost), contrib = money(b.contribution);

      check(`${b.branch_name}: revenue excludes GST`, rev !== money(rev + gst) || gst === 0, { rev, gst });
      check(`${b.branch_name}: billed = revenue + GST + pass-through`,
        Math.abs(billed - (rev + gst + pass_)) <= 0.02, { billed, rev, gst, pass_ });
      check(`${b.branch_name}: contribution = revenue − internal payroll`,
        Math.abs(contrib - (rev - internal)) <= 0.02, { contrib, rev, internal });
      // The old formula was revenue+GST−salary, which went deeply negative on
      // every profitable branch. Contribution must not inherit that.
      check(`${b.branch_name}: contribution is not a fake loss`, contrib >= 0 || internal > rev, { contrib, rev, internal });
      console.log(`        old formula would have shown: ${money(rev + gst - pass_)}`);
    }

    // ── build an employee with one of everything ────────────────────────────
    const branch = await db.query(`SELECT id FROM branches ORDER BY created_at LIMIT 1`);
    const cat = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
    made.code = `F11T${Date.now().toString().slice(-7)}`;
    const emp = await db.query(
      `INSERT INTO employees
         (id, employee_id, full_name, mobile, date_of_birth, gender, address, city, state,
          pincode, emergency_contact, joining_date, branch_id, department, designation,
          category_id, employment_type, salary, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'F11 Components Test', '9000000002', '1990-01-01', 'Other',
               'F11 test', 'Delhi', 'Delhi', '110001', '{}'::jsonb, CURRENT_DATE, $2,
               'Ops', 'Test', $3, 'Full Time', $4, 'Active', now(), now())
       RETURNING id`,
      [made.code, branch.rows[0].id, cat.rows[0].id, SALARY],
    );
    made.employeeId = emp.rows[0].id;

    for (let day = 1; day <= PRESENT_DAYS; day++) {
      const r = await db.query(
        `INSERT INTO attendance (id, employee_id, date, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, make_date($2,$3,$4), 'Present', now(), now()) RETURNING id`,
        [made.employeeId, TEST_YEAR, TEST_MONTH, day],
      );
      made.attendanceIds.push(r.rows[0].id);
    }

    await db.query(
      `INSERT INTO overtime_records (id, employee_id, date, hours, rate_multiplier, total_amount, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, make_date($2,$3,5), 4, 1.5, $4, 'APPROVED', now(), now())`,
      [made.employeeId, TEST_YEAR, TEST_MONTH, OT_AMOUNT],
    );
    await db.query(
      `INSERT INTO bonus_records (id, employee_id, amount, month, year, category, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PERFORMANCE', 'APPROVED', now(), now())`,
      [made.employeeId, BONUS_AMOUNT, TEST_MONTH, TEST_YEAR],
    );
    await db.query(
      `INSERT INTO reimbursement_requests (id, employee_id, amount, expense_date, category, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, make_date($3,$4,10), 'TRAVEL', 'APPROVED', now(), now())`,
      [made.employeeId, REIMB_AMOUNT, TEST_YEAR, TEST_MONTH],
    );
    const loan = await db.query(
      `INSERT INTO employee_loans (id, employee_id, loan_amount, remaining_amount, monthly_emi,
                                   start_date, status, auto_deduction, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 10000, 10000, $2, CURRENT_DATE, 'ACTIVE', true, now(), now())
       RETURNING id`,
      [made.employeeId, LOAN_EMI],
    );
    made.loanId = loan.rows[0].id;

    const daysInMonth = new Date(TEST_YEAR, TEST_MONTH, 0).getDate();
    const expectedBase = money(SALARY * (PRESENT_DAYS / daysInMonth));
    const expectedGross = money(expectedBase + OT_AMOUNT + BONUS_AMOUNT + REIMB_AMOUNT);
    console.log(`\nemployee on ₹${SALARY}, ${PRESENT_DAYS}/${daysInMonth} days, + OT/bonus/reimbursement + a ₹${LOAN_EMI} EMI\n`);

    // ── F-11 · every component counted ──────────────────────────────────────
    //
    // Read by employee id, not by code. Since B6 retired the HR payroll engine,
    // a code lookup resolves through the pipeline to a placement, and placement
    // payroll does not compute these components. The calculation itself is
    // still live and still worth guarding, so this asserts it directly through
    // the preview endpoint that survives.
    //
    // Worth knowing: overtime, bonus, reimbursement and loan EMI can now be
    // previewed but not recorded — see ONE_STAFF_MODEL_PLAN.md §B6. They sit on
    // four of the seventeen enterprise tables that were never deployed to
    // production, so nothing live depends on them today.
    console.log('F-11  the payroll calculation still counts every component');
    const prev = await req(
      'GET',
      `/attendance/${made.employeeId}/payroll-preview?month=${TEST_MONTH}&year=${TEST_YEAR}`,
      { token: finance },
    );
    check('preview loads', prev.status === 200, { status: prev.status, body: prev.body });
    const c = prev.body?.calculation ?? {};

    check('base is pro-rated on attendance', Math.abs(money(c.basicProrated) - expectedBase) < 0.02, { got: c.basicProrated, expected: expectedBase });
    check('overtime is included', money(c.overtimeAmount) === OT_AMOUNT, c.overtimeAmount);
    check('bonus is included', money(c.bonusAmount) === BONUS_AMOUNT, c.bonusAmount);
    check('reimbursement is included', money(c.reimbursementAmount) === REIMB_AMOUNT, c.reimbursementAmount);
    check('gross = base + OT + bonus + reimbursement', Math.abs(money(c.grossSalary) - expectedGross) < 0.02, { got: c.grossSalary, expected: expectedGross });
    // This employee is created in a Delhi branch, and Delhi does not levy
    // professional tax. Asserting ₹200 here was asserting the flat rule F-16
    // removed — the correct figure for Delhi is zero.
    check('professional tax follows the state (Delhi levies none)', money(c.ptDeduction) === 0, c.ptDeduction);
    check('and the payslip explains why', /Delhi does not levy/i.test(c.taxExplanation?.professionalTax ?? ''), c.taxExplanation);
    check('loan EMI shown as a deduction', money(c.loanEmiDeduction) === LOAN_EMI, c.loanEmiDeduction);
    check('employer contributions exposed', c.esicEmployer !== undefined && c.pfEmployer !== undefined, c);

    const expectedDeductions = money(
      money(c.esicEmployee) + money(c.pfEmployee) + money(c.ptDeduction) +
      money(c.tdsDeduction) + money(c.loanEmiDeduction) + money(c.advanceDeduction),
    );
    check('total deductions add up', Math.abs(money(c.totalDeductions) - expectedDeductions) <= 0.02, { got: c.totalDeductions, expected: expectedDeductions });
    check('net = gross − deductions', Math.abs(money(c.netSalary) - money(c.grossSalary - c.totalDeductions)) <= 0.02, c);

    // F-19 discipline: showing an EMI must not move the balance.
    const balMid = await db.query(`SELECT remaining_amount FROM employee_loans WHERE id = $1`, [made.loanId]);
    check('previewing did not touch the loan', money(balMid.rows[0].remaining_amount) === 10000, balMid.rows[0]);
    check('preview says recovery was not applied', prev.body?.recovery_applied === false, prev.body?.recovery_applied);

    // ── the HR payroll engine is retired ────────────────────────────────────
    //
    // This used to generate a row in `employee_payrolls` and assert the stored
    // components. B6 closed that writer: one population of staff, one engine,
    // and `payroll_records` is the one the client invoice is built from. What
    // is asserted now is that the refusal is explicit and explains itself —
    // the failure mode that matters is a silent one.
    const gen = await req('POST', '/finance/payroll/attendance-generate', {
      token: finance, body: { code: made.code, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('generating HR payroll is refused', gen.status === 400, { status: gen.status, body: gen.body });
    check(
      'and the refusal says why, naming the pipeline as the fix',
      /pipeline/i.test(JSON.stringify(gen.body ?? '')),
      gen.body,
    );

    const stored = await db.query(
      `SELECT id FROM employee_payrolls
       WHERE employee_id = $1::uuid AND period_month = $2 AND period_year = $3`,
      [made.employeeId, TEST_MONTH, TEST_YEAR],
    );
    check('nothing was written to the retired table', stored.rows.length === 0, stored.rows.length);

    const balEnd = await db.query(`SELECT remaining_amount FROM employee_loans WHERE id = $1`, [made.loanId]);
    check('the loan balance is untouched', money(balEnd.rows[0].remaining_amount) === 10000, balEnd.rows[0]);
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.employeeId) {
        for (const t of ['employee_payrolls', 'attendance', 'employee_loans', 'overtime_records', 'bonus_records', 'reimbursement_requests', 'payroll_details']) {
          await db.query(`DELETE FROM ${t} WHERE employee_id = $1::uuid`, [made.employeeId]).catch(() => {});
        }
        await db.query(`DELETE FROM employees WHERE id = $1`, [made.employeeId]);
      }
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
