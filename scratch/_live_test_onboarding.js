/**
 * Live HTTP test for "mobile login, then complete your profile" (2026-10-21),
 * docs/REGISTRATION_ONBOARDING_PLAN.md:
 *   no demo fallbacks · GET /me/onboarding · GET /meta/cities · staff profile draft/submit
 *   (S1 → S2, RM auto-assigned by city, no-RM → Leads, restricted → TERMINAL) · fields locked
 *   after S1 · the server-side gate (reads pass, writes refused until complete) · client profile
 *   before requests.
 *
 *   node scratch/_live_test_onboarding.js            (cleans up after itself)
 *   node scratch/_live_test_onboarding.js --sweep    (leftovers of an aborted run)
 */
const { Client } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const RM_PASSWORDS = ['hg', 'HomeGenny@2024', 'Password@123'];
const OTP = process.env.AUTH_MOCK_OTP || '123456';
const DELHI = '00000000-0000-0000-0000-000000000001';

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
const err = (r) => r.raw?.message?.error;
async function login(phone, passwords) {
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.body?.access_token) return r.body.access_token;
  }
  throw new Error(`login failed for ${phone}`);
}
const newPhone = () => '78' + String(Date.now()).slice(-7) + Math.floor(Math.random() * 10);
async function signUp(role, phones) {
  const phone = newPhone();
  phones.push(phone);
  await req('POST', '/auth/otp/send', { body: { phone } });
  const r = await req('POST', '/auth/otp/verify', { body: { phone, otp: OTP, role } });
  return { phone, token: r.body?.access_token, login: r.body };
}
const PROFILE = (over = {}) => ({
  full_name: 'Geeta Kumari', date_of_birth: '1990-06-15', gender: 'FEMALE', series: 'UC',
  address: '12 Malviya Nagar', city: 'Delhi NCR', area: 'South Delhi', pincode: '110017',
  emergency_contact_name: 'Mohan', emergency_contact_mobile: '9811122233', languages: ['Hindi', 'English'],
  ...over,
});

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const phones = [];
  try {
    const rmToken = await login(RM_PHONE, RM_PASSWORDS);

    // ── Cities ────────────────────────────────────────────────────────────
    console.log('\nCities');
    let r = await req('GET', '/meta/cities');
    const names = (r.body?.cities ?? []).map((c) => c.city);
    check('GET /meta/cities is public and lists Delhi NCR, Pune, Mumbai, Other', r.status === 200
      && ['Delhi NCR', 'Pune', 'Mumbai', 'Other'].every((c) => names.includes(c)), names);
    check('Delhi NCR carries its areas', (r.body.cities.find((c) => c.city === 'Delhi NCR')?.areas ?? []).includes('Gurgaon'), r.body.cities[0]);

    // ── Staff: fresh sign-up ──────────────────────────────────────────────
    console.log('\nStaff: fresh sign-up');
    const a = await signUp('STAFF', phones);
    r = await req('GET', '/me/onboarding', { token: a.token });
    check('onboarding: COMPLETE_PROFILE with 8 missing', r.status === 200 && r.body.next_step === 'COMPLETE_PROFILE'
      && r.body.profile_complete === false && r.body.missing.length === 8, r.body);
    r = await req('GET', '/staff/profile', { token: a.token });
    check('profile: blanks are null — no "Pooja Mishra", no MAID, no STF-1029', r.status === 200 && r.body.fullName === null
      && r.body.series === null && r.body.dateOfBirth === null && /^new\d+$/.test(r.body.staffCode) && !JSON.stringify(r.body).includes('Pooja'), r.body);
    r = await req('GET', '/staff/dashboard', { token: a.token });
    check('dashboard: no fake RM, one real task "Complete your profile"', r.status === 200 && r.body.assignedRm === null
      && r.body.todayTasks.length === 1 && r.body.todayTasks[0].id === 'profile' && r.body.fullName === null, r.body);
    check('login response: no fake RM / code / series', a.login.user.assignedRm === null && a.login.user.series === null
      && /^new\d+$/.test(a.login.user.staffCode), a.login.user);

    // The gate: reads pass, writes refused.
    r = await req('POST', '/staff/attendance/location', { token: a.token, body: { lat: 28.5, lng: 77.2 } });
    check('gate: a write is refused with 403 PROFILE_INCOMPLETE', r.status === 403 && err(r) === 'PROFILE_INCOMPLETE'
      && Array.isArray(r.raw.message.missing), { s: r.status, raw: r.raw?.message });
    r = await req('GET', '/staff/pipeline', { token: a.token });
    check('gate: reads still work', r.status === 200, r.status);

    // Drafts.
    r = await req('PUT', '/staff/profile', { token: a.token, body: { full_name: 'Geeta Kumari', city: 'gurgaon' } });
    check('draft save: name + city ("gurgaon" → Delhi NCR)', r.status === 200 && r.body.fullName === 'Geeta Kumari' && r.body.city === 'Delhi NCR'
      && r.body.missing.length === 6, r.body);
    r = await req('PUT', '/staff/profile', { token: a.token, body: { date_of_birth: '2012-01-01' } });
    check('under 18 refused', r.status === 400 && /Age must be between/.test(msg(r)), msg(r));
    r = await req('PUT', '/staff/profile', { token: a.token, body: { emergency_contact_mobile: a.phone } });
    check('own number as emergency contact refused', r.status === 400 && /own number/.test(msg(r)), msg(r));
    r = await req('PUT', '/staff/profile', { token: a.token, body: { city: 'Atlantis' } });
    check('unknown city refused', r.status === 400 && /city must be one of/.test(msg(r)), msg(r));
    r = await req('PUT', '/staff/profile', { token: a.token, body: { pincode: '012345' } });
    check('bad pincode refused', r.status === 400, r.status);
    r = await req('POST', '/staff/profile/submit', { token: a.token, body: {} });
    check('submit with gaps → 400 PROFILE_INCOMPLETE + missing', r.status === 400 && err(r) === 'PROFILE_INCOMPLETE'
      && r.raw.message.missing.includes('date_of_birth') && !r.raw.message.missing.includes('full_name'), r.raw?.message);

    // Expected RM: the Delhi RM with the fewest active staff.
    const { rows: rmLoads } = await db.query(
      `SELECT u.id, (SELECT count(*) FROM staff_applicants s WHERE s.assigned_rm_id = u.id AND s.deleted_at IS NULL AND s.pipeline_stage <> 'TERMINAL')::int AS n
         FROM users u WHERE u.role = 'RM' AND u.is_active AND u.branch_id = $1 ORDER BY n`, [DELHI]);
    r = await req('POST', '/staff/profile/submit', { token: a.token, body: PROFILE() });
    check('submit → ADVANCE_S2, RM assigned', r.status === 201 && r.body.outcome === 'ADVANCE_S2' && r.body.assigned?.id === rmLoads[0]?.id, { s: r.status, m: msg(r), b: r.body });
    check('onboarding now VERIFICATION with the RM', r.body?.next_step === 'VERIFICATION' && r.body.rm?.phone, r.body);
    const { rows: [sa] } = await db.query(`SELECT * FROM staff_applicants WHERE mobile = $1`, [a.phone]);
    check('row: S2, Delhi branch, code from the name, metadata saved', sa.pipeline_stage === 'S2_VERIFY' && sa.branch_id === DELHI
      && /^geeta\d{3,}$/.test(sa.staff_code) && sa.metadata.pincode === '110017' && sa.metadata.languages.length === 2
      && sa.emergency_contact_mobile === '9811122233', sa);
    const { rows: ev } = await db.query(`SELECT event_type, reason_code FROM pipeline_events WHERE staff_id = $1 ORDER BY occurred_at`, [sa.id]);
    check('pipeline events: S1→S2 SELF_COMPLETED and STAFF_AUTO_ASSIGNED', ev.some((e) => e.reason_code === 'SELF_COMPLETED')
      && ev.some((e) => e.event_type === 'STAFF_AUTO_ASSIGNED'), ev);
    const { rows: nt } = await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND template = 'STAFF_AUTO_ASSIGNED' AND payload->>'staff_id' = $2`, [rmLoads[0]?.id, sa.id]);
    check('the RM was notified', nt.length === 1, nt.length);
    r = await req('GET', '/staff/dashboard', { token: a.token });
    check('dashboard: real RM + S2 tasks (Aadhaar, police)', r.body.assignedRm?.phone && r.body.todayTasks.some((t) => t.id === 'AADHAAR_EKYC')
      && r.body.todayTasks.some((t) => t.id === 'POLICE_VERIFICATION'), r.body);

    // Locks and the gate after S1.
    r = await req('PUT', '/staff/profile', { token: a.token, body: { full_name: 'Someone Else' } });
    check('name locked after S1', r.status === 400 && /ask your RM/.test(msg(r)), msg(r));
    r = await req('PUT', '/staff/profile', { token: a.token, body: { address: '99 New Address Road', emergency_contact_name: 'Sita' } });
    check('address + emergency contact still editable', r.status === 200 && r.body.address === '99 New Address Road' && r.body.locked_fields.length === 4, r.body);
    r = await req('POST', '/staff/attendance/location', { token: a.token, body: { lat: 28.5, lng: 77.2 } });
    check('gate lifted (any answer but PROFILE_INCOMPLETE)', err(r) !== 'PROFILE_INCOMPLETE', { s: r.status, e: err(r) });
    r = await req('POST', '/staff/profile/submit', { token: a.token, body: PROFILE() });
    check('submit again → 400 (S1 already done)', r.status === 400 && /already done/.test(msg(r)), msg(r));

    // ── Staff: no RM in the city ──────────────────────────────────────────
    console.log('\nStaff: no RM in the city');
    const b = await signUp('STAFF', phones);
    r = await req('POST', '/staff/profile/submit', { token: b.token, body: PROFILE({ full_name: 'Pune Staff', city: 'Pune', pincode: '411045', emergency_contact_mobile: '9811122244' }) });
    check('Pune (no RM there) → S2 but unassigned', r.status === 201 && r.body.outcome === 'ADVANCE_S2' && r.body.assigned === null && r.body.next_step === 'WAIT_FOR_RM', r.body);
    const { rows: [sb] } = await db.query(`SELECT id, assigned_rm_id, branch_id FROM staff_applicants WHERE mobile = $1`, [b.phone]);
    check('branch = Pune, no RM', sb.assigned_rm_id === null && sb.branch_id === '00000000-0000-0000-0000-000000000002', sb);
    r = await req('GET', '/rm/unassigned-staff', { token: rmToken });
    check('shows in RM Leads', (r.body ?? []).some((s) => s.id === sb.id), null);
    const { rows: nb } = await db.query(`SELECT 1 FROM notifications WHERE template = 'STAFF_NEEDS_RM' AND payload->>'staff_id' = $1`, [sb.id]);
    check('BMs/Admins told there is no RM', nb.length >= 1, nb.length);

    const c = await signUp('STAFF', phones);
    r = await req('POST', '/staff/profile/submit', { token: c.token, body: PROFILE({ full_name: 'Other City', city: 'Other', emergency_contact_mobile: '9811122255' }) });
    check('"Other" city → S2, no branch, unassigned', r.status === 201 && r.body.assigned === null, r.body);

    // ── Staff: restricted list ────────────────────────────────────────────
    console.log('\nStaff: restricted');
    const d = await signUp('STAFF', phones);
    const hash = crypto.createHash('sha256').update(d.phone).digest('hex');
    await db.query(`INSERT INTO restricted_list (id, phone_hash, reason) VALUES (gen_random_uuid(), $1, 'onboarding test')`, [hash]);
    r = await req('POST', '/staff/profile/submit', { token: d.token, body: PROFILE({ full_name: 'Blocked Person', emergency_contact_mobile: '9811122266' }) });
    check('restricted → RESTRICTED, TERMINAL/DENIED, no RM', r.status === 201 && r.body.outcome === 'RESTRICTED', r.body);
    const { rows: [sd] } = await db.query(`SELECT pipeline_stage, terminal_outcome, assigned_rm_id FROM staff_applicants WHERE mobile = $1`, [d.phone]);
    check('row TERMINAL / DENIED', sd.pipeline_stage === 'TERMINAL' && sd.terminal_outcome === 'DENIED' && !sd.assigned_rm_id, sd);
    await db.query(`DELETE FROM restricted_list WHERE phone_hash = $1`, [hash]);

    // ── Client ────────────────────────────────────────────────────────────
    console.log('\nClient');
    const k = await signUp('CLIENT', phones);
    r = await req('GET', '/me/onboarding', { token: k.token });
    check('client onboarding: COMPLETE_PROFILE, name/address/city/pincode', r.body?.next_step === 'COMPLETE_PROFILE'
      && JSON.stringify(r.body.missing) === '["name","address","city","pincode"]', r.body);
    r = await req('POST', '/client/complaints', { token: k.token, body: { type: 'CLIENT_COMPLAINT', description: 'test' } });
    check('gate: client write refused', r.status === 403 && err(r) === 'PROFILE_INCOMPLETE', { s: r.status, e: err(r) });
    r = await req('GET', '/client/dashboard', { token: k.token });
    check('gate: client reads work', r.status === 200, r.status);
    const reqBody = { series: 'CK', start_date: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10), start_time: '08:00',
      requirements: { diet_type: 'VEG', family_size: 3, meals_per_day: ['LUNCH'] }, address: '5 Hauz Khas, Delhi' };
    r = await req('POST', '/client/staff-requests', { token: k.token, body: reqBody });
    check('request refused until the profile is complete', r.status === 403 && err(r) === 'PROFILE_INCOMPLETE', { s: r.status, m: msg(r) });
    r = await req('PATCH', '/client/profile', { token: k.token, body: { name: 'Anil Arora', address: '5 Hauz Khas, Delhi', city: 'Delhi NCR', pincode: '110016' } });
    check('PATCH /client/profile (name alias) completes it', r.status === 200 && r.body.profile_complete === true && r.body.name === 'Anil Arora', r.body);
    r = await req('GET', '/me/onboarding', { token: k.token });
    check('client onboarding READY', r.body?.next_step === 'READY', r.body);
    r = await req('POST', '/client/staff-requests', { token: k.token, body: reqBody });
    check('request accepted now', r.status === 201, { s: r.status, m: msg(r) });

    // ── RM / office logins are never gated ────────────────────────────────
    r = await req('GET', '/me/onboarding', { token: rmToken });
    check('RM cannot use /me/onboarding (app roles only)', r.status === 403, r.status);
  } finally {
    await cleanup(db, phones);
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

async function cleanup(db, phones) {
  if (!phones.length) return;
  const q = (sql, p) => db.query(sql, p).catch((e) => console.log(`  cleanup: ${e.message.slice(0, 140)}`));
  const { rows: users } = await db.query(`SELECT id FROM users WHERE phone = ANY($1)`, [phones]);
  const userIds = users.map((u) => u.id);
  const { rows: staff } = await db.query(`SELECT id FROM staff_applicants WHERE mobile = ANY($1)`, [phones]);
  const staffIds = staff.map((s) => s.id);
  const { rows: custs } = await db.query(`SELECT id FROM finance_customers WHERE user_id = ANY($1)`, [userIds]);
  const custIds = custs.map((x) => x.id);
  await q(`DELETE FROM staff_requests WHERE client_id = ANY($1)`, [custIds]);
  await q(`DELETE FROM notifications WHERE payload->>'staff_id' = ANY($1::text[])`, [staffIds]);
  for (const t of ['deposits', 'deferred_records', 'stage_holds']) await q(`DELETE FROM ${t} WHERE staff_id = ANY($1)`, [staffIds]);
  await q(`DELETE FROM staff_applicants s WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM pipeline_events e WHERE e.staff_id = s.id)`, [staffIds]);
  await q(`UPDATE staff_applicants SET deleted_at = NOW(), user_id = NULL, assigned_rm_id = NULL WHERE id = ANY($1)`, [staffIds]);
  await q(`DELETE FROM finance_customer_branches WHERE customer_id = ANY($1)`, [custIds]);
  await q(`DELETE FROM finance_customers WHERE id = ANY($1)`, [custIds]);
  for (const t of ['user_sessions', 'notifications', 'login_audits']) await q(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [userIds]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
}

if (process.argv[2] === '--sweep') {
  (async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const { rows } = await db.query(
      `SELECT phone FROM users WHERE phone ~ '^78[0-9]{8}$' AND role IN ('CLIENT','STAFF') AND created_at > NOW() - INTERVAL '1 day'
       UNION SELECT mobile FROM staff_applicants WHERE mobile ~ '^78[0-9]{8}$' AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '1 day'`);
    console.log(`sweeping ${rows.length} test accounts`);
    await cleanup(db, rows.map((r) => r.phone));
    await db.end();
  })();
} else main().catch((e) => { console.error(e); process.exitCode = 1; });
