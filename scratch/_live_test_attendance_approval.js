/**
 * Live HTTP verification of M1 — the client confirming staff-app attendance.
 *
 *  - the client sees the staff-app days waiting on them (not HR/RM entries,
 *    not another client's), approves one, then a range (the week at once)
 *  - disputes one with a reason: the RM is told, the day leaves payroll until
 *    resolved; the RM resolves it (half day) and client + staff are told
 *  - a day unanswered for 48 hours is DEEMED; a day already on a released
 *    payslip cannot be disputed; the RM confirms for a client without the app
 *  - the 9 pm note lists today's waiting days; the staff app shows each day's
 *    client status
 *
 * Uses April 2025 for the fixed days. Builds and removes its own rows.
 *
 *   node scratch/_live_test_attendance_approval.js
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { createCustomer } = require('./_fixtures');

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const STAFF_PASSWORD = 'Approve@2026';
const HOME = { lat: 28.6139, lng: 77.209 };

let pass = 0, fail = 0;
const check = (l, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 600) : ''}`); };
async function req(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 429 && attempt < 8) { await new Promise((r) => setTimeout(r, 6000 * (attempt + 1))); continue; }
    let j = null; try { j = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: j && j.success === true && 'data' in j ? j.data : j };
  }
}
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(e) {
  const s = String(e).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of s) { const i = BASE32.indexOf(ch); if (i === -1) continue; value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secret) {
  const { createHmac } = require('crypto');
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const d = createHmac('sha1', base32Decode(secret)).update(buf).digest(); const o = d[d.length - 1] & 0x0f;
  return String((((d[o] & 0x7f) << 24) | ((d[o + 1] & 0xff) << 16) | ((d[o + 2] & 0xff) << 8) | (d[o + 3] & 0xff)) % 1000000).padStart(6, '0');
}
let DB;
async function login(phone, passwords = PASSWORDS) {
  const secret = ((await DB.query(`SELECT metadata FROM users WHERE phone = $1`, [phone])).rows[0]?.metadata ?? {}).totp_secret;
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password, ...(secret ? { totp: totp(secret) } : {}) } });
    const t = r.body?.access_token || r.body?.accessToken; if (t) return t;
  }
  throw new Error(`no login for ${phone}`);
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const apr = (d) => `2025-04-${String(d).padStart(2, '0')}`;
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const msg = (r) => JSON.stringify(r.body ?? '');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); DB = db;
  const started = new Date();
  const made = { users: [], staff: [], placements: [], customers: [] };
  let cust, other;
  try {
    const rm = await login('9800000002');
    const finance = await login('9800000004');
    const admin = await login('9800000003');
    const { rows: [rmUser] } = await db.query(`SELECT id FROM users WHERE phone = '9800000002'`);
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0].id;

    cust = await createCustomer(db, 'Approve');
    other = await createCustomer(db, 'Other');
    await db.query(`UPDATE finance_customers SET lat = $2, lng = $3 WHERE id = $1`, [cust.customerId, HOME.lat, HOME.lng]);
    const client = await login(cust.phone, [cust.password]);
    const otherClient = await login(other.phone, [other.password]);

    const phone = '6' + String(Date.now()).slice(-9);
    const { rows: [u] } = await db.query(
      `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, updated_at)
       VALUES (gen_random_uuid(), 'STAFF', 'Approve Staff', $1, $2, true, now()) RETURNING id`, [phone, await bcrypt.hash(STAFF_PASSWORD, 10)]);
    made.users.push(u.id);
    const { rows: [s] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, pipeline_stage,
                                     assigned_rm_id, branch_id, user_id, updated_at)
       VALUES (gen_random_uuid(), 'APPR-01', 'MAID', 'Approve Staff', '1994-03-02', $1, 'x', 'S5_DEPLOY', $2, $3, $4, NOW()) RETURNING id`,
      [phone, rmUser.id, branchId, u.id]);
    made.staff.push(s.id);
    const { rows: [p] } = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                               staff_salary, management_fee, trial_start_date, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 8, 15000, 1500, '2025-04-01', '2025-04-01', NOW(), NOW())
       RETURNING id`, [s.id, cust.customerId, branchId, rmUser.id]);
    made.placements.push(p.id);
    const day = async (d, source, status, createdAgoH = 1) => (await db.query(
      `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by,
                                           source, client_status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', $5, $6, $7, NOW() - make_interval(hours => $8), NOW()) RETURNING id`,
      [s.id, p.id, branchId, d, rmUser.id, source, status, createdAgoH])).rows[0].id;
    const d1 = await day(apr(1), 'STAFF_APP', 'PENDING');
    const d2 = await day(apr(2), 'STAFF_APP', 'PENDING');
    const d3 = await day(apr(3), 'STAFF_APP', 'PENDING');
    const d4 = await day(apr(4), 'STAFF_APP', 'PENDING');
    await day(apr(5), 'RM', 'NOT_REQUIRED');
    const d6 = await day(apr(6), 'STAFF_APP', 'PENDING', 50);   // unanswered for 50 h
    const d7 = await day(apr(7), 'STAFF_APP', 'PENDING');
    const d8 = await day(apr(8), 'STAFF_APP', 'PENDING');
    const statusOf = async (id) => (await db.query(`SELECT status::text, client_status, client_note, resolution_note FROM staff_daily_attendance WHERE id = $1`, [id])).rows[0];

    // ── the client's list ───────────────────────────────────────────────
    let r = await req('GET', `/client/attendance/approvals?from=${apr(1)}&to=${apr(30)}`, { token: client });
    const ids = (r.body?.items ?? []).map((x) => x.id);
    check('client sees the 7 staff-app days waiting, not the RM entry',
      ok2xx(r) && ids.length === 7 && [d1, d2, d3, d4, d6, d7, d8].every((x) => ids.includes(x)) && r.body.pending_count >= 7, r.body);
    check('…each with a deemed_at 48 h after it was written', (r.body?.items ?? []).every((x) => x.deemed_at), r.body?.items?.[0]);
    r = await req('GET', `/client/attendance/approvals?from=${apr(1)}&to=${apr(30)}`, { token: otherClient });
    check('another client sees none of them', ok2xx(r) && (r.body?.items ?? []).length === 0, r.body);
    r = await req('POST', '/client/attendance/approve', { token: otherClient, body: { ids: [d1] } });
    check('…and cannot approve them', r.body?.approved === 0, r.body);

    // ── approve ─────────────────────────────────────────────────────────
    r = await req('POST', '/client/attendance/approve', { token: client, body: { ids: [d1] } });
    check('approve one day', r.body?.approved === 1 && (await statusOf(d1)).client_status === 'APPROVED', r.body);
    r = await req('POST', '/client/attendance/approve', { token: client, body: { from: apr(2), to: apr(3) } });
    check('approve the range 2–3 at once', r.body?.approved === 2, r.body);
    r = await req('POST', '/client/attendance/approve', { token: client, body: {} });
    check('approve with nothing to approve → 400', r.status === 400, r.body);

    // ── dispute ─────────────────────────────────────────────────────────
    r = await req('POST', `/client/attendance/${d4}/dispute`, { token: client, body: { reason: 'no' } });
    check('dispute needs a reason', r.status === 400, r.body);
    r = await req('POST', `/client/attendance/${d4}/dispute`, { token: client, body: { reason: 'She did not come that day', actual: 'ABSENT' } });
    check('client disputes the 4th', ok2xx(r) && r.body?.client_status === 'DISPUTED', r.body);
    const rmNote = (await db.query(
      `SELECT body FROM notifications WHERE user_id = $1 AND template = 'ATTENDANCE_DISPUTED' AND created_at >= $2`, [rmUser.id, started])).rows;
    check('the RM is told, with the reason', rmNote.some((n) => /did not come/.test(n.body)), rmNote);

    // Payroll leaves the disputed day out: 4 + RM 5th + 6, 7, 8 = 7 days, not 8.
    r = await req('POST', '/finance/invoices/consolidated/generate', { token: finance, body: { customer_id: cust.customerId, month: 4, year: 2025 } });
    const pr = (await db.query(`SELECT id, shift_days FROM payroll_records WHERE placement_id = $1`, [p.id])).rows[0];
    check('payroll counts 7 days — the disputed day is left out', ok2xx(r) && pr?.shift_days === 7, { status: r.status, pr, b: r.body });
    // Clear it so the rest can run without a payroll in the way.
    const invId = r.body?.invoice?.id;
    if (invId) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [invId]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invId]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [invId]);
    }
    await db.query(`DELETE FROM payroll_records WHERE placement_id = $1`, [p.id]);

    // ── the RM resolves ─────────────────────────────────────────────────
    r = await req('GET', '/rm/attendance/disputes', { token: rm });
    const disp = (r.body?.items ?? []).find((x) => x.id === d4);
    check('RM sees it under disputes, with the client\'s note', disp && /ABSENT: She did not come/.test(disp.client_note), r.body);
    r = await req('POST', `/rm/attendance/${d4}/resolve`, { token: rm, body: { status: 'PRESENT', note: 'x' } });
    check('resolving needs a note', r.status === 400, r.body);
    r = await req('POST', `/rm/attendance/${d4}/resolve`, { token: rm, body: { status: 'HALF_DAY', note: 'Came at 2 pm — called the client and staff' } });
    const st4 = await statusOf(d4);
    check('RM resolves: a half day, counted again', ok2xx(r) && st4.status === 'HALF_DAY' && st4.client_status === 'APPROVED' && /2 pm/.test(st4.resolution_note), st4);
    const told = (await db.query(
      `SELECT user_id FROM notifications WHERE template = 'ATTENDANCE_RESOLVED' AND created_at >= $1 AND user_id = ANY($2::uuid[])`,
      [started, [cust.portalUserId, u.id]])).rows.map((x) => x.user_id);
    check('client and staff are told', told.includes(cust.portalUserId) && told.includes(u.id), told);

    // ── deemed after 48 h ───────────────────────────────────────────────
    r = await req('POST', '/rm/attendance/jobs/deem', { token: rm });
    check('only an Admin can run the job (403)', r.status === 403, r.status);
    r = await req('POST', '/rm/attendance/jobs/deem', { token: admin });
    check('the 50-hour-old day is DEEMED, the fresh ones are not',
      ok2xx(r) && (await statusOf(d6)).client_status === 'DEEMED' && (await statusOf(d7)).client_status === 'PENDING', r.body);

    // ── on behalf ───────────────────────────────────────────────────────
    r = await req('GET', `/rm/attendance/awaiting-client?client_id=${cust.customerId}`, { token: rm });
    check('RM sees the days still waiting on this client', (r.body?.items ?? []).some((x) => x.id === d7), r.body);
    r = await req('POST', '/rm/attendance/approve-on-behalf', { token: rm, body: { ids: [d7], note: 'Confirmed on the phone with Mrs. A' } });
    const st7 = await statusOf(d7);
    check('RM confirms for the client, with how', r.body?.approved === 1 && st7.client_status === 'APPROVED' && /RM on behalf.*phone/.test(st7.client_note), st7);

    // ── no dispute once paid ────────────────────────────────────────────
    await db.query(
      `INSERT INTO payroll_records (id, placement_id, staff_id, period_month, period_year, period_from, period_to, shift_days,
                                    gross_salary, deductions, net_salary, placement_type, released_at)
       VALUES (gen_random_uuid(), $1, $2, 4, 2025, '2025-04-01', '2025-04-08', 8, 1000, '{}', 1000, 'PERMANENT', NOW())`, [p.id, s.id]);
    r = await req('POST', `/client/attendance/${d8}/dispute`, { token: client, body: { reason: 'Left at noon that day' } });
    check('a day already on a released payslip cannot be disputed', r.status === 400 && /approved invoice/.test(msg(r)), r.body);
    await db.query(`DELETE FROM payroll_records WHERE placement_id = $1`, [p.id]);

    // ── 9 pm note and the staff app ─────────────────────────────────────
    const staffTok = await login(phone, [STAFF_PASSWORD]);
    r = await req('POST', '/staff/attendance/check-in', { token: staffTok, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('staff checks in today', ok2xx(r), r.body);
    r = await req('POST', '/rm/attendance/jobs/remind', { token: admin });
    const remind = (await db.query(
      `SELECT body FROM notifications WHERE user_id = $1 AND template = 'ATTENDANCE_CONFIRM' AND created_at >= $2`, [cust.portalUserId, started])).rows;
    check('9 pm note to the client lists today\'s waiting day', ok2xx(r) && remind.some((n) => /Approve Staff/.test(n.body)), { r: r.body, remind });
    r = await req('GET', '/staff/attendance/history', { token: staffTok });
    const today = (r.body?.history ?? []).find((h) => h.date === istToday());
    check('staff app shows today as waiting on the client', today?.client_status === 'PENDING', r.body?.history?.[0]);
  } catch (e) {
    fail++; console.error('  ERROR', e.stack || e.message);
  } finally {
    for (const sid of made.staff) {
      await db.query(`DELETE FROM payroll_records WHERE staff_id = $1`, [sid]).catch(() => {});
      await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = $1`, [sid]);
      await db.query(`DELETE FROM staff_location_pings WHERE staff_id = $1`, [sid]).catch(() => {});
      await db.query(`DELETE FROM shift_logs WHERE staff_id = $1`, [sid]);
    }
    if (cust) {
      const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = $1`, [cust.customerId])).rows;
      for (const { id } of invs) {
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
        await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
      }
    }
    await db.query(`DELETE FROM notifications WHERE created_at >= $1 AND template IN ('ATTENDANCE_DISPUTED','ATTENDANCE_RESOLVED','ATTENDANCE_CONFIRM','STAFF_CHECKED_IN')
                      AND (user_id = ANY($2::uuid[]) OR body LIKE '%Approve Staff%')`, [started, made.users]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [made.users]).catch(() => {});
    for (const pid of made.placements) await db.query(`DELETE FROM placements WHERE id = $1`, [pid]);
    for (const sid of made.staff) await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [sid]);
    for (const uid of made.users) await db.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
    if (cust) await cust.teardown();
    if (other) await other.teardown();
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
