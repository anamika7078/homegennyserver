/**
 * Live HTTP test for check-in fixes, location during the shift, and the
 * client's view of their staff (2026-10-15),
 * docs/STAFF_TRACKING_AND_CLIENT_VISIBILITY_PLAN.md.
 *
 * Two homes (A, B, ~5 km apart). Asha works at both: on TRIAL by the hour at A,
 * CONFIRMED at B. Kamla cooks at A only. Rekha has a one-time visit tomorrow.
 *
 *   node scratch/_live_test_staff_tracking.js
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const RM_PASSWORDS = ['hg', 'HomeGenny@2024', 'Password@123'];
const HQ = '00000000-0000-0000-0000-000000000001';
const STAFF_PASSWORD = 'StaffTrack@2026';
const HOME_A = { lat: 28.5592, lng: 77.2066 };
const HOME_B = { lat: 28.6, lng: 77.25 };
const FAR_FROM_A = { lat: 28.57, lng: 77.2066 }; // ~1.2 km north of A

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
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
    return { status: res.status, body: json?.data !== undefined && json?.success !== undefined ? json.data : json, raw: json, text };
  }
}
const msg = (r) => String(r.raw?.message?.message ?? r.raw?.message ?? '');
const ok2xx = (r) => r.status >= 200 && r.status < 300;
async function login(phone, passwords) {
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const token = r.body?.access_token ?? r.body?.accessToken ?? r.raw?.access_token;
    if (token) return token;
  }
  throw new Error(`login failed for ${phone}`);
}
const uniqPhone = () => '6' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
// DUMP=1 writes the real responses to scratch/_staff_tracking_samples.json (for the mobile brief).
const samples = {};
const dump = (name, r) => { if (process.env.DUMP) samples[name] = r.body ?? r.raw; };

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { users: [], staff: [], placements: [] };
  const custA = await createCustomer(db, 'TrkA');
  const custB = await createCustomer(db, 'TrkB');
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);
    await db.query(`UPDATE finance_customers SET lat = $2, lng = $3 WHERE id = $1`, [custA.customerId, HOME_A.lat, HOME_A.lng]);
    await db.query(`UPDATE finance_customers SET lat = $2, lng = $3 WHERE id = $1`, [custB.customerId, HOME_B.lat, HOME_B.lng]);

    const hash = await bcrypt.hash(STAFF_PASSWORD, 10);
    async function makeStaff(name, series, withLogin) {
      const phone = uniqPhone();
      let userId = null;
      if (withLogin) {
        const { rows: [u] } = await db.query(
          `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, updated_at)
           VALUES (gen_random_uuid(), 'STAFF', $1, $2, $3, true, now()) RETURNING id`, [name, phone, hash]);
        userId = u.id;
        made.users.push(userId);
      }
      const { rows: [s] } = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, aadhaar_number,
           emergency_contact_name, emergency_contact_mobile, pv_status, pipeline_stage, assigned_rm_id, branch_id, user_id, metadata, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-05-20', $4, 'Secret Street 9, Faridabad', '999988887777',
           'Sunita Devi', '9111111111', 'CLEAR', 'S5_DEPLOY', $5, $6, $7, $8, NOW()) RETURNING id`,
        [`ZT-${name.slice(0, 3)}-${Date.now() % 100000}`, series, name, phone, rm.id, HQ, userId,
         JSON.stringify({ gender: 'FEMALE', city: 'New Delhi', hometown: 'Agra', experience_years: 6 })],
      );
      made.staff.push(s.id);
      return { id: s.id, phone };
    }
    async function place(staffId, clientId, status, type, meta = {}, start = istToday()) {
      const { rows: [p] } = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours, hourly_rate, trial_start_date, metadata, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 8, $9, $7, $8, NOW(), NOW()) RETURNING id`,
        [staffId, clientId, HQ, rm.id, status, type, start, JSON.stringify(meta), type === 'TEMPORARY' ? 250 : null],
      );
      made.placements.push(p.id);
      return p.id;
    }

    const asha = await makeStaff('Asha Tracktest', 'UNSKILLED_CARE', true);
    const kamla = await makeStaff('Kamla Tracktest', 'COOK', false);
    const rekha = await makeStaff('Rekha Tracktest', 'COOK', true);
    const pA = await place(asha.id, custA.customerId, 'TRIAL', 'TEMPORARY');
    const pB = await place(asha.id, custB.customerId, 'CONFIRMED', 'PERMANENT');
    await place(kamla.id, custA.customerId, 'CONFIRMED', 'PERMANENT');
    await place(rekha.id, custB.customerId, 'TRIAL', 'TEMPORARY', { visit_type: 'ONE_TIME', visit_date: inDays(1) }, inDays(1));

    const ashaT = await login(asha.phone, [STAFF_PASSWORD]);
    const rekhaT = await login(rekha.phone, [STAFF_PASSWORD]);
    const aT = await login(custA.phone, [custA.password]);
    const bT = await login(custB.phone, [custB.password]);
    const rmT = await login(RM_PHONE, RM_PASSWORDS);

    // ── staff: where can I check in ──────────────────────────────────────────
    console.log('\nStaff: placements + check-in');
    const pl = await req('GET', '/staff/placements', { token: ashaT });
    dump('GET /staff/placements', pl);
    check('staff sees both houses (trial + confirmed)', ok2xx(pl) && pl.body?.placements?.length === 2, { status: pl.status, n: pl.body?.placements?.length, msg: msg(pl) });
    check('picker gives a check-in interval of 300 s', pl.body?.location_interval_sec === 300);

    const one = await req('POST', '/staff/attendance/check-in', { token: rekhaT, body: { latitude: HOME_B.lat, longitude: HOME_B.lng } });
    check('one-time visit refused before its day', one.status === 400 && /visit is on/i.test(msg(one)), { status: one.status, msg: msg(one) });

    const ci = await req('POST', '/staff/attendance/check-in', { token: ashaT, body: { latitude: HOME_A.lat + 0.0002, longitude: HOME_A.lng } });
    dump('POST /staff/attendance/check-in', ci);
    check('trial staff checks in (nearest home picked = A)', ok2xx(ci) && ci.body?.placement_id === pA, { status: ci.status, msg: msg(ci), pl: ci.body?.placement_id });
    check('check-in says at home', ci.body?.at_home === true && ci.body?.distance_m < 50, ci.body);
    const { rows: [sl] } = await db.query(`SELECT id, shift_date::text d FROM shift_logs WHERE staff_id = $1 AND placement_id = $2`, [asha.id, pA]);
    check('shift is on the IST day', sl?.d === istToday(), sl);

    const twice = await req('POST', '/staff/attendance/check-in', { token: ashaT, body: { latitude: HOME_A.lat, longitude: HOME_A.lng } });
    check('pressing check-in again changes nothing', ok2xx(twice) && twice.body?.already_checked_in === true && twice.body?.attendanceId === sl.id, twice.body);
    const other = await req('POST', '/staff/attendance/check-in', { token: ashaT, body: { placement_id: pB, latitude: HOME_B.lat, longitude: HOME_B.lng } });
    dump('error: check-in while checked in elsewhere', other);
    check('cannot check in at B while checked in at A', other.status === 400 && /check out there first/i.test(msg(other)), { status: other.status, msg: msg(other) });

    const { rows: nIn } = await db.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND template = 'STAFF_CHECKED_IN'`, [custA.portalUserId]);
    check('client A told "Asha checked in … at home"', nIn.length === 1 && nIn[0].title === 'Asha checked in' && /at home/.test(nIn[0].body), nIn);

    // ── location during the shift ────────────────────────────────────────────
    console.log('\nLocation');
    await db.query(`UPDATE shift_logs SET check_in_at = now() - interval '30 minutes' WHERE id = $1`, [sl.id]);
    const loc = await req('POST', '/staff/attendance/location', {
      token: ashaT,
      body: { points: [
        { latitude: HOME_A.lat, longitude: HOME_A.lng, accuracy: 12, battery: 80, recorded_at: minsAgo(20) },
        { latitude: HOME_A.lat, longitude: HOME_A.lng, recorded_at: minsAgo(19) },
        { latitude: FAR_FROM_A.lat, longitude: FAR_FROM_A.lng, recorded_at: minsAgo(10) },
        { latitude: FAR_FROM_A.lat, longitude: FAR_FROM_A.lng, recorded_at: minsAgo(1) },
        { latitude: HOME_A.lat, longitude: HOME_A.lng, recorded_at: minsAgo(60) },
      ] },
    });
    dump('POST /staff/attendance/location', loc);
    check('3 points kept, 2 dropped (1 too close, 1 before check-in)', ok2xx(loc) && loc.body?.accepted === 3 && loc.body?.dropped === 2, { status: loc.status, body: loc.body, msg: msg(loc) });
    check('server tells the app the next interval', loc.body?.next_in_sec === 300);
    const badPt = await req('POST', '/staff/attendance/location', { token: ashaT, body: { latitude: 'x', longitude: 77 } });
    check('bad point refused', badPt.status === 400, badPt.status);
    const { rows: away } = await db.query(`SELECT user_id FROM notifications WHERE template = 'STAFF_AWAY_FROM_HOME' AND payload->>'shift_id' = $1`, [sl.id]);
    check('two far points → client A and RM told once', away.length === 2 && away.some((n) => n.user_id === custA.portalUserId) && away.some((n) => n.user_id === rm.id), away);
    await req('POST', '/staff/attendance/location', { token: ashaT, body: { latitude: FAR_FROM_A.lat, longitude: FAR_FROM_A.lng, recorded_at: new Date(Date.now() + 90_000).toISOString() } });
    const { rows: away2 } = await db.query(`SELECT 1 FROM notifications WHERE template = 'STAFF_AWAY_FROM_HOME' AND payload->>'shift_id' = $1`, [sl.id]);
    check('still away → not told again', away2.length === 2, away2.length);

    // ── what the client sees ─────────────────────────────────────────────────
    console.log('\nClient views');
    const la = await req('GET', `/client/staff/${asha.id}/location`, { token: aT });
    dump('GET /client/staff/:id/location (checked in)', la);
    check('client A sees Asha PRESENT with the last point', ok2xx(la) && la.body?.status === 'PRESENT' && !!la.body?.last, { status: la.status, msg: msg(la), b: la.body });
    check('last point is ~1.2 km from home, not at home', la.body?.last?.at_home === false && /km from home/.test(la.body?.last?.label ?? ''), la.body?.last);
    check('trail has today\'s points, home pin given', la.body?.trail?.length === 4 && la.body?.home?.lat === HOME_A.lat, { trail: la.body?.trail?.length, home: la.body?.home });
    const lb = await req('GET', `/client/staff/${asha.id}/location`, { token: bT });
    check('client B (Asha works there too) sees no location — not checked in at B', ok2xx(lb) && lb.body?.status === 'NOT_CHECKED_IN' && lb.body?.last === null && lb.body?.trail?.length === 0, lb.body);
    const lk = await req('GET', `/client/staff/${kamla.id}/location`, { token: bT });
    check("client B can't see A's cook", lk.status === 403, lk.status);

    const td = await req('GET', '/client/attendance/today', { token: aT });
    dump('GET /client/attendance/today', td);
    const ashaRow = td.body?.staff?.find((s) => s.staff_id === asha.id);
    check('client A today lists both staff', td.body?.staff?.length === 2, td.body?.staff?.length);
    check('Asha PRESENT with last_location, Kamla NOT_CHECKED_IN', ashaRow?.status === 'PRESENT' && !!ashaRow?.last_location && td.body.staff.find((s) => s.staff_id === kamla.id)?.status === 'NOT_CHECKED_IN', td.body?.staff);
    check('old top-level fields still there', 'todayStatus' in (td.body ?? {}) && 'staffCode' in (td.body ?? {}), Object.keys(td.body ?? {}));

    // ── check-out, then a second house ───────────────────────────────────────
    console.log('\nCheck-out + second house');
    const co = await req('POST', '/staff/attendance/check-out', { token: ashaT, body: { latitude: HOME_A.lat, longitude: HOME_A.lng } });
    dump('POST /staff/attendance/check-out', co);
    check('check-out', ok2xx(co) && co.body?.status === 'CHECKED_OUT' && /^0 h 3\d m$/.test(co.body?.worked ?? ''), { status: co.status, msg: msg(co), w: co.body?.worked });
    const { rows: [att] } = await db.query(`SELECT hours_worked::float h FROM staff_daily_attendance WHERE staff_id = $1 AND placement_id = $2`, [asha.id, pA]);
    check('hourly placement: hours worked on the attendance day (~0.5)', att && att.h >= 0.4 && att.h <= 0.6, att);
    const { rows: nOut } = await db.query(`SELECT body FROM notifications WHERE user_id = $1 AND template = 'STAFF_CHECKED_OUT'`, [custA.portalUserId]);
    check('client A told about check-out with time worked', nOut.length === 1 && /0 h 3\d m/.test(nOut[0].body), nOut);
    const la2 = await req('GET', `/client/staff/${asha.id}/location`, { token: aT });
    dump('GET /client/staff/:id/location (after check-out)', la2);
    check('after check-out the client sees no location', la2.body?.status === 'CHECKED_OUT' && la2.body?.last === null && la2.body?.trail?.length === 0, la2.body);
    const late = await req('POST', '/staff/attendance/location', { token: ashaT, body: { latitude: HOME_A.lat, longitude: HOME_A.lng } });
    check('location refused after check-out', late.status === 400 && /not checked in/i.test(msg(late)), { status: late.status, msg: msg(late) });

    const cB = await req('POST', '/staff/attendance/check-in', { token: ashaT, body: { placement_id: pB, latitude: HOME_B.lat, longitude: HOME_B.lng } });
    check('same day, checks in at house B', ok2xx(cB) && cB.body?.placement_id === pB, { status: cB.status, msg: msg(cB) });
    const coB = await req('POST', '/staff/attendance/check-out', { token: ashaT, body: {} });
    check('checks out at B', ok2xx(coB), { status: coB.status, msg: msg(coB) });
    const { rows: [{ n: rowsToday }] } = await db.query(`SELECT count(*)::int n FROM shift_logs WHERE staff_id = $1 AND shift_date = $2::date`, [asha.id, istToday()]);
    check('two shifts today, one per house', rowsToday === 2, rowsToday);
    const again = await req('POST', '/staff/attendance/check-out', { token: ashaT, body: {} });
    check('second check-out says already checked out', again.status === 400 && /already checked out/i.test(msg(again)), msg(again));

    const hA = await req('GET', '/client/attendance/history', { token: aT });
    dump('GET /client/attendance/history', hA);
    check("client A history: only A's day", ok2xx(hA) && hA.body?.history?.length === 1 && hA.body.history[0].placement_id === pA, hA.body?.history);
    const hB = await req('GET', `/client/attendance/history?staff_id=${asha.id}`, { token: bT });
    check("client B history: only B's day", hB.body?.history?.length === 1 && hB.body.history[0].placement_id === pB, hB.body?.history);

    // ── profile ──────────────────────────────────────────────────────────────
    console.log('\nProfile');
    const pr = await req('GET', `/client/staff/${asha.id}/profile`, { token: aT });
    dump('GET /client/staff/:id/profile', pr);
    const b = pr.body ?? {};
    check('profile: name, phone, age, gender, city, experience', ok2xx(pr) && b.full_name === 'Asha Tracktest' && b.phone === asha.phone && b.age >= 35 && b.gender === 'FEMALE' && b.city === 'New Delhi' && b.experience_years === 6, { status: pr.status, msg: msg(pr), b });
    check('profile: emergency contact name, RM, placement on trial', b.emergency_contact_name === 'Sunita Devi' && !!b.rm?.name && b.placement?.status_label === 'On trial', { e: b.emergency_contact_name, rm: b.rm, p: b.placement });
    check('profile: verification block', b.verification && b.verification.police_verification === 'CLEAR' && 'id_verified' in b.verification, b.verification);
    check('profile never has Aadhaar, home address or emergency number', !/999988887777|Secret Street|9111111111/.test(pr.text), pr.text.slice(0, 200));
    check('no photo on file → photo_url null, photo 404', b.photo_url === null && (await req('GET', `/client/staff/${asha.id}/photo`, { token: aT })).status === 404);
    const prX = await req('GET', `/client/staff/${kamla.id}/profile`, { token: bT });
    check("client B can't open A's cook's profile", prX.status === 403, prX.status);

    // ── RM map ───────────────────────────────────────────────────────────────
    console.log('\nRM map');
    const map = await req('GET', '/rm/checkins', { token: rmT });
    const mA = map.body?.items?.find((i) => i.shift_id === sl.id);
    check('RM map has the trail of the A shift', ok2xx(map) && mA?.trail?.length === 4 && mA?.last_location === null, { status: map.status, t: mA?.trail?.length, last: mA?.last_location });

    if (process.env.DUMP) samples.notifications_client_A = (await db.query(`SELECT template, title, body, payload FROM notifications WHERE user_id = $1 ORDER BY created_at`, [custA.portalUserId])).rows;
    // ── 30-day cleanup ───────────────────────────────────────────────────────
    console.log('\nCleanup cron');
    await db.query(
      `INSERT INTO staff_location_pings (staff_id, placement_id, shift_log_id, lat, lng, recorded_at)
       VALUES ($1, $2, $3, 1, 1, now() - interval '40 days')`, [asha.id, pA, sl.id]);
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../dist/app.module');
    const { TrackingService } = require('../dist/modules/tracking/tracking.service');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    let purged = 0;
    try { purged = await app.get(TrackingService).purgeOldPoints(); } finally { await app.close(); }
    const { rows: [{ n: left }] } = await db.query(`SELECT count(*)::int n FROM staff_location_pings WHERE shift_log_id = $1`, [sl.id]);
    check('points older than 30 days removed, today\'s kept', purged >= 1 && left === 4, { purged, left });
  } finally {
    const ids = made.staff;
    await db.query(`DELETE FROM staff_location_pings WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM shift_logs WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE staff_applicant_id = ANY($1::uuid[]))`, [ids]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]).catch((e) => console.log('  cleanup placements:', e.message));
    await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[]) OR payload->>'staff_id' = ANY($2::text[])`, [[custA.portalUserId, custB.portalUserId, ...made.users], ids]).catch(() => {});
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [ids]).catch((e) => console.log('  cleanup staff:', e.message));
    for (const u of made.users) {
      await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [u]).catch(() => {});
      await db.query(`DELETE FROM users WHERE id = $1`, [u]).catch((e) => console.log('  cleanup user:', e.message));
    }
    await custA.teardown().catch((e) => console.log('  cleanup A:', e.message));
    await custB.teardown().catch((e) => console.log('  cleanup B:', e.message));
    await db.end();
  }
  if (process.env.DUMP) require('fs').writeFileSync(__dirname + '/_staff_tracking_samples.json', JSON.stringify(samples, null, 2));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
