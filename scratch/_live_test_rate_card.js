/**
 * The cost sheet, end to end: quote → placement → payroll → invoice.
 *
 * scratch/_check_rate_card.js proves the wage engine reproduces the Terrier
 * cost sheet. That is not the part that costs money. This walks a column of
 * the sheet through the real API — RM creates the placement from the wage
 * form, a full month is worked, Finance runs payroll and raises the invoice —
 * and checks the figure the client is billed against the sheet's CTC, and the
 * figure the staff member is paid against the sheet's net.
 *
 * Before the fix this failed by about 21%: placement.service stored the
 * sheet's *net* as the wage, so payroll took the employee's PF and ESIC a
 * second time, and relieving, LWF and uniform were never billed at all.
 *
 *   node scratch/_live_test_rate_card.js
 */
require('dotenv').config();
const { Client } = require('pg');
const { createCustomer } = require('./_fixtures');

let computeWageBreakup;
try {
  ({ computeWageBreakup } = require('../dist/modules/placement/wage-calculator.util'));
} catch {
  require('ts-node/register');
  ({ computeWageBreakup } = require('../src/modules/placement/wage-calculator.util'));
}

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];

const MONTH = 4;
const YEAR = 2026;
const TOLERANCE = 1.5;

/** "Lady Guard · Semi-Skilled · 12hr" from the Haryana Zone-I sheet. */
const WAGE_CONFIG = {
  basic_wage: 11552, da: 0, hra: 0, skilled_allowance: 0,
  working_hours: 12, additional_hours_pct: 50,
  employer_pf_pct: 13, employer_pf_max: 15000, employee_pf_pct: 12,
  employer_esic_pct: 3.25, employee_esic_pct: 0.75,
  bonus_pct: 8.33, leave_days: 32, lwf_amount: 62, uniform_allowance: 275,
  relieving_pct: 16.67, management_pct: 5.5, professional_tax: 0,
};
/** What the sheet prints for that column. */
const SHEET = { ctc: 28051, net: 18318 };

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= TOLERANCE;

async function req(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
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
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.status === 200 || r.status === 201) {
      const t = r.body?.access_token || r.body?.accessToken;
      if (t) return t;
    }
  }
  throw new Error(`could not log in as ${phone}`);
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customer: null, placementId: null, staffId: null, invoiceId: null };

  try {
    const rm = await login(RM_PHONE);
    const finance = await login(FINANCE_PHONE);
    console.log('logged in as RM + FINANCE\n');

    const want = computeWageBreakup(WAGE_CONFIG);
    const otherCharges = want.relieving + want.lwf + want.uniform;

    console.log('Sheet column: Lady Guard · Semi-Skilled · 12hr');
    check('the engine still reproduces the sheet CTC', near(want.totalCTC, SHEET.ctc),
      { engine: want.totalCTC, sheet: SHEET.ctc });
    check('and the sheet net take home', near(want.netSalary, SHEET.net),
      { engine: want.netSalary, sheet: SHEET.net });

    // ── RM creates the placement from the wage form ────────────────────────
    console.log('\n[1] RM creates the placement from the wage form');
    const free = (await db.query(`
      SELECT sa.id, sa.staff_code FROM staff_applicants sa
      LEFT JOIN placements pl ON pl.staff_id = sa.id
      WHERE sa.pipeline_stage = 'S5_DEPLOY' AND pl.id IS NULL
      ORDER BY sa.staff_code LIMIT 1`)).rows[0];
    if (!free) throw new Error('no deployable staff without a placement — seed one with scratch/_seed_staff_s4.js --deploy');
    made.staffId = free.id;
    made.customer = await createCustomer(db, 'RateCard');

    const created = await req('POST', '/placements', {
      token: rm,
      body: {
        staff_id: free.id, client_id: made.customer.customerId,
        status: 'CONFIRMED', placement_type: 'PERMANENT',
        wage_config: WAGE_CONFIG,
      },
    });
    check('placement is created', created.status === 200 || created.status === 201,
      { status: created.status, body: created.body });
    made.placementId = created.body?.id;
    if (!made.placementId) throw new Error('no placement id returned');

    const stored = (await db.query(
      `SELECT staff_salary, management_fee, metadata FROM placements WHERE id = $1`, [made.placementId])).rows[0];
    // The wage stored has to be what the staff member earns *before* their own
    // PF and ESIC, or payroll deducts them twice.
    check('the stored wage is the sheet gross, not the net', near(stored.staff_salary, want.grossEarnings),
      { stored: stored.staff_salary, gross: want.grossEarnings, net: want.netSalary });
    check('the stored fee is the management fee', near(stored.management_fee, want.managementFee),
      { stored: stored.management_fee, want: want.managementFee });
    check('the breakup is kept on the placement', !!stored.metadata?.wage_breakup, Object.keys(stored.metadata ?? {}));

    // ── a full month worked ────────────────────────────────────────────────
    console.log('\n[2] A full month is worked');
    const dim = new Date(YEAR, MONTH, 0).getDate();
    const branch = (await db.query(`SELECT branch_id FROM staff_applicants WHERE id = $1`, [free.id])).rows[0];
    for (let d = 1; d <= dim; d++) {
      await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', $1, now(), now())
         ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING`,
        [free.id, made.placementId, branch.branch_id, YEAR, MONTH, d]);
    }
    check(`all ${dim} days marked, so nothing is pro-rated away`, true);

    // ── payroll ────────────────────────────────────────────────────────────
    console.log('\n[3] Finance runs payroll');
    const pay = await req('POST', '/finance/payroll/attendance-generate', {
      token: finance, body: { code: free.staff_code, month: MONTH, year: YEAR },
    });
    check('payroll runs', pay.status === 200 || pay.status === 201, { status: pay.status, body: pay.body });

    const pr = (await db.query(
      `SELECT gross_salary, net_salary, esic_employer, pf_employer, management_fee, other_charges
         FROM payroll_records WHERE placement_id = $1 AND period_month = $2 AND period_year = $3`,
      [made.placementId, MONTH, YEAR])).rows[0];
    check('payroll gross is the sheet gross', near(pr?.gross_salary, want.grossEarnings),
      { got: pr?.gross_salary, want: want.grossEarnings });
    check('employer PF matches the sheet', near(pr?.pf_employer, want.epfoEmployer),
      { got: pr?.pf_employer, want: want.epfoEmployer });
    check('employer ESIC matches the sheet', near(pr?.esic_employer, want.esicEmployer),
      { got: pr?.esic_employer, want: want.esicEmployer });
    check('relieving + LWF + uniform are recorded', near(pr?.other_charges, otherCharges),
      { got: pr?.other_charges, want: otherCharges });
    // The whole point of the staff side: what they take home.
    check('the staff member is paid the sheet net', near(pr?.net_salary, SHEET.net),
      { got: pr?.net_salary, sheet: SHEET.net });

    // ── the invoice ────────────────────────────────────────────────────────
    console.log('\n[4] Finance raises the invoice');
    const gen = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: made.customer.customerId, month: MONTH, year: YEAR },
    });
    check('the invoice is raised', gen.status === 200 || gen.status === 201, { status: gen.status, body: gen.body });
    made.invoiceId = (gen.body?.invoice ?? gen.body)?.id;

    const inv = (await db.query(
      `SELECT taxable_value, total_amount, gst_amount FROM client_invoices WHERE id = $1`, [made.invoiceId])).rows[0];
    // This is the number the whole exercise is about.
    check('the client is billed the sheet CTC', near(inv?.taxable_value, SHEET.ctc),
      { billed: inv?.taxable_value, sheet: SHEET.ctc, short_by: Math.round(SHEET.ctc - Number(inv?.taxable_value ?? 0)) });

    const items = (await db.query(
      `SELECT description, amount FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order`, [made.invoiceId])).rows;
    check('the agreed charges appear as their own line',
      items.some((i) => /Agreed charges/.test(i.description)), items.map((i) => i.description));
    const itemSum = Math.round(items.reduce((t, i) => t + Number(i.amount), 0) * 100) / 100;
    check('line items still reconcile to the invoice total', near(itemSum, inv?.total_amount),
      { itemSum, total: inv?.total_amount });

    // ── the quotation side ─────────────────────────────────────────────────
    // The same sheet drives Finance's Commercial Calculator, through a second
    // copy of the formula that nothing was testing. What is quoted and what is
    // billed have to be the same number.
    console.log('\n[5] The Commercial Calculator quotes the same sheet');
    const quote = await req('POST', '/finance/commercial/calculations/calculate', {
      token: finance,
      body: {
        state: 'Haryana', zone: 'Zone-I',
        items: [{
          category: 'Semi-Skilled', no_of_resources: 1, working_hours: 12,
          ...WAGE_CONFIG,
          // Pinned so a wage config sitting in the database cannot quietly
          // change what this is comparing.
          nfh_applicable: false, training_charges: 0,
          pf_applicable: true, esic_applicable: true, bonus_applicable: true,
          lwf_applicable: true, uniform_applicable: true, relieving_applicable: true,
        }],
      },
    });
    check('the calculator answers', quote.status === 200 || quote.status === 201,
      { status: quote.status, body: quote.body });
    const q = (Array.isArray(quote.body) ? quote.body[0] : null) ?? {};
    for (const [label, got, expected] of [
      ['sub total 2', q.subtotal2, want.subtotal2],
      ['employer PF', q.employerPf, want.epfoEmployer],
      ['employer ESIC', q.esic, want.esicEmployer],
      ['leave wages', q.leaveWages, want.leaveWages],
      ['relieving', q.relieving, want.relieving],
      ['management fee', q.managementFee, want.managementFee],
      ['monthly cost is the sheet CTC', q.monthlyCost, SHEET.ctc],
      ['rate per day', q.dailyRate, want.ratePerDay],
      ['rate per hour', q.hourlyRate, want.ratePerHour],
      ['net take home', q.netSalary, SHEET.net],
    ]) {
      check(`quote — ${label}`, near(got, expected), { got, expected });
    }
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.invoiceId) {
        await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM payment_reminders WHERE invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM client_invoices WHERE id = $1`, [made.invoiceId]);
      }
      if (made.placementId) {
        await db.query(`DELETE FROM staff_daily_attendance WHERE placement_id = $1`, [made.placementId]);
        await db.query(`DELETE FROM payroll_records WHERE placement_id = $1`, [made.placementId]);
        await db.query(`DELETE FROM placements WHERE id = $1`, [made.placementId]);
      }
      if (made.customer) await made.customer.teardown();
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
