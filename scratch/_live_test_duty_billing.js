/**
 * Live HTTP verification for per-duty (24×7 live-in) billing, against the
 * business's own October duty sheet:
 *
 *   Staff     Joined     Duties  Pay/duty  Bill/duty  Payout   Invoice  GST      Total
 *   Priya     5 Oct      23      517       585        11,891   13,455   2,421.90 15,876.90
 *   Anamika   relief      1      500       585           500      585     105.30    690.30
 *   Manisha   relief      3      500       585         1,500    1,755     315.90  2,070.90
 *   Kiran     12 Oct     19      500       580         9,500   11,020   1,983.60 13,003.60
 *                                                      23,391   26,815   4,826.70 31,641.70
 *
 * Supplier and client are both in Uttarakhand, so CGST 9% + SGST 9%. No ESIC or
 * PF on any of them, which is what the per-placement switches are for.
 *
 * Also checks: terms validation over HTTP, the invoice lines name each person
 * with "N duties at Rs.X/-per duty", every staff member gets a slip whose net
 * is the payout, a half day is half a duty, and PF switched on comes out of
 * the margin while the client's charge stays duties × billing rate.
 *
 * Uses October 2025 (also 31 days) so it cannot collide with real billing.
 * Builds and removes its own rows; restores the finance.* settings it found.
 *
 *   node scratch/_live_test_duty_billing.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const RM_PHONE = '9800000002';
const HR_PHONE = '9800000008';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const MONTH = 10;
const YEAR = 2025;
const SUPPLIER_GSTIN = '05ABBFV5073E1ZB';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}`); }
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
const day = (d) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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
    const rm = await login(RM_PHONE);
    const hr = await login(HR_PHONE);
    check('finance, RM and HR can log in', !!(finance && rm && hr));

    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const marker = (await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE])).rows[0].id;

    // Supplier as on the sheet.
    let r = await req('PUT', '/finance/settings/company', {
      token: finance,
      body: { legal_name: 'Veejay Shri Manpower Services LLP', gstin: SUPPLIER_GSTIN, state: '', sac_code: '998513', gst_rate_pct: 18 },
    });
    check('supplier set: GSTIN 05… → Uttarakhand', r.status === 200 && r.body?.state === 'Uttarakhand', r.body);

    // ── fixture ──────────────────────────────────────────────────────────
    const c = await db.query(
      `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                      bill_no_prefix, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Duty Test Household', 'DUTYT-01', 'Test Colony',
               '12 Test Road, Test Colony', 'Dehradun', 'Uttarakhand', 'DUTYT', 'ACTIVE', now(), now())
       RETURNING id`,
    );
    const customerId = c.rows[0].id;
    made.customers.push(customerId);

    const staff = {};
    for (const [code, name] of [['DUTYT1', 'Priya'], ['DUTYT2', 'Anamika'], ['DUTYT3', 'Manisha'], ['DUTYT4', 'Kiran']]) {
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'SKILLED_CARE', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [code, `${name} DutyTest`, `95000000${code.slice(-1)}0`, branchId],
      );
      staff[name] = s.rows[0].id;
      made.staff.push(s.rows[0].id);
    }

    // Placements are priced over HTTP, which is what is under test. A temporary
    // placement cannot exist unpriced (placements_temporary_needs_rate), so the
    // relief ones start per-duty at a placeholder rate the PATCH then replaces.
    const place = async (name, type, startDay) => {
      const temp = type === 'TEMPORARY';
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', $4, 24, $6, $7, $7,
                 $5::date, $5::date, now(), now()) RETURNING id`,
        [staff[name], customerId, branchId, type, day(startDay), temp ? 'PER_DUTY' : null, temp ? 1 : null],
      );
      made.placements.push(p.rows[0].id);
      return p.rows[0].id;
    };
    const priya = await place('Priya', 'PERMANENT', 5);
    const anamika = await place('Anamika', 'TEMPORARY', 5);
    const manisha = await place('Manisha', 'TEMPORARY', 5);
    const kiran = await place('Kiran', 'PERMANENT', 12);

    // ── terms validation ─────────────────────────────────────────────────
    r = await req('PATCH', `/placements/${priya}/terms`, { token: rm, body: { rate_basis: 'PER_DUTY' } });
    check('PER_DUTY without rates refused', r.status === 400 && /duty_rate/.test(JSON.stringify(r.body)), r.body);
    r = await req('PATCH', `/placements/${priya}/terms`, { token: rm, body: { rate_basis: 'PER_DUTY', duty_rate: 600, duty_billing_rate: 585 } });
    check('billing rate below pay rate refused', r.status === 400 && /below duty_rate/.test(JSON.stringify(r.body)), r.body);
    r = await req('PATCH', `/placements/${priya}/terms`, { token: rm, body: { rate_basis: 'HOURLY' } });
    check('HOURLY on a PERMANENT placement refused', r.status === 400, r.status);
    r = await req('PATCH', `/placements/${priya}/terms`, { token: rm, body: { shift_hours: 30 } });
    check('shift_hours over 24 refused', r.status === 400, r.status);

    const terms = async (id, rate, bill, extra = {}) => req('PATCH', `/placements/${id}/terms`, {
      token: rm,
      body: { rate_basis: 'PER_DUTY', duty_rate: rate, duty_billing_rate: bill, shift_hours: 24,
              esic_applicable: false, pf_applicable: false, ...extra },
    });
    r = await terms(priya, 517, 585);
    check('Priya priced 517/585 per duty, ESIC/PF off', r.status === 200 && r.body?.rate_basis === 'PER_DUTY'
      && r.body.duty_rate === 517 && r.body.duty_billing_rate === 585
      && r.body.esic_applicable === false && r.body.pf_applicable === false, r.body);
    r = await terms(kiran, 500, 580);
    check('Kiran priced 500/580', r.status === 200 && r.body?.duty_billing_rate === 580, r.body);
    r = await terms(anamika, 500, 585, { covers_placement_id: priya });
    check('Anamika relief, covers Priya', r.status === 200 && r.body?.covers_placement_id === priya, r.body);
    r = await terms(manisha, 500, 585, { covers_placement_id: priya });
    check('Manisha relief, covers Priya', r.status === 200, r.body);
    r = await req('PATCH', `/placements/${manisha}/terms`, { token: rm, body: { covers_placement_id: manisha } });
    check('a placement cannot cover itself', r.status === 400, r.status);

    // The New Placement form's path: a relief placement created per-duty in one go.
    const s5 = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                     branch_id, pipeline_stage, created_at, updated_at)
       VALUES (gen_random_uuid(), 'DUTYT5', 'SKILLED_CARE', 'Relief DutyTest', '9500000050', '1995-01-01', 'x',
               $1, 'S5_DEPLOY', now(), now()) RETURNING id`,
      [branchId],
    );
    made.staff.push(s5.rows[0].id);
    r = await req('POST', '/placements', {
      token: rm,
      body: { staff_id: s5.rows[0].id, client_id: customerId, placement_type: 'TEMPORARY', status: 'CONFIRMED',
              rate_basis: 'PER_DUTY', duty_rate: 500, duty_billing_rate: 585, shift_hours: 24,
              esic_applicable: false, pf_applicable: false, covers_placement_id: kiran },
    });
    if (r.body?.id) made.placements.push(r.body.id);
    check('POST /placements creates a per-duty relief placement (no hourly rate needed)',
      r.status === 201 && r.body?.rate_basis === 'PER_DUTY' && r.body?.covers_placement_id === kiran
        && r.body?.esic_applicable === false && r.body?.status === 'CONFIRMED', r.body);

    // ── attendance, as on the sheet ──────────────────────────────────────
    const mark = async (placementId, name, days, status = 'PRESENT') => {
      for (const d of days) {
        await db.query(
          `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                               hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5, 24, $6, now(), now())`,
          [staff[name], placementId, branchId, day(d), status, marker],
        );
      }
    };
    // Priya: 5–31 Oct is 27 days; off on 9, 16, 23, 30 → 23 duties.
    const priyaOff = [9, 16, 23, 30];
    await mark(priya, 'Priya', range(5, 31).filter((d) => !priyaOff.includes(d)));
    await mark(priya, 'Priya', priyaOff, 'ABSENT');
    await mark(anamika, 'Anamika', [9]);
    await mark(manisha, 'Manisha', [16, 23, 30]);
    // Kiran: 12–31 Oct is 20 days; off on the 20th → 19 duties.
    await mark(kiran, 'Kiran', range(12, 31).filter((d) => d !== 20));
    await mark(kiran, 'Kiran', [20], 'ABSENT');

    // ── payroll, by staff code, the way Finance runs it ──────────────────
    const expected = {
      Priya: { code: 'DUTYT1', duties: 23, gross: 11891, billed: 13455 },
      Anamika: { code: 'DUTYT2', duties: 1, gross: 500, billed: 585 },
      Manisha: { code: 'DUTYT3', duties: 3, gross: 1500, billed: 1755 },
      Kiran: { code: 'DUTYT4', duties: 19, gross: 9500, billed: 11020 },
    };
    for (const [name, e] of Object.entries(expected)) {
      r = await req('POST', '/finance/payroll/attendance-generate', { token: finance, body: { code: e.code, month: MONTH, year: YEAR } });
      const run = (r.body?.runs ?? [])[0];
      const calc = run?.calculation;
      check(`${name}: ${e.duties} duties → pay ₹${e.gross}, no ESIC/PF`,
        (r.status === 201 || r.status === 200) && Number(run?.preview?.duties) === e.duties
          && calc?.grossSalary === e.gross && calc?.netSalary === e.gross
          && calc?.esicEmployer === 0 && calc?.pfEmployer === 0, r.body);
      check(`${name}: client charge before GST = ₹${e.billed}`,
        round2(calc?.clientTotalCharge - calc?.gstOnFee) === e.billed, calc);
    }

    // ── the invoice ──────────────────────────────────────────────────────
    r = await req('POST', '/finance/invoices/consolidated/generate', { token: finance, body: { customer_id: customerId, month: MONTH, year: YEAR } });
    const inv = r.body?.invoice;
    const t = r.body?.preview?.totals;
    check('one invoice for all four', r.status === 201 && r.body?.preview?.staff_count === 4, r.body);
    check('taxable value ₹26,815 (sheet: invoice value)', round2(Number(inv?.taxable_value)) === 26815, t);
    check('CGST ₹2,413.35 + SGST ₹2,413.35 (both in Uttarakhand)',
      round2(Number(inv?.cgst_amount)) === 2413.35 && round2(Number(inv?.sgst_amount)) === 2413.35
        && Number(inv?.igst_amount) === 0, inv);
    check('total ₹31,641.70 (sheet: total invoice value)', round2(Number(inv?.total_amount)) === 31641.7, inv?.total_amount);
    check('salary total ₹23,391 (sheet: total payout)', round2(Number(inv?.staff_salary_component)) === 23391, inv?.staff_salary_component);
    check('margin ₹3,424 (sheet: difference)', round2(Number(inv?.management_fee)) === 3424, inv?.management_fee);
    check('TAX_INVOICE under the supplier GSTIN', inv?.document_type === 'TAX_INVOICE' && inv?.supplier_gstin === SUPPLIER_GSTIN, inv);

    const detail = (await req('GET', `/finance/invoices/${inv?.id}`, { token: finance })).body;
    check('internal lines reconcile to the total', detail?.reconciles === true, detail?.line_items_total);
    check('internal salary line shows "23 duties × ₹517"',
      (detail?.line_items ?? []).some((l) => /Priya DutyTest — Staff Salary \(23 duties × ₹517\)/.test(l.description)),
      (detail?.line_items ?? []).map((l) => l.description));

    const html = (await req('GET', `/finance/invoices/${inv?.id}/download`, { token: finance, raw: true })).text;
    check('client copy: Priya 23 duties at Rs.585.00/-per duty, ₹13,455',
      /Priya DutyTest \(24hrs\) — 23 duties at Rs\.585\.00\/-per duty \[585\.00 × 23\][\s\S]*?13,455\.00/.test(html));
    check('client copy: Anamika as relief, 1 duty', /Anamika DutyTest \(relief\) — 1 duty at Rs\.585\.00/.test(html));
    check('client copy: Kiran 19 duties at Rs.580.00', /Kiran DutyTest \(24hrs\) — 19 duties at Rs\.580\.00/.test(html));
    check('client copy: 9% CGST and 9% SGST', html.includes('9% CGST') && html.includes('9% SGST'));
    check('client copy: supplier name and GSTIN', html.includes('Veejay Shri Manpower Services LLP') && html.includes(SUPPLIER_GSTIN));
    check('client copy: "From 05/10/2025 To 31/10/2025" — service began on the 5th, as on the sheet',
      /From <strong>05\/10\/2025<\/strong> To <strong>31\/10\/2025<\/strong>/.test(html));
    const slipPack = await req('GET', `/finance/invoices/${inv?.id}/salary-slips`, { token: finance, raw: true });
    check('salary slips with the invoice: one each for all four staff',
      slipPack.status === 200 && (slipPack.text.match(/class="slip"/g) ?? []).length === 4, slipPack.status);
    check('Priya\'s slip: 05/10 – 31/10, 23 duties × ₹517, net ₹11,891',
      /05\/10\/2025 – 31\/10\/2025/.test(slipPack.text) && slipPack.text.includes('23 duties × ₹517.00')
        && slipPack.text.includes('₹11,891.00'));
    check('relief slip says TEMP duty, as on the sheet', /TEMP duty/.test(slipPack.text));

    // ── a slip for every staff member ────────────────────────────────────
    const slips = (await req('GET', `/employees/payslips?month=${MONTH}&year=${YEAR}`, { token: hr })).body;
    const list = slips?.items ?? [];
    for (const [name, e] of Object.entries(expected)) {
      const slip = list.find((s) => s.staffName === `${name} DutyTest`);
      check(`${name}: salary slip — ${e.duties} duties, net ₹${e.gross}, no deductions`,
        slip && round2(Number(slip.netSalary ?? slip.net_salary)) === e.gross
          && round2(Number(slip.totalDeductions)) === 0 && slip.duties === e.duties, slip);
    }

    // ── half day, and PF switched on (fresh month so nothing collides) ───
    const NOV = 11;
    const dayN = (d) => `${YEAR}-11-${String(d).padStart(2, '0')}`;
    for (const d of range(1, 10)) {
      await db.query(
        `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                             hours_worked, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5, 24, $6, now(), now())`,
        [staff.Kiran, kiran, branchId, dayN(d), d === 10 ? 'HALF_DAY' : 'PRESENT', marker],
      );
    }
    r = await req('PATCH', `/placements/${kiran}/terms`, { token: rm, body: { pf_applicable: true } });
    check('PF switched on for Kiran', r.status === 200 && r.body?.pf_applicable === true, r.body);
    r = await req('POST', '/finance/payroll/attendance-generate', { token: finance, body: { code: 'DUTYT4', month: NOV, year: YEAR } });
    const nov = (r.body?.runs ?? [])[0];
    const nc = nov?.calculation;
    check('9 days + 1 half day = 9.5 duties', Number(nov?.preview?.duties) === 9.5, nov?.preview);
    check('pay 9.5 × 500 = ₹4,750', nc?.grossSalary === 4750, nc);
    check('PF 12% = ₹570 each side', nc?.pfEmployee === 570 && nc?.pfEmployer === 570, nc);
    check('net pay ₹4,180 after employee PF', nc?.netSalary === 4180, nc);
    check('client charge still 9.5 × 580 = ₹5,510 — PF comes out of the margin',
      round2(nc?.clientTotalCharge - nc?.gstOnFee) === 5510 && nc?.managementFee === 190, nc);

    // A billing rate that cannot cover pay + PF is refused, not billed at a loss.
    r = await req('PATCH', `/placements/${kiran}/terms`, { token: rm, body: { duty_billing_rate: 520 } });
    await db.query(`DELETE FROM payroll_records WHERE placement_id = $1 AND period_month = $2`, [kiran, NOV]);
    r = await req('POST', '/finance/payroll/attendance-generate', { token: finance, body: { code: 'DUTYT4', month: NOV, year: YEAR } });
    check('billing rate too low for pay + PF → refused with a reason',
      r.status === 400 && /does not cover the staff pay and the employer ESIC\/PF/.test(JSON.stringify(r.body)), r.body);
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
    await db.query(`DELETE FROM deployments WHERE placement_id = ANY($1::uuid[])`, [made.placements]).catch(() => {});
    await db.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])`, [made.placements]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);

    const savedKeys = saved.map((s) => s.key);
    await db.query(`DELETE FROM system_settings WHERE key LIKE 'finance.%' AND NOT (key = ANY($1::text[]))`, [savedKeys]);
    for (const s of saved) {
      await db.query(`UPDATE system_settings SET value = $2::jsonb WHERE key = $1`, [s.key, JSON.stringify(s.value)]);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
