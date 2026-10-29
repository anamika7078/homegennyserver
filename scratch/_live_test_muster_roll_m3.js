/**
 * Live HTTP verification of M3 — the muster roll behind the invoice.
 *
 *  - invoice detail carries attendance_proof: staff-app days by client status,
 *    days by source, the signed roll, and warnings (waiting, disputed, unsigned
 *    paper roll) — warnings only, approval still goes through
 *  - the client signs: the warnings for waiting days and the unsigned roll go
 *  - approving the invoice locks the signed roll: neither the client nor the RM
 *    can sign a new version under it; cancelling the invoice frees it
 *  - Finance attention: disputes unresolved over 48 h, last month's unsigned roll
 *
 * Uses March 2025 plus last month. Builds and removes its own rows.
 *
 *   node scratch/_live_test_muster_roll_m3.js
 */
const { Client } = require('pg');
require('dotenv').config();
const { createCustomer } = require('./_fixtures');

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
let pass = 0, fail = 0;
const check = (l, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 700) : ''}`); };
async function req(method, path, { token, body, form } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (!form) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 429 && attempt < 8) { await new Promise((r) => setTimeout(r, 6000 * (attempt + 1))); continue; }
    let j = null; try { j = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: j && j.success === true && 'data' in j ? j.data : j };
  }
}
async function login(phone, passwords = PASSWORDS) {
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken; if (t) return t;
  }
  throw new Error(`no login for ${phone}`);
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const mar = (d) => `2025-03-${String(d).padStart(2, '0')}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const made = { staff: [], placements: [], invoices: [] };
  let cust;
  try {
    const finance = await login('9800000004');
    const rm = await login('9800000002');
    const { rows: [rmUser] } = await db.query(`SELECT id FROM users WHERE phone = '9800000002'`);
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0].id;
    cust = await createCustomer(db, 'MusterInv');
    const client = await login(cust.phone, [cust.password]);
    const C = cust.customerId;
    await db.query(`UPDATE finance_customers SET attendance_proof_mode = 'BOTH' WHERE id = $1`, [C]);

    const { rows: [s] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, branch_id, metadata, updated_at)
       VALUES (gen_random_uuid(), 'MUS-I', 'MAID', 'Isha Muster', '1990-01-01', $1, 'x', $2, '{"father_or_husband_name":"Raj","gender":"FEMALE"}'::jsonb, NOW()) RETURNING id`,
      [`95${String(Date.now()).slice(-8)}`, branchId]);
    made.staff.push(s.id);
    const { rows: [p] } = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours, staff_salary,
                               management_fee, trial_start_date, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 8, 15000, 1500, '2025-03-01', '2025-03-01', NOW(), NOW()) RETURNING id`,
      [s.id, C, branchId, rmUser.id]);
    made.placements.push(p.id);
    const mark = async (date, source, cs, actionAgo) => (await db.query(
      `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, source, client_status,
                                           client_action_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', $5, $6, $7, NOW() - make_interval(hours => $8::int), NOW(), NOW()) RETURNING id`,
      [s.id, p.id, branchId, date, rmUser.id, source, cs, actionAgo ?? 0])).rows[0].id;
    for (const d of [1, 2]) await mark(mar(d), 'STAFF_APP', 'APPROVED');
    for (const d of [3, 4, 5]) await mark(mar(d), 'STAFF_APP', 'PENDING');
    const disputed = await mark(mar(6), 'STAFF_APP', 'DISPUTED', 72);   // disputed three days ago
    for (const d of [7, 8]) await mark(mar(d), 'RM', 'NOT_REQUIRED');

    const { rows: [inv] } = await db.query(
      `INSERT INTO client_invoices (client_id, invoice_number, period_month, period_year, period_from, period_to, staff_salary_component,
                                    management_fee, gst_amount, total_amount, due_date, status, is_consolidated)
       VALUES ($1, $2, 3, 2025, '2025-03-01', '2025-03-31', 1000, 100, 18, 1118, '2025-04-15', 'DRAFT', true) RETURNING id`,
      [C, `TST-MUS-${Date.now()}`]);
    made.invoices.push(inv.id);

    // ── the proof on the invoice ────────────────────────────────────────
    let r = await req('GET', `/finance/invoices/${inv.id}`, { token: finance });
    let ap = r.body?.attendance_proof;
    check('invoice detail carries attendance_proof', ok2xx(r) && !!ap, r.body);
    check('staff-app days by client status: 2 approved, 3 waiting, 1 disputed',
      ap?.staff_app_days?.APPROVED === 2 && ap?.staff_app_days?.PENDING === 3 && ap?.staff_app_days?.DISPUTED === 1, ap?.staff_app_days);
    check('days by source: 6 staff app, 2 RM', ap?.days_by_source?.STAFF_APP === 6 && ap?.days_by_source?.RM === 2, ap?.days_by_source);
    check('warns: waiting days, disputed days, unsigned roll',
      ap?.warnings?.length === 3 && /not yet confirmed/.test(ap.warnings[0]) && /disputed/.test(ap.warnings[1]) && /not signed/.test(ap.warnings[2]), ap?.warnings);
    check('no signed roll yet', ap?.muster_roll === null, ap?.muster_roll);

    // ── attention ───────────────────────────────────────────────────────
    r = await req('GET', '/finance/invoices/attention', { token: finance });
    check('attention lists the dispute unresolved over 48 h',
      ok2xx(r) && (r.body?.disputes_unresolved ?? []).some((x) => x.id === disputed) && r.body?.counts?.disputes_unresolved >= 1, r.body?.counts);
    const lm = (await db.query(`SELECT to_char(date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 month'), 'YYYY-MM-DD') AS d,
                                      EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 month')::int AS m,
                                      EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 month')::int AS y`)).rows[0];
    await mark(lm.d, 'RM', 'NOT_REQUIRED');
    r = await req('GET', '/finance/invoices/attention', { token: finance });
    check('attention lists last month\'s unsigned roll', (r.body?.muster_rolls_unsigned ?? []).some((x) => x.client_id === C && x.rm_days === 1), r.body?.muster_rolls_unsigned);

    // ── the client signs March ──────────────────────────────────────────
    r = await req('POST', '/client/muster-rolls/sign', { token: client, body: { month: 3, year: 2025, name: 'Mrs. Invoice' } });
    check('client signs March: the 3 waiting days confirmed', ok2xx(r) && r.body?.days_confirmed === 3, r.body);
    r = await req('GET', `/finance/invoices/${inv.id}`, { token: finance });
    ap = r.body?.attendance_proof;
    check('proof now shows the signed roll v1, signed in the app',
      ap?.muster_roll?.version === 1 && ap?.muster_roll?.sign_method === 'CLIENT_APP' && ap?.muster_roll?.signed_name === 'Mrs. Invoice' && !ap?.muster_roll?.locked, ap?.muster_roll);
    check('only the dispute warning is left', ap?.warnings?.length === 1 && /disputed/.test(ap.warnings[0]), ap?.warnings);

    // ── approving locks the roll ────────────────────────────────────────
    r = await req('POST', `/finance/invoices/${inv.id}/approve`, { token: finance });
    check('Finance approves despite the warning; the roll is locked', ok2xx(r) && r.body?.muster_roll_locked === true, r.body);
    const roll = (await db.query(`SELECT invoice_id, locked_at FROM muster_rolls WHERE client_id = $1 AND period_month = 3 AND status <> 'SUPERSEDED'`, [C])).rows[0];
    check('…with the invoice on it', roll?.invoice_id === inv.id && !!roll?.locked_at, roll);
    r = await req('GET', `/finance/invoices/${inv.id}`, { token: finance });
    check('proof says locked', r.body?.attendance_proof?.muster_roll?.locked === true, r.body?.attendance_proof?.muster_roll);
    r = await req('POST', '/client/muster-rolls/sign', { token: client, body: { month: 3, year: 2025, name: 'Mrs. Invoice' } });
    check('the client cannot sign again under an approved invoice (400)', r.status === 400 && /locked/.test(JSON.stringify(r.body)), r.body);
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'roll.png');
    form.append('client_id', C); form.append('month', '3'); form.append('year', '2025');
    r = await req('POST', '/muster-rolls/upload', { token: rm, form });
    check('nor can the RM upload a paper roll (400)', r.status === 400, r.body);

    // ── cancelling frees it ─────────────────────────────────────────────
    r = await req('POST', `/finance/invoices/${inv.id}/cancel`, { token: finance, body: { reason: 'Test cancel to free the roll' } });
    check('Finance cancels the approved invoice', ok2xx(r), r.body);
    const after = (await db.query(`SELECT invoice_id, locked_at FROM muster_rolls WHERE client_id = $1 AND period_month = 3 AND status <> 'SUPERSEDED'`, [C])).rows[0];
    check('…and the roll is unlocked', after && after.invoice_id === null && after.locked_at === null, after);
    r = await req('POST', '/client/muster-rolls/sign', { token: client, body: { month: 3, year: 2025, name: 'Mrs. Invoice' } });
    check('the client can sign again: version 2', ok2xx(r) && r.body?.version === 2, r.body);
  } catch (e) {
    fail++; console.error('  ERROR', e.stack || e.message);
  } finally {
    if (cust) await db.query(`DELETE FROM muster_rolls WHERE client_id = $1`, [cust.customerId]);
    for (const id of made.invoices) {
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]).catch((e) => console.error('  cleanup invoice:', e.message));
    }
    for (const sid of made.staff) await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = $1`, [sid]);
    for (const pid of made.placements) await db.query(`DELETE FROM placements WHERE id = $1`, [pid]);
    for (const sid of made.staff) await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [sid]);
    if (cust) await cust.teardown();
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
