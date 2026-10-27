/**
 * Live HTTP verification of P2 — dated rate changes, rate history, re-running
 * what a change reaches back over, Finance's rate notes, and RM warnings.
 *
 *  - a raise from the 16th: payroll is cut in two, each part at its own rate
 *  - the invoice shows Finance the change (and that it is a first invoice)
 *  - correcting the rate back-dated over a DRAFT invoice re-runs the payroll
 *    and rebuilds the invoice in place (same number)
 *  - reaching further back supersedes the earlier change (one timeline)
 *  - once Finance approves: the rate counts as checked; reaching back over it
 *    is refused (reject first); a change from after it is fine and shows up as
 *    new on the next invoice
 *  - warnings: no margin, a rate 10× the usual, a placement unlike the request
 *  - hourly price editable; a negative one refused
 *
 * Uses August–September 2025. Builds and removes its own rows.
 *
 *   node scratch/_live_test_rate_history.js
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
const aug = (d) => `${YEAR}-08-${String(d).padStart(2, '0')}`;
const sep = (d) => `${YEAR}-09-${String(d).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const msg = (r) => JSON.stringify(r.body ?? '');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customers: [], staff: [], placements: [], requests: [] };

  try {
    const finance = await login(FINANCE_PHONE);
    const rm = await login(RM_PHONE);
    check('finance and RM log in', !!(finance && rm));
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const rmUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE])).rows[0].id;

    const c = await db.query(
      `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                      bill_no_prefix, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Rate Test A', 'RATE-A', 'x', 'x', 'New Delhi', 'Delhi', 'RATEA', 'ACTIVE', now(), now())
       RETURNING id`,
    );
    const A = c.rows[0].id;
    made.customers.push(A);
    let n = 0;
    const staff = async (name) => {
      n += 1;
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [`RATE${String(n).padStart(2, '0')}`, name, `92000000${String(n).padStart(2, '0')}`, branchId],
      );
      made.staff.push(s.rows[0].id);
      return s.rows[0].id;
    };
    const place = async (staffId, cols) => {
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate, hourly_rate, hourly_fee,
                                 esic_applicable, pf_applicable, metadata,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', $5, $6, $7, $8, $9, $10, $11, false, false, $12::jsonb,
                 $13::date, $13::date, now(), now()) RETURNING id`,
        [staffId, A, branchId, rmUserId, cols.type ?? 'PERMANENT', cols.hours ?? 24, cols.basis ?? 'PER_DUTY',
         cols.rate ?? null, cols.bill ?? null, cols.hourly ?? null, cols.fee ?? null,
         JSON.stringify(cols.metadata ?? {}), aug(1)],
      );
      made.placements.push(p.rows[0].id);
      return p.rows[0].id;
    };

    const L = await staff('Rate Live-in');
    const LP = await place(L, { rate: 500, bill: 600 });
    for (const d of range(1, 31)) {
      await db.query(
        `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                             hours_worked, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 24, $5, now(), now())`,
        [L, LP, branchId, aug(d), rmUserId],
      );
    }

    let r = await req('GET', `/placements/${LP}/rate-history`, { token: rm });
    check('no history yet; a change would apply from the start', r.status === 200 && r.body?.changes?.length === 0 &&
      r.body?.next_unbilled_day === aug(1), r.body);

    // ── a raise from the 16th, before any payroll ───────────────────────
    r = await req('PATCH', `/placements/${LP}/terms`, {
      token: rm, body: { duty_rate: 550, duty_billing_rate: 650, effective_from: aug(16), reason: 'Raise agreed from 16 Aug' },
    });
    check('raise from 16 Aug saved and recorded', r.status === 200 && r.body?.rate_change?.effective_from === aug(16) &&
      r.body.rate_change.fields.includes('duty_rate'), r.body?.rate_change ?? r.body);
    r = await req('GET', `/placements/${LP}/rate-history`, { token: rm });
    const h1 = r.body?.changes?.[0];
    check('history: 500 → 550 from 16 Aug, with the reason and who',
      h1 && h1.before.duty_rate === 500 && h1.after.duty_rate === 550 && h1.reason === 'Raise agreed from 16 Aug' && h1.changed_by_name, h1);

    r = await req('POST', '/finance/invoices/consolidated/generate', { token: finance, body: { customer_id: A, month: 8, year: YEAR } });
    const inv = r.body?.invoice;
    check('August invoiced', r.status === 201 && inv?.status === 'DRAFT', r.body);
    let rows = (await db.query(
      `SELECT period_from::text f, period_to::text t, duty_rate::float rate, gross_salary::float gross
         FROM payroll_records WHERE placement_id = $1 ORDER BY period_from`, [LP])).rows;
    check('payroll cut at the 16th: 1–15 × ₹500, 16–31 × ₹550 = ₹16,300',
      rows.length === 2 && rows[0].t === aug(15) && rows[0].rate === 500 && rows[1].f === aug(16) && rows[1].rate === 550 &&
        rows[0].gross + rows[1].gross === 16300, rows);

    r = await req('GET', `/finance/invoices/${inv.id}`, { token: finance });
    const note = (r.body?.rate_notes ?? [])[0];
    check('Finance sees: first invoice for this placement, and the change (500 → 550 from 16 Aug, by whom, why)',
      note && note.first_invoice === true && note.changes.length === 1 &&
        note.changes[0].fields.some((f) => f.field === 'duty_rate' && f.before === 500 && f.after === 550) &&
        note.changes[0].reason === 'Raise agreed from 16 Aug', r.body?.rate_notes);

    // ── correct it, back-dated over the DRAFT invoice ───────────────────
    r = await req('PATCH', `/placements/${LP}/terms`, {
      token: rm, body: { duty_rate: 560, duty_billing_rate: 660, effective_from: aug(16), reason: 'Raise is 560, not 550' },
    });
    check('correction from 16 Aug re-runs the draft invoice',
      r.status === 200 && r.body?.rate_change?.rebuilt?.[0]?.invoice_number === inv.invoice_number, r.body?.rate_change ?? r.body);
    rows = (await db.query(
      `SELECT period_from::text f, duty_rate::float rate, gross_salary::float gross, client_invoice_id
         FROM payroll_records WHERE placement_id = $1 ORDER BY period_from`, [LP])).rows;
    check('…16–31 now at ₹560 (₹16,460 in all), still on the same invoice',
      rows.length === 2 && rows[1].rate === 560 && rows[0].gross + rows[1].gross === 16460 &&
        rows.every((x) => x.client_invoice_id === inv.id), rows);
    const total1 = Number((await db.query(`SELECT total_amount FROM client_invoices WHERE id = $1`, [inv.id])).rows[0].total_amount);
    const voidedRerun = (await db.query(`SELECT COUNT(*)::int n FROM payroll_records_voided WHERE placement_id = $1 AND void_source = 'RERUN'`, [LP])).rows[0].n;
    check('…the replaced row is kept (RERUN)', voidedRerun === 1, voidedRerun);

    // ── further back: from the 10th, supersedes the 16th ────────────────
    r = await req('PATCH', `/placements/${LP}/terms`, {
      token: rm, body: { duty_rate: 520, duty_billing_rate: 620, effective_from: aug(10), reason: 'Rate changed from the 10th' },
    });
    check('change from 10 Aug accepted', r.status === 200, r.body);
    rows = (await db.query(
      `SELECT period_from::text f, period_to::text t, duty_rate::float rate, gross_salary::float gross
         FROM payroll_records WHERE placement_id = $1 ORDER BY period_from`, [LP])).rows;
    check('payroll now 1–9 × ₹500, 10–31 × ₹520 = ₹15,940',
      rows.length === 2 && rows[0].t === aug(9) && rows[0].rate === 500 && rows[1].rate === 520 &&
        rows[0].gross + rows[1].gross === 15940, rows);
    const active = (await db.query(
      `SELECT effective_from::text e FROM placement_rate_changes WHERE placement_id = $1 AND superseded_at IS NULL`, [LP])).rows;
    check('the 16 Aug changes are superseded — one change active, from the 10th', active.length === 1 && active[0].e === aug(10), active);
    const total2 = Number((await db.query(`SELECT total_amount, invoice_number FROM client_invoices WHERE id = $1`, [inv.id])).rows[0].total_amount);
    check('invoice total moved with it (same invoice)', total2 < total1, { total1, total2 });

    // ── Finance approves: the rate is checked ───────────────────────────
    r = await req('POST', `/finance/invoices/${inv.id}/approve`, { token: finance });
    check('Finance approves August', r.status === 201, r.body);
    const ver = (await db.query(`SELECT rate_verified_at, rate_verified_invoice_id FROM placements WHERE id = $1`, [LP])).rows[0];
    check('placement marked as rate-checked by this invoice', ver.rate_verified_at && ver.rate_verified_invoice_id === inv.id, ver);
    r = await req('PATCH', `/placements/${LP}/terms`, { token: rm, body: { duty_rate: 530, effective_from: aug(20) } });
    check('reaching back over the approved invoice → refused, reject it first',
      r.status === 400 && /already approved by Finance/.test(msg(r)) && /reject/.test(msg(r)), r.body);
    r = await req('PATCH', `/placements/${LP}/terms`, { token: rm, body: { duty_rate: 540, duty_billing_rate: 640, reason: 'September rate' } });
    check('a change with no date applies from the first unbilled day (1 Sep)',
      r.status === 200 && r.body?.rate_change?.effective_from === sep(1) && r.body.rate_change.rebuilt.length === 0, r.body?.rate_change ?? r.body);
    const ver2 = (await db.query(
      `SELECT p.rate_verified_at, (SELECT MAX(changed_at) FROM placement_rate_changes c WHERE c.placement_id = p.id) AS last_change
         FROM placements p WHERE p.id = $1`, [LP])).rows[0];
    check('…the last check is kept, and this change is after it (new to Finance)',
      ver2.rate_verified_at && new Date(ver2.last_change) > new Date(ver2.rate_verified_at), ver2);

    // September: the new rate shows up for Finance.
    for (const d of range(1, 10)) {
      await db.query(
        `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                             hours_worked, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 24, $5, now(), now())`,
        [L, LP, branchId, sep(d), rmUserId],
      );
    }
    r = await req('POST', '/finance/invoices/consolidated/generate', { token: finance, body: { customer_id: A, month: 9, year: YEAR } });
    const invS = r.body?.invoice;
    const sepRow = (await db.query(`SELECT duty_rate::float rate, gross_salary::float gross FROM payroll_records WHERE client_invoice_id = $1`, [invS?.id])).rows[0];
    check('September billed at ₹540 (10 × 540 = ₹5,400)', sepRow && sepRow.rate === 540 && sepRow.gross === 5400, sepRow ?? r.body);
    r = await req('GET', `/finance/invoices/${invS.id}`, { token: finance });
    const sn = (r.body?.rate_notes ?? [])[0];
    check('…and Finance sees the 520 → 540 change, not a first invoice',
      sn && sn.first_invoice === false && sn.changes.length === 1 &&
        sn.changes[0].fields.some((f) => f.field === 'duty_rate' && f.before === 520 && f.after === 540), r.body?.rate_notes);

    // ── warnings ────────────────────────────────────────────────────────
    r = await req('PATCH', `/placements/${LP}/terms`, { token: rm, body: { duty_billing_rate: 540, effective_from: sep(11) } });
    check('billing = pay → warned (not refused)', r.status === 200 && (r.body?.warnings ?? []).some((w) => /equals staff pay/.test(w)), r.body?.warnings ?? r.body);
    for (let i = 0; i < 5; i += 1) {
      const s = await staff(`Rate Peer ${i}`);
      await place(s, { rate: 500, bill: 600 });
    }
    r = await req('PATCH', `/placements/${LP}/terms`, { token: rm, body: { duty_rate: 5000, duty_billing_rate: 6000, effective_from: sep(11) } });
    check('₹5,000/duty against peers at ₹500 → "10× more … check for a typo"',
      (r.body?.warnings ?? []).some((w) => /10× more than the usual ₹500\/duty/.test(w)), r.body?.warnings ?? r.body);

    const sr = await db.query(
      `INSERT INTO staff_requests (request_no, source, series, client_id, placement_type, shift_hours, status)
       VALUES ('SR-RATE-0001', 'RM_WEB', 'MAID', $1, 'PERMANENT', 8, 'FULFILLED') RETURNING id`, [A]);
    made.requests.push(sr.rows[0].id);
    const Q = await staff('Rate Requested');
    const QP = await place(Q, { rate: 500, bill: 600, metadata: { staff_request_id: sr.rows[0].id } });
    r = await req('PATCH', `/placements/${QP}/terms`, { token: rm, body: { duty_rate: 500, reason: 'no-op' } });
    check('client asked for 8 hours, placed as a 24-hour duty → warned with the request number',
      (r.body?.warnings ?? []).some((w) => /asked for 8 hours/.test(w) && /SR-RATE-0001/.test(w)), r.body?.warnings ?? r.body);

    // ── hourly price is editable ────────────────────────────────────────
    const H = await staff('Rate Hourly');
    const HP = await place(H, { type: 'TEMPORARY', hours: 4, basis: 'HOURLY', hourly: 150, fee: 30 });
    r = await req('PATCH', `/placements/${HP}/terms`, { token: rm, body: { hourly_rate: -5 } });
    check('negative hourly rate refused', r.status === 400, r.body);
    r = await req('PATCH', `/placements/${HP}/terms`, { token: rm, body: { hourly_rate: 180, hourly_fee: 0, reason: 'new hourly rate' } });
    check('hourly rate edited and recorded; no fee → warned',
      r.status === 200 && r.body?.hourly_rate === 180 && r.body?.rate_change?.fields.includes('hourly_rate') &&
        (r.body?.warnings ?? []).some((w) => /No hourly fee/.test(w)), r.body);
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.stack || e.message}`);
  } finally {
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    for (const { id } of invs) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM placement_rate_changes WHERE placement_id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM payroll_records_voided WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])`, [made.placements]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_requests WHERE id = ANY($1::uuid[])`, [made.requests]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
