/**
 * Live HTTP test for the RM pipeline's DEFERRED / TERMINAL transitions and the
 * 90-day deferred timeout. Hits the running API, then verifies what actually
 * landed in Postgres. Creates its own throwaway staff and removes them after.
 *
 *   node scratch/_live_test_rm_pipeline.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM = { phone: '9800000002', passwords: ['hg', 'HomeGenny@2024', 'Password@123'] };

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

async function login() {
  for (const password of RM.passwords) {
    const r = await req('POST', '/auth/login', { body: { phone: RM.phone, password } });
    const token = r.body?.access_token ?? r.body?.accessToken ?? r.raw?.access_token;
    if (token) return { token, userId: r.body?.user?.id };
  }
  throw new Error('RM login failed');
}

async function makeStaff(db, rmId, stage, tag) {
  const mobile = '7' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 10));
  const { rows } = await db.query(
    `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
       pipeline_stage, assigned_rm_id, branch_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MAID', $2, '1990-01-01', $3, 'Test', $4::pipeline_stage, $5,
       '00000000-0000-0000-0000-000000000001', NOW())
     RETURNING id`,
    [`ZT-${tag}-${Date.now() % 100000}`, `Pipeline Test ${tag}`, mobile, stage, rmId],
  );
  return rows[0].id;
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const created = [];
  try {
    const { token } = await login();
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM.phone]);

    console.log('\n── DEFERRED needs a reason, and the record lands with the stage change');
    const a = await makeStaff(db, rm.id, 'S3_TRAIN', 'A');
    created.push(a);
    let r = await req('POST', `/rm/pipeline/${a}/advance`, { token, body: { to_stage: 'DEFERRED' } });
    check('defer without a reason → 400', r.status === 400, r.status);
    let { rows: [st] } = await db.query(`SELECT pipeline_stage FROM staff_applicants WHERE id = $1`, [a]);
    check('stage unchanged after refused defer', st.pipeline_stage === 'S3_TRAIN', st);

    r = await req('POST', `/rm/pipeline/${a}/advance`, { token, body: { to_stage: 'DEFERRED', payload: { deferred_reason: 'NOT_A_REASON' } } });
    check('defer with an unknown reason → 400', r.status === 400, r.status);

    r = await req('POST', `/rm/pipeline/${a}/advance`, {
      token, body: { to_stage: 'DEFERRED', payload: { deferred_reason: 'TRAINING_GAP', notes: 'needs cooking module' } },
    });
    check('defer with a reason → 2xx', r.status < 300, r);
    const { rows: recs } = await db.query(
      `SELECT reason::text, resume_stage::text, notes, resume_at, EXTRACT(DAY FROM timeout_at - deferred_at)::int AS days
       FROM deferred_records WHERE staff_id = $1`, [a]);
    check('one deferred record written', recs.length === 1, recs);
    check('record keeps reason, notes, and the stage deferred from',
      recs[0]?.reason === 'TRAINING_GAP' && recs[0]?.resume_stage === 'S3_TRAIN' && recs[0]?.notes === 'needs cooking module', recs[0]);
    check('timeout is 90 days out', recs[0]?.days === 90, recs[0]?.days);

    r = await req('GET', '/rm/deferred', { token });
    const listed = (Array.isArray(r.body) ? r.body : []).filter((d) => d.staffId === a || d.staff?.id === a);
    check('deferred list shows the staff exactly once', listed.length === 1, listed.length);

    console.log('\n── Resume goes back to where the staff left, never past it');
    const b = await makeStaff(db, rm.id, 'S2_5_ASSESS', 'B');
    created.push(b);
    r = await req('POST', `/rm/pipeline/${b}/advance`, { token, body: { to_stage: 'DEFERRED', payload: { deferred_reason: 'PERSONAL_PAUSE' } } });
    check('defer from S2.5 → 2xx', r.status < 300, r);
    r = await req('POST', `/rm/deferred/${b}/resume`, { token, body: { to_stage: 'S3_TRAIN' } });
    check('resume past the deferred-from stage (S2.5 → S3) → 400', r.status === 400, r);
    ({ rows: [st] } = await db.query(`SELECT pipeline_stage FROM staff_applicants WHERE id = $1`, [b]));
    check('still DEFERRED after refused resume', st.pipeline_stage === 'DEFERRED', st);

    r = await req('POST', `/rm/deferred/${b}/resume`, { token, body: {} });
    check('resume with no stage → 2xx, lands on S2_5_ASSESS', r.status < 300 && r.body?.to_stage === 'S2_5_ASSESS', r);
    ({ rows: [st] } = await db.query(`SELECT pipeline_stage FROM staff_applicants WHERE id = $1`, [b]));
    check('stage is S2_5_ASSESS', st.pipeline_stage === 'S2_5_ASSESS', st);
    const { rows: [closed] } = await db.query(`SELECT resume_at FROM deferred_records WHERE staff_id = $1`, [b]);
    check('deferred record closed (resume_at set)', !!closed?.resume_at, closed);

    console.log('\n── TERMINAL needs an outcome');
    r = await req('POST', `/rm/pipeline/${b}/advance`, { token, body: { to_stage: 'TERMINAL' } });
    check('terminal without outcome → 400', r.status === 400, r.status);
    r = await req('POST', `/rm/pipeline/${b}/advance`, { token, body: { to_stage: 'TERMINAL', terminal_outcome: 'ABANDONED' } });
    check('terminal with outcome → 2xx', r.status < 300, r);
    ({ rows: [st] } = await db.query(`SELECT pipeline_stage, terminal_outcome::text FROM staff_applicants WHERE id = $1`, [b]));
    check('stage TERMINAL, outcome ABANDONED', st.pipeline_stage === 'TERMINAL' && st.terminal_outcome === 'ABANDONED', st);

    console.log('\n── 90-day timeout cron');
    await db.query(`UPDATE deferred_records SET timeout_at = NOW() - INTERVAL '1 day' WHERE staff_id = $1`, [a]);
    process.env.DISABLE_SCHEDULER = 'true';
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../dist/app.module');
    const { EnterpriseCronService } = require('../dist/modules/cron/enterprise-cron.service');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await app.get(EnterpriseCronService).deferredTimeoutCheck();
    } finally {
      await app.close();
    }
    ({ rows: [st] } = await db.query(`SELECT pipeline_stage, terminal_outcome::text FROM staff_applicants WHERE id = $1`, [a]));
    check('timed-out staff → TERMINAL / DEFERRED', st.pipeline_stage === 'TERMINAL' && st.terminal_outcome === 'DEFERRED', st);
    const { rows: ev } = await db.query(`SELECT 1 FROM pipeline_events WHERE staff_id = $1 AND event_type = 'DEFERRED_TIMEOUT'`, [a]);
    check('timeout event logged', ev.length === 1, ev.length);
    const { rows: [rec] } = await db.query(`SELECT resume_at FROM deferred_records WHERE staff_id = $1`, [a]);
    check('timed-out record closed', !!rec?.resume_at, rec);
  } finally {
    // pipeline_events is append-only at the database level, so a staff with
    // events can't be deleted — soft-delete instead, which every list skips.
    for (const id of created) {
      await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = $1`, [id])
        .catch((e) => console.log(`  (cleanup staff: ${e.message})`));
    }
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
