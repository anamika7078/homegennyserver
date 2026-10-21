/**
 * Live HTTP test for mobile-number-only registration (2026-10-21),
 * docs/MOBILE_BRIEF_MOBILE_ONLY_REGISTRATION.md.
 *
 *   OTP sign-in      /auth/otp/send + /auth/otp/verify: new number → signs up
 *                    (role CLIENT/STAFF), known number → signs in, office
 *                    numbers refused, wrong/expired codes refused
 *   Staff            lands at S1 with a mobile only; S1→S2 refused until the
 *                    RM uses "Complete S1"; that claims, renames the code, moves to S2
 *   Client           pending profile; first staff request needs a name
 *                    (profile block), takes the request address, fixes the
 *                    unit code; PATCH /client/profile; RM client leads
 *   Older app builds the full register payloads still work
 *
 * Every row it makes is deleted at the end.
 *
 *   node scratch/_live_test_mobile_only_registration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const RM_PASSWORDS = ['hg', 'HomeGenny@2024', 'Password@123'];
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
const ok2xx = (r) => r.status >= 200 && r.status < 300;

async function login(phone, passwords) {
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const token = r.body?.access_token;
    if (token) return token;
  }
  throw new Error(`login failed for ${phone}`);
}

const uniqPhone = () => '7' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);
const inDays = (n) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

async function otpSignIn(phone, extra = {}) {
  const sent = await req('POST', '/auth/otp/send', { body: { phone } });
  const r = await req('POST', '/auth/otp/verify', { body: { phone, otp: OTP, ...extra } });
  return { sent, r };
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const phones = [];
  try {
    const rmToken = await login(RM_PHONE, RM_PASSWORDS);
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);

    // ── OTP sign-in mechanics ───────────────────────────────────────────────
    console.log('\nOTP sign-in');
    const staffPhone = uniqPhone(); phones.push(staffPhone);
    let r = await req('POST', '/auth/otp/send', { body: { phone: staffPhone } });
    check('send: new number → is_registered false', r.status === 201 && r.body.sent === true && r.body.is_registered === false, r.body);
    r = await req('POST', '/auth/otp/send', { body: { phone: '12345' } });
    check('send: bad number refused', r.status === 400, r.status);
    r = await req('POST', '/auth/otp/verify', { body: { phone: staffPhone, otp: '000000', role: 'STAFF' } });
    check('verify: wrong code → 401', r.status === 401, { s: r.status, m: msg(r) });
    r = await req('POST', '/auth/otp/verify', { body: { phone: staffPhone, otp: OTP } });
    check('verify: new number without role → 400', r.status === 400 && /role/i.test(msg(r)), { s: r.status, m: msg(r) });
    r = await req('POST', '/auth/otp/verify', { body: { phone: uniqPhone(), otp: OTP, role: 'STAFF' } });
    check('verify: no code was sent for this number → 400', r.status === 400 && /expired/i.test(msg(r)), { s: r.status, m: msg(r) });

    r = await req('POST', '/auth/otp/send', { body: { phone: RM_PHONE } });
    check('send: office (RM) number → use_password_login', r.body.is_registered === true && r.body.use_password_login === true && r.body.role === null, r.body);
    r = await req('POST', '/auth/otp/verify', { body: { phone: RM_PHONE, otp: OTP } });
    check('verify: office (RM) number refused (403)', r.status === 403, { s: r.status, m: msg(r) });

    // ── Staff: mobile only → S1 → RM completes ──────────────────────────────
    console.log('\nStaff sign-up');
    r = await req('POST', '/auth/otp/verify', { body: { phone: staffPhone, otp: OTP, role: 'STAFF' } });
    check('staff signs up with a mobile only', r.status === 201 && !!r.body.access_token && r.body.is_new_user === true, { s: r.status, m: msg(r) });
    check('not asked to change a password', r.body?.must_change_password === false, r.body?.must_change_password);
    check('login says profile incomplete (4 S1 fields)', r.body?.user?.profile_complete === false
      && ['full_name', 'date_of_birth', 'address', 'series'].every((f) => r.body.user.profile_missing.includes(f)), r.body?.user);
    check('login: series null, stage S1', r.body?.user?.series === null && r.body?.user?.pipelineStage === 'S1_INTAKE', r.body?.user);
    const staffToken = r.body.access_token;
    const { rows: [sa] } = await db.query(`SELECT * FROM staff_applicants WHERE mobile = $1`, [staffPhone]);
    check('staff row at S1_INTAKE, no RM, nothing but the mobile', sa && sa.pipeline_stage === 'S1_INTAKE' && !sa.assigned_rm_id
      && sa.full_name === null && sa.series === null && sa.date_of_birth === null && sa.address === null, sa);
    check('provisional staff code', /^new\d{3,}$/.test(sa.staff_code), sa.staff_code);
    const { rows: [su] } = await db.query(`SELECT password_hash, metadata FROM users WHERE phone = $1`, [staffPhone]);
    r = await req('POST', '/auth/login', { body: { phone: staffPhone, password: 'HomeGenny@2024' } });
    check('OTP-only account is not on the default password', r.status === 401 && su.metadata.otp_only === true, { s: r.status, meta: su.metadata });

    r = await req('GET', '/user/profile', { token: staffToken });
    check('GET /user/profile: profile_complete false', r.status === 200 && r.body.profile_complete === false, r.body);
    r = await req('GET', '/staff/pipeline', { token: staffToken });
    check('staff app pipeline screen still works with no series', r.status === 200, { s: r.status, m: msg(r) });
    r = await req('GET', '/staff/dashboard', { token: staffToken });
    check('staff app dashboard still works with no series', r.status === 200, { s: r.status, m: msg(r) });

    r = await otpSignIn(staffPhone);
    check('signs in again by OTP: known number, STAFF, not new', r.sent.body.role === 'STAFF' && r.r.status === 201 && r.r.body.is_new_user === false, r.r.body?.is_new_user);
    r = await otpSignIn(staffPhone, { role: 'CLIENT' });
    check('known number ignores a different role and signs in as itself', r.r.status === 201 && r.r.body.user.role === 'STAFF', r.r.body?.user?.role);

    r = await req('GET', '/rm/unassigned-staff', { token: rmToken });
    const lead = (r.body ?? []).find((s) => s.id === sa.id);
    check('RM leads list shows it, intake_complete false', lead && lead.intake_complete === false && lead.intake_missing.length === 4, lead);

    r = await req('POST', `/rm/unassigned-staff/${sa.id}/claim`, { token: rmToken });
    check('RM claims it', ok2xx(r), { s: r.status, m: msg(r) });
    r = await req('POST', `/rm/pipeline/${sa.id}/advance`, { token: rmToken, body: { to_stage: 'S2_VERIFY' } });
    check('S1→S2 refused while S1 is incomplete', r.status === 400 && /S1 intake is incomplete/.test(msg(r)), { s: r.status, m: msg(r) });

    r = await req('POST', `/rm/staff/${sa.id}/complete-intake`, { token: rmToken, body: { full_name: 'Rekha Testwali' } });
    check('Complete S1 refuses missing fields', r.status === 400 && /date_of_birth/.test(msg(r)) && /series/.test(msg(r)), { s: r.status, m: msg(r) });
    r = await req('POST', `/rm/staff/${sa.id}/complete-intake`, {
      token: rmToken,
      body: { full_name: 'Rekha Testwali', date_of_birth: '1992-03-04', address: '14 Lajpat Nagar, Delhi', series: 'MAID' },
    });
    check('Complete S1 refuses a paused series', r.status === 400, { s: r.status, m: msg(r) });
    r = await req('POST', `/rm/staff/${sa.id}/complete-intake`, {
      token: rmToken,
      body: {
        full_name: 'Rekha Testwali', date_of_birth: '1992-03-04', address: '14 Lajpat Nagar, Delhi', series: 'UC',
        gender: 'female', language_tier: 'T2', hometown: 'Gaya',
      },
    });
    check('Complete S1 → ADVANCE_S2', ok2xx(r) && r.body.outcome === 'ADVANCE_S2' && r.body.staff.pipeline_stage === 'S2_VERIFY', { s: r.status, m: msg(r), b: r.body });
    const { rows: [sa2] } = await db.query(`SELECT *, to_char(date_of_birth, 'YYYY-MM-DD') AS dob FROM staff_applicants WHERE id = $1`, [sa.id]);
    check('details saved, DOB the day given', sa2.full_name === 'Rekha Testwali' && sa2.series === 'UNSKILLED_CARE'
      && sa2.dob === '1992-03-04' && sa2.metadata.gender === 'FEMALE', sa2);
    check('staff code renamed from the name', /^rekha\d{3,}$/.test(sa2.staff_code), sa2.staff_code);
    check('still the claiming RM\'s', sa2.assigned_rm_id === rm.id, sa2.assigned_rm_id);
    const { rows: [su2] } = await db.query(`SELECT full_name FROM users WHERE phone = $1`, [staffPhone]);
    check('login name updated', su2.full_name === 'Rekha Testwali', su2);
    r = await req('POST', `/rm/staff/${sa.id}/complete-intake`, { token: rmToken, body: { full_name: 'X Y' } });
    check('Complete S1 again refused (already at S2)', r.status === 400 && /already done/.test(msg(r)), { s: r.status, m: msg(r) });
    r = await req('GET', '/user/profile', { token: staffToken });
    check('staff profile_complete now true', r.body.profile_complete === true, r.body);

    // Unclaimed: Complete S1 claims it
    const staff2Phone = uniqPhone(); phones.push(staff2Phone);
    r = await otpSignIn(staff2Phone, { role: 'STAFF', full_name: 'Sunita Testwali', series: 'CK' });
    check('sign-up with optional name + series kept', r.r.status === 201, { s: r.r.status, m: msg(r.r) });
    const { rows: [sb] } = await db.query(`SELECT * FROM staff_applicants WHERE mobile = $1`, [staff2Phone]);
    check('name and series stored, code from the name', sb.full_name === 'Sunita Testwali' && sb.series === 'COOK' && /^sunita\d{3,}$/.test(sb.staff_code), sb);
    r = await req('POST', `/rm/staff/${sb.id}/complete-intake`, {
      token: rmToken, body: { date_of_birth: '1988-11-30', address: '7 Saket, Delhi' },
    });
    check('Complete S1 needs only what is missing, and claims it', ok2xx(r) && r.body.staff.assigned_rm_id === rm.id && r.body.staff.pipeline_stage === 'S2_VERIFY', { s: r.status, m: msg(r) });

    // ── Client: mobile only → pending profile → first request ───────────────
    console.log('\nClient sign-up');
    const clientPhone = uniqPhone(); phones.push(clientPhone);
    r = await otpSignIn(clientPhone, { role: 'CLIENT' });
    check('client signs up with a mobile only', r.r.status === 201 && r.r.body.is_new_user === true && r.r.body.user.role === 'CLIENT', { s: r.r.status, m: msg(r.r) });
    check('profile_missing = name, address', JSON.stringify(r.r.body.user.profile_missing) === '["name","address"]', r.r.body.user);
    check('login shows no placeholder customer name', r.r.body.user.customerName === null, r.r.body.user.customerName);
    const clientToken = r.r.body.access_token;
    const { rows: [fc] } = await db.query(`SELECT c.* FROM finance_customers c JOIN users u ON u.id = c.user_id WHERE u.phone = $1`, [clientPhone]);
    check('pending customer: placeholder name, no address/PAN, NEW- unit code', fc.customer_name === `New client ${clientPhone}`
      && fc.address === null && fc.pan_card === null && /^NEW-\d{2}$/.test(fc.unit_code) && fc.metadata.name_pending === true, fc);

    r = await req('GET', '/client/profile', { token: clientToken });
    check('GET /client/profile: name null, incomplete', r.status === 200 && r.body.name === null && r.body.profile_complete === false, r.body);
    r = await req('GET', '/client/dashboard', { token: clientToken });
    check('client dashboard works for a pending profile', r.status === 200, { s: r.status, m: msg(r) });

    const ucReq = {
      series: 'UC', start_date: inDays(3), start_time: '08:00', requirements: { patient_age: 80, mobility: 'ASSISTED' },
      address: '22 Green Park, New Delhi', lat: 28.5592, lng: 77.2066, language: 'Hindi', gender_pref: 'ANY',
    };
    r = await req('POST', '/client/staff-requests', { token: clientToken, body: ucReq });
    check('first request without a name → 400 PROFILE_INCOMPLETE', r.status === 400 && (r.raw?.message?.error === 'PROFILE_INCOMPLETE' || /full_name/.test(msg(r))), { s: r.status, raw: r.raw });
    const { rows: [fcSame] } = await db.query(`SELECT address FROM finance_customers WHERE id = $1`, [fc.id]);
    check('…and nothing was saved', fcSame.address === null, fcSame);
    r = await req('POST', '/client/staff-requests', { token: clientToken, body: { ...ucReq, requirements: {}, profile: { full_name: 'Meera Kapoor' } } });
    check('invalid request with a profile → 400, profile untouched', r.status === 400, r.status);
    const { rows: [fcSame2] } = await db.query(`SELECT customer_name FROM finance_customers WHERE id = $1`, [fc.id]);
    check('…name not saved either', fcSame2.customer_name === `New client ${clientPhone}`, fcSame2);

    r = await req('POST', '/client/staff-requests', {
      token: clientToken, body: { ...ucReq, profile: { full_name: 'Meera Kapoor', city: 'New Delhi', pincode: '110016' } },
    });
    check('first request with profile.full_name → created', ok2xx(r) && !!r.body.id, { s: r.status, m: msg(r) });
    const requestId = r.body?.id;
    const { rows: [fc2] } = await db.query(`SELECT * FROM finance_customers WHERE id = $1`, [fc.id]);
    check('name saved, address taken from the request, city/pincode saved', fc2.customer_name === 'Meera Kapoor'
      && fc2.address === '22 Green Park, New Delhi' && fc2.city === 'New Delhi' && fc2.pincode === '110016', fc2);
    check('unit code rebuilt from the name', !/^NEW-/.test(fc2.unit_code) && fc2.unit_code.startsWith('MEERA') && fc2.bill_no_prefix.startsWith(fc2.unit_code + '/'), fc2.unit_code);
    const { rows: [br] } = await db.query(`SELECT unit_code, address FROM finance_customer_branches WHERE customer_id = $1`, [fc.id]);
    check('primary branch follows (code + address)', br.unit_code === fc2.unit_code && br.address === '22 Green Park, New Delhi', br);
    const { rows: [cu] } = await db.query(`SELECT full_name FROM users WHERE phone = $1`, [clientPhone]);
    check('client login name updated', cu.full_name === 'Meera Kapoor', cu);
    r = await req('GET', '/client/profile', { token: clientToken });
    check('profile now complete', r.body.profile_complete === true && r.body.name === 'Meera Kapoor', r.body);
    r = await req('POST', '/client/staff-requests', { token: clientToken, body: { ...ucReq, start_date: inDays(5) } });
    check('second request needs no profile block', ok2xx(r), { s: r.status, m: msg(r) });
    const requestId2 = r.body?.id;

    r = await req('PATCH', '/client/profile', { token: clientToken, body: { pan_card: 'nope' } });
    check('PATCH profile: bad PAN refused', r.status === 400, r.status);
    r = await req('PATCH', '/client/profile', { token: clientToken, body: { pincode: '12' } });
    check('PATCH profile: bad pincode refused', r.status === 400, r.status);
    r = await req('PATCH', '/client/profile', { token: clientToken, body: { state: 'Delhi', email: `meera${Date.now()}@example.com` } });
    check('PATCH profile: state + email saved', r.status === 200 && r.body.state === 'Delhi' && /meera/.test(r.body.email), { s: r.status, b: r.body });
    r = await req('PATCH', '/client/profile', { token: rmToken, body: { state: 'X' } });
    check('PATCH profile is client-only', r.status === 403, r.status);

    // PATCH /client/profile route completes a second pending client before any request
    const client2Phone = uniqPhone(); phones.push(client2Phone);
    r = await otpSignIn(client2Phone, { role: 'CLIENT' });
    const client2Token = r.r.body.access_token;
    r = await req('PATCH', '/client/profile', { token: client2Token, body: { full_name: 'Arjun Mehra', address: '5 Hauz Khas, Delhi' } });
    check('PATCH completes the profile up front', r.status === 200 && r.body.profile_complete === true, r.body);

    // RM client leads
    console.log('\nRM client leads');
    r = await req('GET', '/rm/client-leads', { token: rmToken });
    const cl = (r.body ?? []).find((c) => c.phone === clientPhone);
    check('lead listed with request count', r.status === 200 && cl && cl.request_count === 2 && cl.profile_complete === true, cl);
    const client3Phone = uniqPhone(); phones.push(client3Phone);
    await otpSignIn(client3Phone, { role: 'CLIENT' });
    r = await req('GET', '/rm/client-leads?status=pending', { token: rmToken });
    const pending = (r.body ?? []).find((c) => c.phone === client3Phone);
    check('pending filter shows the new one, missing name+address', pending && pending.name === null && pending.profile_missing.length === 2, pending);
    r = await req('PATCH', `/rm/client-leads/${pending.id}`, {
      token: rmToken, body: { full_name: 'Kavita Rao', address: '9 Vasant Kunj, Delhi', pan_card: 'ABCDE9876K', note: 'Needs a cook from next month' },
    });
    check('RM fills profile + PAN + note', ok2xx(r) && r.body.profile_complete === true && r.body.pan_card === 'ABCDE9876K' && r.body.lead_notes.length === 1, { s: r.status, m: msg(r), b: r.body });

    // ── Older app builds: full payloads still work ──────────────────────────
    console.log('\nOlder app build');
    const legacyC = uniqPhone(); phones.push(legacyC);
    r = await req('POST', '/auth/register/customer', {
      body: { full_name: 'Old App Client', phone: legacyC, password: 'Str0ng@Pass', address: '1 Old Road, Pune', city: 'Pune', pan_card: 'ZZZZZ' + String(Date.now()).slice(-4) + 'Z' },
    });
    check('legacy full client payload → registered, profile complete', r.status === 201 && r.body.user.profile_complete === true, { s: r.status, m: msg(r) });
    r = await req('POST', '/auth/login', { body: { phone: legacyC, password: 'Str0ng@Pass' } });
    check('legacy client keeps password login', r.status === 201 && !!r.body.access_token, r.status);
    const legacyS = uniqPhone(); phones.push(legacyS);
    r = await req('POST', '/auth/register/staff', {
      body: {
        full_name: 'Old App Staff', phone: legacyS, password: 'Str0ng@Pass', series: 'SC', date_of_birth: '1990-05-05',
        gender: 'FEMALE', address: '2 Old Road, Pune', city: 'Pune', state: 'MH', pincode: '411001',
      },
    });
    check('legacy full staff payload → registered at S1, intake complete', r.status === 201 && r.body.user.pipelineStage === 'S1_INTAKE' && r.body.user.profile_complete === true, { s: r.status, m: msg(r), u: r.body?.user });
    const { rows: [ls] } = await db.query(`SELECT id, metadata FROM staff_applicants WHERE mobile = $1`, [legacyS]);
    check('legacy extras kept on the S1 record', ls.metadata.gender === 'FEMALE' && ls.metadata.pincode === '411001', ls.metadata);
    await req('POST', `/rm/unassigned-staff/${ls.id}/claim`, { token: rmToken });
    r = await req('POST', `/rm/pipeline/${ls.id}/advance`, { token: rmToken, body: { to_stage: 'S2_VERIFY' } });
    check('complete S1 record can advance normally', ok2xx(r), { s: r.status, m: msg(r) });
    r = await req('POST', '/auth/register/staff', { body: { phone: legacyS } });
    check('same phone twice → 409', r.status === 409, r.status);

    // cleanup helpers
    globalThis.__cleanup = { requestIds: [requestId, requestId2].filter(Boolean) };
  } finally {
    await cleanup(db, phones);
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

async function cleanup(db, phones) {
  if (!phones.length) return;
  const q = (sql, p) => db.query(sql, p).catch((e) => console.log(`  cleanup: ${e.message.slice(0, 120)}`));
  const { rows: users } = await db.query(`SELECT id FROM users WHERE phone = ANY($1)`, [phones]);
  const userIds = users.map((u) => u.id);
  const { rows: staff } = await db.query(`SELECT id FROM staff_applicants WHERE mobile = ANY($1)`, [phones]);
  const staffIds = staff.map((s) => s.id);
  const { rows: custs } = await db.query(`SELECT id FROM finance_customers WHERE user_id = ANY($1)`, [userIds]);
  const custIds = custs.map((c) => c.id);
  const { rows: reqs } = await db.query(`SELECT id FROM staff_requests WHERE client_id = ANY($1)`, [custIds]);
  const reqIds = reqs.map((r) => r.id);
  for (const t of ['staff_request_candidates']) await q(`DELETE FROM ${t} WHERE request_id = ANY($1)`, [reqIds]);
  await q(`DELETE FROM staff_requests WHERE id = ANY($1)`, [reqIds]);
  for (const t of ['deposits', 'deferred_records', 'stage_holds']) {
    await q(`DELETE FROM ${t} WHERE staff_id = ANY($1)`, [staffIds]);
  }
  // pipeline_events is append-only at the database level, so a staff row with
  // events can only be soft-deleted — unlinked from its login so that can go.
  await q(`DELETE FROM staff_applicants s WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM pipeline_events e WHERE e.staff_id = s.id)`, [staffIds]);
  await q(`UPDATE staff_applicants SET deleted_at = NOW(), user_id = NULL WHERE id = ANY($1)`, [staffIds]);
  await q(`DELETE FROM finance_customer_branches WHERE customer_id = ANY($1)`, [custIds]);
  await q(`DELETE FROM finance_customers WHERE id = ANY($1)`, [custIds]);
  for (const t of ['user_sessions', 'notifications', 'login_audits']) await q(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [userIds]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
}

if (process.argv[2] === '--sweep') {
  // Leftovers of an aborted run: this test's phones start with 7 and were made in the last day.
  (async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const { rows } = await db.query(
      `SELECT phone FROM users WHERE phone ~ '^7[0-9]{9}$' AND role IN ('CLIENT','STAFF') AND created_at > NOW() - INTERVAL '1 day'
       UNION
       SELECT mobile FROM staff_applicants WHERE mobile ~ '^7[0-9]{9}$' AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '1 day'`,
    );
    console.log(`sweeping ${rows.length} test accounts`);
    await cleanup(db, rows.map((r) => r.phone));
    await db.end();
  })();
} else main().catch((e) => { console.error(e); process.exitCode = 1; });
