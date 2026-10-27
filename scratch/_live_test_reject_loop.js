/**
 * Live HTTP verification of the rejection loop between Finance and the RM:
 * Finance rejects → the RM sees it → the RM answers → Finance sees it → one
 * click raises the invoice again.
 *
 *  - the RM reads their own in-app notifications (HR's office-wide alerts are
 *    not theirs); nobody marks someone else's notification read
 *  - the invoice list has a Rejected filter that carries the reason
 *  - "Ready to re-invoice" lists the invoice only once every rate on that
 *    client has been answered, and drops it once it is raised again
 *  - the Finance user who rejected is told when the RM answers
 *
 * Uses May 2025. Builds and removes its own rows.
 *
 *   node scratch/_live_test_reject_loop.js
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
const may = (d) => `${YEAR}-05-${String(d).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const items = (b) => (Array.isArray(b) ? b : b?.data ?? b?.items ?? []);

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customers: [], staff: [], placements: [], notes: [] };
  const started = new Date();

  try {
    const finance = await login(FINANCE_PHONE);
    const rm = await login(RM_PHONE);
    check('finance and RM log in', !!(finance && rm));
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const rmUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE])).rows[0].id;
    const financeUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [FINANCE_PHONE])).rows[0].id;

    const c = await db.query(
      `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                      bill_no_prefix, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Loop Test', 'LOOP-A', 'x', 'x', 'New Delhi', 'Delhi', 'LOOPA', 'ACTIVE', now(), now()) RETURNING id`,
    );
    const A = c.rows[0].id;
    made.customers.push(A);
    const place = async (code, name, rate) => {
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [code, name, `90900000${code.slice(-2)}`, branchId],
      );
      made.staff.push(s.rows[0].id);
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 24, 'PER_DUTY', $5, $6, false, false,
                 $7::date, $7::date, now(), now()) RETURNING id`,
        [s.rows[0].id, A, branchId, rmUserId, rate, rate + 100, may(1)],
      );
      made.placements.push(p.rows[0].id);
      for (const d of range(1, 6)) {
        await db.query(
          `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                               hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 24, $5, now(), now())`,
          [s.rows[0].id, p.rows[0].id, branchId, may(d), rmUserId],
        );
      }
      return p.rows[0].id;
    };
    const P1 = await place('LOOP01', 'Loop One', 5000);
    const P2 = await place('LOOP02', 'Loop Two', 500);

    // An office-wide HR alert: HR's, not the RM's.
    const hrNote = await db.query(
      `INSERT INTO notifications (id, title, body, user_id, channel, status, sent_at, created_at)
       VALUES (gen_random_uuid(), 'Loop HR broadcast', 'for HR only', NULL, 'IN_APP', 'SENT', NOW(), NOW()) RETURNING id`,
    ).catch(() => ({ rows: [] }));
    if (hrNote.rows[0]) made.notes.push(hrNote.rows[0].id);

    let r = await req('POST', '/finance/invoices/consolidated/generate', { token: finance, body: { customer_id: A, month: 5, year: YEAR } });
    const inv = r.body?.invoice;
    check('May invoiced', r.status === 201 && inv?.id, r.body);
    r = await req('POST', `/finance/invoices/${inv.id}/reject`, { token: finance, body: { reason: 'Loop One rate 5000 should be 500' } });
    check('Finance rejects it', r.status === 201, r.body);

    // ── the RM sees it ───────────────────────────────────────────────────
    r = await req('GET', '/notifications/in-app', { token: rm });
    const rmNotes = items(r.body);
    check('RM can read their notifications (was HR/Admin only)', r.status === 200, r.status);
    check('…the rejection is there, with the reason',
      rmNotes.some((n) => n.title === 'Invoice rejected — check the rate' && /5000 should be 500/.test(n.body)), rmNotes.map((n) => n.title));
    check('…HR\'s office-wide alert is not', !rmNotes.some((n) => n.title === 'Loop HR broadcast'), rmNotes.map((n) => n.title));
    r = await req('GET', '/notifications/in-app/unread-count', { token: rm });
    check('RM unread count answers', r.status === 200 && Number(r.body?.count) >= 1, r.body);

    // ── Finance's views while the RM has not answered ───────────────────
    r = await req('GET', '/finance/invoices?status=REJECTED', { token: finance });
    const rejected = items(r.body);
    check('Rejected filter lists it, with the reason',
      rejected.some((x) => x.id === inv.id && /5000 should be 500/.test(x.reject_reason)), rejected.map((x) => x.invoice_number));
    check('…and only rejected ones', rejected.every((x) => x.status === 'CANCELLED' && x.reject_reason), rejected.map((x) => x.status));
    r = await req('GET', '/finance/invoices/attention', { token: finance });
    check('not "ready to re-invoice" while the RM has not answered',
      !(r.body?.ready_to_reinvoice ?? []).some((x) => x.id === inv.id), r.body?.ready_to_reinvoice);

    // ── the RM answers, one placement at a time ─────────────────────────
    r = await req('PATCH', `/placements/${P1}/terms`, { token: rm, body: { duty_rate: 500, duty_billing_rate: 600, reason: 'Typo fixed' } });
    check('RM corrects Loop One', r.status === 200 && r.body?.rate_review === null, r.body);
    let fin = (await db.query(
      `SELECT title, body FROM notifications WHERE user_id = $1 AND created_at >= $2 AND body LIKE '%Loop One%'`, [financeUserId, started])).rows;
    check('Finance told the RM answered, and that one more is waiting',
      fin.some((n) => n.title === 'RM answered a rejected invoice' && /1 more placement/.test(n.body)), fin);
    r = await req('GET', '/finance/invoices/attention', { token: finance });
    check('…still not ready (Loop Two is waiting)', !(r.body?.ready_to_reinvoice ?? []).some((x) => x.id === inv.id), r.body?.ready_to_reinvoice);

    r = await req('POST', `/placements/${P2}/rate-review/confirm`, { token: rm, body: { note: 'Loop Two rate 500 is the agreed rate' } });
    check('RM confirms Loop Two', r.status === 201, r.body);
    fin = (await db.query(
      `SELECT title, body FROM notifications WHERE user_id = $1 AND created_at >= $2 AND body LIKE '%Loop Two%'`, [financeUserId, started])).rows;
    check('Finance told it is ready to re-invoice', fin.some((n) => n.title === 'Ready to re-invoice'), fin);
    r = await req('GET', '/notifications/in-app', { token: finance });
    check('…and Finance can read it in the app', r.status === 200 && items(r.body).some((n) => n.title === 'Ready to re-invoice'), r.status);
    const finNoteId = items(r.body).find((n) => n.title === 'Ready to re-invoice')?.id;
    r = await req('PATCH', `/notifications/in-app/${finNoteId}/read`, { token: rm });
    check('the RM cannot mark Finance\'s notification read', r.body?.updated === 0, r.body);

    r = await req('GET', '/finance/invoices/attention', { token: finance });
    const ready = (r.body?.ready_to_reinvoice ?? []).find((x) => x.id === inv.id);
    check('now listed under "ready to re-invoice", with what to raise',
      ready && ready.client_id === A && ready.period_to === may(31) && ready.period_month === 5, ready ?? r.body?.ready_to_reinvoice);

    // ── one click raises it again ───────────────────────────────────────
    r = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: ready.client_id, month: ready.period_month, year: ready.period_year, to_date: ready.period_to },
    });
    const again = r.body?.invoice;
    check('re-invoiced as a DRAFT', r.status === 201 && again?.status === 'DRAFT' && again.id !== inv.id, r.body);
    const one = (await db.query(`SELECT duty_rate::float r FROM payroll_records WHERE client_invoice_id = $1 AND placement_id = $2`, [again.id, P1])).rows[0];
    check('…at the corrected rate (₹500)', one?.r === 500, one);
    r = await req('GET', '/finance/invoices/attention', { token: finance });
    check('…and it drops off the list', !(r.body?.ready_to_reinvoice ?? []).some((x) => x.id === inv.id), r.body?.ready_to_reinvoice);
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
    await db.query(`DELETE FROM notifications WHERE id = ANY($1::uuid[])`, [made.notes]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE created_at >= $1 AND (body LIKE '%Loop %' OR title LIKE 'Loop %')`, [started]).catch(() => {});
    await db.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])`, [made.placements]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
