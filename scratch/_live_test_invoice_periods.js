/**
 * Live HTTP verification for invoicing a client in parts of a month.
 *
 * The business rule, in the user's words: placement starts on the 1st, an
 * invoice is made on the 7th → 1–7 is billed, nothing else can ever bill
 * 1–7, and the next invoice starts on the 8th.
 *
 *  - invoice to the 7th → period 1–7, payroll for 1–7 run automatically
 *  - asking again for any date ≤ 7 → refused, naming the invoice
 *  - the 1–7 invoice SENT, a later invoice still issues (8–20), then 21–31
 *  - the three invoices add up to exactly what one whole-month invoice is
 *    (per-duty and monthly-salary staff both), statutory included
 *  - the database itself refuses an overlapping invoice and overlapping payroll
 *  - the staff member's slip for the month is one slip, summing all parts
 *  - the printed invoice reads its own dates; service starts on the join date
 *  - salary slips for an invoice: one per staff, same days
 *
 * Uses December 2025 so it cannot collide with real billing. Builds and
 * removes its own rows; restores the finance.* settings.
 *
 *   node scratch/_live_test_invoice_periods.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const HR_PHONE = '9800000008';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const MONTH = 12;
const YEAR = 2025;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''}`); }
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}
async function req(method, path, { token, body, raw } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, text: await res.text() };
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  const payload = json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}
async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken;
    if (t) return t;
  }
  throw new Error(`Could not log in as ${phone}`);
}
const round2 = (n) => Math.round(n * 100) / 100;
const day = (d) => `${YEAR}-12-${String(d).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

async function main() {
  const url = process.env.DATABASE_URL;
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const db = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await db.connect();
  const saved = (await db.query(`SELECT key, value FROM system_settings WHERE key LIKE 'finance.%'`)).rows;
  const made = { customers: [], staff: [], placements: [] };

  try {
    const finance = await login(FINANCE_PHONE);
    const hr = await login(HR_PHONE);
    check('finance and HR log in', !!(finance && hr));
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const marker = (await db.query(`SELECT id FROM users WHERE phone = $1`, [FINANCE_PHONE])).rows[0].id;

    // Two identical clients: A is invoiced in three parts, B once for the month.
    // Whatever A's parts add up to must equal B's single invoice.
    const client = async (tag) => {
      const c = await db.query(
        `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                        bill_no_prefix, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'x', 'x', 'New Delhi', 'Delhi', $3, 'ACTIVE', now(), now()) RETURNING id`,
        [`Period Test ${tag}`, `PERT-${tag}`, `PERT${tag}`],
      );
      made.customers.push(c.rows[0].id);
      return c.rows[0].id;
    };
    const A = await client('A');
    const B = await client('B');

    const staff = async (code, name) => {
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [code, name, `94000000${code.slice(-2)}`, branchId],
      );
      made.staff.push(s.rows[0].id);
      return s.rows[0].id;
    };
    // Per client: one live-in per duty (ESIC/PF off), one monthly-salary maid
    // with ESIC and PF on — so the statutory true-up across parts is exercised.
    const placeDuty = async (staffId, clientId) => {
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', 24, 'PER_DUTY', 517, 585, false, false,
                 $4::date, $4::date, now(), now()) RETURNING id`,
        [staffId, clientId, branchId, day(1)],
      );
      made.placements.push(p.rows[0].id);
      return p.rows[0].id;
    };
    const placeMonthly = async (staffId, clientId) => {
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type, shift_hours,
                                 staff_salary, management_fee, confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', 8, 15500, 1550,
                 $4::date, $4::date, now(), now()) RETURNING id`,
        [staffId, clientId, branchId, day(3)],
      );
      made.placements.push(p.rows[0].id);
      return p.rows[0].id;
    };
    const mark = async (staffId, placementId, days) => {
      for (const d of days) {
        await db.query(
          `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                               hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 8, $5, now(), now())`,
          [staffId, placementId, branchId, day(d), marker],
        );
      }
    };
    const dutyDays = range(1, 31).filter((d) => ![6, 18].includes(d));      // 29 duties
    const maidDays = range(3, 31).filter((d) => d % 7 !== 0);               // monthly maid from the 3rd

    const aDuty = await staff('PERTA1', 'Live-in A'); const aDutyP = await placeDuty(aDuty, A);
    const aMaid = await staff('PERTA2', 'Maid A');    const aMaidP = await placeMonthly(aMaid, A);
    const bDuty = await staff('PERTB1', 'Live-in B'); const bDutyP = await placeDuty(bDuty, B);
    const bMaid = await staff('PERTB2', 'Maid B');    const bMaidP = await placeMonthly(bMaid, B);
    for (const [s, p, d] of [[aDuty, aDutyP, dutyDays], [aMaid, aMaidP, maidDays], [bDuty, bDutyP, dutyDays], [bMaid, bMaidP, maidDays]]) {
      await mark(s, p, d);
    }

    const gen = (customer_id, to_date) => req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id, month: MONTH, year: YEAR, ...(to_date ? { to_date } : {}) },
    });

    // ── part 1: up to the 7th ────────────────────────────────────────────
    let r = await gen(A, day(7));
    const inv1 = r.body?.invoice;
    check('invoice to the 7th → issued, no payroll run beforehand needed', r.status === 201 && inv1?.id, r.body);
    check('it covers 1–7', String(inv1?.period_from).startsWith(day(1)) || r.body?.preview?.period_from === day(1), inv1);
    check('preview period 01–07', r.body?.preview?.period_from === day(1) && r.body?.preview?.period_to === day(7), r.body?.preview);
    const p1 = (await db.query(`SELECT period_from::text f, period_to::text t FROM payroll_records WHERE placement_id = $1`, [aDutyP])).rows;
    check('payroll for the live-in ran for 1–7 only', p1.length === 1 && p1[0].f === day(1) && p1[0].t === day(7), p1);
    // 6 duties in 1–7 (off on the 6th) × 585
    check('part 1 bills the live-in 6 duties × ₹585',
      (r.body?.preview?.line_items ?? []).some((l) => /Live-in A — Staff Salary \(6 duties × ₹517\)/.test(l.description)),
      (r.body?.preview?.line_items ?? []).map((l) => l.description));

    r = await gen(A, day(5));
    check('a date inside 1–7 again → refused, naming the invoice',
      r.status === 400 && new RegExp(inv1?.invoice_number?.replace(/\//g, '\\/')).test(JSON.stringify(r.body)), r.body);
    r = await gen(A, day(7));
    check('the 7th again → refreshes the same DRAFT, not a second invoice',
      r.status === 201 && r.body?.amended === true && r.body?.invoice?.id === inv1?.id, r.body);

    // Approve and send part 1: the client has it now.
    await req('POST', `/finance/invoices/${inv1.id}/approve`, { token: finance });
    await db.query(`UPDATE client_invoices SET status = 'SENT' WHERE id = $1`, [inv1.id]);

    // ── part 2: 8–20, after part 1 was sent ──────────────────────────────
    r = await gen(A, day(20));
    const inv2 = r.body?.invoice;
    check('after 1–7 is SENT, 8–20 still issues as a new invoice', r.status === 201 && inv2?.id && inv2.id !== inv1.id, r.body);
    check('part 2 covers 8–20', r.body?.preview?.period_from === day(8) && r.body?.preview?.period_to === day(20), r.body?.preview);

    // ── part 3: the rest of the month, no date given ─────────────────────
    r = await gen(A);
    const inv3 = r.body?.invoice;
    check('no date → the rest of the month, 21–31', r.status === 201 && r.body?.preview?.period_from === day(21)
      && r.body?.preview?.period_to === day(31), r.body?.preview);
    r = await gen(A);
    check('again with the last part still DRAFT → that draft is refreshed, not duplicated',
      r.status === 201 && r.body?.amended === true && r.body?.invoice?.id === inv3?.id, r.body);
    await req('POST', `/finance/invoices/${inv3.id}/approve`, { token: finance });
    r = await gen(A);
    check('month fully invoiced and approved → asking again is refused (credit note)',
      r.status === 400 && /credit note/.test(JSON.stringify(r.body)), r.body);

    // ── B: one invoice for the whole month ───────────────────────────────
    r = await gen(B);
    const invB = r.body?.invoice;
    check('client B invoiced once for the month', r.status === 201 && invB?.id, r.body);

    // ── the parts add up to the whole ────────────────────────────────────
    const sums = async (ids) => (await db.query(
      `SELECT SUM(staff_salary_component)::float s, SUM(esic_employer)::float e, SUM(pf_employer)::float pf,
              SUM(management_fee)::float f, SUM(taxable_value)::float tv, SUM(gst_amount)::float g,
              SUM(total_amount)::float t
         FROM client_invoices WHERE id = ANY($1::uuid[])`, [ids])).rows[0];
    const a = await sums([inv1.id, inv2.id, inv3.id]);
    const b = await sums([invB.id]);
    const close = (x, y) => Math.abs(x - y) <= 0.05;
    check('salary: three parts = whole month', close(a.s, b.s), { a: a.s, b: b.s });
    check('employer ESIC: parts true up to the monthly figure', close(a.e, b.e), { a: a.e, b: b.e });
    check('employer PF: parts true up to the monthly figure', close(a.pf, b.pf), { a: a.pf, b: b.pf });
    check('taxable value: parts = whole', close(a.tv, b.tv), { a: a.tv, b: b.tv });
    check('total incl. GST: parts = whole (within rounding)', close(a.t, b.t), { a: a.t, b: b.t });
    check('live-in total: 29 duties × ₹585 across the parts',
      close((await db.query(`SELECT SUM(duties * duty_billing_rate)::float v FROM payroll_records WHERE placement_id = $1`, [aDutyP])).rows[0].v, 29 * 585));

    // ── the database refuses overlaps itself ─────────────────────────────
    let refused = null;
    try {
      await db.query(
        `INSERT INTO client_invoices (id, client_id, invoice_number, period_month, period_year, staff_salary_component,
                                      management_fee, gst_amount, total_amount, due_date, status, is_consolidated,
                                      period_from, period_to)
         VALUES (gen_random_uuid(), $1, 'PERT-OVERLAP', $2, $3, 0, 0, 0, 0, now(), 'DRAFT', true, $4::date, $5::date)`,
        [A, MONTH, YEAR, day(5), day(9)],
      );
    } catch (e) { refused = e.message; }
    check('DB refuses an invoice overlapping 1–7 (naming it)', /INVOICE_PERIOD_OVERLAP/.test(refused ?? '') && refused.includes(inv1.invoice_number), refused);
    refused = null;
    try {
      await db.query(
        `INSERT INTO payroll_records (id, placement_id, staff_id, period_month, period_year, gross_salary, net_salary,
                                      period_from, period_to)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, 0, $5::date, $6::date)`,
        [aDutyP, aDuty, MONTH, YEAR, day(15), day(16)],
      );
    } catch (e) { refused = e.message; }
    check('DB refuses payroll overlapping a paid period', /PAYROLL_PERIOD_OVERLAP/.test(refused ?? ''), refused);
    refused = null;
    try {
      await db.query(
        `INSERT INTO client_invoices (id, client_id, invoice_number, period_month, period_year, staff_salary_component,
                                      management_fee, gst_amount, total_amount, due_date, status, is_consolidated,
                                      period_from, period_to)
         VALUES (gen_random_uuid(), $1, 'PERT-CROSS', 1, 2025, 0, 0, 0, 0, now(), 'DRAFT', true, '2025-01-30', '2025-02-02')`,
        [B],
      );
    } catch (e) { refused = e.message; }
    check('DB refuses a period crossing into the next month', /period_chk/.test(refused ?? ''), refused);

    // ── documents ────────────────────────────────────────────────────────
    const html2 = (await req('GET', `/finance/invoices/${inv2.id}/download`, { token: finance, raw: true })).text;
    check('part 2 prints "From 08/12/2025 To 20/12/2025"',
      /From <strong>08\/12\/2025<\/strong> To <strong>20\/12\/2025<\/strong>/.test(html2));
    const htmlB = (await req('GET', `/finance/invoices/${invB.id}/download`, { token: finance, raw: true })).text;
    check('whole-month invoice prints from the 1st (live-in started on the 1st)', /From <strong>01\/12\/2025<\/strong>/.test(htmlB));

    const list = (await req('GET', '/finance/invoices', { token: finance })).body?.data ?? [];
    check('invoice list carries each invoice\'s dates',
      list.filter((x) => [inv1.id, inv2.id, inv3.id].includes(x.id)).every((x) => x.period_from && x.period_to), null);

    const look = (await req('GET', `/finance/invoices/by-unit-code?unit_code=PERT-A&month=${MONTH}&year=${YEAR}`, { token: finance })).body;
    check('unit-code lookup lists all three parts, no next period left',
      look?.invoices?.length === 3 && look?.next_period === null && look?.placements?.length === 2, look);

    const slipsHtml = await req('GET', `/finance/invoices/${inv2.id}/salary-slips`, { token: finance, raw: true });
    check('salary slips for part 2: one per staff, same dates',
      slipsHtml.status === 200 && (slipsHtml.text.match(/class="slip"/g) ?? []).length === 2
        && slipsHtml.text.includes('08/12/2025 – 20/12/2025'), slipsHtml.status);
    check('live-in slip: duties × rate, no deductions',
      /Wages \(\d+ duties × ₹517\.00\)/.test(slipsHtml.text));

    // One slip for the month, summing the parts.
    const slips = (await req('GET', `/employees/payslips?month=${MONTH}&year=${YEAR}`, { token: hr })).body?.items ?? [];
    const aSlip = slips.find((x) => x.staffName === 'Live-in A');
    const bSlip = slips.find((x) => x.staffName === 'Live-in B');
    check('monthly slip: one slip, 29 duties, same as the single-invoice client',
      aSlip && aSlip.duties === 29 && round2(aSlip.netSalary) === round2(bSlip?.netSalary), { aSlip, bSlip });
    const mA = slips.find((x) => x.staffName === 'Maid A');
    const mB = slips.find((x) => x.staffName === 'Maid B');
    check('monthly-salary maid: net pay identical whether billed in parts or whole',
      mA && mB && Math.abs(mA.netSalary - mB.netSalary) <= 0.05 && mA.presentDays === mB.presentDays, { mA, mB });
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.message}`);
  } finally {
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    for (const { id } of invs) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    const savedKeys = saved.map((s) => s.key);
    await db.query(`DELETE FROM system_settings WHERE key LIKE 'finance.%' AND NOT (key = ANY($1::text[]))`, [savedKeys]);
    for (const s of saved) await db.query(`UPDATE system_settings SET value = $2::jsonb WHERE key = $1`, [s.key, JSON.stringify(s.value)]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
