/**
 * Live HTTP test for stage holds: a held stage lets the staff past its exit
 * gate, releasing the hold checks that gate instead, no placement while a hold
 * is open, and a move to TERMINAL closes whatever is still held.
 * Builds its own staff and customer; soft-deletes the staff after (pipeline
 * events are append-only, so it can't be deleted).
 *
 *   node scratch/_live_test_rm_holds.js
 */
const { Client } = require('pg');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM = { phone: '9800000002', passwords: ['hg', 'HomeGenny@2024', 'Password@123'] };
const BRANCH = '00000000-0000-0000-0000-000000000001';

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

async function login() {
  for (const password of RM.passwords) {
    const r = await req('POST', '/auth/login', { body: { phone: RM.phone, password } });
    const token = r.body?.access_token ?? r.body?.accessToken ?? r.raw?.access_token;
    if (token) return token;
  }
  throw new Error('RM login failed');
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let staffId = null;
  let customer = null;
  try {
    const token = await login();
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM.phone]);
    ({ rows: [{ id: staffId }] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
         pipeline_stage, assigned_rm_id, branch_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'SKILLED_CARE', 'Hold Test', '1990-01-01', $2, 'Test', 'S2_VERIFY', $3, $4, NOW())
       RETURNING id`,
      [`ZH-${Date.now() % 100000}`, '7' + String(Date.now()).slice(-9), rm.id, BRANCH],
    ));
    const stageOf = async () => (await db.query(`SELECT pipeline_stage FROM staff_applicants WHERE id = $1`, [staffId])).rows[0].pipeline_stage;

    console.log('\n── Without a hold, the S2 gate stands');
    let r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'S3_TRAIN' } });
    check('S2 → S3 with nothing verified → 400', r.status === 400, r.status);

    console.log('\n── Placing a hold');
    r = await req('POST', `/rm/pipeline/${staffId}/hold`, { token, body: { reason: 'NOT_A_REASON' } });
    check('unknown reason → 400', r.status === 400, r.status);
    r = await req('POST', `/rm/pipeline/${staffId}/hold`, { token, body: { reason: 'PV_PENDING', stage: 'S4_AGREEMENTS' } });
    check('hold on a stage not yet reached → 400', r.status === 400, r.status);
    r = await req('POST', `/rm/pipeline/${staffId}/hold`, { token, body: { reason: 'PV_PENDING', notes: 'Thana report awaited' } });
    check('hold current stage → 2xx', r.status < 300, r);
    const s2Hold = r.body;
    check('hold is on S2_VERIFY with reason and notes',
      s2Hold?.stage === 'S2_VERIFY' && s2Hold?.reason === 'PV_PENDING' && s2Hold?.notes === 'Thana report awaited', s2Hold);
    r = await req('POST', `/rm/pipeline/${staffId}/hold`, { token, body: { reason: 'OTHER' } });
    check('second hold on the same stage → 400', r.status === 400, r.status);
    check('stage itself unchanged by a hold', (await stageOf()) === 'S2_VERIFY');

    r = await req('GET', '/rm/kanban?limit=500', { token });
    const card = (r.body?.columns?.S2_VERIFY ?? []).find((s) => s.id === staffId);
    check('kanban card carries the open hold', card?.open_holds?.length === 1 && card.open_holds[0].stage === 'S2_VERIFY', card?.open_holds);
    r = await req('GET', '/rm/holds', { token });
    check('hold listed on /rm/holds', (r.body ?? []).some((h) => h.id === s2Hold?.id && h.staff_name === 'Hold Test'), r.body);

    console.log('\n── A held stage lets the staff move on');
    r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'S3_TRAIN' } });
    check('S2 (held) → S3 → 2xx', r.status < 300, r);
    check('staff now at S3_TRAIN', (await stageOf()) === 'S3_TRAIN');

    console.log('\n── Releasing checks the gate that was skipped');
    r = await req('POST', `/rm/holds/${s2Hold.id}/release`, { token, body: {} });
    check('release with verification still incomplete → 400', r.status === 400, r.status);
    check('the 400 says what is missing', /Aadhaar/.test(msg(r)), msg(r));
    for (const t of ['AADHAAR_EKYC', 'HEALTH_SCREENING', 'POLICE_VERIFICATION']) {
      await db.query(
        `INSERT INTO verification_tracks (id, staff_id, track_type, status, verified_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'CLEAR', NOW(), NOW())`, [staffId, t]);
    }
    await db.query(`UPDATE staff_applicants SET pv_status = 'CLEAR' WHERE id = $1`, [staffId]);
    r = await req('POST', `/rm/holds/${s2Hold.id}/release`, { token, body: { notes: 'PV came back clear' } });
    check('release once verification clears → 2xx', r.status < 300, r);
    check('hold marked released', !!r.body?.released_at && r.body?.release_notes === 'PV came back clear', r.body);
    r = await req('POST', `/rm/holds/${s2Hold.id}/release`, { token, body: {} });
    check('releasing twice → 400', r.status === 400, r.status);
    r = await req('GET', '/rm/holds', { token });
    check('released hold gone from /rm/holds', !(r.body ?? []).some((h) => h.id === s2Hold.id));
    const { rows: ev } = await db.query(
      `SELECT event_type FROM pipeline_events WHERE staff_id = $1 AND event_type IN ('HOLD_PLACED','HOLD_RELEASED') ORDER BY occurred_at`, [staffId]);
    check('HOLD_PLACED and HOLD_RELEASED logged', ev.map((e) => e.event_type).join(',') === 'HOLD_PLACED,HOLD_RELEASED', ev);

    console.log('\n── No placement while a hold is open');
    r = await req('POST', `/rm/pipeline/${staffId}/hold`, { token, body: { reason: 'TRAINING_PENDING' } });
    check('hold S3 → 2xx', r.status < 300, r);
    const s3Hold = r.body;
    await db.query(`UPDATE staff_applicants SET pipeline_stage = 'S5_DEPLOY' WHERE id = $1`, [staffId]);
    customer = await createCustomer(db, 'Hold');
    r = await req('POST', '/placements', {
      token, body: { staff_id: staffId, client_id: customer.customerId, placement_type: 'PERMANENT', staff_salary: 15000, management_fee: 3000 },
    });
    check('placement with an open hold → 400', r.status === 400, r.status);
    check('the 400 names the hold', /S3_TRAIN/.test(msg(r)), msg(r));

    console.log('\n── TERMINAL closes open holds');
    r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'TERMINAL', terminal_outcome: 'ABANDONED' } });
    check('S5 → TERMINAL → 2xx', r.status < 300, r);
    const { rows: [h] } = await db.query(`SELECT released_at, release_notes FROM stage_holds WHERE id = $1`, [s3Hold.id]);
    check('open hold closed on TERMINAL', !!h?.released_at && /TERMINAL/.test(h.release_notes), h);
    r = await req('POST', `/rm/pipeline/${staffId}/hold`, { token, body: { reason: 'OTHER' } });
    check('holding a TERMINAL staff → 400', r.status === 400, r.status);
  } finally {
    if (staffId) {
      await db.query(`DELETE FROM verification_tracks WHERE staff_id = $1`, [staffId]).catch(() => {});
      await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = $1`, [staffId]).catch((e) => console.log(`  (cleanup: ${e.message})`));
    }
    if (customer) await customer.teardown().catch((e) => console.log(`  (cleanup customer: ${e.message})`));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
