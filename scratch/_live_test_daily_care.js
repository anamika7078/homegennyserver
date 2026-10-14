/**
 * Live HTTP test for Phases C, D, E and the "staff sees every client input"
 * rule — docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md (2026-10-12).
 *
 * Builds one household with three placements — a Skilled Caretaker, an
 * Unskilled Caretaker and a Cook — and drives them as the client, the two
 * staff members with logins (SC + cook) and the RM would:
 *
 *   C  care plan (versions, diff, UC scope), checklist, vitals alerts, missed
 *      doses, skip, daily report, history, files
 *   D  food profile (versions), menu (client + cook suggestions, health
 *      warnings), meal log, ratings, repeated-feedback suggestions, low rating
 *   E  instructions (text, voice, recurring), ack/done, refuse → RM decision,
 *      compliance board, monthly PDF
 *   +  staff feed, unread count, "Padh liya", client sees it was read
 *
 *   node scratch/_live_test_daily_care.js
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const HQ = '00000000-0000-0000-0000-000000000001';
const PW = 'hg';

let pass = 0;
let fail = 0;
let skip = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}

async function raw(method, path, { token, body, form } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
    return res;
  }
}
async function req(method, path, opts = {}) {
  const res = await raw(method, path, opts);
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json?.data !== undefined && json?.success !== undefined ? json.data : json, raw: json };
}
const msg = (r) => String(r.raw?.message?.message ?? r.raw?.message ?? '');
const ok2xx = (r) => r.status >= 200 && r.status < 300;

async function login(phone, password = PW) {
  for (let i = 0; i < 4; i++) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const token = r.body?.access_token ?? r.body?.accessToken;
    if (token) return token;
    if (r.status !== 429) throw new Error(`login failed for ${phone}: ${r.status} ${msg(r)}`);
  }
  throw new Error(`login throttled for ${phone}`);
}

const ist = () => new Date(Date.now() + 330 * 60_000);
const today = () => ist().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const nowMin = () => ist().getUTCHours() * 60 + ist().getUTCMinutes();
// A tiny valid PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function upload(token, placementId, kind, buf, mime, name) {
  const form = new FormData();
  form.append('placement_id', placementId);
  form.append('kind', kind);
  form.append('file', new Blob([buf], { type: mime }), name);
  return req('POST', '/care-files', { token, form });
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { users: [], staff: [], placements: [], customers: [] };
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);
    const hash = await bcrypt.hash(PW, 10);
    const tag = String(Date.now()).slice(-6);

    async function staffWithLogin(series, name, n) {
      const phone = `81${tag}${n}0`;
      const { rows: [u] } = await db.query(
        `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, branch_id, updated_at)
         VALUES (gen_random_uuid(), 'STAFF', $1, $2, $3, true, $4, NOW()) RETURNING id`,
        [name, phone, hash, HQ],
      );
      made.users.push(u.id);
      const { rows: [s] } = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, pipeline_stage,
           assigned_rm_id, branch_id, user_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-01-01', $4, 'x', 'S5_DEPLOY', $5, $6, $7, NOW()) RETURNING id`,
        [`ZC-${tag}-${n}`, series, name, phone, rm.id, HQ, u.id],
      );
      made.staff.push(s.id);
      return { userId: u.id, staffId: s.id, phone };
    }
    async function place(staffId, clientId) {
      const { rows: [p] } = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 12, CURRENT_DATE, NOW(), NOW()) RETURNING id`,
        [staffId, clientId, HQ, rm.id],
      );
      made.placements.push(p.id);
      return p.id;
    }

    const cust = await createCustomer(db, 'Care');
    const other = await createCustomer(db, 'CarX');
    made.customers.push(cust, other);
    const sc = await staffWithLogin('SKILLED_CARE', 'Kavita Nurse', 1);
    const uc = await staffWithLogin('UNSKILLED_CARE', 'Uma Helper', 2);
    const ck = await staffWithLogin('COOK', 'Ramu Cook', 3);
    const pSC = await place(sc.staffId, cust.customerId);
    const pUC = await place(uc.staffId, cust.customerId);
    const pCK = await place(ck.staffId, cust.customerId);

    const clientT = await login(cust.phone, cust.password);
    const scT = await login(sc.phone);
    const ckT = await login(ck.phone);
    const rmT = await login(RM_PHONE);
    console.log('  (waiting out the login rate limit…)');
    await new Promise((r) => setTimeout(r, 61_000));
    const otherT = await login(other.phone, other.password);

    const notes = async (userId, template) =>
      (await db.query(`SELECT title, body, payload FROM notifications WHERE user_id = $1 AND template = $2`, [userId, template])).rows;

    // ── assigned-staff exposes placement + features ─────────────────────────
    console.log('\nClient app: assigned staff');
    const as = await req('GET', '/client/assigned-staff', { token: clientT });
    const asSC = as.body?.assignedStaff?.find((x) => x.staffId === sc.staffId);
    const asCK = as.body?.assignedStaff?.find((x) => x.staffId === ck.staffId);
    check('placementId on each assigned staff', asSC?.placementId === pSC && asCK?.placementId === pCK, as.body?.assignedStaff);
    check('features: care_plan for SC, menu for cook', asSC?.features?.care_plan === true && asSC?.features?.menu === false && asCK?.features?.menu === true);

    // ── files ────────────────────────────────────────────────────────────────
    console.log('\nFiles');
    const rx = await upload(clientT, pSC, 'PRESCRIPTION', PNG, 'image/png', 'rx.png');
    check('client uploads a prescription', ok2xx(rx) && rx.body?.id, { status: rx.status, msg: msg(rx) });
    const staffRx = await upload(scT, pSC, 'PRESCRIPTION', PNG, 'image/png', 'rx.png');
    check('staff cannot upload a prescription', staffRx.status === 400, staffRx.status);
    const badType = await upload(clientT, pSC, 'PHOTO', Buffer.from('hello'), 'text/plain', 'a.txt');
    check('a text file is not a photo', badType.status === 400, badType.status);
    const fileRes = await raw('GET', `/care-files/${rx.body?.id}`, { token: clientT });
    check('client can download it (image/png)', fileRes.status === 200 && fileRes.headers.get('content-type') === 'image/png', fileRes.status);
    const otherFile = await raw('GET', `/care-files/${rx.body?.id}`, { token: otherT });
    check("another client can't", otherFile.status === 404, otherFile.status);
    const otherRx = await upload(clientT, pCK, 'PRESCRIPTION', PNG, 'image/png', 'rx2.png');

    // ── care plan ────────────────────────────────────────────────────────────
    console.log('\nCare plan');
    const ucPlan = await req('PUT', `/care/placements/${pUC}/plan`, { token: clientT, body: { medications: [{ name: 'Crocin', dose: '1 tablet', times: ['09:00'] }] } });
    check('UC placement: medicines refused (scope)', ucPlan.status === 400 && /Unskilled Caretaker/i.test(msg(ucPlan)), msg(ucPlan));
    const ucOk = await req('PUT', `/care/placements/${pUC}/plan`, { token: clientT, body: { activities: [{ type: 'WALK', times: ['18:00'] }], dos: 'Keep him company' } });
    check('UC placement: activities-only plan is fine', ok2xx(ucOk), msg(ucOk));
    const cookPlan = await req('PUT', `/care/placements/${pCK}/plan`, { token: clientT, body: { dos: 'x' } });
    check('cook placement has no care plan', cookPlan.status === 400, cookPlan.status);
    const wrongRx = await req('PUT', `/care/placements/${pSC}/plan`, { token: clientT, body: { medications: [{ name: 'X', dose: '1', times: ['09:00'], prescription_file_id: otherRx.body?.id }] } });
    check("a file from another placement can't be attached", wrongRx.status === 400, msg(wrongRx));
    const badTime = await req('PUT', `/care/placements/${pSC}/plan`, { token: clientT, body: { medications: [{ name: 'X', dose: '1', times: ['9am'] }] } });
    check('bad time refused', badTime.status === 400 && /HH:MM/.test(msg(badTime)), msg(badTime));
    const staffWrite = await req('PUT', `/care/placements/${pSC}/plan`, { token: scT, body: { dos: 'x' } });
    check("staff can't write the plan", staffWrite.status === 400, staffWrite.status);

    const canMiss = nowMin() >= 3 * 60 && nowMin() < 23 * 60;
    const past = hhmm(Math.max(0, nowMin() - 120));
    const later = '23:30';
    const v1 = {
      patient: { name: 'Ramesh Kumar', age: 78, conditions: ['Diabetes'], allergies: ['Penicillin'], mobility: 'ASSISTED' },
      medications: [
        { name: 'Metformin', dose: '500', unit: 'mg', times: canMiss ? [past, later] : [later], food_relation: 'AFTER', prescription_file_id: rx.body?.id },
      ],
      vitals: [{ type: 'BP', times: [later] }, { type: 'SUGAR_FASTING', times: [later] }],
      activities: [{ type: 'WALK', title: 'Evening walk', times: [later], duration_min: 20 }],
      diet_notes: 'Low salt',
    };
    const p1 = await req('PUT', `/care/placements/${pSC}/plan`, { token: clientT, body: v1 });
    check('plan v1 saved', ok2xx(p1) && p1.body?.plan?.version === 1, { status: p1.status, msg: msg(p1) });
    check('v1 changes = "New care plan"', p1.body?.plan?.changes?.[0]?.type === 'CREATED');
    const medId = p1.body?.plan?.medications?.[0]?.id;
    const bpDefaults = p1.body?.plan?.vitals?.find((v) => v.type === 'BP');
    check('BP got default ranges', bpDefaults?.systolic_max === 140 && bpDefaults?.diastolic_max === 90, bpDefaults);
    check('staff told about the plan', (await notes(sc.userId, 'CARE_PLAN_UPDATED')).length === 1);
    const same = await req('PUT', `/care/placements/${pSC}/plan`, { token: clientT, body: { ...v1, medications: [{ ...v1.medications[0], id: medId }], vitals: p1.body.plan.vitals, activities: p1.body.plan.activities } });
    check('saving the same plan again makes no new version', same.body?.plan?.version === 1, same.body?.plan?.version);

    // ── staff day ────────────────────────────────────────────────────────────
    console.log('\nCaretaker checklist');
    const day = await req('GET', '/staff/care/today', { token: scT });
    const mine = day.body?.placements?.find((p) => p.placement_id === pSC);
    const expected = (canMiss ? 2 : 1) + 2 + 1;
    check(`today has ${expected} tasks`, mine?.tasks?.length === expected, mine?.tasks?.map((t) => `${t.time} ${t.title}`));
    check('plan shows as not yet read', mine?.plan?.acknowledged === false);
    if (canMiss) {
      const missed = mine.tasks.find((t) => t.type === 'MEDICATION' && t.time === past);
      check('a dose 2h overdue is MISSED', missed?.status === 'MISSED', missed);
    } else { skip++; console.log('  SKIP  missed-dose check (too close to midnight IST)'); }
    const ucDay = await req('GET', `/care/placements/${pSC}/day`, { token: (await login(uc.phone).catch(() => null)) ?? 'x' });
    check("the UC staff can't open the SC household's day", ucDay.status === 404 || ucDay.status === 401, ucDay.status);

    const bp = mine.tasks.find((t) => t.title.includes('Blood pressure'));
    const sugar = mine.tasks.find((t) => t.title.includes('Sugar'));
    const walk = mine.tasks.find((t) => t.type === 'ACTIVITY');
    const noVal = await req('POST', `/staff/care/tasks/${bp.id}/done`, { token: scT, body: {} });
    check('BP without a reading refused', noVal.status === 400, msg(noVal));
    const bpDone = await req('POST', `/staff/care/tasks/${bp.id}/done`, { token: scT, body: { value: { systolic: 190, diastolic: 125 }, notes: 'Felt dizzy' } });
    check('BP 190/125 recorded, out of range', ok2xx(bpDone) && bpDone.body?.out_of_range === true, { status: bpDone.status, msg: msg(bpDone), b: bpDone.body });
    const { rows: esc } = await db.query(`SELECT severity FROM escalation_logs WHERE metadata->>'care_task_id' = $1`, [bp.id]);
    check('escalation raised, CRITICAL', esc[0]?.severity === 'CRITICAL', esc);
    check('client alerted', (await notes(cust.portalUserId, 'CARE_VITAL_ALERT')).length === 1);
    check('RM alerted', (await notes(rm.id, 'CARE_VITAL_ALERT')).some((n) => n.payload.task_id === bp.id));
    const sg = await req('POST', `/staff/care/tasks/${sugar.id}/done`, { token: scT, body: { value: { value: 100 } } });
    check('sugar 100 in range', ok2xx(sg) && sg.body?.out_of_range === false, msg(sg));
    const again = await req('POST', `/staff/care/tasks/${sugar.id}/done`, { token: scT, body: { value: { value: 100 } } });
    check('ticking twice refused', again.status === 400, again.status);
    const sk0 = await req('POST', `/staff/care/tasks/${walk.id}/skip`, { token: scT, body: {} });
    check('skip without a reason refused', sk0.status === 400, sk0.status);
    const sk = await req('POST', `/staff/care/tasks/${walk.id}/skip`, { token: scT, body: { reason: 'Raining' } });
    check('walk skipped', ok2xx(sk) && sk.body?.status === 'SKIPPED', msg(sk));
    if (canMiss) {
      const missed = mine.tasks.find((t) => t.type === 'MEDICATION' && t.time === past);
      const late = await req('POST', `/staff/care/tasks/${missed.id}/done`, { token: scT, body: {} });
      check('a missed dose can still be given late (marked late)', ok2xx(late) && late.body?.value?.late === true, late.body);
    }
    const photo = await upload(scT, pSC, 'PHOTO', PNG, 'image/png', 'meal.png');
    const rep = await req('PUT', '/staff/care/daily-report', {
      token: scT,
      body: { placement_id: pSC, meals: [{ meal: 'lunch', description: 'Dal, roti', quantity: 'half' }], fluid_intake_ml: 1500, sleep: 'Good', mood: 'Calm', hygiene: { bath: true }, notes: 'BP was high in the evening', photo_file_ids: [photo.body?.id] },
    });
    check('daily report saved', ok2xx(rep) && rep.body?.fluid_intake_ml === 1500, msg(rep));
    const oldRep = await req('PUT', '/staff/care/daily-report', { token: scT, body: { placement_id: pSC, date: addDays(today(), -3) } });
    check('a 3-day-old report is closed', oldRep.status === 400, msg(oldRep));

    const cday = await req('GET', `/care/placements/${pSC}/day`, { token: clientT });
    check('client sees the day: out_of_range=1, skipped=1, report present', cday.body?.summary?.out_of_range === 1 && cday.body?.summary?.skipped === 1 && !!cday.body?.report, cday.body?.summary);
    const rmDay = await req('GET', `/care/placements/${pSC}/day`, { token: rmT });
    check('RM can read it too', rmDay.status === 200, rmDay.status);
    const otherDay = await req('GET', `/care/placements/${pSC}/plan`, { token: otherT });
    check("another client can't", otherDay.status === 404, otherDay.status);

    // ── v2 + feed + ack ──────────────────────────────────────────────────────
    console.log('\nPlan change → staff feed → "Padh liya"');
    const v2 = {
      ...v1,
      medications: [
        { ...v1.medications[0], id: medId, times: canMiss ? [past, '22:00'] : ['22:00'] },
        { name: 'Amlodipine', dose: '5', unit: 'mg', times: ['21:00'], food_relation: 'ANY' },
      ],
      vitals: p1.body.plan.vitals,
      activities: p1.body.plan.activities,
    };
    const p2 = await req('PUT', `/care/placements/${pSC}/plan`, { token: clientT, body: v2 });
    const ch = (p2.body?.plan?.changes ?? []).map((c) => c.text);
    check('v2 saved', p2.body?.plan?.version === 2, msg(p2));
    check('changes say a medicine was added and one changed', ch.some((t) => /Medicine added: Amlodipine/.test(t)) && ch.some((t) => /Medicine changed: Metformin/.test(t)), ch);
    const day2 = await req('GET', `/care/placements/${pSC}/day`, { token: scT });
    check('BP reading kept after the plan changed', day2.body?.tasks?.some((t) => t.id === bp.id && t.status === 'DONE'));
    check('new dose at 21:00 is on today\'s list', day2.body?.tasks?.some((t) => t.time === '21:00' && /Amlodipine/.test(t.title)));
    check('old 23:30 Metformin slot gone (moved to 22:00)', !day2.body?.tasks?.some((t) => t.time === '23:30' && /Metformin/.test(t.title)) && day2.body?.tasks?.some((t) => t.time === '22:00'));

    const feed = await req('GET', '/staff/care/client-updates', { token: scT });
    const planItem = feed.body?.items?.find((i) => i.type === 'CARE_PLAN');
    check('staff feed has the plan, v2, unread, with changes', planItem?.version === 2 && !planItem?.acknowledged_at && planItem?.changes?.length >= 2, planItem);
    const cnt = await req('GET', '/staff/care/client-updates/unread-count', { token: scT });
    check('unread count ≥ 1', cnt.body?.unread >= 1, cnt.body);
    const beforeAck = await req('GET', `/care/placements/${pSC}/plan`, { token: clientT });
    check('client sees: not read yet', beforeAck.body?.staff_acknowledged_at === null);
    const ack = await req('POST', `/staff/care/client-updates/CARE_PLAN/${planItem?.id}/ack`, { token: scT });
    check('"Padh liya"', ok2xx(ack) && ack.body?.acknowledged === true, msg(ack));
    const afterAck = await req('GET', `/care/placements/${pSC}/plan`, { token: clientT });
    check('client sees: read', !!afterAck.body?.staff_acknowledged_at);
    check('client told it was read', (await notes(cust.portalUserId, 'CARE_PLAN_ACKNOWLEDGED')).length === 1);
    const badAck = await req('POST', `/staff/care/client-updates/CARE_PLAN/${p1.body?.plan?.id}/ack`, { token: scT });
    check('acking an old version refused', badAck.status === 400, badAck.status);

    const hist = await req('GET', `/care/placements/${pSC}/history`, { token: clientT });
    check('history: vitals include the high BP', hist.body?.vitals?.some((v) => v.out_of_range && v.value?.systolic === 190), hist.body?.vitals);

    // ── cook ─────────────────────────────────────────────────────────────────
    console.log('\nCook: food profile');
    const fp0 = await req('PUT', '/client/food-profile', { token: clientT, body: { spice_level: 3 } });
    check('diet_type required', fp0.status === 400, msg(fp0));
    const fp1 = await req('PUT', '/client/food-profile', { token: clientT, body: { diet_type: 'veg', spice_level: 4, salt: 'normal', health_conditions: ['diabetic'], cuisines: ['North Indian'], family_size: 4 } });
    check('profile v1', fp1.body?.profile?.version === 1 && fp1.body?.profile?.diet_type === 'VEG', msg(fp1));
    const fp2 = await req('PUT', '/client/food-profile', { token: clientT, body: { diet_type: 'VEG', spice_level: 2, salt: 'NORMAL', health_conditions: ['DIABETIC'], cuisines: ['North Indian'], family_size: 4 } });
    check('profile v2 says spice 4 → 2', fp2.body?.profile?.version === 2 && fp2.body?.profile?.changes?.some((c) => /Spice level: 4 → 2/.test(c)), fp2.body?.profile?.changes);
    check('cook told', (await notes(ck.userId, 'FOOD_PROFILE_UPDATED')).length === 2);
    const fpRead = await req('GET', `/care/placements/${pCK}/food-profile`, { token: ckT });
    check('cook reads the profile', fpRead.body?.profile?.spice_level === 2, fpRead.status);

    console.log('\nCook: menu');
    const scMenu = await req('PUT', `/care/placements/${pSC}/menu`, { token: clientT, body: { items: [{ date: today(), meal: 'DINNER', dishes: ['Dal'] }] } });
    check('no menu on a caretaker placement', scMenu.status === 400, scMenu.status);
    const m1 = await req('PUT', `/care/placements/${pCK}/menu`, {
      token: clientT,
      body: { items: [{ date: today(), meal: 'DINNER', dishes: ['Paneer', 'Gulab Jamun'], special_instruction: 'Kam teekha' }, { date: addDays(today(), 1), meal: 'LUNCH', dishes: ['Rajma', 'Rice'] }] },
    });
    const dinner = m1.body?.items?.find((i) => i.date === today() && i.meal === 'DINNER');
    check('menu saved', ok2xx(m1) && !!dinner, msg(m1));
    check('diabetic warning on gulab jamun', dinner?.health_warnings?.some((w) => /gulab jamun/.test(w)), dinner?.health_warnings);
    check('cook told the menu changed', (await notes(ck.userId, 'MENU_UPDATED')).length === 1);
    const pastMenu = await req('PUT', `/care/placements/${pCK}/menu`, { token: clientT, body: { items: [{ date: addDays(today(), -1), meal: 'LUNCH', dishes: ['x'] }] } });
    check('menu for yesterday refused', pastMenu.status === 400, pastMenu.status);
    // Only the family sets the menu now (2026-10-14): the cook's suggestion route is off.
    const sug = await req('POST', '/staff/care/cook/menu-suggestions', { token: ckT, body: { placement_id: pCK, items: [{ date: addDays(today(), 1), meal: 'BREAKFAST', dishes: ['Poha'] }] } });
    check('cook menu suggestions are switched off (403)', sug.status === 403, { status: sug.status, msg: msg(sug) });
    // A suggestion made before the switch can still be answered.
    const { rows: [bf] } = await db.query(
      `INSERT INTO menu_plans (placement_id, menu_date, meal, dishes, status, created_by_role)
       VALUES ($1, $2, 'BREAKFAST', '[{"name":"Poha"}]', 'SUGGESTED', 'STAFF') RETURNING id`,
      [pCK, addDays(today(), 1)],
    );
    const rj0 = await req('POST', `/client/menu/${bf?.id}/reject`, { token: clientT, body: {} });
    check('decline needs a reason', rj0.status === 400, rj0.status);
    const ap = await req('POST', `/client/menu/${bf?.id}/approve`, { token: clientT });
    check('client approves', ap.body?.status === 'APPROVED', msg(ap));
    check('cook told it was approved', (await notes(ck.userId, 'MENU_APPROVED')).length === 1);

    console.log('\nCook: meals + ratings');
    const cphoto = await upload(ckT, pCK, 'PHOTO', PNG, 'image/png', 'paneer.png');
    const meal = await req('POST', '/staff/care/cook/meals', { token: ckT, body: { placement_id: pCK, meal: 'DINNER', dishes: [{ name: 'Paneer', spice_level: 2, photo_file_id: cphoto.body?.id }, 'Roti'], servings: 4 } });
    check('dinner logged with a photo', ok2xx(meal) && meal.body?.menu_plan_id === dinner?.id && meal.body?.dishes?.[0]?.photo_file_id === cphoto.body?.id, msg(meal));
    check('client told dinner is ready', (await notes(cust.portalUserId, 'MEAL_LOGGED')).length === 1);
    const oldMeal = await req('POST', '/staff/care/cook/meals', { token: ckT, body: { placement_id: pCK, date: addDays(today(), -5), meal: 'LUNCH', dishes: ['x'] } });
    check('a 5-day-old meal is closed', oldMeal.status === 400, oldMeal.status);
    const scMeal = await req('POST', '/staff/care/cook/meals', { token: scT, body: { placement_id: pCK, meal: 'LUNCH', dishes: ['x'] } });
    check("the nurse can't log the cook's meals", scMeal.status === 404, scMeal.status);
    const r9 = await req('POST', `/client/meals/${meal.body?.id}/feedback`, { token: clientT, body: { rating: 9 } });
    check('rating 9 refused', r9.status === 400, r9.status);
    const rTag = await req('POST', `/client/meals/${meal.body?.id}/feedback`, { token: clientT, body: { rating: 3, tags: ['YUMMY'] } });
    check('unknown tag refused', rTag.status === 400, msg(rTag));
    // Three meals, each "too spicy" and rated 2 → suggestion + RM low-rating alert.
    const mealIds = [meal.body?.id];
    for (const m of ['BREAKFAST', 'LUNCH']) {
      const x = await req('POST', '/staff/care/cook/meals', { token: ckT, body: { placement_id: pCK, meal: m, dishes: ['Sabzi'] } });
      mealIds.push(x.body?.id);
    }
    let fb;
    for (const id of mealIds) fb = await req('POST', `/client/meals/${id}/feedback`, { token: clientT, body: { rating: 2, tags: ['too spicy'], comment: 'Bahut teekha' } });
    check('rating stored, 7-day average 2', fb.body?.rating?.avg_7d === 2 && fb.body?.rating?.count_7d === 3, fb.body?.rating);
    check('"too spicy" ×3 → suggest lowering spice 2 → 1', fb.body?.suggestions?.some((x) => x.tag === 'TOO_SPICY' && /2 to 1/.test(x.suggestion)), fb.body?.suggestions);
    check('RM told the rating is low (once)', (await notes(rm.id, 'COOK_LOW_RATING')).filter((n) => n.payload.placement_id === pCK).length === 1);
    check('cook told about each rating', (await notes(ck.userId, 'MEAL_FEEDBACK')).length >= 3);
    const ct = await req('GET', '/staff/care/cook/today', { token: ckT });
    const ctp = ct.body?.placements?.find((p) => p.placement_id === pCK);
    check("cook's day: profile + dinner menu + dinner log", ctp?.food_profile?.spice_level === 2 && ctp?.meals?.find((x) => x.meal === 'DINNER')?.menu && ctp?.meals?.find((x) => x.meal === 'DINNER')?.log, ctp?.meals?.map((x) => x.meal));
    const ckFeed = await req('GET', '/staff/care/client-updates', { token: ckT });
    const types = new Set((ckFeed.body?.items ?? []).map((i) => i.type));
    check('cook feed has food profile, menu and ratings', types.has('FOOD_PROFILE') && types.has('MENU') && types.has('MEAL_FEEDBACK'), [...types]);
    const fpItem = ckFeed.body?.items?.find((i) => i.type === 'FOOD_PROFILE');
    check('food profile item shows what changed', fpItem?.version === 2 && fpItem?.changes?.some((c) => /Spice/.test(c)), fpItem);

    // ── instructions ─────────────────────────────────────────────────────────
    console.log('\nInstructions');
    const i0 = await req('POST', `/care/placements/${pSC}/instructions`, { token: clientT, body: {} });
    check('empty instruction refused', i0.status === 400, i0.status);
    const i1 = await req('POST', `/care/placements/${pSC}/instructions`, { token: clientT, body: { text: 'Give him warm water at 4pm' } });
    check('instruction sent', i1.body?.status === 'SENT', msg(i1));
    check('staff told', (await notes(sc.userId, 'INSTRUCTION_NEW')).length === 1);
    const myIns = await req('GET', '/staff/care/instructions', { token: scT });
    check('staff sees it', myIns.body?.items?.some((x) => x.id === i1.body?.id));
    const a1 = await req('POST', `/staff/care/instructions/${i1.body?.id}/ack`, { token: scT });
    check('"Samjha" → ACKNOWLEDGED, client told', a1.body?.status === 'ACKNOWLEDGED' && (await notes(cust.portalUserId, 'INSTRUCTION_ACKNOWLEDGED')).length === 1, msg(a1));
    const d1 = await req('POST', `/staff/care/instructions/${i1.body?.id}/done`, { token: scT, body: { note: 'Given' } });
    check('"Ho gaya" → DONE', d1.body?.status === 'DONE', msg(d1));
    const voice = await upload(clientT, pSC, 'VOICE', Buffer.from('ID3fakeaudio'), 'audio/mpeg', 'note.mp3');
    const iv = await req('POST', `/care/placements/${pSC}/instructions`, { token: clientT, body: { voice_file_id: voice.body?.id } });
    check('voice-only instruction', ok2xx(iv) && iv.body?.voice_url?.includes(voice.body?.id), msg(iv));
    const vRes = await raw('GET', iv.body?.voice_url?.replace('/api/v1', '') ?? '/care-files/x', { token: scT });
    check('staff can play the voice note', vRes.status === 200 && vRes.headers.get('content-type') === 'audio/mpeg', vRes.status);
    const ir = await req('POST', `/care/placements/${pSC}/instructions`, { token: clientT, body: { text: 'Check his feet every morning', kind: 'RECURRING', recurrence: { times: ['08:00'] } } });
    const dr = await req('POST', `/staff/care/instructions/${ir.body?.id}/done`, { token: scT, body: {} });
    check('a standing order is never "done"', dr.status === 400, msg(dr));
    const ix = await req('POST', `/care/placements/${pSC}/instructions`, { token: clientT, body: { text: 'Clean the bathrooms too' } });
    const rf0 = await req('POST', `/staff/care/instructions/${ix.body?.id}/refuse`, { token: scT, body: {} });
    check('refuse needs a reason', rf0.status === 400, rf0.status);
    const rf = await req('POST', `/staff/care/instructions/${ix.body?.id}/refuse`, { token: scT, body: { reason: 'I am a nurse, not housekeeping' } });
    check('refused, Right-to-Refuse case opened', rf.body?.status === 'REFUSED' && !!rf.body?.refusal_id, msg(rf));
    const { rows: rtr } = await db.query(`SELECT event_type FROM right_to_refuse_log WHERE refusal_id = $1`, [rf.body?.refusal_id]);
    check('…in the Pillar 8 log', rtr[0]?.event_type === 'INVOKED', rtr);
    check('RM told', (await notes(rm.id, 'INSTRUCTION_REFUSED')).some((n) => n.payload.instruction_id === ix.body?.id));
    const q = await req('GET', '/rm/care/instructions/refused', { token: rmT });
    const qi = q.body?.items?.find((x) => x.id === ix.body?.id);
    check('in the RM queue with names and scope_of_work field', qi?.staff_name === 'Kavita Nurse' && 'scope_of_work' in (qi ?? {}), qi);
    const dc0 = await req('POST', `/rm/care/instructions/${ix.body?.id}/decide`, { token: rmT, body: { decision: 'UPHELD' } });
    check('decision needs a note', dc0.status === 400, dc0.status);
    const dc = await req('POST', `/rm/care/instructions/${ix.body?.id}/decide`, { token: rmT, body: { decision: 'UPHELD', note: 'Housekeeping is outside the SC scope' } });
    check('RM upholds → stays REFUSED with the decision', dc.body?.rm_decision === 'UPHELD' && dc.body?.status === 'REFUSED', msg(dc));
    const { rows: rtr2 } = await db.query(`SELECT event_type FROM right_to_refuse_log WHERE refusal_id = $1 ORDER BY created_at`, [rf.body?.refusal_id]);
    check('…and the Pillar 8 case is closed UPHELD', rtr2.at(-1)?.event_type === 'UPHELD', rtr2);
    check('client and staff both told', (await notes(cust.portalUserId, 'INSTRUCTION_DECIDED')).length === 1 && (await notes(sc.userId, 'INSTRUCTION_DECIDED')).length === 1);
    const cx = await req('POST', `/client/instructions/${ir.body?.id}/cancel`, { token: clientT });
    check('client withdraws the standing order', cx.body?.status === 'CANCELLED', msg(cx));
    const scFeed = await req('GET', '/staff/care/client-updates', { token: scT });
    check('instructions appear in the staff feed', (scFeed.body?.items ?? []).filter((i) => i.type === 'INSTRUCTION').length >= 3);

    // ── RM board + report ────────────────────────────────────────────────────
    console.log('\nRM compliance + monthly report');
    const board = await req('GET', '/rm/care/compliance', { token: rmT });
    const rowSC = board.body?.items?.find((r) => r.placement_id === pSC);
    const rowCK = board.body?.items?.find((r) => r.placement_id === pCK);
    check('SC placement is RED (out-of-range reading)', rowSC?.health === 'RED' && rowSC?.care?.vital_alerts_7d >= 1, rowSC);
    check('cook placement is RED (rating 2/5)', rowCK?.health === 'RED' && rowCK?.cook?.rating?.avg_7d === 2, rowCK);
    const pdf = await raw('GET', `/care/placements/${pSC}/report`, { token: clientT });
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    check('client downloads the monthly PDF', pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf' && pdfBuf.slice(0, 4).toString() === '%PDF', { status: pdf.status, ct: pdf.headers.get('content-type') });
    const staffPdf = await req('GET', `/care/placements/${pSC}/report`, { token: scT });
    check('not for the staff', staffPdf.status === 400, staffPdf.status);

    // ── after the placement ends ─────────────────────────────────────────────
    console.log('\nAfter exit');
    await db.query(`UPDATE placements SET status = 'EXITED', exit_date = CURRENT_DATE WHERE id = $1`, [pSC]);
    const gone = await req('GET', '/staff/care/today', { token: scT });
    check("staff no longer sees the household", !(gone.body?.placements ?? []).some((p) => p.placement_id === pSC));
    const goneFile = await raw('GET', `/care-files/${rx.body?.id}`, { token: scT });
    check("…nor its files", goneFile.status === 404, goneFile.status);
    const stillClient = await req('GET', `/care/placements/${pSC}/plan`, { token: clientT });
    check('client still reads the history', stillClient.status === 200, stillClient.status);
    const noWrite = await req('PUT', `/care/placements/${pSC}/plan`, { token: clientT, body: { dos: 'x' } });
    check('…but cannot change it', noWrite.status === 400, noWrite.status);
  } finally {
    const users = [...made.users];
    for (const c of made.customers) users.push(c.portalUserId);
    if (made.placements.length) {
      await db.query(`DELETE FROM escalation_logs WHERE metadata->>'placement_id' = ANY($1::text[])`, [made.placements]).catch(() => {});
      await db.query(`DELETE FROM deployments WHERE placement_id = ANY($1::uuid[])`, [made.placements]).catch(() => {});
      await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]).catch((e) => console.log('  cleanup placements:', e.message));
    }
    for (const c of made.customers) await db.query(`DELETE FROM food_profiles WHERE client_id = $1`, [c.customerId]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[]) OR (template LIKE ANY(ARRAY['CARE_%','COOK_%','MEAL_%','MENU_%','INSTRUCTION_%','FOOD_%']) AND payload->>'placement_id' = ANY($2::text[]))`, [users, made.placements]).catch(() => {});
    await db.query(`UPDATE staff_applicants SET user_id = NULL, deleted_at = NOW() WHERE id = ANY($1::uuid[])`, [made.staff]).catch(() => {});
    for (const u of made.users) {
      await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [u]).catch(() => {});
      await db.query(`DELETE FROM users WHERE id = $1`, [u]).catch(() => {});
    }
    for (const c of made.customers) await c.teardown().catch((e) => console.log('  cleanup customer:', e.message));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
