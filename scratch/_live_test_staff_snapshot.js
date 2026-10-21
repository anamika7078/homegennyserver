/**
 * Live HTTP test for the staff snapshot (2026-10-21), docs/STAFF_SNAPSHOT_PLAN.md:
 *   GET /rm/snapshot      availability states, deployments, the day's work (RED/AMBER/GREEN/NOT_STARTED)
 *   GET /client/snapshot  the client's own staff, today, last 7 days, open requests
 *   shift_start           set on create, from a request, and through PATCH /placements/:id/terms
 *
 * The day's fixtures are written for YESTERDAY and read with ?date=yesterday,
 * so the day is over and every rule (late, no-show, due meals, report) is
 * decided the same way whatever time the test runs.
 *
 *   node scratch/_live_test_staff_snapshot.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const RM_PASSWORDS = ['hg', 'HomeGenny@2024', 'Password@123'];
const HQ = '00000000-0000-0000-0000-000000000001';
const OTP = process.env.AUTH_MOCK_OTP || '123456';

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
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json?.data !== undefined && json?.success !== undefined ? json.data : json, raw: json };
  }
}
const msg = (r) => String(r.raw?.message?.message ?? r.raw?.message ?? '');
async function login(phone, passwords) {
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.body?.access_token) return r.body.access_token;
  }
  throw new Error(`login failed for ${phone}`);
}

const istDate = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
/** An instant: IST date + HH:MM → the UTC Date. */
const istAt = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`);
const tag = `ZS${Date.now() % 100000}`;
const phone = () => '6' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { staff: [], placements: [], customers: [], users: [], plans: [] };
  const Y = istDate(-1);
  try {
    const rmToken = await login(RM_PHONE, RM_PASSWORDS);
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);

    // Client: a real app sign-up, so /client/snapshot can be called as them.
    const clientPhone = '7' + String(Date.now()).slice(-8) + '1';
    await req('POST', '/auth/otp/send', { body: { phone: clientPhone } });
    const v = await req('POST', '/auth/otp/verify', { body: { phone: clientPhone, otp: OTP, role: 'CLIENT', full_name: `${tag} Home` } });
    const clientToken = v.body.access_token;
    const { rows: [cust] } = await db.query(
      `SELECT c.id FROM finance_customers c JOIN users u ON u.id = c.user_id WHERE u.phone = $1`, [clientPhone]);
    made.customers.push(cust.id);
    made.users.push(clientPhone);
    // Home at Green Park; check-ins are measured against it.
    await db.query(`UPDATE finance_customers SET lat = 28.5592, lng = 77.2066, city = 'Delhi NCR', pincode = '110016', address = '22 Green Park' WHERE id = $1`, [cust.id]);

    async function staff(name, series, stage = 'S5_DEPLOY') {
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
           pipeline_stage, assigned_rm_id, branch_id, metadata, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-01-01', $4, 'x', $5, $6, $7, '{"gender":"FEMALE","city":"New Delhi"}', NOW())
         RETURNING id`,
        [`${tag}-${name}`, series, `${name} ${tag}`, phone(), stage, rm.id, HQ]);
      made.staff.push(id);
      return id;
    }
    async function placement(staffId, { type = 'PERMANENT', status = 'CONFIRMED', start = null, trialEnd = null, meta = {} } = {}) {
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours, shift_start,
           hourly_rate, trial_start_date, trial_end_date, metadata, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::placement_status, $6, 8, $7, $8, $9::date - 10, $10, $11, NOW())
         RETURNING id`,
        [staffId, cust.id, HQ, rm.id, status, type, start, type === 'TEMPORARY' ? 150 : null, Y, trialEnd, JSON.stringify(meta)]);
      made.placements.push(id);
      return id;
    }
    async function checkIn(staffId, pid, hhmm, lat = 28.5592, lng = 77.2066) {
      await db.query(
        `INSERT INTO shift_logs (id, staff_id, placement_id, shift_date, check_in_at, check_in_lat, check_in_lng, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
        [staffId, pid, Y, istAt(Y, hhmm), lat, lng]);
    }

    // ── Fixtures ──────────────────────────────────────────────────────────
    const sAvail = await staff('Avail', 'UNSKILLED_CARE');
    const sHourly = await staff('Hourly', 'UNSKILLED_CARE');
    await placement(sHourly, { type: 'TEMPORARY', start: '10:00' });
    const sSoon = await staff('Soon', 'SKILLED_CARE');
    const pSoon = await placement(sSoon, { status: 'TRIAL', trialEnd: istDate(3) });
    const sLeave = await staff('Leave', 'UNSKILLED_CARE');
    const pLeave = await placement(sLeave, { start: '08:00' });
    await db.query(
      `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LEAVE', $5, NOW())`, [sLeave, pLeave, HQ, Y, rm.id]);
    const sHold = await staff('Hold', 'UNSKILLED_CARE');
    await db.query(`INSERT INTO stage_holds (staff_id, stage, reason, kind) VALUES ($1, 'S4_AGREEMENTS', 'test', 'HOLD')`, [sHold]);
    await staff('Pipe', 'UNSKILLED_CARE', 'S3_TRAIN');

    // Care, late, one missed medicine, one done, a report missing.
    const sLate = await staff('Late', 'UNSKILLED_CARE');
    const pLate = await placement(sLate, { start: '08:00' });
    await checkIn(sLate, pLate, '08:30');
    const { rows: [plan] } = await db.query(
      `INSERT INTO care_plans (placement_id, client_id, version) VALUES ($1, $2, 1) RETURNING id`, [pLate, cust.id]);
    made.plans.push(plan.id);
    await db.query(
      `INSERT INTO care_tasks (placement_id, plan_id, task_date, source_type, source_id, title, scheduled_time, status)
       VALUES ($1, $2, $3, 'MEDICATION', 'm1', 'Metformin 500 mg', '09:00', 'MISSED'),
              ($1, $2, $3, 'ACTIVITY', 'a1', 'Morning walk', '10:00', 'DONE'),
              ($1, $2, $3, 'ACTIVITY', 'a2', 'Evening walk', '18:00', 'PENDING')`,
      [pLate, plan.id, Y]);

    // Cook, no check-in long after start, breakfast planned and not logged.
    const sCook = await staff('Cook', 'COOK');
    const pCook = await placement(sCook, { start: '07:00' });
    await db.query(
      `INSERT INTO menu_plans (placement_id, menu_date, meal, meal_time, status) VALUES ($1, $2, 'BREAKFAST', '08:00', 'PLANNED'),
                                                                                       ($1, $2, 'LUNCH', '13:00', 'PLANNED')`,
      [pCook, Y]);
    await db.query(`INSERT INTO meal_logs (placement_id, staff_id, meal_date, meal) VALUES ($1, $2, $3, 'LUNCH')`, [pCook, sCook, Y]);

    // On time and at home, every task done, report filled → GREEN.
    const sGood = await staff('Good', 'UNSKILLED_CARE');
    const pGood = await placement(sGood, { start: '09:00' });
    await checkIn(sGood, pGood, '08:55');
    const { rows: [plan2] } = await db.query(
      `INSERT INTO care_plans (placement_id, client_id, version) VALUES ($1, $2, 1) RETURNING id`, [pGood, cust.id]);
    made.plans.push(plan2.id);
    await db.query(
      `INSERT INTO care_tasks (placement_id, plan_id, task_date, source_type, source_id, title, scheduled_time, status)
       VALUES ($1, $2, $3, 'ACTIVITY', 'a1', 'Walk', '10:00', 'DONE')`, [pGood, plan2.id, Y]);
    await db.query(`INSERT INTO daily_care_reports (placement_id, staff_id, report_date) VALUES ($1, $2, $3)`, [pGood, sGood, Y]);

    // Checked in on time but 1.1 km away.
    const sFar = await staff('Far', 'SKILLED_CARE');
    const pFar = await placement(sFar, { start: '09:00' });
    await checkIn(sFar, pFar, '09:05', 28.5692, 77.2066);

    // ── RM snapshot ───────────────────────────────────────────────────────
    console.log('\nRM snapshot');
    let r = await req('GET', `/rm/snapshot?date=${Y}`, { token: rmToken });
    check('GET /rm/snapshot → 200', r.status === 200, { s: r.status, m: msg(r) });
    const snap = r.body;
    const st = (id) => snap.staff.find((s) => s.staff_id === id)?.state;
    check('available', st(sAvail) === 'AVAILABLE', st(sAvail));
    check('hourly only → partly available', st(sHourly) === 'PARTLY_AVAILABLE', st(sHourly));
    check('trial ending in 3 days → free soon', st(sSoon) === 'FREE_SOON', st(sSoon));
    check('leave that day → on leave', st(sLeave) === 'ON_LEAVE', st(sLeave));
    check('open hold, not placed → on hold', st(sHold) === 'ON_HOLD', st(sHold));
    check('deployed', st(sLate) === 'DEPLOYED', st(sLate));
    check('S3 staff only counted in pipeline', !snap.staff.some((s) => s.name?.startsWith('Pipe')) && snap.summary.availability.in_pipeline.S3_TRAIN >= 1, snap.summary.availability.in_pipeline);

    const dep = (pid) => snap.deployments.find((d) => d.placement_id === pid);
    const late = dep(pLate);
    check('late check-in → LATE 30 min', late?.today.attendance === 'LATE' && late.today.late_by_min === 30, late?.today);
    check('missed medicine → RED', late?.status_today === 'RED' && late.flags.some((f) => /medicine/.test(f)), late?.flags);
    check('care progress counted (1 done of 3, 1 missed med; past PENDING counts as missed)',
      late?.today.care.done === 1 && late.today.care.total === 3 && late.today.care.missed_meds === 1 && late.today.care.missed === 2, late?.today.care);
    check('report missing flagged', late?.today.report_filled === false && late.flags.some((f) => /report/.test(f)), late?.flags);
    const cook = dep(pCook);
    check('no check-in an hour after start → NO_SHOW, RED', cook?.today.attendance === 'NO_SHOW' && cook.status_today === 'RED', cook?.today);
    check('cook: 1 of 2 meals logged, breakfast flagged', cook?.today.cook.meals_logged === 1 && cook.today.cook.meals_planned === 2
      && cook.flags.some((f) => /breakfast/.test(f)), cook?.flags);
    const good = dep(pGood);
    check('on time, at home, all done → GREEN', good?.status_today === 'GREEN' && good.today.attendance === 'ON_TIME' && good.today.far === false, good);
    const far = dep(pFar);
    check('1.1 km away → far, AMBER', far?.today.far === true && far.today.distance_m > 1000 && far.status_today === 'AMBER', far?.today);
    const leave = dep(pLeave);
    check('leave marked → ON_LEAVE, RED', leave?.today.attendance === 'ON_LEAVE' && leave.status_today === 'RED', leave?.today);
    const soon = dep(pSoon);
    check('no shift start, no check-in, day over → AMBER "no check-in"', soon?.status_today === 'AMBER' && soon.flags.includes('No check-in recorded'), soon);
    const order = snap.deployments.map((d) => d.status_today);
    const rank = { RED: 0, AMBER: 1, NOT_STARTED: 2, GREEN: 3 };
    check('deployments sorted RED first', order.every((s, i) => i === 0 || rank[order[i - 1]] <= rank[s]), order);
    check('summary counts match rows', snap.summary.alignment.RED === order.filter((s) => s === 'RED').length, snap.summary.alignment);

    r = await req('GET', `/rm/snapshot?date=${Y}&series=CK`, { token: rmToken });
    check('series filter keeps only cooks', r.status === 200 && r.body.deployments.length >= 1 && r.body.deployments.every((d) => d.staff.series === 'CK'), r.body?.deployments?.map((d) => d.staff.series));
    r = await req('GET', '/rm/snapshot?date=2026-13-40', { token: rmToken });
    check('bad date → 400', r.status === 400, r.status);
    r = await req('GET', '/rm/snapshot', { token: clientToken });
    check('client cannot read the RM snapshot', r.status === 403, r.status);

    // Today: a shift that starts at 23:59 has not started yet.
    const nowMin = (() => { const t = new Date(Date.now() + 330 * 60_000); return t.getUTCHours() * 60 + t.getUTCMinutes(); })();
    if (nowMin < 23 * 60 + 40) {
      const sTonight = await staff('Tonight', 'UNSKILLED_CARE');
      const pTonight = await placement(sTonight, { start: '23:59' });
      r = await req('GET', '/rm/snapshot', { token: rmToken });
      const t = r.body.deployments.find((d) => d.placement_id === pTonight);
      check('today, shift not due yet → NOT_STARTED', t?.status_today === 'NOT_STARTED' && t.today.attendance === 'NOT_STARTED', t?.today);
    }

    // ── Client snapshot ───────────────────────────────────────────────────
    console.log('\nClient snapshot');
    r = await req('GET', `/client/snapshot?date=${Y}`, { token: clientToken });
    check('GET /client/snapshot → 200', r.status === 200, { s: r.status, m: msg(r) });
    const cs = r.body;
    const card = cs.staff.find((s) => s.placement_id === pLate);
    check('one card per active placement', cs.staff.length === made.placements.length, cs.staff.length);
    check('card: first name, label, photo url, no phone', card?.staff.first_name === 'Late' && card.staff.series_label === 'Caretaker'
      && card.staff.photo_url && !JSON.stringify(cs).includes(clientPhone) && !('phone' in card.staff), card?.staff);
    check('card: late + work; a past day has no next task', card?.today.attendance === 'LATE' && card.today.work.done === 1 && /Evening walk/.test(card.today.work.next ?? '') === false, card?.today);
    check('message line', /Late checked in at 08:30 \(30 min late\) · 1 of 3 tasks done/.test(card?.message ?? ''), card?.message);
    check('last 7 days: yesterday present, oldest first', card?.last_7_days.length === 7 && card.last_7_days[6].date === Y && card.last_7_days[6].attendance === 'PRESENT', card?.last_7_days);
    const leaveCard = cs.staff.find((s) => s.placement_id === pLeave);
    check('leave day shows LEAVE in the strip', leaveCard?.last_7_days[6].attendance === 'LEAVE' && /on leave/.test(leaveCard.message), leaveCard?.message);
    const cookCard = cs.staff.find((s) => s.placement_id === pCook);
    check('cook card: meals 1 of 2', cookCard?.today.meals.logged === 1 && cookCard.today.meals.planned === 2 && /1 of 2 meals made/.test(cookCard.message), cookCard?.today);
    check('client never sees the RM-only refused-instruction count', !JSON.stringify(cs).includes('refused_open'), null);

    const sr = await req('POST', '/client/staff-requests', {
      token: clientToken,
      body: { series: 'UC', start_date: istDate(3), start_time: '08:00', requirements: { patient_age: 80, mobility: 'ASSISTED' }, address: '22 Green Park, New Delhi', lat: 28.5592, lng: 77.2066 },
    });
    r = await req('GET', '/client/snapshot', { token: clientToken });
    check('open staff request listed', r.body.requests.some((q) => q.id === sr.body?.id && q.series === 'UC'), r.body.requests);
    r = await req('GET', '/client/snapshot', { token: rmToken });
    check('RM cannot read a client snapshot', r.status === 403, r.status);

    // ── shift_start on placements ─────────────────────────────────────────
    console.log('\nshift_start');
    r = await req('PATCH', `/placements/${pSoon}/terms`, { token: rmToken, body: { shift_start: '7:30' } });
    check('PATCH terms sets shift_start (normalised to 07:30)', r.status === 200 && r.body.shift_start === '07:30', { s: r.status, b: r.body?.shift_start, m: msg(r) });
    r = await req('PATCH', `/placements/${pSoon}/terms`, { token: rmToken, body: { shift_start: '25:00' } });
    check('bad time refused', r.status === 400, r.status);
    r = await req('PATCH', `/placements/${pSoon}/terms`, { token: rmToken, body: { shift_start: '' } });
    check('empty clears it', r.status === 200 && r.body.shift_start === null, r.body?.shift_start);
    r = await req('POST', '/placements', { token: rmToken, body: { staff_id: sAvail, client_id: cust.id, placement_type: 'TEMPORARY', hourly_rate: 150, shift_start: '06:45' } });
    if (r.body?.id) made.placements.push(r.body.id);
    check('create with shift_start', r.status === 201 && r.body.shift_start === '06:45', { s: r.status, m: msg(r) });
    if (sr.body?.id) {
      const sHourly2 = await staff('Req', 'UNSKILLED_CARE');
      const sl = await req('POST', `/rm/staff-requests/${sr.body.id}/shortlist`, { token: rmToken, body: { staff_ids: [sHourly2] } });
      check('shortlisted for the request', sl.status === 201 || sl.status === 200, { s: sl.status, m: msg(sl) });
      r = await req('POST', '/placements', { token: rmToken, body: { staff_id: sHourly2, client_id: cust.id, staff_request_id: sr.body.id, staff_salary: 15000, management_fee: 3000 } });
      if (r.body?.id) made.placements.push(r.body.id);
      check('from a request: shift_start taken from the booking (08:00)', r.status === 201 && r.body.shift_start === '08:00', { s: r.status, m: msg(r), b: r.body?.shift_start });
    }
  } finally {
    await cleanup(db, made, tag);
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

async function cleanup(db, made, tagStr) {
  const q = (sql, p) => db.query(sql, p).catch((e) => console.log(`  cleanup: ${e.message.slice(0, 140)}`));
  const pids = made.placements;
  for (const t of ['care_tasks', 'daily_care_reports', 'meal_logs', 'menu_plans', 'shift_logs', 'staff_daily_attendance', 'client_instructions', 'staff_location_pings', 'deployments']) {
    await q(`DELETE FROM ${t} WHERE placement_id = ANY($1)`, [pids]);
  }
  await q(`DELETE FROM care_plans WHERE placement_id = ANY($1)`, [pids]);
  await q(`DELETE FROM staff_request_candidates WHERE placement_id = ANY($1) OR staff_id = ANY($2)`, [pids, made.staff]);
  await q(`DELETE FROM staff_requests WHERE client_id = ANY($1)`, [made.customers]);
  await q(`DELETE FROM placements WHERE id = ANY($1)`, [pids]);
  await q(`DELETE FROM stage_holds WHERE staff_id = ANY($1)`, [made.staff]);
  await q(`DELETE FROM staff_applicants s WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM pipeline_events e WHERE e.staff_id = s.id)`, [made.staff]);
  await q(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = ANY($1)`, [made.staff]);
  await q(`DELETE FROM finance_customer_branches WHERE customer_id = ANY($1)`, [made.customers]);
  await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [made.users]);
  await q(`DELETE FROM finance_customers WHERE id = ANY($1)`, [made.customers]);
  for (const t of ['user_sessions', 'login_audits']) await q(`DELETE FROM ${t} WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [made.users]);
  await q(`DELETE FROM users WHERE phone = ANY($1)`, [made.users]);
  const { rows: [left] } = await db.query(`SELECT count(*)::int AS n FROM staff_applicants WHERE staff_code LIKE $1 AND deleted_at IS NULL`, [`${tagStr}-%`]);
  if (left.n) console.log(`  cleanup: ${left.n} staff rows left`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
