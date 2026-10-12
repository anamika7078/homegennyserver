/**
 * Live HTTP test for Phase A (2026-10-12) — docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md:
 *
 *  - GET /meta/series: UC, SC, CK active; MAID, DR paused; Stage 2.5 off. Public.
 *  - A new MAID / DRIVER is refused at intake, with the "not taken on" message.
 *  - A new UC goes through intake fine.
 *  - A new COOK is filed as COOK (series_db) and shows as CK —
 *    not quietly turned into SKILLED_CARE, which the old mapper fallback did.
 *    Skipped (not failed) when the DB enum has no COOK yet — that needs
 *    scratch/_cook_series_migration.js run as the type's owner.
 *  - An unknown series is refused, not guessed.
 *  - S2 → S2_5 is refused; S2 → S3 still works.
 *  - A staff already sitting in S2_5 can still leave it.
 *  - Holding S2_5 is refused for a staff who never went there.
 *  - The RM kanban has no S2_5 column while nobody is in it.
 *  - An existing MAID still loads.
 *
 *   node scratch/_live_test_series_phase_a.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM = { phone: '9800000002', passwords: ['hg', 'HomeGenny@2024', 'Password@123'] };
const BRANCH = '00000000-0000-0000-0000-000000000001';

let pass = 0;
let fail = 0;
let skip = 0;
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

const uniqPhone = () => '6' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);

function intakeBody(series, tag) {
  return {
    full_name: `Phase A ${tag}`,
    date_of_birth: '1992-05-05',
    mobile: uniqPhone(),
    aadhaar_number: String(Date.now()).slice(-12).padStart(12, '4'),
    address: 'Test address, Delhi',
    series,
    language_tier: 'T2',
  };
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const created = [];
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM.phone]);
    const token = await login();

    console.log('\n/meta/series');
    const meta = await req('GET', '/meta/series'); // no token: it must be public
    check('public, 200', meta.status === 200, meta.status);
    const active = (meta.body?.series ?? []).filter((s) => s.active).map((s) => s.value).sort();
    check('active = COOK, SKILLED_CARE, UNSKILLED_CARE', JSON.stringify(active) === JSON.stringify(['COOK', 'SKILLED_CARE', 'UNSKILLED_CARE']), active);
    const all = (meta.body?.series ?? []).map((s) => s.value);
    check('MAID and DRIVER still listed (paused)', all.includes('MAID') && all.includes('DRIVER'), all);
    check('COOK short code is CK', meta.body?.series?.find((s) => s.value === 'COOK')?.short === 'CK');
    check('stage_2_5_enabled = false', meta.body?.stage_2_5_enabled === false, meta.body?.stage_2_5_enabled);

    console.log('\nIntake');
    for (const s of ['MAID', 'DRIVER', 'DR', 'M3X']) {
      const r = await req('POST', '/rm/intake', { token, body: intakeBody(s, s) });
      check(`${s} refused (400)`, r.status === 400, { status: r.status, msg: msg(r) });
      check(`${s} message says not taken on`, /not being taken on/i.test(msg(r)), msg(r));
    }
    const bogus = await req('POST', '/rm/intake', { token, body: intakeBody('PLUMBER', 'bogus') });
    check('unknown series refused (400), not guessed', bogus.status === 400 && /unknown series/i.test(msg(bogus)), { status: bogus.status, msg: msg(bogus) });
    const missing = { ...intakeBody('UC', 'missing') }; delete missing.series;
    const noSeries = await req('POST', '/rm/intake', { token, body: missing });
    check('missing series refused (400)', noSeries.status === 400, { status: noSeries.status, msg: msg(noSeries) });

    // Self-registration from the app is a separate door into the same table.
    const regPhone = uniqPhone();
    const reg = await req('POST', '/auth/register/staff', {
      body: {
        full_name: 'Phase A Self Reg', phone: regPhone, series: 'MAID', password: 'Str0ng@Pass1',
        date_of_birth: '1992-05-05', gender: 'FEMALE', address: 'Test address, Delhi',
        city: 'Delhi', state: 'Delhi', pincode: '110001',
      },
    });
    check('self-registration as MAID refused (400)', reg.status === 400 && /not being taken on/i.test(msg(reg)), { status: reg.status, msg: msg(reg) });
    const { rows: [{ c: regUsers }] } = await db.query(`SELECT count(*)::int c FROM users WHERE phone = $1`, [regPhone]);
    check('…and no login account was left behind', regUsers === 0, regUsers);

    const uc = await req('POST', '/rm/intake', { token, body: intakeBody('UNSKILLED_CARE', 'uc') });
    const ucId = uc.body?.id ?? uc.body?.staff?.id;
    check('UNSKILLED_CARE accepted', [200, 201].includes(uc.status) && !!ucId, { status: uc.status, msg: msg(uc) });
    if (ucId) created.push(ucId);

    const { rows: [{ v: enumVals }] } = await db.query(`SELECT enum_range(NULL::staff_applicants_series_enum)::text AS v`);
    if (!enumVals.includes('COOK')) {
      skip++;
      console.log('  SKIP  COOK intake — DB enum has no COOK yet (run scratch/_cook_series_migration.js as the type owner)');
    } else {
      for (const code of ['COOK', 'CK']) {
        const ck = await req('POST', '/rm/intake', { token, body: intakeBody(code, `ck-${code}`) });
        const ckId = ck.body?.id ?? ck.body?.staff?.id;
        check(`${code} accepted`, [200, 201].includes(ck.status) && !!ckId, { status: ck.status, msg: msg(ck) });
        if (!ckId) continue;
        created.push(ckId);
        const { rows: [row] } = await db.query(`SELECT series::text, staff_code FROM staff_applicants WHERE id = $1`, [ckId]);
        check(`${code} stored as COOK (not SKILLED_CARE)`, row.series === 'COOK', row.series);
        // RM intake names staff codes after the person (e.g. asha001) for every series, so
        // the only thing to rule out is a code that still claims the old SC fallback.
        check(`${code} staff code is not an SC code`, !/^HG-SC-/.test(row.staff_code), row.staff_code);
        const got = await req('GET', `/staff/${ckId}`, { token });
        const dto = got.body?.staff ?? got.body;
        check(`${code} API shows series CK / series_db COOK`, dto?.series === 'CK' && dto?.series_db === 'COOK', { series: dto?.series, series_db: dto?.series_db });
      }
      const prompts = await req('GET', '/video-cert/prompts/CK', { token });
      check('CK has 9 video prompts', (prompts.body?.prompts ?? prompts.body?.data?.prompts ?? []).length === 9, prompts.body);
    }

    console.log('\nStage 2.5');
    // A UC in S2_VERIFY, put there directly so this tests the S2 exit, not S2's own checks.
    const { rows: [s2] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
         pipeline_stage, assigned_rm_id, branch_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'UNSKILLED_CARE', 'Phase A S2', '1990-01-01', $2, 'Test', 'S2_VERIFY', $3, $4, NOW())
       RETURNING id`,
      [`ZA-S2-${Date.now() % 100000}`, uniqPhone(), rm.id, BRANCH],
    );
    created.push(s2.id);
    const to25 = await req('POST', `/rm/pipeline/${s2.id}/advance`, { token, body: { to_stage: 'S2_5_ASSESS' } });
    check('S2 → S2_5 refused (400)', to25.status === 400, { status: to25.status, msg: msg(to25) });
    check('…saying Stage 2.5 is switched off', /switched off/i.test(msg(to25)), msg(to25));
    const hold25 = await req('POST', `/rm/pipeline/${s2.id}/hold`, { token, body: { stage: 'S2_5_ASSESS', reason: 'OTHER' } });
    check('hold on S2_5 refused for a staff who never went there', hold25.status === 400, { status: hold25.status, msg: msg(hold25) });

    // S2 → S3 uses the S2 identity gate; mark S2 COMPLETE so this checks routing, not verification.
    await req('POST', `/rm/pipeline/${s2.id}/complete`, { token, body: { stage: 'S2_VERIFY', reason: 'RM_CONFIRMED_MANUALLY' } });
    const to3 = await req('POST', `/rm/pipeline/${s2.id}/advance`, { token, body: { to_stage: 'S3_TRAIN' } });
    check('S2 → S3 still works', [200, 201].includes(to3.status), { status: to3.status, msg: msg(to3) });

    // A Driver already in S2_5 must still be able to leave it.
    const { rows: [in25] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
         pipeline_stage, assigned_rm_id, branch_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'DRIVER', 'Phase A in S2.5', '1990-01-01', $2, 'Test', 'S2_5_ASSESS', $3, $4, NOW())
       RETURNING id`,
      [`ZA-25-${Date.now() % 100000}`, uniqPhone(), rm.id, BRANCH],
    );
    created.push(in25.id);
    const kanbanWith = await req('GET', '/rm/kanban', { token });
    check('kanban keeps S2_5 column while someone is in it', 'S2_5_ASSESS' in (kanbanWith.body?.columns ?? {}), Object.keys(kanbanWith.body?.columns ?? {}));
    const out25 = await req('POST', `/rm/pipeline/${in25.id}/advance`, {
      token, body: { to_stage: 'DEFERRED', payload: { deferred_reason: 'PERSONAL_PAUSE', notes: 'phase A test' } },
    });
    check('staff already in S2_5 can still leave it (→ DEFERRED)', [200, 201].includes(out25.status), { status: out25.status, msg: msg(out25) });
    // Deferred FROM S2_5: a resume can't go past that stage, so it must be allowed back in.
    const resume25 = await req('POST', `/rm/deferred/${in25.id}/resume`, { token, body: {} });
    const { rows: [after25] } = await db.query(`SELECT pipeline_stage::text s FROM staff_applicants WHERE id = $1`, [in25.id]);
    check('staff deferred FROM S2_5 can resume back into it', [200, 201].includes(resume25.status) && after25.s === 'S2_5_ASSESS', { status: resume25.status, stage: after25.s, msg: msg(resume25) });
    const leave25 = await req('POST', `/rm/pipeline/${in25.id}/advance`, {
      token, body: { to_stage: 'TERMINAL', terminal_outcome: 'ABANDONED' },
    });
    check('…and leave it again (→ TERMINAL)', [200, 201].includes(leave25.status), { status: leave25.status, msg: msg(leave25) });

    // Deferred from somewhere else: no way into S2_5.
    await req('POST', `/rm/pipeline/${s2.id}/advance`, {
      token, body: { to_stage: 'DEFERRED', payload: { deferred_reason: 'PERSONAL_PAUSE', notes: 'phase A test' } },
    });
    const sneak25 = await req('POST', `/rm/pipeline/${s2.id}/advance`, { token, body: { to_stage: 'S2_5_ASSESS' } });
    check('staff deferred from S3 cannot resume into S2_5', sneak25.status === 400 && /switched off/i.test(msg(sneak25)), { status: sneak25.status, msg: msg(sneak25) });

    const { rows: [{ n }] } = await db.query(`SELECT count(*)::int n FROM staff_applicants WHERE pipeline_stage = 'S2_5_ASSESS' AND deleted_at IS NULL`);
    if (n === 0) {
      const kanban = await req('GET', '/rm/kanban', { token });
      check('kanban has no S2_5 column when nobody is in it', !('S2_5_ASSESS' in (kanban.body?.columns ?? {})), Object.keys(kanban.body?.columns ?? {}));
    } else {
      skip++;
      console.log(`  SKIP  empty-S2_5 kanban check — ${n} other staff still in S2_5`);
    }

    console.log('\nExisting MAID staff');
    const { rows: [maid] } = await db.query(`SELECT id FROM staff_applicants WHERE series = 'MAID' AND deleted_at IS NULL LIMIT 1`);
    if (maid) {
      const m = await req('GET', `/staff/${maid.id}`, { token });
      const dto = m.body?.staff ?? m.body;
      check('existing MAID still loads', m.status === 200 && dto?.series_db === 'MAID', { status: m.status, series_db: dto?.series_db });
      const k = await req('GET', '/rm/kanban?series=MAID', { token });
      check('kanban can still filter by MAID', k.status === 200, k.status);
    } else {
      skip++;
      console.log('  SKIP  no MAID staff in this DB');
    }
  } finally {
    // Soft delete, like the other live tests — pipeline_events are append-only.
    if (created.length) {
      await db.query(`DELETE FROM stage_holds WHERE staff_id = ANY($1::uuid[])`, [created]).catch(() => {});
      await db.query(`DELETE FROM verification_tracks WHERE staff_id = ANY($1::uuid[])`, [created]).catch(() => {});
      await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = ANY($1::uuid[])`, [created])
        .catch((e) => console.log('  cleanup:', e.message));
    }
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
