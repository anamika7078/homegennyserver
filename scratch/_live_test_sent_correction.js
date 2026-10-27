/**
 * Live HTTP verification of P3 — correcting an invoice the client already has.
 *
 * A sent invoice is never edited and salary is never taken back. The rate is
 * changed on the placement (back-dated), and the correction settles the
 * difference:
 *   - client over-billed → credit note (tax included); staff over-paid → recorded, not deducted
 *   - client under-billed → DRAFT supplementary invoice; staff under-paid → arrears
 *   - arrears ride on the staff member's next payroll row; voiding that row
 *     puts them back to pending
 *   - a second correction settles only what is left; nothing left → refused
 *
 * Uses July–August 2025. Builds and removes its own rows.
 *
 *   node scratch/_live_test_sent_correction.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const RM_PHONE = '9800000002';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const YEAR = 2025;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : ''}`); }
}
async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
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
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken;
    if (t) return t;
  }
  throw new Error(`Could not log in as ${phone}`);
}
const jul = (d) => `${YEAR}-07-${String(d).padStart(2, '0')}`;
const aug = (d) => `${YEAR}-08-${String(d).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const msg = (r) => JSON.stringify(r.body ?? '');
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customers: [], staff: [], placements: [], users: [] };

  try {
    const finance = await login(FINANCE_PHONE);
    const rm = await login(RM_PHONE);
    check('finance and RM log in', !!(finance && rm));
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const rmUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE])).rows[0].id;

    const c = await db.query(
      `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                      bill_no_prefix, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Correction Test', 'CORR-A', 'x', 'x', 'New Delhi', 'Delhi', 'CORRA', 'ACTIVE', now(), now())
       RETURNING id`,
    );
    const A = c.rows[0].id;
    made.customers.push(A);
    const u = await db.query(
      `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, updated_at)
       VALUES (gen_random_uuid(), 'STAFF', 'Corr Staff', $1, 'x', true, now()) RETURNING id`,
      ['6' + String(Date.now()).slice(-9)],
    );
    made.users.push(u.rows[0].id);
    const s = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                     branch_id, user_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'CORR01', 'MAID', 'Corr Staff', '9100000001', '1995-01-01', 'x', $1, $2, now(), now()) RETURNING id`,
      [branchId, u.rows[0].id],
    );
    const S = s.rows[0].id;
    made.staff.push(S);
    const pl = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                               rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                               confirmed_at, trial_start_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 24, 'PER_DUTY', 500, 600, false, false,
               $5::date, $5::date, now(), now()) RETURNING id`,
      [S, A, branchId, rmUserId, jul(1)],
    );
    const P = pl.rows[0].id;
    made.placements.push(P);
    const mark = async (day) => db.query(
      `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                           hours_worked, marked_by, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 24, $5, now(), now())`,
      [S, P, branchId, day, rmUserId],
    );
    for (const d of range(1, 10)) await mark(jul(d));

    let r = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: A, month: 7, year: YEAR, to_date: jul(10) },
    });
    const inv = r.body?.invoice;
    check('July 1–10 invoiced (10 duties × ₹600)', r.status === 201 && inv?.id, r.body);
    const gstRate = Number(inv.gst_amount) / Number(inv.taxable_value);

    r = await req('GET', `/finance/invoices/${inv.id}/correction`, { token: finance });
    check('a DRAFT is not corrected — it is rejected', r.status === 400 && /reject it instead/.test(msg(r)), r.body);

    await req('POST', `/finance/invoices/${inv.id}/approve`, { token: finance });
    // Stands in for delivery: sending needs a client email on file.
    await db.query(`UPDATE client_invoices SET status = 'SENT' WHERE id = $1`, [inv.id]);
    r = await req('GET', `/finance/invoices/${inv.id}/correction`, { token: finance });
    check('sent, rates unchanged → nothing to correct', r.status === 200 && r.body?.nothing_to_correct === true, r.body);
    r = await req('POST', `/finance/invoices/${inv.id}/correct`, { token: finance, body: { reason: 'checking nothing changes' } });
    check('…and applying it is refused', r.status === 400 && /nothing to correct/.test(msg(r)), r.body);

    // ── the rate was too high: back-date a lower one ────────────────────
    r = await req('PATCH', `/placements/${P}/terms`, {
      token: rm, body: { duty_rate: 450, duty_billing_rate: 540, effective_from: jul(1), reason: 'Agreed rate is 450/540' },
    });
    check('RM back-dates over the sent invoice: allowed, invoice left as billed, flagged for correction',
      r.status === 200 && r.body?.rate_change?.rebuilt?.length === 0 &&
        r.body?.rate_change?.invoices_to_correct?.includes(inv.invoice_number), r.body?.rate_change ?? r.body);
    const stillThere = (await db.query(`SELECT gross_salary::float g FROM payroll_records WHERE client_invoice_id = $1`, [inv.id])).rows[0];
    check('…the sent payroll row is untouched (₹5,000)', stillThere?.g === 5000, stillThere);

    r = await req('GET', `/finance/invoices/${inv.id}/correction`, { token: finance });
    const p1 = r.body;
    check('preview: client over-billed ₹600 + GST; staff over-paid ₹500',
      near(p1?.totals?.client_delta, -600) && near(p1?.totals?.gst_delta, -600 * gstRate) &&
        near(p1?.actions?.credit_note, 600 * (1 + gstRate)) && near(p1?.actions?.overpayment_recorded, 500) &&
        p1?.actions?.arrears_to_pay === 0, p1);
    r = await req('POST', `/finance/invoices/${inv.id}/correct`, { token: finance, body: { reason: 'short' } });
    check('a reason is required', r.status === 400, r.body);
    r = await req('POST', `/finance/invoices/${inv.id}/correct`, { token: finance, body: { reason: 'Rate was 450/540, billed at 500/600' } });
    check('applied: credit note for the over-billing', r.status === 201 && r.body?.credit_note?.credit_note_number &&
      near(r.body.credit_note.credit_amount, 600 * (1 + gstRate)) && !r.body?.supplementary_invoice, r.body);
    const credited = (await db.query(`SELECT status, credited_amount::float c FROM client_invoices WHERE id = $1`, [inv.id])).rows[0];
    check('…the invoice stays SENT, partly credited', credited.status === 'SENT' && near(credited.c, 600 * (1 + gstRate)), credited);
    const absorbed = (await db.query(`SELECT kind, status, amount::float a FROM pay_adjustments WHERE staff_id = $1`, [S])).rows;
    check('…staff over-payment recorded as ABSORBED, nothing deducted',
      absorbed.length === 1 && absorbed[0].kind === 'ABSORBED' && absorbed[0].status === 'RECORDED' && absorbed[0].a === 500, absorbed);
    const net = (await db.query(`SELECT net_salary::float n FROM payroll_records WHERE client_invoice_id = $1`, [inv.id])).rows[0];
    check('…and the paid salary row is unchanged', net.n === 5000, net);

    r = await req('GET', `/finance/invoices/${inv.id}/correction`, { token: finance });
    check('a second look: nothing left to correct', r.body?.nothing_to_correct === true, r.body?.totals);

    // ── then it turns out the rate should be higher ─────────────────────
    r = await req('PATCH', `/placements/${P}/terms`, {
      token: rm, body: { duty_rate: 520, duty_billing_rate: 650, effective_from: jul(1), reason: 'Final rate 520/650' },
    });
    check('RM back-dates the final rate', r.status === 200, r.body);
    r = await req('GET', `/finance/invoices/${inv.id}/correction`, { token: finance });
    const p2 = r.body;
    // billed so far: 6000 − 600 = 5400 → should be 6500: +1100. Paid 5000 → should be 5200: +200 (the absorbed 500 was never taken).
    check('preview: client under-billed ₹1,100 + GST; staff owed ₹200 arrears',
      near(p2?.totals?.client_delta, 1100) && near(p2?.actions?.supplementary_invoice, 1100 * (1 + gstRate)) &&
        near(p2?.actions?.arrears_to_pay, 200) && p2?.actions?.credit_note === 0, p2);
    r = await req('POST', `/finance/invoices/${inv.id}/correct`, { token: finance, body: { reason: 'Final agreed rate 520/650' } });
    const sup = r.body?.supplementary_invoice;
    check('applied: a DRAFT supplementary invoice', r.status === 201 && sup?.invoice_number, r.body);
    const supRow = (await db.query(
      `SELECT status, is_consolidated, taxable_value::float t, total_amount::float tot, payment_ref FROM client_invoices WHERE id = $1`, [sup.id])).rows[0];
    check('…₹1,100 taxable + GST, DRAFT, names the original',
      supRow.status === 'DRAFT' && supRow.is_consolidated === false && near(supRow.t, 1100) &&
        near(supRow.tot, 1100 * (1 + gstRate)) && supRow.payment_ref.includes(inv.invoice_number), supRow);
    const items = (await db.query(`SELECT SUM(amount)::float s FROM invoice_items WHERE invoice_id = $1`, [sup.id])).rows[0];
    check('…its lines add up to its total', near(items.s, supRow.tot), items);
    const arrears = (await db.query(`SELECT amount::float a, status FROM pay_adjustments WHERE staff_id = $1 AND kind = 'ARREARS'`, [S])).rows;
    check('…₹200 arrears pending for the staff member', arrears.length === 1 && arrears[0].a === 200 && arrears[0].status === 'PENDING', arrears);
    const told = (await db.query(`SELECT body FROM notifications WHERE user_id = $1 AND title = 'Arrears on your next salary'`, [u.rows[0].id])).rows;
    check('…and they are told', told.length === 1 && /₹200/.test(told[0].body), told);
    r = await req('GET', `/finance/invoices/${inv.id}/corrections`, { token: finance });
    check('history: two corrections, with the credit note and supplementary invoice',
      r.body?.length === 2 && r.body.some((x) => x.credit_note_number) && r.body.some((x) => x.supplementary_invoice_number), r.body);

    // ── arrears ride on the next payroll ────────────────────────────────
    for (const d of range(1, 5)) await mark(aug(d));
    r = await req('POST', '/finance/invoices/consolidated/generate', { token: finance, body: { customer_id: A, month: 8, year: YEAR } });
    const invAug = r.body?.invoice;
    const augRow = (await db.query(
      `SELECT id, gross_salary::float g, net_salary::float n, arrears::float a, arrears_note FROM payroll_records WHERE client_invoice_id = $1`, [invAug?.id])).rows[0];
    check('August: 5 duties × ₹520 + ₹200 arrears = ₹2,800 net',
      augRow && augRow.g === 2600 && augRow.a === 200 && augRow.n === 2800 && /Final agreed rate/.test(augRow.arrears_note), augRow ?? r.body);
    check('…the client is billed for August only (5 × ₹650)', near(invAug.taxable_value, 3250), invAug?.taxable_value);
    const applied = (await db.query(`SELECT status, applied_payroll_id FROM pay_adjustments WHERE staff_id = $1 AND kind = 'ARREARS'`, [S])).rows[0];
    check('…arrears marked APPLIED to that row', applied.status === 'APPLIED' && applied.applied_payroll_id === augRow.id, applied);

    r = await req('POST', `/finance/invoices/${invAug.id}/reject`, { token: finance, body: { reason: 'recheck August days' } });
    check('August rejected', r.status === 201, r.body);
    const back = (await db.query(`SELECT status, applied_payroll_id FROM pay_adjustments WHERE staff_id = $1 AND kind = 'ARREARS'`, [S])).rows[0];
    check('…the arrears go back to PENDING with the voided row', back.status === 'PENDING' && back.applied_payroll_id === null, back);
    await db.query(`UPDATE placements SET rate_review_status = NULL WHERE id = $1`, [P]);
    r = await req('POST', '/finance/invoices/consolidated/generate', { token: finance, body: { customer_id: A, month: 8, year: YEAR } });
    const again = (await db.query(`SELECT arrears::float a FROM payroll_records WHERE client_invoice_id = $1`, [r.body?.invoice?.id])).rows[0];
    check('…and ride on the re-generated row', again?.a === 200, again ?? r.body);
    r = await req('GET', '/finance/payroll/adjustments?status=APPLIED', { token: finance });
    check('Finance lists applied arrears', r.status === 200 && r.body.some((x) => x.staff_name === 'Corr Staff' && Number(x.amount) === 200), r.body);
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.stack || e.message}`);
  } finally {
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    const ids = invs.map((x) => x.id);
    await db.query(`DELETE FROM invoice_corrections WHERE invoice_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM credit_notes WHERE invoice_id = ANY($1::uuid[])`, [ids]);
    for (const id of ids) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM pay_adjustments WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM placement_rate_changes WHERE placement_id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM payroll_records_voided WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [made.users]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE title = 'Invoice rejected — check the rate' AND body LIKE '%Correction Test%'`).catch(() => {});
    await db.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])`, [made.placements]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [made.users]).catch(() => {});
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
