/**
 * Live HTTP test for shifts that cross midnight — night shifts and 24×7
 * live-in stays (2026-10-26).
 *
 * A shift used to be found by today's date, so at 12 midnight it vanished:
 * location stopped ("you are not checked in"), check-out next morning failed,
 * the family saw "not checked in". Shifts are not moved in time here — the
 * check-in is written as if it happened earlier, then the real endpoints run.
 *
 *  Night   — hourly staff checked in yesterday evening, 5 h ago (8 h shift)
 *  Forgot  — staff checked in two days ago and never checked out (8 h shift)
 *  Live-in — 24×7 per-duty staff, in since 20:00 three days ago
 *
 *   node scratch/_live_test_overnight_shifts.js
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const HQ = '00000000-0000-0000-0000-000000000001';
const STAFF_PASSWORD = 'Overnight@2026';
const HOME = { lat: 28.5592, lng: 77.2066 };

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''}`); }
}
async function req(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < 8) { await new Promise((r) => setTimeout(r, 8000 * (attempt + 1))); continue; }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json?.data !== undefined && json?.success !== undefined ? json.data : json, raw: json };
  }
}
const msg = (r) => String(r.raw?.message?.message ?? r.raw?.message ?? '');
const ok2xx = (r) => r.status >= 200 && r.status < 300;
async function login(phone, password) {
  const r = await req('POST', '/auth/login', { body: { phone, password } });
  const token = r.body?.access_token ?? r.body?.accessToken ?? r.raw?.access_token;
  if (!token) throw new Error(`login failed for ${phone}: ${r.status} ${msg(r)}`);
  return token;
}
const ist = (ms = Date.now()) => new Date(ms + 330 * 60_000);
const istDay = (n = 0) => ist(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const uniqPhone = () => '6' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { users: [], staff: [], placements: [] };
  const cust = await createCustomer(db, 'Nite');
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);
    await db.query(`UPDATE finance_customers SET lat = $2, lng = $3 WHERE id = $1`, [cust.customerId, HOME.lat, HOME.lng]);
    const hash = await bcrypt.hash(STAFF_PASSWORD, 10);

    const makeStaff = async (name) => {
      const phone = uniqPhone();
      const { rows: [u] } = await db.query(
        `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, updated_at)
         VALUES (gen_random_uuid(), 'STAFF', $1, $2, $3, true, now()) RETURNING id`, [name, phone, hash]);
      made.users.push(u.id);
      const { rows: [s] } = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
           pipeline_stage, assigned_rm_id, branch_id, user_id, updated_at)
         VALUES (gen_random_uuid(), $1, 'SKILLED_CARE', $2, '1990-05-20', $3, 'x', 'S5_DEPLOY', $4, $5, $6, NOW()) RETURNING id`,
        [`ZN-${name.slice(0, 3)}-${Date.now() % 100000}`, name, phone, rm.id, HQ, u.id]);
      made.staff.push(s.id);
      return { id: s.id, phone };
    };
    const place = async (staffId, type, cols) => {
      const { rows: [p] } = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                                 hourly_rate, rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                                 trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', $5, $6, $7, $8, $9, $10, false, false, $11, NOW(), NOW()) RETURNING id`,
        [staffId, cust.customerId, HQ, rm.id, type, cols.shift_hours, cols.hourly_rate ?? null,
         cols.rate_basis ?? null, cols.duty_rate ?? null, cols.duty_billing_rate ?? null, istDay(-5)]);
      made.placements.push(p.id);
      return p.id;
    };
    // A check-in written as if it happened `ago` ms back, on IST day `day`.
    const openShiftAt = async (staffId, placementId, day, checkInAt) => {
      const { rows: [sl] } = await db.query(
        `INSERT INTO shift_logs (id, staff_id, placement_id, shift_date, check_in_at, check_in_lat, check_in_lng, status, metadata, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::date, $4, $5, $6, 'APPROVED', '{}', NOW()) RETURNING id`,
        [staffId, placementId, day, checkInAt, HOME.lat, HOME.lng]);
      await db.query(
        `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', $5, NOW(), NOW())`,
        [staffId, placementId, HQ, day, rm.id]);
      return sl.id;
    };

    // ── Night shift: in yesterday, 5 h ago ───────────────────────────────
    console.log('\nNight shift across midnight');
    const night = await makeStaff('Night Overnighttest');
    const nightP = await place(night.id, 'TEMPORARY', { shift_hours: 8, hourly_rate: 200 });
    const nightShift = await openShiftAt(night.id, nightP, istDay(-1), new Date(Date.now() - 5 * 3_600_000));
    const nT = await login(night.phone, STAFF_PASSWORD);

    let r = await req('GET', '/staff/placements', { token: nT });
    check('app still shows them checked in after midnight', ok2xx(r) && r.body?.checked_in_at === nightP
      && r.body?.placements?.[0]?.today === 'CHECKED_IN', r.body);
    r = await req('POST', '/staff/attendance/location', { token: nT, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('location after midnight is accepted (used to be "not checked in")', ok2xx(r) && r.body?.accepted === 1, { s: r.status, m: msg(r), b: r.body });
    const cT = await login(cust.phone, cust.password);
    r = await req('GET', '/client/dashboard', { token: cT });
    check('family sees them on duty', ok2xx(r) && r.body?.todayAttendanceStatus === 'CHECKED_IN', r.body?.todayAttendanceStatus);
    r = await req('POST', '/staff/attendance/check-out', { token: nT, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('check-out next morning works (used to be "no check-in found for today")', ok2xx(r) && r.body?.attendanceId === nightShift, { s: r.status, m: msg(r) });
    const { rows: [nAtt] } = await db.query(
      `SELECT attendance_date::text d, hours_worked::float h FROM staff_daily_attendance WHERE placement_id = $1`, [nightP]);
    check('the hours land on the evening the shift began', nAtt?.d === istDay(-1) && nAtt?.h >= 4.9 && nAtt?.h <= 5.1, nAtt);

    // ── Forgotten check-out ──────────────────────────────────────────────
    console.log('\nForgotten check-out');
    const forgot = await makeStaff('Forgot Overnighttest');
    const forgotP = await place(forgot.id, 'PERMANENT', { shift_hours: 8 });
    await db.query(`UPDATE placements SET staff_salary = 15000, management_fee = 1500 WHERE id = $1`, [forgotP]);
    const oldIn = new Date(Date.now() - 40 * 3_600_000);
    const forgotShift = await openShiftAt(forgot.id, forgotP, istDay(-2), oldIn);
    const fT = await login(forgot.phone, STAFF_PASSWORD);
    r = await req('POST', '/staff/attendance/location', { token: fT, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('a 40 h old 8 h shift is not treated as still on duty', r.status === 400 && /not checked in/i.test(msg(r)), { s: r.status, m: msg(r) });
    r = await req('POST', '/staff/attendance/check-in', { token: fT, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('today\'s check-in works — not "check out first", not "already checked in"',
      ok2xx(r) && r.body?.already_checked_in === false && r.body?.attendanceId !== forgotShift, { s: r.status, m: msg(r), b: r.body });
    const { rows: [old] } = await db.query(`SELECT check_out_at, metadata FROM shift_logs WHERE id = $1`, [forgotShift]);
    check('the forgotten shift was closed at check-in + 8 h, and marked so',
      old?.check_out_at && Math.abs(new Date(old.check_out_at) - (oldIn.getTime() + 8 * 3_600_000)) < 1000 && old.metadata?.auto_closed === true, old);

    // ── 24×7 live-in, in for three days ──────────────────────────────────
    console.log('\n24×7 live-in');
    const live = await makeStaff('Livein Overnighttest');
    const liveP = await place(live.id, 'PERMANENT', { shift_hours: 24, rate_basis: 'PER_DUTY', duty_rate: 517, duty_billing_rate: 585 });
    // 20:00 IST three days ago
    const liveIn = new Date(Date.parse(`${istDay(-3)}T20:00:00+05:30`));
    const liveShift = await openShiftAt(live.id, liveP, istDay(-3), liveIn);
    const lT = await login(live.phone, STAFF_PASSWORD);
    r = await req('GET', '/staff/placements', { token: lT });
    check('live-in on day 4 is still checked in, flagged live-in', ok2xx(r) && r.body?.placements?.[0]?.today === 'CHECKED_IN'
      && r.body?.placements?.[0]?.live_in === true, r.body);
    r = await req('POST', '/staff/attendance/location', { token: lT, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('live-in location accepted on day 4', ok2xx(r) && r.body?.accepted === 1, { s: r.status, m: msg(r) });
    r = await req('GET', '/client/attendance/today', { token: cT });
    const mine = (r.body?.staff ?? []).find((s) => s.staff_name === 'Livein Overnighttest' || s.name === 'Livein Overnighttest' || JSON.stringify(s).includes('Livein'));
    check('family\'s "today" shows the live-in present', ok2xx(r) && mine && /PRESENT|CHECKED_IN/.test(JSON.stringify(mine)), mine ?? r.body);

    r = await req('POST', '/staff/attendance/check-out', { token: lT, body: { latitude: HOME.lat, longitude: HOME.lng } });
    check('live-in checks out after 3+ days', ok2xx(r) && r.body?.attendanceId === liveShift, { s: r.status, m: msg(r) });
    const pastNoonToday = ist().getUTCHours() >= 12;
    const expectedNew = 2 + (pastNoonToday ? 1 : 0);   // day -2, day -1, and today if past noon
    check(`duties marked for the days on duty at noon (${expectedNew} more)`, r.body?.live_in_days_marked === expectedNew, r.body);
    const { rows: days } = await db.query(
      `SELECT attendance_date::text d FROM staff_daily_attendance WHERE placement_id = $1 AND status = 'PRESENT' ORDER BY 1`, [liveP]);
    const want = [istDay(-3), istDay(-2), istDay(-1), ...(pastNoonToday ? [istDay(0)] : [])];
    check(`attendance: ${want.length} duties — arrival day + each noon on duty`, JSON.stringify(days.map((x) => x.d)) === JSON.stringify(want), days);

    // A day the RM had marked otherwise is not overwritten.
    await db.query(`UPDATE staff_daily_attendance SET status = 'LEAVE' WHERE placement_id = $1 AND attendance_date = $2::date`, [liveP, istDay(-2)]);
    await db.query(`UPDATE shift_logs SET check_out_at = NULL WHERE id = $1`, [liveShift]);
    r = await req('POST', '/staff/attendance/check-out', { token: lT, body: {} });
    const { rows: [lv] } = await db.query(
      `SELECT status FROM staff_daily_attendance WHERE placement_id = $1 AND attendance_date = $2::date`, [liveP, istDay(-2)]);
    check('a day the RM marked as leave stays leave', lv?.status === 'LEAVE', lv);

    // ── Client asks for 24×7 live-in staff (as the app's new option sends it) ─
    console.log('\nClient request: 24×7 live-in');
    const reqBody = {
      address: '22 Green Park, New Delhi', lat: HOME.lat, lng: HOME.lng, gender_pref: 'ANY',
      series: 'SC', visit_type: 'REGULAR', start_date: istDay(3), start_time: '08:00',
      requirements: { patient_age: 80, mobility: 'ASSISTED' },
    };
    r = await req('POST', '/client/staff-requests', { token: cT, body: { ...reqBody, placement_type: 'PERMANENT', shift_hours: 24 } });
    const reqId = r.body?.id;
    check('24×7 live-in request accepted — permanent, 24 h', ok2xx(r) && Number(r.body?.shift_hours) === 24
      && r.body?.placement_type === 'PERMANENT', { s: r.status, m: msg(r), b: r.body });
    r = await req('POST', '/client/staff-requests', { token: cT, body: { ...reqBody, placement_type: 'PERMANENT', shift_hours: 30 } });
    check('30 hours a day refused', r.status === 400 && /shift_hours/.test(msg(r)), { s: r.status, m: msg(r) });
    if (reqId) await db.query(`DELETE FROM staff_requests WHERE id = $1`, [reqId]).catch(() => {});
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.message}`);
  } finally {
    const ids = made.staff;
    await db.query(`DELETE FROM staff_location_pings WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM shift_logs WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]).catch((e) => console.log('  cleanup placements:', e.message));
    await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[]) OR payload->>'staff_id' = ANY($2::text[])`, [[cust.portalUserId, ...made.users], ids]).catch(() => {});
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [ids]).catch((e) => console.log('  cleanup staff:', e.message));
    for (const u of made.users) {
      await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [u]).catch(() => {});
      await db.query(`DELETE FROM users WHERE id = $1`, [u]).catch((e) => console.log('  cleanup user:', e.message));
    }
    await cust.teardown().catch((e) => console.log('  cleanup customer:', e.message));
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
