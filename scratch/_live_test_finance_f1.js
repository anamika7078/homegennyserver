/**
 * Live HTTP verification for Phase F1 of docs/FINANCE_MODULE_AUDIT.md.
 *
 * Covers F-01 (attendance is really read), F-02 (invoice resolves its client),
 * F-03 (line items reconcile to the total), F-04 (field payslip reaches HR),
 * F-05 (deposit ledger reads the table intake writes), F-08 (webhook signature).
 *
 * Creates its own placement attendance, payroll, invoice and a throwaway
 * employee link, then removes all of it — nothing it makes is left behind.
 *
 *   node scratch/_live_test_finance_f1.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const HR_PHONE = '9800000008';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

// A period far enough back that no real invoice exists for it, so the run
// cannot collide with genuine billing.
const TEST_MONTH = 3;
const TEST_YEAR = 2026;

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

async function req(method, path, { token, body, headers } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
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

const round2 = (n) => Math.round(n * 100) / 100;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // Everything this run creates, torn down in the finally block.
  const made = {
    attendanceIds: [], employeeId: null, invoiceId: null, payrollIds: [],
    staffId: null, depositId: null,
  };

  try {
    const financeToken = await login(FINANCE_PHONE);
    const hrToken = await login(HR_PHONE);
    console.log('logged in as FINANCE + HR\n');

    // ── F-08 · webhook signature ────────────────────────────────────────────
    console.log('F-08  Razorpay webhook signature');
    const unsigned = await req('POST', '/finance/settlements/webhook', {
      body: { event: 'payment.captured', payload: { payment: { entity: { order_id: 'order_probe', id: 'pay_probe' } } } },
    });
    check('unsigned webhook is rejected', unsigned.status === 401, unsigned.status);
    const badSig = await req('POST', '/finance/settlements/webhook', {
      body: { event: 'payment.captured', payload: {} },
      headers: { 'x-razorpay-signature': 'deadbeef' },
    });
    check('bad signature is rejected', badSig.status === 401, badSig.status);

    // ── F-05 · deposit ledger ───────────────────────────────────────────────
    console.log('\nF-05  Deposit ledger reads the table intake writes');
    const depRows = await db.query(`SELECT count(*)::int AS n FROM deposits WHERE amount > 0`);
    const expectedDeposits = depRows.rows[0].n;
    const deposits = await req('GET', '/finance/deposits', { token: financeToken });
    check('deposits list is not empty', Array.isArray(deposits.body) && deposits.body.length > 0, deposits.body?.length);
    check(
      `deposits list matches table (${expectedDeposits})`,
      Array.isArray(deposits.body) && deposits.body.length === expectedDeposits,
      { api: deposits.body?.length, db: expectedDeposits },
    );
    const stats = await req('GET', '/finance/deposits/stats', { token: financeToken });
    check('deposit stats show money collected', parseFloat(stats.body?.total_collected ?? '0') > 0, stats.body);
    check('deposit stats expose refund_due_count', stats.body?.refund_due_count !== undefined, stats.body);

    const firstDeposit = (deposits.body || [])[0];
    check('row carries staff_id (what the event endpoint is keyed by)', !!firstDeposit?.staff_id, Object.keys(firstDeposit || {}));
    check('row carries amount', firstDeposit?.amount !== undefined, Object.keys(firstDeposit || {}));

    // ── deposit events, on a throwaway staff member ─────────────────────────
    // The endpoint takes a STAFF id, not a deposit id — the web console was
    // sending the wrong one, so this path had never actually worked.
    console.log('\n      recording an event on a throwaway deposit');
    const anyBranch = await db.query(`SELECT id FROM branches ORDER BY created_at LIMIT 1`);
    const tmpStaff = await db.query(
      `INSERT INTO staff_applicants
         (id, staff_code, full_name, mobile, date_of_birth,
          address, series, branch_id, pipeline_stage, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'F1 Deposit Probe', $2,
               '1990-01-01', 'probe', 'MAID', $3, 'S1_INTAKE', now(), now())
       RETURNING id`,
      [`F1DEP${Date.now().toString().slice(-6)}`, `7${Date.now().toString().slice(-9)}`, anyBranch.rows[0].id],
    );
    made.staffId = tmpStaff.rows[0].id;
    const tmpDep = await db.query(
      `INSERT INTO deposits (id, staff_id, amount, status, collected_at, created_at)
       VALUES (gen_random_uuid(), $1, 1000, 'COLLECTED', now(), now()) RETURNING id`,
      [made.staffId],
    );
    made.depositId = tmpDep.rows[0].id;

    const badPartial = await req('POST', `/finance/deposits/${made.staffId}/event`, {
      token: financeToken, body: { event: 'PARTIAL_REFUND' },
    });
    check('PARTIAL_REFUND without an amount is rejected', badPartial.status === 400, badPartial.status);

    const tooMuch = await req('POST', `/finance/deposits/${made.staffId}/event`, {
      token: financeToken, body: { event: 'PARTIAL_REFUND', refund_amount: 5000 },
    });
    check('refund larger than the deposit is rejected', tooMuch.status === 400, tooMuch.status);

    const good = await req('POST', `/finance/deposits/${made.staffId}/event`, {
      token: financeToken,
      body: { event: 'PARTIAL_REFUND', refund_amount: 250, notes: 'F1 probe', scenario_code: 'M3X-08' },
    });
    check('valid partial refund is recorded', good.status === 200 || good.status === 201, { status: good.status, body: good.body });
    check('response reports the refund amount', Number(good.body?.refund_amount) === 250, good.body);

    const persisted = await db.query(
      `SELECT event, refund_amount, event_scenario_code, event_at FROM deposits WHERE id = $1`,
      [made.depositId],
    );
    check('event landed on the deposit row', persisted.rows[0]?.event === 'PARTIAL_REFUND', persisted.rows[0]);
    check('refund amount persisted', Number(persisted.rows[0]?.refund_amount) === 250, persisted.rows[0]);
    check('scenario code persisted', persisted.rows[0]?.event_scenario_code === 'M3X-08', persisted.rows[0]);

    const again = await req('POST', `/finance/deposits/${made.staffId}/event`, {
      token: financeToken, body: { event: 'REFUND' },
    });
    check('an already-resolved deposit is not overwritten', again.status === 400, again.status);

    const unknownStaff = await req('POST', `/finance/deposits/${made.depositId}/event`, {
      token: financeToken, body: { event: 'REFUND' },
    });
    check('passing a deposit id instead of a staff id 404s', unknownStaff.status === 404, unknownStaff.status);

    // ── pick a placement to bill ────────────────────────────────────────────
    const cand = await db.query(`
      SELECT p.id AS placement_id, p.staff_id, p.client_id, sa.staff_code, sa.full_name,
             sa.branch_id, fc.customer_name
      FROM placements p
      JOIN staff_applicants sa ON sa.id = p.staff_id
      JOIN finance_customers fc ON fc.id = p.client_id
      LEFT JOIN employees e ON e.staff_applicant_id = sa.id AND e.deleted_at IS NULL
      WHERE p.status = 'CONFIRMED'
        AND p.staff_salary IS NOT NULL AND p.management_fee IS NOT NULL
        AND e.id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM client_invoices ci
          WHERE ci.placement_id = p.id AND ci.period_month = $1 AND ci.period_year = $2
        )
      ORDER BY p.created_at DESC
      LIMIT 1
    `, [TEST_MONTH, TEST_YEAR]);

    if (!cand.rows.length) {
      console.log('\n  no billable placement available for the test period — cannot continue');
      process.exitCode = 1;
      return;
    }
    const target = cand.rows[0];
    console.log(`\nusing ${target.staff_code} (${target.full_name}) → ${target.customer_name}`);

    // ── seed attendance: 20 present days in the test period ─────────────────
    const PRESENT_DAYS = 20;
    for (let day = 1; day <= PRESENT_DAYS; day++) {
      const r = await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', $1, now(), now())
         ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING
         RETURNING id`,
        [target.staff_id, target.placement_id, target.branch_id, TEST_YEAR, TEST_MONTH, day],
      );
      if (r.rows[0]) made.attendanceIds.push(r.rows[0].id);
    }
    console.log(`seeded ${made.attendanceIds.length} attendance days\n`);

    // ── F-01 · attendance is actually read ──────────────────────────────────
    console.log('F-01  Attendance drives the calculation');
    const preview = await req(
      'GET',
      `/finance/payroll/attendance-preview?code=${encodeURIComponent(target.staff_code)}&month=${TEST_MONTH}&year=${TEST_YEAR}`,
      { token: financeToken },
    );
    const daysInMonth = new Date(TEST_YEAR, TEST_MONTH, 0).getDate();
    check('preview counts the seeded days', preview.body?.billable_days === PRESENT_DAYS, preview.body?.billable_days);
    check('preview does not assume a full month', preview.body?.billable_days < daysInMonth, {
      billable: preview.body?.billable_days, daysInMonth,
    });
    const monthly = parseFloat(preview.body?.monthly_salary ?? '0');
    const expectedGross = round2(monthly * (PRESENT_DAYS / daysInMonth));
    check('gross is pro-rated, not full salary', Math.abs(preview.body?.prorated_gross - expectedGross) < 0.02, {
      got: preview.body?.prorated_gross, expected: expectedGross,
    });

    // ── run the payroll, then raise the invoice ─────────────────────────────
    const gen = await req('POST', '/finance/payroll/attendance-generate', {
      token: financeToken,
      body: { code: target.staff_code, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('payroll generated', gen.status === 200 || gen.status === 201, { status: gen.status, body: gen.body });
    if (gen.body?.payroll_id) made.payrollIds.push(gen.body.payroll_id);

    // Payroll records what is owed and stops there; Finance raises the client's
    // invoice separately, from their unit code.
    const raised = await req('POST', '/finance/invoices/consolidated/generate', {
      token: financeToken,
      body: { customer_id: target.client_id, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('the client invoice is raised',
      raised.status === 200 || raised.status === 201, { status: raised.status, body: raised.body });
    made.invoiceId = (raised.body?.invoice ?? raised.body)?.id ?? null;

    if (!made.invoiceId) {
      console.log('  no invoice id returned — stopping before the invoice assertions');
      process.exitCode = 1;
      return;
    }

    // ── F-02 · invoice resolves its client ──────────────────────────────────
    console.log('\nF-02  Invoice resolves its own client');
    const inv = await req('GET', `/finance/invoices/${made.invoiceId}`, { token: financeToken });
    check('invoice detail loads', inv.status === 200, inv.status);
    check('client_name is populated', !!inv.body?.client_name, inv.body?.client_name);
    check('client_name matches the finance customer', inv.body?.client_name === target.customer_name, {
      got: inv.body?.client_name, expected: target.customer_name,
    });
    const list = await req('GET', '/finance/invoices?limit=50', { token: financeToken });
    const listed = (list.body?.data || []).find((r) => r.id === made.invoiceId);
    check('invoice list also shows the client', !!listed?.client_name, listed?.client_name);

    // ── F-03 · line items reconcile ─────────────────────────────────────────
    console.log('\nF-03  Line items reconcile to the total');
    const items = inv.body?.line_items || [];
    const itemsTotal = round2(items.reduce((s, li) => s + Number(li.amount), 0));
    const invoiceTotal = round2(Number(inv.body?.total_amount));
    check('invoice has line items', items.length > 0, items.length);
    check(
      `line items sum to the total (${itemsTotal} vs ${invoiceTotal})`,
      Math.abs(itemsTotal - invoiceTotal) <= 0.01,
      { itemsTotal, invoiceTotal, items },
    );
    check('server agrees it reconciles', inv.body?.reconciles === true, inv.body?.reconciles);
    check('employer ESIC is itemised', items.some((li) => /employer esic/i.test(li.description)), items.map((i) => i.description));
    check('employer PF is itemised', items.some((li) => /employer pf/i.test(li.description)), items.map((i) => i.description));

    const stored = await db.query(
      `SELECT esic_employer, pf_employer, staff_salary_component, management_fee, gst_amount, total_amount
       FROM client_invoices WHERE id = $1`, [made.invoiceId],
    );
    const row = stored.rows[0];
    check('employer ESIC persisted on the invoice', parseFloat(row.esic_employer) > 0, row.esic_employer);
    check('employer PF persisted on the invoice', parseFloat(row.pf_employer) > 0, row.pf_employer);
    const columnsTotal = round2(
      parseFloat(row.staff_salary_component) + parseFloat(row.management_fee) +
      parseFloat(row.gst_amount) + parseFloat(row.esic_employer) + parseFloat(row.pf_employer),
    );
    check('stored columns reconstruct the total', Math.abs(columnsTotal - parseFloat(row.total_amount)) <= 0.01, {
      columnsTotal, total: row.total_amount,
    });

    const itemRows = await db.query(`SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1`, [made.invoiceId]);
    check('invoice_items rows were written', itemRows.rows[0].n === items.length, { db: itemRows.rows[0].n, api: items.length });

    // ── F-04 · field payslip reaches HR ─────────────────────────────────────
    console.log('\nF-04  Field payroll appears as an HR payslip');
    const cat = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
    const emp = await db.query(
      `INSERT INTO employees
         (id, staff_applicant_id, employee_id, full_name, mobile, date_of_birth, gender,
          address, city, state, pincode, emergency_contact, joining_date, branch_id,
          department, designation, category_id, employment_type, salary, status,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '9000000000', '1990-01-01', 'Other',
               'F1 test', 'Delhi', 'Delhi', '110001', '{}'::jsonb, CURRENT_DATE, $4,
               'Ops', 'Field Staff', $5, 'Full Time', 1, 'Active', now(), now())
       RETURNING id`,
      [target.staff_id, `F1TEST${Date.now().toString().slice(-6)}`, target.full_name, target.branch_id, cat.rows[0].id],
    );
    made.employeeId = emp.rows[0].id;

    const slips = await req('GET', `/employees/${made.employeeId}/payslips`, { token: hrToken });
    check('payslip list loads', slips.status === 200, { status: slips.status, body: slips.body });
    const fieldSlips = (slips.body?.items || []).filter((s) => s.source === 'FIELD_PAYROLL');
    check('a FIELD_PAYROLL slip is present', fieldSlips.length > 0, slips.body?.items?.length);
    const slip = fieldSlips.find((s) => s.periodMonth === TEST_MONTH && s.periodYear === TEST_YEAR);
    check('slip is for the period just run', !!slip, fieldSlips.map((s) => `${s.periodMonth}/${s.periodYear}`));
    if (slip) {
      check('slip carries the pro-rated gross', Math.abs(slip.grossSalary - expectedGross) < 0.02, {
        got: slip.grossSalary, expected: expectedGross,
      });
      check('slip net = gross - deductions', Math.abs(round2(slip.grossSalary - slip.totalDeductions) - slip.netSalary) <= 0.01, slip);
      check('slip shows days paid', slip.presentDays === PRESENT_DAYS, slip.presentDays);

      const pdf = await fetchWithBackoff(
        `${BASE}/employees/${made.employeeId}/payslips/pdf?ref=${encodeURIComponent(slip.ref)}`,
        { headers: { Authorization: `Bearer ${hrToken}` } },
      );
      const buf = Buffer.from(await pdf.arrayBuffer());
      check('payslip PDF downloads', pdf.status === 200, pdf.status);
      check('payslip PDF is a real PDF', buf.slice(0, 4).toString() === '%PDF', buf.slice(0, 8).toString());
    }
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    // ── cleanup ─────────────────────────────────────────────────────────────
    console.log('\ncleaning up…');
    try {
      if (made.employeeId) await db.query(`DELETE FROM employees WHERE id = $1`, [made.employeeId]);
      if (made.invoiceId) {
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM client_invoices WHERE id = $1`, [made.invoiceId]);
      }
      for (const id of made.payrollIds) await db.query(`DELETE FROM payroll_records WHERE id = $1`, [id]);
      if (made.attendanceIds.length) {
        await db.query(`DELETE FROM staff_daily_attendance WHERE id = ANY($1::uuid[])`, [made.attendanceIds]);
      }
      if (made.depositId) await db.query(`DELETE FROM deposits WHERE id = $1`, [made.depositId]);
      if (made.staffId) await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [made.staffId]);
      // Anything a crashed earlier run left behind, so a stale probe can never
      // skew the "deposits list matches table" assertion above.
      await db.query(`DELETE FROM deposits WHERE staff_id IN
                        (SELECT id FROM staff_applicants WHERE staff_code LIKE 'F1DEP%')`);
      await db.query(`DELETE FROM staff_applicants WHERE staff_code LIKE 'F1DEP%'`);
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
