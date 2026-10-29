/**
 * Live HTTP verification of the muster-roll groundwork (M0).
 *
 *  - every attendance writer records where the day came from:
 *      staff check-in → STAFF_APP / PENDING (the client will confirm it)
 *      RM entry       → RM / NOT_REQUIRED
 *      HR entry       → HR / NOT_REQUIRED, and it wins over the staff check-in
 *      the staff member checking in again that day does not take it back
 *  - father's/husband's name: the staff app saves and returns it; bad input 400;
 *    the RM can set it (and gender) without wiping the rest of the profile
 *  - placement weekly off: day name or 0–6, cleared with '', bad value 400
 *  - client: attendance_proof_mode APP | PAPER | BOTH, bad value 400
 *
 * Builds and removes its own rows.
 *
 *   node scratch/_live_test_muster_roll_m0.js
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const STAFF_PASSWORD = 'Muster@2026';
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
async function login(phone, passwords = PASSWORDS) {
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken; if (t) return t;
  }
  throw new Error(`no login for ${phone}`);
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const istDay = (n) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);
const msg = (r) => JSON.stringify(r.body ?? '');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const made = { customer: null, user: null, staff: null, placement: null, employee: null };
  try {
    const rm = await login('9800000002');
    const hr = await login('9800000008');
    const finance = await login('9800000004');
    const { rows: [rmUser] } = await db.query(`SELECT id FROM users WHERE phone = '9800000002'`);
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0].id;

    const { rows: [c] } = await db.query(
      `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state, bill_no_prefix,
                                      status, lat, lng, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Muster M0 Test', 'MUSM0', 'x', 'x', 'New Delhi', 'Delhi', 'MUSM0', 'ACTIVE', $1, $2, now(), now())
       RETURNING id`, [HOME.lat, HOME.lng]);
    made.customer = c.id;
    const phone = '6' + String(Date.now()).slice(-9);
    const { rows: [u] } = await db.query(
      `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, updated_at)
       VALUES (gen_random_uuid(), 'STAFF', 'Muster Staff', $1, $2, true, now()) RETURNING id`,
      [phone, await bcrypt.hash(STAFF_PASSWORD, 10)]);
    made.user = u.id;
    const { rows: [s] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, pipeline_stage,
                                     assigned_rm_id, branch_id, user_id, metadata, updated_at)
       VALUES (gen_random_uuid(), 'MUSM0-01', 'MAID', 'Muster Staff', '1994-03-02', $1, 'x', 'S5_DEPLOY', $2, $3, $4,
               '{"city":"Delhi NCR","gender":"FEMALE"}'::jsonb, NOW()) RETURNING id`,
      [phone, rmUser.id, branchId, u.id]);
    made.staff = s.id;
    const { rows: [p] } = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                               staff_salary, management_fee, trial_start_date, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 8, 15000, 1500, $5::date, $5::date, NOW(), NOW())
       RETURNING id`, [s.id, c.id, branchId, rmUser.id, istDay(-20)]);
    made.placement = p.id;
    const cat = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
    const { rows: [e] } = await db.query(
      `INSERT INTO employees (id, employee_id, full_name, mobile, date_of_birth, gender, address, city, state, pincode,
                              emergency_contact, joining_date, branch_id, department, designation, category_id,
                              employment_type, salary, status, staff_applicant_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'MUSM0EMP', 'Muster Staff', $1, make_date(1994,3,2), 'Female', 'x', 'New Delhi', 'Delhi',
               '110001', '9700000089', make_date(2026,1,1), $2, 'Housekeeping', 'Maid', $3, 'Full Time', 15000, 'Active', $4,
               now(), now()) RETURNING id`,
      [phone, branchId, cat.rows[0]?.id ?? null, s.id]);
    made.employee = e.id;
    const staff = await login(phone, [STAFF_PASSWORD]);

    const day = async (date) => (await db.query(
      `SELECT source, client_status FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date = $2::date`,
      [s.id, date])).rows[0];

    // ── staff check-in ───────────────────────────────────────────────────
    let r = await req('POST', '/staff/attendance/check-in', { token: staff, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('staff checks in', ok2xx(r), r.body);
    let d = await day(istToday());
    check('check-in day: STAFF_APP, waiting for the client', d?.source === 'STAFF_APP' && d?.client_status === 'PENDING', d);

    // ── RM entry ─────────────────────────────────────────────────────────
    r = await req('PUT', '/rm/attendance', { token: rm, body: { staff_id: s.id, date: istDay(-3), status: 'PRESENT', placement_id: p.id } });
    check('RM marks a day', ok2xx(r), r.body);
    d = await day(istDay(-3));
    check('RM day: RM, no client approval needed', d?.source === 'RM' && d?.client_status === 'NOT_REQUIRED', d);

    // ── HR entry over the staff check-in ─────────────────────────────────
    r = await req('POST', '/attendance/mark', {
      token: hr, body: { employeeId: e.id, date: istToday(), status: 'Present', placementId: p.id, overrideSelfCheckIn: true },
    });
    check('HR marks the same day over the check-in', ok2xx(r), r.body);
    d = await day(istToday());
    check('…the office entry wins: HR, no client approval needed', d?.source === 'HR' && d?.client_status === 'NOT_REQUIRED', d);
    r = await req('POST', '/attendance/mark', { token: hr, body: { employeeId: e.id, date: istDay(-5), status: 'Present', placementId: p.id } });
    d = await day(istDay(-5));
    check('HR day on its own: HR / NOT_REQUIRED', ok2xx(r) && d?.source === 'HR' && d?.client_status === 'NOT_REQUIRED', { r: r.body, d });

    await req('POST', '/staff/attendance/check-out', { token: staff, body: { latitude: HOME.lat, longitude: HOME.lng } });
    r = await req('POST', '/staff/attendance/check-in', { token: staff, body: { latitude: HOME.lat, longitude: HOME.lng } });
    d = await day(istToday());
    check('staff checking in again that day does not take it back from HR', d?.source === 'HR', { r: r.status, d });

    // ── father's/husband's name ─────────────────────────────────────────
    r = await req('PUT', '/staff/profile', { token: staff, body: { father_or_husband_name: 'Ramesh Kumar' } });
    check('staff app saves father/husband name', ok2xx(r) && r.body?.fatherOrHusbandName === 'Ramesh Kumar', r.body);
    r = await req('GET', '/staff/profile', { token: staff });
    check('…and returns it', r.body?.fatherOrHusbandName === 'Ramesh Kumar', r.body?.fatherOrHusbandName);
    r = await req('PUT', '/staff/profile', { token: staff, body: { father_or_husband_name: '1' } });
    check('bad name → 400', r.status === 400 && /father_or_husband_name/.test(msg(r)), r.body);
    r = await req('PATCH', `/staff/${s.id}`, { token: rm, body: { father_or_husband_name: 'Suresh Kumar', gender: 'female' } });
    const meta = (await db.query(`SELECT metadata FROM staff_applicants WHERE id = $1`, [s.id])).rows[0].metadata;
    check('RM sets name and gender without wiping the profile',
      ok2xx(r) && meta.father_or_husband_name === 'Suresh Kumar' && meta.gender === 'FEMALE' && meta.city === 'Delhi NCR', { r: r.status, meta });
    r = await req('PATCH', `/staff/${s.id}`, { token: rm, body: { gender: 'X' } });
    check('RM: bad gender → 400', r.status === 400, r.body);

    // ── weekly off ───────────────────────────────────────────────────────
    r = await req('PATCH', `/placements/${p.id}/terms`, { token: rm, body: { weekly_off_day: 'SUNDAY' } });
    check('weekly off by name → 0 (Sunday)', ok2xx(r) && r.body?.weekly_off_day === 0, r.body?.weekly_off_day ?? r.body);
    r = await req('PATCH', `/placements/${p.id}/terms`, { token: rm, body: { weekly_off_day: 3 } });
    check('weekly off by number → 3 (Wednesday)', ok2xx(r) && r.body?.weekly_off_day === 3, r.body?.weekly_off_day);
    r = await req('PATCH', `/placements/${p.id}/terms`, { token: rm, body: { weekly_off_day: 9 } });
    check('weekly off 9 → 400', r.status === 400, r.body);
    r = await req('PATCH', `/placements/${p.id}/terms`, { token: rm, body: { weekly_off_day: '' } });
    check('weekly off cleared with ""', ok2xx(r) && r.body?.weekly_off_day === null, r.body?.weekly_off_day);

    // ── client proof mode ───────────────────────────────────────────────
    r = await req('PUT', `/finance/customers/${c.id}`, { token: finance, body: { attendance_proof_mode: 'paper' } });
    check('client set to PAPER', ok2xx(r) && r.body?.attendance_proof_mode === 'PAPER', r.body?.attendance_proof_mode ?? r.body);
    r = await req('PUT', `/finance/customers/${c.id}`, { token: finance, body: { attendance_proof_mode: 'FAX' } });
    check('bad proof mode → 400', r.status === 400, r.body);
  } catch (err) {
    fail++; console.error('  ERROR', err.stack || err.message);
  } finally {
    if (made.staff) {
      await db.query(`DELETE FROM attendance WHERE employee_id = $1`, [made.employee]).catch(() => {});
      await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = $1`, [made.staff]);
      await db.query(`DELETE FROM staff_location_pings WHERE staff_id = $1`, [made.staff]).catch(() => {});
      await db.query(`DELETE FROM shift_logs WHERE staff_id = $1`, [made.staff]);
      await db.query(`DELETE FROM notifications WHERE user_id = $1`, [made.user]).catch(() => {});
    }
    if (made.employee) await db.query(`DELETE FROM employees WHERE id = $1`, [made.employee]).catch((x) => console.log('  cleanup employee:', x.message));
    if (made.placement) {
      await db.query(`DELETE FROM placement_rate_changes WHERE placement_id = $1`, [made.placement]).catch(() => {});
      await db.query(`DELETE FROM audit_logs WHERE entity_id = $1`, [made.placement]).catch(() => {});
      await db.query(`DELETE FROM placements WHERE id = $1`, [made.placement]);
    }
    if (made.staff) {
      await db.query(`DELETE FROM audit_logs WHERE entity_id = $1`, [made.staff]).catch(() => {});
      await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [made.staff]).catch((x) => console.log('  cleanup staff:', x.message));
    }
    if (made.user) await db.query(`DELETE FROM users WHERE id = $1`, [made.user]).catch((x) => console.log('  cleanup user:', x.message));
    if (made.customer) await db.query(`DELETE FROM finance_customers WHERE id = $1`, [made.customer]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
