/**
 * Live HTTP test for the request booking flow (2026-10-14),
 * docs/REQUEST_BOOKING_FLOW_PLAN.md.
 *
 * The request carries the whole booking — visit type, date + time, duration,
 * the cook's dishes or the caretaker's care needs — and when the RM places
 * someone, it lands in the staff app on its own:
 *   one-time cook   → that day's menu slot; placement is that one day, by the hour
 *   regular SC      → care plan v1 from the care needs
 *   regular cook    → the client's weekly menu template
 * Plus validation, "Booking confirmed" to the client, and the nightly close of
 * finished one-time visits.
 *
 *   node scratch/_live_test_request_booking.js
 */
const { Client } = require('pg');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const RM_PASSWORDS = ['hg', 'HomeGenny@2024', 'Password@123'];
const HQ = '00000000-0000-0000-0000-000000000001';

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
    if (res.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json?.data !== undefined && json?.success !== undefined ? json.data : json, raw: json };
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

const uniqPhone = () => '5' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);
const inDays = (n) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

const BASE_BODY = { address: '22 Green Park, New Delhi', lat: 28.5592, lng: 77.2066, language: 'Hindi', gender_pref: 'ANY' };
const COOK_REQ = { diet_type: 'veg', family_size: 3, meals_per_day: ['dinner'] };
const UC_REQ = { patient_age: 80, mobility: 'ASSISTED' };

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const staffIds = [];
  const placementIds = [];
  const requestIds = [];
  const cust = await createCustomer(db, 'Book');
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);
    async function makeStaff(tag, series) {
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
           pipeline_stage, assigned_rm_id, branch_id, metadata, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-01-01', $4, 'x', 'S5_DEPLOY', $5, $6, '{"gender":"FEMALE"}', NOW())
         RETURNING id`,
        [`ZB-${tag}-${Date.now() % 100000}`, series, `${tag} Testwali`, uniqPhone(), rm.id, HQ],
      );
      staffIds.push(id);
      return id;
    }
    const COOK1 = await makeStaff('Kamla', 'COOK');
    const COOK2 = await makeStaff('Lata', 'COOK');
    const NURSE = await makeStaff('Meena', 'SKILLED_CARE');

    const rmToken = await login(RM_PHONE, RM_PASSWORDS);
    const clientToken = await login(cust.phone, [cust.password]);

    const dal = await req('GET', '/care/dishes?q=dal', { token: clientToken });
    const roti = await req('GET', '/care/dishes?q=roti', { token: clientToken });
    const sabzi = await req('GET', '/care/dishes?q=paneer', { token: clientToken });
    const pick = (r) => (r.body?.items ?? r.body ?? [])[0]?.id;
    const dishIds = [pick(dal), pick(roti), pick(sabzi)].filter(Boolean);
    check('3 dishes found in the list', dishIds.length === 3, dishIds);

    const post = (body) => req('POST', '/client/staff-requests', { token: clientToken, body: { ...BASE_BODY, ...body } });
    async function bad(label, body, re) {
      const r = await post(body);
      check(label, r.status === 400 && re.test(msg(r)), { status: r.status, msg: msg(r) });
    }

    // ── validation ───────────────────────────────────────────────────────────
    console.log('\nValidation');
    const oneTimeCook = { series: 'CK', visit_type: 'ONE_TIME', duration_min: 120, start_date: inDays(2), start_time: '19:30', requirements: COOK_REQ };
    await bad('unknown visit_type refused', { ...oneTimeCook, visit_type: 'WEEKLY' }, /visit_type/i);
    await bad('one-time visit without duration refused', { ...oneTimeCook, duration_min: undefined, menu: { dish_ids: dishIds } }, /duration_min/i);
    await bad('duration 45 refused', { ...oneTimeCook, duration_min: 45, menu: { dish_ids: dishIds } }, /duration_min/i);
    await bad('date is required', { ...oneTimeCook, start_date: undefined, menu: { dish_ids: dishIds } }, /start_date is required/i);
    await bad('time is required', { ...oneTimeCook, start_time: undefined, menu: { dish_ids: dishIds } }, /start_time is required/i);
    await bad('one-time cook without dishes refused', oneTimeCook, /at least one dish/i);
    await bad('4 dishes in 60 minutes refused', { ...oneTimeCook, duration_min: 60, menu: { dish_ids: dishIds, dishes: [{ name: 'Kheer' }] } }, /up to 3 dishes/i);
    await bad('care_needs on a cook request refused', { ...oneTimeCook, menu: { dish_ids: dishIds }, care_needs: { dos: ['x'] } }, /care_needs is for caretakers/i);
    const ucBody = { series: 'UC', start_date: inDays(3), start_time: '08:00', requirements: UC_REQ };
    await bad('menu on a caretaker request refused', { ...ucBody, menu: { dish_ids: dishIds } }, /menu is for a cook/i);
    await bad('UC care needs with medicines refused', { ...ucBody, care_needs: { medications: [{ name: 'Metformin', dose: '500 mg', times: ['09:00'] }] } }, /Unskilled Caretaker/i);
    await bad('prescription before the booking refused', {
      series: 'SC', start_date: inDays(3), start_time: '08:00', requirements: UC_REQ,
      care_needs: { medications: [{ name: 'Metformin', dose: '500 mg', times: ['09:00'], prescription_file_id: '00000000-0000-0000-0000-000000000009' }] },
    }, /after the booking is confirmed/i);

    async function placeFrom(srId, staffId, extra = {}) {
      const sl = await req('POST', `/rm/staff-requests/${srId}/shortlist`, { token: rmToken, body: { staff_ids: [staffId] } });
      if (!ok2xx(sl)) return { error: msg(sl) };
      const pl = await req('POST', '/placements', { token: rmToken, body: { staff_id: staffId, client_id: cust.customerId, staff_request_id: srId, ...extra } });
      const id = pl.body?.id ?? pl.body?.placement?.id;
      if (id) placementIds.push(id);
      return { id, status: pl.status, error: msg(pl) };
    }

    // ── one-time cook ────────────────────────────────────────────────────────
    console.log('\nOne-time cook visit');
    const visitDate = inDays(2);
    const ot = await post({ ...oneTimeCook, menu: { dish_ids: dishIds, special_instruction: 'Less oil' } });
    check('one-time cook booking accepted', ok2xx(ot), { status: ot.status, msg: msg(ot) });
    const otId = ot.body?.id;
    if (otId) {
      requestIds.push(otId);
      check('visit_type + duration returned', ot.body.visit_type === 'ONE_TIME' && ot.body.duration_min === 120, { v: ot.body.visit_type, d: ot.body.duration_min });
      check('billed by the hour for 2 hours', ot.body.placement_type === 'TEMPORARY' && Number(ot.body.shift_hours) === 2, { t: ot.body.placement_type, h: ot.body.shift_hours });
      check('19:30 visit → DINNER, 3 dishes', ot.body.menu?.meal === 'DINNER' && ot.body.menu?.dishes?.length === 3 && ot.body.menu?.meal_time === '19:30', ot.body.menu);

      const rmView = await req('GET', `/rm/staff-requests/${otId}`, { token: rmToken });
      check('RM sees the menu before placing', rmView.body?.menu?.dishes?.length === 3, rmView.body?.menu);

      // The RM prices the hour when placing.
      const p = await placeFrom(otId, COOK1, { hourly_rate: 250 });
      check('cook placed from the request', !!p.id, p);
      if (p.id) {
        const { rows: [pl] } = await db.query(
          `SELECT placement_type, shift_hours::text sh, trial_start_date::text s, trial_end_date::text e, metadata->>'visit_type' vt FROM placements WHERE id = $1`, [p.id]);
        check('placement is that one day', pl.s === visitDate && pl.e === visitDate, pl);
        check('placement TEMPORARY 2 h, marked ONE_TIME', pl.placement_type === 'TEMPORARY' && Number(pl.sh) === 2 && pl.vt === 'ONE_TIME', pl);
        const { rows: mp } = await db.query(
          `SELECT meal, meal_time, jsonb_array_length(dishes) n, special_instruction si FROM menu_plans WHERE placement_id = $1 AND menu_date = $2::date`, [p.id, visitDate]);
        check('menu slot written for the visit day', mp.length === 1 && mp[0].meal === 'DINNER' && mp[0].n === 3 && mp[0].meal_time === '19:30' && mp[0].si === 'Less oil', mp);
        const { rows: cn } = await db.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND template = 'STAFF_REQUEST_CONFIRMED' AND payload->>'request_id' = $2`, [cust.portalUserId, otId]);
        check('client told "Booking confirmed" with name, date, time', cn.length === 1 && cn[0].title === 'Booking confirmed' && cn[0].body.includes('Kamla') && cn[0].body.includes(visitDate) && cn[0].body.includes('19:30'), cn);

        // ── the nightly close ───────────────────────────────────────────────
        console.log('\nFinished visits close');
        await db.query(`UPDATE placements SET trial_start_date = CURRENT_DATE - 1, trial_end_date = CURRENT_DATE - 1 WHERE id = $1`, [p.id]);
        const { NestFactory } = require('@nestjs/core');
        const { AppModule } = require('../dist/app.module');
        const { StaffRequestsService } = require('../dist/modules/staff-requests/staff-requests.service');
        const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
        try {
          await app.get(StaffRequestsService).closeFinishedVisits();
        } finally {
          await app.close();
        }
        const { rows: [done] } = await db.query(`SELECT status, exit_scenario_code c, exit_date::text d FROM placements WHERE id = $1`, [p.id]);
        check('yesterday\'s visit → EXITED / VISIT_DONE', done.status === 'EXITED' && done.c === 'VISIT_DONE' && !!done.d, done);
      }
    }

    // ── regular skilled caretaker with care needs ────────────────────────────
    console.log('\nRegular SC with care needs');
    const careNeeds = {
      patient: { name: 'Papa', age: 80 },
      medications: [{ name: 'Metformin', dose: '500 mg', times: ['09:00', '21:00'], food_relation: 'AFTER' }],
      vitals: [{ type: 'BP', times: ['08:00'] }],
      activities: [{ type: 'WALK', times: ['17:00'], duration_min: 20 }],
      dos: 'Help him walk to the balcony',
      donts: 'No sugar in tea',
    };
    const sc = await post({ series: 'SC', start_date: inDays(3), start_time: '08:00', placement_type: 'PERMANENT', shift_hours: 12, requirements: UC_REQ, care_needs: careNeeds });
    check('SC booking with care needs accepted', ok2xx(sc), { status: sc.status, msg: msg(sc) });
    if (sc.body?.id) {
      requestIds.push(sc.body.id);
      check('regular by default, PERMANENT 12 h kept', sc.body.visit_type === 'REGULAR' && sc.body.placement_type === 'PERMANENT' && Number(sc.body.shift_hours) === 12, sc.body);
      check('care needs returned', sc.body.care_needs?.medications?.length === 1 && sc.body.care_needs?.vitals?.length === 1 && sc.body.care_needs?.dos === 'Help him walk to the balcony', sc.body.care_needs);
      const p = await placeFrom(sc.body.id, NURSE);
      check('SC placed from the request', !!p.id, p);
      if (p.id) {
        const { rows: cp } = await db.query(
          `SELECT version, jsonb_array_length(medications) m, jsonb_array_length(vitals) v, jsonb_array_length(activities) a, changes FROM care_plans WHERE placement_id = $1`, [p.id]);
        check('care plan v1 created from the booking', cp.length === 1 && cp[0].version === 1 && cp[0].m === 1 && cp[0].v === 1 && cp[0].a === 1, cp);
        check('plan says where it came from', JSON.stringify(cp[0]?.changes ?? '').includes('Care plan from your booking'), cp[0]?.changes);
        const { rows: [pl] } = await db.query(`SELECT trial_end_date, metadata->>'visit_type' vt FROM placements WHERE id = $1`, [p.id]);
        check('regular placement not marked one-time', pl.vt === null, pl);
      }
    }

    // ── regular cook with a weekly menu ──────────────────────────────────────
    console.log('\nRegular cook with a weekly menu');
    const rc = await post({
      series: 'CK', start_date: inDays(1), start_time: '12:00', requirements: COOK_REQ,
      menu: { items: [{ dow: 'MON', meal: 'LUNCH', dish_ids: dishIds.slice(0, 2), meal_time: '13:00' }, { dow: 'THU', meal: 'DINNER', dishes: [{ name: 'Grandma Khichdi' }] }] },
    });
    check('regular cook booking with weekly menu accepted', ok2xx(rc), { status: rc.status, msg: msg(rc) });
    if (rc.body?.id) {
      requestIds.push(rc.body.id);
      check('weekly menu returned (2 items)', rc.body.menu?.items?.length === 2, rc.body.menu);
      const p = await placeFrom(rc.body.id, COOK2);
      check('cook placed from the request', !!p.id, p);
      if (p.id) {
        const { rows: [tpl] } = await db.query(`SELECT jsonb_array_length(items) n FROM menu_templates WHERE client_id = $1`, [cust.customerId]);
        check('weekly menu became the client\'s template', tpl?.n === 2, tpl);
        const { rows: [{ n }] } = await db.query(`SELECT count(*)::int n FROM menu_plans WHERE placement_id = $1 AND source = 'TEMPLATE'`, [p.id]);
        check('template applied for the coming days', n >= 2, n);
      }
    }

    // ── an RM replacement request defaults to tomorrow 09:00 is covered in
    //    _live_test_staff_requests.js (convert) — here only the shape.
  } finally {
    for (const id of placementIds) {
      await db.query(`DELETE FROM menu_plans WHERE placement_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM care_tasks WHERE placement_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM care_plans WHERE placement_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM deployments WHERE placement_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM placements WHERE id = $1`, [id]).catch((e) => console.log('  cleanup placement:', e.message));
    }
    if (requestIds.length) await db.query(`DELETE FROM staff_requests WHERE id = ANY($1::uuid[])`, [requestIds]).catch((e) => console.log('  cleanup requests:', e.message));
    await db.query(`DELETE FROM menu_templates WHERE client_id = $1`, [cust.customerId]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE payload->>'request_id' = ANY($1::text[]) OR payload->>'placement_id' = ANY($2::text[])`, [requestIds, placementIds]).catch(() => {});
    await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = ANY($1::uuid[])`, [staffIds]).catch(() => {});
    await cust.teardown().catch((e) => console.log('  cleanup customer:', e.message));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
