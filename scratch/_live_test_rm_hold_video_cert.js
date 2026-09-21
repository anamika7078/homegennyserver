/**
 * Live HTTP test for two things added 2026-09-21:
 *
 *  1. Video certification's blocker is owned by S3_TRAIN — holding S3_TRAIN
 *     lets a staff reach S5_DEPLOY without the video prompts done, same as
 *     holding S2_VERIFY skips Aadhaar/PV.
 *  2. The COMPLETE override — for a staff whose work already happened
 *     outside the system: permanent (not re-checked), and unlike HOLD it
 *     does not block placement. Reverting a COMPLETE is unconditional (no
 *     gate re-check), unlike releasing a HOLD.
 *
 *   node scratch/_live_test_rm_hold_video_cert.js
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

async function makeStaff(db, rmId, tag) {
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
       pipeline_stage, assigned_rm_id, branch_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MAID', $2, '1990-01-01', $3, 'Test', 'S4_AGREEMENTS', $4, $5, NOW())
     RETURNING id`,
    [`ZV-${tag}-${Date.now() % 100000}`, `Video Cert Test ${tag}`, '7' + String(Date.now()).slice(-9), rmId, BRANCH],
  );
  await db.query(
    `INSERT INTO agreements (id, staff_id, type, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'A1', 'SIGNED', NOW(), NOW())`,
    [id],
  );
  // Aadhaar CLEAR and no other blockers — only video cert (S3_TRAIN) should
  // remain, since that's what this file is testing in isolation.
  await db.query(
    `INSERT INTO verification_tracks (id, staff_id, track_type, status, verified_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'AADHAAR_EKYC', 'CLEAR', NOW(), NOW())`,
    [id],
  );
  return id;
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const staffIds = [];
  const customers = [];
  try {
    const token = await login();
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM.phone]);

    console.log('\n── Holding S3_TRAIN lets an unfinished video cert through');
    const a = await makeStaff(db, rm.id, 'A');
    staffIds.push(a);
    let r = await req('POST', `/rm/pipeline/${a}/advance`, { token, body: { to_stage: 'S5_DEPLOY' } });
    check('baseline: blocked on video cert', r.status === 400 && /Video certification/.test(msg(r)), msg(r));

    r = await req('POST', `/rm/pipeline/${a}/hold`, { token, body: { reason: 'TRAINING_PENDING', stage: 'S3_TRAIN' } });
    check('hold S3_TRAIN → 2xx', r.status < 300, r);
    const s3Hold = r.body;

    r = await req('POST', `/rm/pipeline/${a}/advance`, { token, body: { to_stage: 'S5_DEPLOY' } });
    check('advance → 2xx despite video cert undone, because S3_TRAIN is held', r.status < 300, r);
    let { rows: [st] } = await db.query(`SELECT pipeline_stage FROM staff_applicants WHERE id = $1`, [a]);
    check('staff now at S5_DEPLOY', st.pipeline_stage === 'S5_DEPLOY', st);

    r = await req('POST', `/rm/holds/${s3Hold.id}/release`, { token, body: {} });
    check('release → 400 (video cert still not done)', r.status === 400, r.status);
    check('cites video certification', /Video certification/.test(msg(r)), msg(r));

    console.log('\n── COMPLETE: permanent, does not block placement, no gate re-check on revert');
    const b = await makeStaff(db, rm.id, 'B');
    staffIds.push(b);
    r = await req('POST', `/rm/pipeline/${b}/complete`, { token, body: { reason: 'NOT_A_REASON' } });
    check('complete with an unknown reason → 400', r.status === 400, r.status);
    r = await req('POST', `/rm/pipeline/${b}/complete`, { token, body: { reason: 'PV_PENDING' } });
    check('complete with a HOLD-only reason → 400', r.status === 400, r.status);
    r = await req('POST', `/rm/pipeline/${b}/complete`, {
      token, body: { reason: 'MIGRATED_STAFF', stage: 'S4_AGREEMENTS', notes: 'Fully vetted before joining HomeGenny' },
    });
    check('complete S4_AGREEMENTS → 2xx', r.status < 300, r);
    const s4Complete = r.body;
    check('kind is COMPLETE', s4Complete?.kind === 'COMPLETE', s4Complete);

    r = await req('POST', `/rm/pipeline/${b}/hold`, { token, body: { reason: 'AGREEMENT_PENDING', stage: 'S4_AGREEMENTS' } });
    check('a HOLD on an already-COMPLETE stage → 400', r.status === 400, r.status);

    r = await req('POST', `/rm/pipeline/${b}/hold`, { token, body: { reason: 'TRAINING_PENDING', stage: 'S3_TRAIN' } });
    check('hold S3_TRAIN (video cert) on staff B → 2xx', r.status < 300, r);
    const s3HoldB = r.body;
    r = await req('POST', `/rm/pipeline/${b}/advance`, { token, body: { to_stage: 'S5_DEPLOY' } });
    check('advance → 2xx (agreement complete, video held)', r.status < 300, r);

    // COMPLETE doesn't block placement; the still-open S3_TRAIN HOLD does.
    const client = await createCustomer(db, 'VidCert');
    customers.push(client);
    r = await req('POST', '/placements', {
      token, body: { staff_id: b, client_id: client.customerId, placement_type: 'PERMANENT', staff_salary: 15000, management_fee: 3000 },
    });
    check('placement blocked by the open HOLD, not the COMPLETE', r.status === 400 && /S3_TRAIN/.test(msg(r)), msg(r));
    check('the 400 does not blame S4_AGREEMENTS (that one is COMPLETE)', !/S4_AGREEMENTS/.test(msg(r)), msg(r));

    r = await req('POST', `/rm/holds/${s3HoldB.id}/release`, { token, body: {} });
    check('release S3_TRAIN → 400 (video cert genuinely not done)', r.status === 400, r.status);

    r = await req('POST', `/rm/holds/${s4Complete.id}/release`, { token, body: {} });
    check('reverting the COMPLETE → 2xx unconditionally, no gate re-check', r.status < 300, r);
    ({ rows: [st] } = await db.query(`SELECT released_at FROM stage_holds WHERE id = $1`, [s4Complete.id]));
    check('complete row now closed', !!st.released_at, st);
    r = await req('POST', `/rm/holds/${s4Complete.id}/release`, { token, body: {} });
    check('reverting an already-reverted complete → 400', r.status === 400, r.status);

    console.log('\n── /rm/holds lists both kinds');
    r = await req('GET', '/rm/holds', { token });
    const rows = Array.isArray(r.body) ? r.body : [];
    check('S3_TRAIN hold on staff B is listed with kind HOLD', rows.some((h) => h.id === s3HoldB.id && h.kind === 'HOLD'), rows);
    check('the reverted S4 complete is not listed (closed)', !rows.some((h) => h.id === s4Complete.id));
  } finally {
    for (const id of staffIds) {
      await db.query(`DELETE FROM agreements WHERE staff_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM video_certifications WHERE staff_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM verification_tracks WHERE staff_id = $1`, [id]).catch(() => {});
      await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = $1`, [id])
        .catch((e) => console.log(`  (cleanup staff: ${e.message})`));
    }
    for (const c of customers) await c.teardown().catch((e) => console.log(`  (cleanup customer: ${e.message})`));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
