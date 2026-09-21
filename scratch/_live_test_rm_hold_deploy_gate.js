/**
 * Live HTTP test for the exact bug reported 2026-09-21: the S5_DEPLOY gate
 * used to only skip when the FROM stage of *this* transition was on hold —
 * so a staff with an open S2_VERIFY hold (Aadhaar never done) still got
 * blocked on Aadhaar when advancing S4 → S5, because S4 (not S2) was the
 * "current" stage. Fixed by tagging each blocker with the stage that owns
 * it and checking *that* stage's hold, not just the current one.
 *
 * Video certification is owned by S3_TRAIN, not S2_VERIFY — this test only
 * holds S2, so it must still block regardless (verified here too, so the fix
 * doesn't overcorrect into "any hold anywhere waves through everything").
 * See _live_test_rm_hold_video_cert.js for S3_TRAIN holding/completing it.
 *
 *   node scratch/_live_test_rm_hold_deploy_gate.js
 */
const { Client } = require('pg');
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

const VIDEO_PROMPTS_MAID = 9;

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let staffId = null;
  try {
    const token = await login();
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM.phone]);
    ({ rows: [{ id: staffId }] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
         pipeline_stage, assigned_rm_id, branch_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'MAID', 'Hold Deploy Gate Test', '1990-01-01', $2, 'Test', 'S4_AGREEMENTS', $3, $4, NOW())
       RETURNING id`,
      [`ZG-${Date.now() % 100000}`, '7' + String(Date.now()).slice(-9), rm.id, BRANCH],
    ));
    // Agreement signed, so the only blockers are Aadhaar/PV (S2_VERIFY, held) and video cert (owned by S3_TRAIN, not held here).
    await db.query(
      `INSERT INTO agreements (id, staff_id, type, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'A1', 'SIGNED', NOW(), NOW())`,
      [staffId],
    );

    console.log('\n── Baseline: nothing held, nothing done — deploy blocked on everything');
    let r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'S5_DEPLOY' } });
    check('advance → 400', r.status === 400, r.status);
    check('names both Aadhaar and video cert', /Aadhaar/.test(msg(r)) && /Video certification/.test(msg(r)), msg(r));

    console.log('\n── Hold S2_VERIFY (the stage that owns Aadhaar/PV) — deploy should stop citing them');
    r = await req('POST', `/rm/pipeline/${staffId}/hold`, { token, body: { reason: 'PV_PENDING', stage: 'S2_VERIFY', notes: 'PV appointment pending' } });
    check('hold S2_VERIFY → 2xx', r.status < 300, r);
    const s2Hold = r.body;

    r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'S5_DEPLOY' } });
    check('advance still → 400 (video cert not done)', r.status === 400, r.status);
    check('no longer names Aadhaar — that stage is held', !/Aadhaar/.test(msg(r)), msg(r));
    check('no longer names police verification — same stage', !/Police verification/.test(msg(r)), msg(r));
    check('still names video certification — S3_TRAIN isn\'t held here', /Video certification/.test(msg(r)), msg(r));

    console.log('\n── Finish video cert — deploy should now succeed with S2 still held');
    for (let i = 0; i < VIDEO_PROMPTS_MAID; i++) {
      await db.query(
        `INSERT INTO video_certifications (id, staff_id, prompt_key, video_url, sha256_hash, review_status)
         VALUES (gen_random_uuid(), $1, $2, 'https://example.com/v.mp4', $3, 'APPROVED')`,
        [staffId, `prompt_${i}`, `${'a'.repeat(63)}${i}`],
      );
    }
    r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'S5_DEPLOY' } });
    check('advance → 2xx despite Aadhaar/PV still undone, because S2_VERIFY is held', r.status < 300, r);
    const { rows: [st] } = await db.query(`SELECT pipeline_stage FROM staff_applicants WHERE id = $1`, [staffId]);
    check('staff now at S5_DEPLOY', st.pipeline_stage === 'S5_DEPLOY', st);

    console.log('\n── Releasing S2_VERIFY now re-checks Aadhaar/PV — and refuses, since they still aren\'t done');
    r = await req('POST', `/rm/holds/${s2Hold.id}/release`, { token, body: {} });
    check('release → 400', r.status === 400, r.status);
    check('the 400 cites Aadhaar, not video cert', /Aadhaar/.test(msg(r)) && !/Video certification/.test(msg(r)), msg(r));
  } finally {
    if (staffId) {
      await db.query(`DELETE FROM video_certifications WHERE staff_id = $1`, [staffId]).catch(() => {});
      await db.query(`DELETE FROM agreements WHERE staff_id = $1`, [staffId]).catch(() => {});
      await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = $1`, [staffId])
        .catch((e) => console.log(`  (cleanup: ${e.message})`));
    }
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
