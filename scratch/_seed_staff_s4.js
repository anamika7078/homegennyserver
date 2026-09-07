/**
 * One staff member with the pipeline complete through S4.
 *
 * They are walked through the real API — intake, then every stage transition —
 * so the FSM guards actually run and the immutable event log is written by the
 * application, not by this script. If a gate would refuse them in real use, it
 * refuses them here too.
 *
 * Three things are written directly, because they record work that happens
 * outside the system and whose APIs need a live provider or a real upload:
 * the Aadhaar eKYC result, the reviewed video prompts, and the signed
 * agreement. Everything else is the application's own doing.
 *
 * They stop at S4_AGREEMENTS with a signed agreement on file — S4 done, and
 * the next move (S5_DEPLOY) left for you to press, so you can watch the
 * deployment gate pass on real data.
 *
 *   node scratch/_seed_staff_s4.js --name Anupriya
 *   node scratch/_seed_staff_s4.js --name Anupriya --mobile 9811100778 --series SC
 *   node scratch/_seed_staff_s4.js --name Anupriya --clean
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const NAME = arg('--name', 'Anamika');
const SERIES = arg('--series', 'MAID').toUpperCase();
const BRANCH = arg('--branch', '00000000-0000-0000-0000-000000000001');   // Delhi NCR HQ

// A phone and an Aadhaar unique to this name, so two fixtures never collide on
// `users.phone` (UNIQUE) or on the restricted-list hash.
const seed = [...NAME.toLowerCase()].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 900000, 7);
const MOBILE = arg('--mobile', `98${String(100000 + (seed % 899999)).padStart(8, '0')}`.slice(0, 10));
const AADHAAR = String(400000000000 + seed * 977).slice(0, 12);

// Deposit by series — not derived server-side, so send the right one.
const DEPOSIT = { DR: 2000, SC: 1500, UC: 1000, MAID: 500 }[SERIES] ?? 500;

// Pillar 5 — how many RM-approved prompts each series needs, matching
// REQUIRED_VIDEO_PROMPTS in pipeline-fsm.service.ts.
const PROMPT_COUNT = { MAID: 9, SC: 10, UC: 10, DR: 12 }[SERIES] ?? 9;
const VIDEO_PROMPTS = [
  'INTRO', 'ID_PROOF', 'ADDRESS_CONFIRM', 'COOKING_BASIC', 'CLEANING_BASIC',
  'CHILD_SAFETY', 'EMERGENCY_RESPONSE', 'HYGIENE', 'CONDUCT_PLEDGE',
  'SAFETY_DRILL', 'EQUIPMENT_USE', 'ROAD_RULES',
].slice(0, PROMPT_COUNT);

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  const payload =
    json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}

async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.status === 200 || r.status === 201) {
      const t = r.body?.access_token || r.body?.accessToken;
      if (t) return t;
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

async function clean(c) {
  const sel = `(SELECT id FROM staff_applicants WHERE mobile = '${MOBILE}')`;
  await c.query('BEGIN');
  await c.query('DROP TRIGGER IF EXISTS prevent_update_delete_pipeline_events ON pipeline_events');
  await c.query('DROP TRIGGER IF EXISTS check_pipeline_events_append_only ON pipeline_events');
  for (const t of ['agreements', 'video_certifications', 'verification_tracks',
    'deposits', 'scenario_logs', 'pipeline_events']) {
    await c.query(`DELETE FROM ${t} WHERE staff_id IN ${sel}`).catch(() => {});
  }
  await c.query(`DELETE FROM staff_applicants WHERE mobile = $1`, [MOBILE]);
  await c.query(`DELETE FROM users WHERE phone = $1`, [MOBILE]);
  await c.query(`
    CREATE TRIGGER prevent_update_delete_pipeline_events
      BEFORE DELETE OR UPDATE ON public.pipeline_events
      FOR EACH ROW EXECUTE FUNCTION prevent_update_delete()`);
  await c.query(`
    CREATE TRIGGER check_pipeline_events_append_only
      BEFORE DELETE OR UPDATE ON public.pipeline_events
      FOR EACH ROW EXECUTE FUNCTION prevent_pipeline_events_mutation()`);
  await c.query('COMMIT');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname)) {
    console.error('\n  This seeds test data. Refusing to run against anything but localhost.\n');
    process.exit(1);
  }
  const c = new Client({ connectionString: url });
  await c.connect();

  try {
    if (process.argv.includes('--clean')) {
      await clean(c);
      console.log(`\n  ${NAME} hata di gayi.\n`);
      return;
    }

    // Start from nothing, so a re-run is not half a candidate.
    await clean(c);

    const token = await login(RM_PHONE);
    console.log(`  RM ${RM_PHONE} logged in`);

    // ── S1 → S2, through the real intake ─────────────────────────────────
    const intake = await req('POST', '/rm/intake', {
      token,
      body: {
        full_name: NAME,
        mobile: MOBILE,
        aadhaar_number: AADHAAR,
        date_of_birth: '1996-03-14',
        address: 'H-14, Sector 12, Dwarka, New Delhi 110078',
        email: `${NAME.toLowerCase()}.test@example.com`,
        series: SERIES,
        language_tier: 'T1',
        role_types: [SERIES],
        branch_id: BRANCH,
        deposit_amount: DEPOSIT,
        deposit_collected: true,
        referral_source: 'Walk-in',
        advance_to_verify: true,
      },
    });
    if (intake.status !== 200 && intake.status !== 201) {
      throw new Error(`intake failed (${intake.status}): ${JSON.stringify(intake.body)}`);
    }
    const staffId = intake.body?.id ?? intake.body?.staff?.id;
    const staffCode = intake.body?.staff_code ?? intake.body?.staff?.staff_code;
    console.log(`  S1_INTAKE   ${staffCode}  banaya, login bhi bana`);
    console.log(`  S2_VERIFY   intake ne khud aage badha diya`);

    // ── verification results, recorded as the outside world returns them ──
    // Aadhaar eKYC has to be CLEAR before S2 will let her out; for MAID a
    // police verification still in progress does not block her.
    await c.query(
      `INSERT INTO verification_tracks (id, staff_id, track_type, status, verified_at, notes, updated_at)
       VALUES (gen_random_uuid(), $1, 'AADHAAR_EKYC', 'CLEAR', now(), 'Seeded fixture', now())`,
      [staffId],
    );
    // Police verification: only MAID may deploy with it still running. Every
    // other series needs it CLEAR, so give them a clear one.
    const pv = SERIES === 'MAID' ? 'IN_PROGRESS' : 'CLEAR';
    await c.query(
      `INSERT INTO verification_tracks (id, staff_id, track_type, status, notes, updated_at)
       VALUES (gen_random_uuid(), $1, 'POLICE_VERIFICATION', $2, 'Seeded fixture', now())`,
      [staffId, pv],
    );
    await c.query(
      `UPDATE staff_applicants SET pv_status = $2 WHERE id = $1`, [staffId, pv],
    );
    console.log(
      `              Aadhaar eKYC CLEAR · PV ${pv}` +
        (SERIES === 'MAID' ? '  (MAID par rukavat nahi)' : ''),
    );

    // Pillar 3 — medical/sobriety, required for SC, UC and DR.
    if (['SC', 'UC', 'DR'].includes(SERIES)) {
      await c.query(
        `INSERT INTO verification_tracks (id, staff_id, track_type, status, verified_at, notes, updated_at)
         VALUES (gen_random_uuid(), $1, 'HEALTH_SCREENING', 'CLEAR', now(), 'Seeded fixture', now())`,
        [staffId],
      );
      console.log(`              health screening CLEAR (${SERIES} ke liye zaroori)`);
    }

    // A driver also needs their licence and challan record checked.
    if (SERIES === 'DR') {
      for (const t of ['SARATHI_API', 'ECHALLAN_API']) {
        await c.query(
          `INSERT INTO verification_tracks (id, staff_id, track_type, status, verified_at, notes, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'CLEAR', now(), 'Seeded fixture', now())`,
          [staffId, t],
        );
      }
      console.log(`              licence + eChallan CLEAR`);
    }

    // ── S2 → S2.5 → S3, each through the FSM ─────────────────────────────
    for (const [to, why] of [
      ['S2_5_ASSESS', 'VERIFICATION_CLEAR'],
      ['S3_TRAIN', 'ASSESSMENT_PASSED'],
    ]) {
      const r = await req('POST', `/rm/pipeline/${staffId}/advance`, {
        token, body: { to_stage: to, reason_code: why },
      });
      if (r.status !== 200 && r.status !== 201) {
        throw new Error(`${to} refused (${r.status}): ${JSON.stringify(r.body)}`);
      }
      console.log(`  ${to.padEnd(12)}${why}`);
    }

    // ── Pillar 5: the nine prompts, reviewed and approved ────────────────
    for (let i = 0; i < VIDEO_PROMPTS.length; i++) {
      await c.query(
        `INSERT INTO video_certifications
           (id, staff_id, prompt_key, video_url, sha256_hash, review_status, review_notes)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'APPROVED', 'Seeded fixture')`,
        [
          staffId,
          VIDEO_PROMPTS[i],
          `https://fixture.local/anamika/${VIDEO_PROMPTS[i].toLowerCase()}.mp4`,
          require('crypto').createHash('sha256').update(`anamika-${VIDEO_PROMPTS[i]}`).digest('hex'),
        ],
      );
    }
    console.log(`              ${VIDEO_PROMPTS.length}/${PROMPT_COUNT} video prompts RM-approved`);

    // ── S3 → S4 ──────────────────────────────────────────────────────────
    const s4 = await req('POST', `/rm/pipeline/${staffId}/advance`, {
      token, body: { to_stage: 'S4_AGREEMENTS', reason_code: 'TRAINING_COMPLETE' },
    });
    if (s4.status !== 200 && s4.status !== 201) {
      throw new Error(`S4_AGREEMENTS refused (${s4.status}): ${JSON.stringify(s4.body)}`);
    }
    console.log(`  S4_AGREEMENTS TRAINING_COMPLETE`);

    // ── S4's own work: the agreement, signed ─────────────────────────────
    await c.query(
      `INSERT INTO agreements (id, staff_id, type, status, signatures, otp_verified, metadata, updated_at)
       VALUES (gen_random_uuid(), $1, 'STAFF_ENGAGEMENT', 'SIGNED',
               $2::jsonb, true, '{"seeded":true}'::jsonb, now())`,
      [staffId, JSON.stringify([{ party: 'STAFF', name: NAME, signed_at: new Date().toISOString() }])],
    );
    console.log(`              engagement agreement SIGNED`);

    // --deploy walks the last hop too, through the same gate. Useful for
    // anything that needs a deployed candidate HR has not onboarded yet.
    if (process.argv.includes('--deploy')) {
      const s5 = await req('POST', `/rm/pipeline/${staffId}/advance`, {
        token, body: { to_stage: 'S5_DEPLOY', reason_code: 'AGREEMENT_SIGNED' },
      });
      if (s5.status !== 200 && s5.status !== 201) {
        throw new Error(`S5_DEPLOY refused (${s5.status}): ${JSON.stringify(s5.body)}`);
      }
      console.log(`  S5_DEPLOY     AGREEMENT_SIGNED  — gate paas`);
    }

    // --place <unit_code> puts them to work at a client. Without a placement a
    // staff member has no client, so attendance has nowhere to belong and
    // nothing mirrors into the pipeline ledger payroll counts.
    const placeAt = arg('--place', null);
    if (placeAt) {
      const cust = await c.query(
        `SELECT id, customer_name FROM finance_customers WHERE UPPER(unit_code) = UPPER($1)`,
        [placeAt],
      );
      if (!cust.rows.length) throw new Error(`No client with unit code "${placeAt}".`);
      const hourly = SERIES === 'MAID' && process.argv.includes('--hourly');
      const branchRow = await c.query(`SELECT branch_id FROM staff_applicants WHERE id = $1`, [staffId]);
      await c.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                                 staff_salary, management_fee, hourly_rate, hourly_fee,
                                 shift_hours, trial_start_date, confirmed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', $4,
                 $5, $6, $7, $8, 8, CURRENT_DATE, now(), now(), now())`,
        [
          staffId, cust.rows[0].id, branchRow.rows[0].branch_id,
          hourly ? 'TEMPORARY' : 'PERMANENT',
          hourly ? null : 18000, hourly ? null : 2000,
          hourly ? 150 : null, hourly ? 30 : null,
        ],
      );
      console.log(
        `              ${cust.rows[0].customer_name} par placed` +
          (hourly ? ' — Rs.150/ghanta' : ' — Rs.18,000/mahina'),
      );
    }

    // ── does the S5 gate actually pass? Say so rather than assume ────────
    const blockers = [];
    const aad = await c.query(
      `SELECT status FROM verification_tracks WHERE staff_id = $1 AND track_type = 'AADHAAR_EKYC'`, [staffId]);
    if (aad.rows[0]?.status !== 'CLEAR') blockers.push('Aadhaar eKYC not CLEAR');
    const vid = await c.query(
      `SELECT COUNT(DISTINCT prompt_key)::int n FROM video_certifications
        WHERE staff_id = $1 AND review_status = 'APPROVED'`, [staffId]);
    if (vid.rows[0].n < PROMPT_COUNT) blockers.push(`video ${vid.rows[0].n}/${PROMPT_COUNT}`);
    const agr = await c.query(
      `SELECT COUNT(*)::int n FROM agreements WHERE staff_id = $1 AND status = 'SIGNED'`, [staffId]);
    if (!agr.rows[0].n) blockers.push('no signed agreement');
    const pvNow = await c.query(`SELECT pv_status::text s FROM staff_applicants WHERE id = $1`, [staffId]);
    if (pvNow.rows[0].s === 'ADVERSE') blockers.push('PV adverse');
    if (SERIES !== 'MAID' && pvNow.rows[0].s !== 'CLEAR') {
      blockers.push(`PV ${pvNow.rows[0].s} — ${SERIES} needs CLEAR`);
    }

    const stage = await c.query(
      `SELECT pipeline_stage::text s, staff_code FROM staff_applicants WHERE id = $1`, [staffId]);
    const events = await c.query(
      `SELECT COUNT(*)::int n FROM pipeline_events WHERE staff_id = $1`, [staffId]);

    console.log(`\n  ${NAME}  ·  ${stage.rows[0].staff_code}  ·  ${MOBILE}`);
    console.log(`  stage            : ${stage.rows[0].s}   (S1–S4 poore)`);
    console.log(`  pipeline events  : ${events.rows[0].n}  (application ne khud likhe)`);
    console.log(`  S5 ka darwaza    : ${blockers.length ? 'BAND — ' + blockers.join('; ') : 'KHULA — deploy ho sakti hai'}`);
    console.log(`  login            : ${MOBILE} / HomeGenny@2024  (pehli baar par password badalna hoga)\n`);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
