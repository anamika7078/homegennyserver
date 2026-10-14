/**
 * Live HTTP test for docs/MENU_TRACKING_REQUEST_CHANGES_PLAN.md (2026-10-14):
 *   - dish search for the dropdown (diet filter from the food profile, region
 *     and meal first, partial names) and "+ Add as my dish" (dedupe, privacy)
 *   - the client's menu with picked dishes, meal time (own or the profile
 *     default), photos, diet warnings; cook suggestions off
 *   - the weekly template (fills empty slots, never a client slot, a cleared
 *     slot stays cleared, edits flow through) and "same as last week"
 *   - the cook's Today screen shows the time
 *   - the check-in map: distance from the client home, far flag, setting the home
 * (Staff-request address/time/budget are covered in _live_test_staff_requests.js.)
 *
 *   node scratch/_live_test_menu_checkins.js
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
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}
async function req(method, path, { token, body, form } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json?.data !== undefined && json?.success !== undefined ? json.data : json, raw: json };
  }
}
const msg = (r) => String(r.raw?.message?.message ?? r.raw?.message ?? '');
const ok2xx = (r) => r.status >= 200 && r.status < 300;
async function login(phone, password = PW) {
  for (let i = 0; i < 4; i++) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token ?? r.body?.accessToken;
    if (t) return t;
    if (r.status !== 429) throw new Error(`login failed for ${phone}: ${r.status} ${msg(r)}`);
  }
  throw new Error(`login throttled for ${phone}`);
}
const ist = () => new Date(Date.now() + 330 * 60_000);
const today = () => ist().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DOWS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const dow = (d) => DOWS[new Date(`${d}T00:00:00Z`).getUTCDay()];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { users: [], staff: [], placements: [], customers: [] };
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);
    const tag = String(Date.now()).slice(-6);
    const cust = await createCustomer(db, 'Menu');
    const other = await createCustomer(db, 'MenX');
    made.customers.push(cust, other);
    const phone = `82${tag}10`;
    const { rows: [u] } = await db.query(
      `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, branch_id, updated_at)
       VALUES (gen_random_uuid(), 'STAFF', 'Ramu Cook', $1, $2, true, $3, NOW()) RETURNING id`,
      [phone, await bcrypt.hash(PW, 10), HQ],
    );
    made.users.push(u.id);
    const { rows: [st] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, pipeline_stage, assigned_rm_id, branch_id, user_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'COOK', 'Ramu Cook', '1990-01-01', $2, 'x', 'S5_DEPLOY', $3, $4, $5, NOW()) RETURNING id`,
      [`ZM-${tag}`, phone, rm.id, HQ, u.id],
    );
    made.staff.push(st.id);
    const { rows: [pl] } = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours, trial_start_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 8, CURRENT_DATE, NOW(), NOW()) RETURNING id`,
      [st.id, cust.customerId, HQ, rm.id],
    );
    const pid = pl.id;
    made.placements.push(pid);

    const clientT = await login(cust.phone, cust.password);
    const otherT = await login(other.phone, other.password);
    const cookT = await login(phone);
    const rmT = await login(RM_PHONE);
    const dishId = async (name) => (await db.query(`SELECT id FROM dishes WHERE client_id IS NULL AND name = $1`, [name])).rows[0]?.id;

    // ── dish search ──────────────────────────────────────────────────────────
    console.log('\nDish search');
    const s0 = await req('GET', '/care/dishes?q=paneer', { token: clientT });
    check('partial name search works', s0.body?.items?.length >= 5 && s0.body.items.every((d) => /paneer/i.test(d.name)), s0.body?.items?.map((d) => d.name));
    check('no exact "paneer" dish → can_add', s0.body?.can_add === true);
    const prof = await req('PUT', '/client/food-profile', {
      token: clientT,
      body: { diet_type: 'VEG', cuisines: ['Gujarati'], health_conditions: ['DIABETIC'], meal_times: { BREAKFAST: '08:30', LUNCH: '13:00' } },
    });
    check('profile saved with meal times', prof.body?.profile?.meal_times?.BREAKFAST === '08:30', { status: prof.status, msg: msg(prof) });
    const badTime = await req('PUT', '/client/food-profile', { token: clientT, body: { diet_type: 'VEG', meal_times: { LUNCH: '1pm' } } });
    check('bad meal time refused', badTime.status === 400, msg(badTime));
    const veg = await req('GET', '/care/dishes?q=chicken', { token: clientT });
    check('veg profile: no chicken dishes at all', veg.body?.total === 0 && JSON.stringify(veg.body?.filtered_by?.diet) === '["VEG"]', veg.body);
    const askNonVeg = await req('GET', '/care/dishes?diet=NON_VEG', { token: clientT });
    check('asking for non-veg cannot widen a veg profile', askNonVeg.body?.total === 0, askNonVeg.body?.total);
    const bfast = await req('GET', '/care/dishes?meal=BREAKFAST&limit=5', { token: clientT });
    const top = bfast.body?.items?.[0];
    check('breakfast + Gujarati dishes come first', top?.meals?.includes('BREAKFAST') && top?.region === 'GUJARATI', bfast.body?.items?.map((d) => `${d.name}/${d.region}`));
    const dh = await req('GET', '/care/dishes?q=dhok', { token: clientT });
    check('"dhok" finds Dhokla first', dh.body?.items?.[0]?.name === 'Dhokla', dh.body?.items?.map((d) => d.name));
    const badDiet = await req('GET', '/care/dishes?diet=FISH', { token: clientT });
    check('unknown diet filter refused', badDiet.status === 400, badDiet.status);

    console.log('\nAdd my own dish');
    const own0 = await req('GET', '/care/dishes?q=grandma special khichdi', { token: clientT });
    check('not on the list → can_add', own0.body?.total === 0 && own0.body?.can_add === true, own0.body);
    const noDiet = await req('POST', '/client/dishes', { token: clientT, body: { name: 'Grandma Special Khichdi', category: 'RICE' } });
    check('own dish needs a diet', noDiet.status === 400, msg(noDiet));
    const own = await req('POST', '/client/dishes', { token: clientT, body: { name: 'Grandma  Special Khichdi', category: 'RICE', diet: 'VEG' } });
    check('own dish added', ok2xx(own) && own.body?.existing === false && own.body?.dish?.own === true, { status: own.status, msg: msg(own) });
    const ownAgain = await req('POST', '/client/dishes', { token: clientT, body: { name: 'grandma special KHICHDI', category: 'RICE', diet: 'VEG' } });
    check('same name again (any case/spaces) → the same dish', ownAgain.body?.existing === true && ownAgain.body?.dish?.id === own.body?.dish?.id, ownAgain.body);
    const poha = await req('POST', '/client/dishes', { token: clientT, body: { name: 'POHA', category: 'BREAKFAST', diet: 'VEG' } });
    check('a dish already on the common list is returned, not copied', poha.body?.existing === true && poha.body?.dish?.own === false, poha.body);
    const found = await req('GET', '/care/dishes?q=grandma', { token: clientT });
    check('own dish shows in my search', found.body?.items?.some((d) => d.id === own.body?.dish?.id && d.own), found.body?.items);
    const hidden = await req('GET', '/care/dishes?q=grandma', { token: otherT });
    check("another client doesn't see it", hidden.body?.total === 0, hidden.body?.total);
    const mine = await req('GET', '/client/dishes', { token: clientT });
    check('listed under my dishes', mine.body?.items?.length === 1, mine.body);

    // ── menu ─────────────────────────────────────────────────────────────────
    console.log('\nClient menu');
    const d1 = addDays(today(), 1);
    const photo = await (async () => {
      const form = new FormData();
      form.append('placement_id', pid); form.append('kind', 'PHOTO');
      form.append('file', new Blob([PNG], { type: 'image/png' }), 'like-this.png');
      return req('POST', '/care-files', { token: clientT, form });
    })();
    check('client uploads a photo', ok2xx(photo), msg(photo));
    const pohaId = await dishId('Poha');
    const curryId = await dishId('Chicken Curry');
    const jamunId = await dishId('Gulab Jamun');
    const m1 = await req('PUT', `/care/placements/${pid}/menu`, {
      token: clientT,
      body: {
        items: [
          { date: d1, meal: 'BREAKFAST', dish_ids: [pohaId, own.body.dish.id], meal_time: '08:45', special_instruction: 'Less oil', photo_file_ids: [photo.body.id] },
          { date: d1, meal: 'LUNCH', dish_ids: [curryId, jamunId], dishes: ['Phulka'] },
        ],
      },
    });
    const bf = m1.body?.items?.find((i) => i.date === d1 && i.meal === 'BREAKFAST');
    const ln = m1.body?.items?.find((i) => i.date === d1 && i.meal === 'LUNCH');
    check('menu saved from picked dishes', ok2xx(m1) && bf?.dishes?.map((d) => d.name).join(',') === 'Poha,Grandma Special Khichdi', { status: m1.status, msg: msg(m1), d: bf?.dishes });
    check('own time kept (08:45)', bf?.meal_time === '08:45' && bf?.meal_time_is_default === false, bf);
    check('photo attached for the cook', bf?.photo_file_ids?.[0] === photo.body.id);
    check('no time given → the profile default (13:00)', ln?.meal_time === '13:00' && ln?.meal_time_is_default === true, ln);
    check('typed "Phulka" matched to the list', ln?.dishes?.find((d) => d.name === 'Phulka')?.dish_id === (await dishId('Phulka')), ln?.dishes);
    check('warning: non-veg dish on a veg profile', ln?.health_warnings?.some((w) => /Chicken Curry is non-veg/.test(w)), ln?.health_warnings);
    check('warning: sweet for a diabetic', ln?.health_warnings?.some((w) => /diabetic/.test(w)), ln?.health_warnings);
    const bad1 = await req('PUT', `/care/placements/${pid}/menu`, { token: clientT, body: { items: [{ date: d1, meal: 'DINNER', dish_ids: ['00000000-0000-0000-0000-000000000000'] }] } });
    check('unknown dish id refused', bad1.status === 400, msg(bad1));
    const bad2 = await req('PUT', `/care/placements/${pid}/menu`, { token: clientT, body: { items: [{ date: d1, meal: 'DINNER', dishes: ['Dal'], meal_time: '25:00' }] } });
    check('bad meal time refused', bad2.status === 400, msg(bad2));
    const otherOwn = await req('PUT', `/care/placements/${pid}/menu`, { token: otherT, body: { items: [{ date: d1, meal: 'DINNER', dishes: ['Dal'] }] } });
    check("another client can't touch this menu", otherOwn.status === 404, otherOwn.status);
    const sug = await req('POST', '/staff/care/cook/menu-suggestions', { token: cookT, body: { placement_id: pid, items: [{ date: d1, meal: 'DINNER', dishes: ['Dal'] }] } });
    check('cook cannot suggest (403)', sug.status === 403, sug.status);
    const cookMenu = await req('PUT', `/care/placements/${pid}/menu`, { token: cookT, body: { items: [{ date: d1, meal: 'DINNER', dishes: ['Dal'] }] } });
    check('cook cannot set the menu', cookMenu.status === 400, cookMenu.status);

    // ── template ─────────────────────────────────────────────────────────────
    console.log('\nWeekly template');
    const dalId = await dishId('Dal Tadka');
    const rotiId = await dishId('Phulka');
    const tplItems = DOWS.map((d) => ({ dow: d, meal: 'DINNER', dish_ids: [dalId, rotiId], meal_time: '20:30' }));
    tplItems.push({ dow: dow(d1), meal: 'BREAKFAST', dish_ids: [await dishId('Upma')] });
    const t1 = await req('PUT', '/client/menu-template', { token: clientT, body: { items: tplItems } });
    check('template saved', ok2xx(t1) && t1.body?.items?.length === 8 && t1.body?.active === true, { status: t1.status, msg: msg(t1) });
    const dupT = await req('PUT', '/client/menu-template', { token: clientT, body: { items: [{ dow: 'MON', meal: 'DINNER', dishes: ['Dal'] }, { dow: 'MON', meal: 'DINNER', dishes: ['Rice'] }] } });
    check('same day+meal twice refused', dupT.status === 400, msg(dupT));
    const wk = await req('GET', `/care/placements/${pid}/menu?week=${today()}`, { token: clientT });
    const todayDinner = wk.body?.items?.find((i) => i.date === today() && i.meal === 'DINNER');
    check("template filled today's dinner (20:30)", todayDinner?.source === 'TEMPLATE' && todayDinner?.meal_time === '20:30', todayDinner);
    const wk2 = await req('GET', `/care/placements/${pid}/menu?week=${d1}`, { token: clientT });
    const bf2 = wk2.body?.items?.find((i) => i.date === d1 && i.meal === 'BREAKFAST');
    check("template did not overwrite the client's own breakfast", bf2?.source === 'CLIENT' && bf2?.dishes?.[0]?.name === 'Poha', bf2);
    const cookDay = await req('GET', '/staff/care/cook/today', { token: cookT });
    const cd = cookDay.body?.placements?.find((p) => p.placement_id === pid)?.meals?.find((m) => m.meal === 'DINNER');
    check("cook's Today shows dinner at 20:30", cd?.menu?.meal_time === '20:30' && cd?.menu?.dishes?.length === 2, cd);
    // Clear today's dinner by hand → stays cleared.
    const clr = await req('PUT', `/care/placements/${pid}/menu`, { token: clientT, body: { items: [{ date: today(), meal: 'DINNER', dish_ids: [], dishes: [] }] } });
    check('dinner cleared', ok2xx(clr) && !clr.body?.items?.some((i) => i.date === today() && i.meal === 'DINNER'), msg(clr));
    const again = await req('GET', `/care/placements/${pid}/menu?week=${today()}`, { token: clientT });
    check('a cleared slot is not refilled by the template', !again.body?.items?.some((i) => i.date === today() && i.meal === 'DINNER'));
    // Change the template → future template slots follow, client slots don't.
    const khichdiId = await dishId('Khichdi');
    for (const t of tplItems) if (t.meal === 'DINNER') t.dish_ids = [khichdiId];
    await req('PUT', '/client/menu-template', { token: clientT, body: { items: tplItems } });
    const wk3 = await req('GET', `/care/placements/${pid}/menu?week=${addDays(today(), 2)}`, { token: clientT });
    const d2din = wk3.body?.items?.find((i) => i.date === addDays(today(), 2) && i.meal === 'DINNER');
    check('template change reaches upcoming template slots', d2din?.dishes?.[0]?.name === 'Khichdi' && d2din?.changes?.some((c) => /Khichdi/.test(c)), d2din);

    console.log('\nSame as last week');
    const cw = await req('POST', `/care/placements/${pid}/menu/copy-week`, { token: clientT, body: { from_week: today(), to_week: addDays(today(), 7) } });
    const nextBf = cw.body?.menu?.items?.find((i) => i.date === addDays(d1, 7) && i.meal === 'BREAKFAST');
    check('next week copied from this week', ok2xx(cw) && cw.body?.copied > 0 && nextBf?.dishes?.[0]?.name === 'Poha' && nextBf?.source === 'CLIENT', { status: cw.status, msg: msg(cw), copied: cw.body?.copied });
    const cw2 = await req('POST', `/care/placements/${pid}/menu/copy-week`, { token: clientT, body: { from_week: today(), to_week: addDays(today(), 7) } });
    check('copying again keeps the slots already set', cw2.body?.copied === 0 && cw2.body?.kept_existing > 0, cw2.body);

    // ── check-in map ─────────────────────────────────────────────────────────
    console.log('\nCheck-in map');
    const home = await req('PUT', '/client/home-location', { token: clientT, body: { lat: 28.6139, lng: 77.209 } });
    check('client sets home on the map', ok2xx(home), msg(home));
    const badHome = await req('PUT', '/client/home-location', { token: clientT, body: { lat: 200, lng: 1 } });
    check('bad location refused', badHome.status === 400, badHome.status);
    const ci = await req('POST', '/staff/attendance/check-in', { token: cookT, body: { latitude: 28.6239, longitude: 77.209 } });
    check('cook checks in (~1.1 km away)', ok2xx(ci), msg(ci));
    const { rows: [sl] } = await db.query(`SELECT to_char(shift_date, 'YYYY-MM-DD') AS d FROM shift_logs WHERE staff_id = $1`, [st.id]);
    const map = await req('GET', `/rm/checkins?date=${sl.d}`, { token: rmT });
    const row = map.body?.items?.find((i) => i.staff?.id === st.id);
    check('RM sees the check-in', !!row, map.body?.summary);
    check('distance ~1.1 km, flagged far', row?.check_in?.far === true && Math.abs(row.check_in.distance_m - 1112) < 30, row?.check_in);
    check('home came from the client', row?.home?.source === 'CLIENT');
    const fix = await req('PATCH', `/rm/clients/${cust.customerId}/home-location`, { token: rmT, body: { lat: 28.6239, lng: 77.209 } });
    check('RM sets the home to the check-in point', ok2xx(fix), msg(fix));
    const map2 = await req('GET', `/rm/checkins?date=${sl.d}`, { token: rmT });
    const row2 = map2.body?.items?.find((i) => i.staff?.id === st.id);
    check('now at the home (0 m, not far)', row2?.check_in?.far === false && row2.check_in.distance_m === 0, row2?.check_in);
    const noOwn = await req('PATCH', `/rm/clients/${other.customerId}/home-location`, { token: rmT, body: { lat: 1, lng: 1 } });
    check("RM can't move the home of a client with none of their placements", noOwn.status === 403, noOwn.status);
    const asClient = await req('GET', '/rm/checkins', { token: clientT });
    check('client cannot open the RM map', asClient.status === 403, asClient.status);
  } finally {
    for (const c of made.customers) {
      await db.query(`DELETE FROM dishes WHERE client_id = $1`, [c.customerId]).catch(() => {});
      await db.query(`DELETE FROM menu_templates WHERE client_id = $1`, [c.customerId]).catch(() => {});
      await db.query(`DELETE FROM food_profiles WHERE client_id = $1`, [c.customerId]).catch(() => {});
    }
    for (const s of made.staff) {
      await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = $1`, [s]).catch(() => {});
      await db.query(`DELETE FROM shift_logs WHERE staff_id = $1`, [s]).catch(() => {});
    }
    if (made.placements.length) await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]).catch((e) => console.log('  cleanup placements:', e.message));
    const users = [...made.users, ...made.customers.map((c) => c.portalUserId)];
    await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [users]).catch(() => {});
    await db.query(`UPDATE staff_applicants SET user_id = NULL, deleted_at = NOW() WHERE id = ANY($1::uuid[])`, [made.staff]).catch(() => {});
    for (const id of made.users) {
      await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
    }
    for (const c of made.customers) await c.teardown().catch((e) => console.log('  cleanup customer:', e.message));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
