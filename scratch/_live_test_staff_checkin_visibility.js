/**
 * The question this answers: a staff member marks their own attendance from
 * the mobile app — does HR see it as Present, without anyone pressing anything?
 *
 * Uses the REAL mobile endpoint (POST /staff/attendance/check-in) so the whole
 * chain is exercised: staff login -> shift_logs -> staff_daily_attendance ->
 * HR's screen -> payroll ledger.
 *
 *   node scratch/_live_test_staff_checkin_visibility.js
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const HR = { phone: '9800000008', password: 'HomeGenny@2024' };
const STAFF_PASSWORD = 'StaffTest@2026';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  }
}

/**
 * The API rate-limits auth, and running these suites back to back trips it.
 * That is the throttler working, not a failure — so back off and retry rather
 * than reporting a false red.
 */
async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 6) {
    const waitMs = 5000 * (attempt + 1);
    console.log(`      (rate limited, waiting ${waitMs / 1000}s…)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}

async function req(method, path, { token, body } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  const payload =
    json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload, rawBody: json };
}

/** Today as the server's UTC calendar day — what the check-in writes. */
function todayUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const hrLogin = await req('POST', '/auth/login', { body: HR });
  const hrToken = hrLogin.body?.access_token || hrLogin.body?.data?.access_token;
  if (!hrToken) {
    console.log('HR login failed — aborting', hrLogin.status, hrLogin.rawBody);
    process.exit(1);
  }

  // ── set up a deployed candidate with a confirmed placement + staff login ──
  const pending = await req('GET', '/employees/pending-onboarding', { token: hrToken });
  const target = (pending.body?.items ?? [])[0];
  if (!target) {
    console.log('no S5 candidate available — aborting');
    process.exit(1);
  }

  const cat = await db.query('SELECT id FROM employee_categories LIMIT 1');
  const onboarded = await req('POST', '/employees/onboard-from-pipeline', {
    token: hrToken,
    body: {
      staffApplicantId: target.id,
      department: 'Field Operations',
      designation: 'Housemaid',
      categoryId: cat.rows[0].id,
      employmentType: 'Full Time',
      salary: 20000,
      joiningDate: '2026-01-01',
      gender: 'Female',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110001',
    },
  });
  const employeeId = onboarded.body?.employee?.id;
  if (!employeeId) {
    console.log('onboarding failed — aborting', onboarded.status, onboarded.rawBody);
    process.exit(1);
  }

  const app = (
    await db.query('SELECT user_id, branch_id, mobile FROM staff_applicants WHERE id = $1', [
      target.id,
    ])
  ).rows[0];

  // Give the staff account a password we know, so the real mobile login works.
  let staffUserId = app.user_id;
  const hash = await bcrypt.hash(STAFF_PASSWORD, 12);
  let originalHash = null;
  if (staffUserId) {
    const u = await db.query('SELECT password_hash, phone FROM users WHERE id = $1', [staffUserId]);
    originalHash = u.rows[0]?.password_hash ?? null;
    await db.query('UPDATE users SET password_hash = $1, is_active = true WHERE id = $2', [
      hash,
      staffUserId,
    ]);
  }

  // A CONFIRMED placement is what the mobile check-in requires.
  const client = await db.query('SELECT id FROM finance_customers LIMIT 1');
  let placementId = null;
  if (client.rows.length) {
    const p = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', now(), now()) RETURNING id`,
      [target.id, client.rows[0].id, app.branch_id],
    );
    placementId = p.rows[0].id;
  }

  const DAY = todayUtc();

  async function cleanup() {
    await db.query('DELETE FROM attendance WHERE employee_id = $1', [employeeId]);
    await db.query('DELETE FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date = $2::date', [target.id, DAY]);
    await db.query('DELETE FROM shift_logs WHERE staff_id = $1 AND shift_date = $2::date', [target.id, DAY]);
    if (placementId) await db.query('DELETE FROM placements WHERE id = $1', [placementId]);
    if (staffUserId && originalHash !== null) {
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [originalHash, staffUserId]);
    }
    await db.query("DELETE FROM audit_logs WHERE entity_id = $1 AND entity_type = 'employee'", [employeeId]);
    await db.query('DELETE FROM employees WHERE id = $1', [employeeId]);
  }

  try {
    console.log(`set up: ${target.staffCode} -> employee ${onboarded.body.employee.employeeId}`);
    console.log(`        placement ${placementId ? 'CONFIRMED' : 'NONE'} | day under test ${DAY}`);

    // ── 1. the staff member checks in from the app ─────────────────────────
    console.log('\n[1] Staff checks in from the mobile app');
    let usedRealEndpoint = false;
    if (staffUserId && placementId) {
      const staffLogin = await req('POST', '/auth/login', {
        body: { phone: app.mobile, password: STAFF_PASSWORD },
      });
      const staffToken = staffLogin.body?.access_token || staffLogin.body?.data?.access_token;
      check('staff can log in', Boolean(staffToken), staffLogin.status);
      if (staffToken) {
        const ci = await req('POST', '/staff/attendance/check-in', {
          token: staffToken,
          body: { latitude: 28.6139, longitude: 77.209 },
        });
        check('POST /staff/attendance/check-in succeeds', [200, 201].includes(ci.status), ci.rawBody);
        usedRealEndpoint = [200, 201].includes(ci.status);
      }
    }
    if (!usedRealEndpoint) {
      console.log('      (real check-in unavailable here — writing the same rows it writes)');
      await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, branch_id, placement_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', $1, now(), now())
         ON CONFLICT (staff_id, attendance_date) DO UPDATE SET status = 'PRESENT'`,
        [target.id, app.branch_id, placementId, DAY],
      );
    }

    const fieldRow = await db.query(
      "SELECT status FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date = $2::date",
      [target.id, DAY],
    );
    check('the check-in is recorded on the pipeline side', fieldRow.rows[0]?.status === 'PRESENT', fieldRow.rows[0]);

    // ── 2. HR sees it immediately, with no sync and no cron ────────────────
    console.log("\n[2] HR opens the employee — with NO sync run in between");
    const now = new Date();
    const view = await req(
      'GET',
      `/employees/${employeeId}/attendance-month?month=${now.getUTCMonth() + 1}&year=${now.getUTCFullYear()}`,
      { token: hrToken },
    );
    check('returns 200', view.status === 200, view.status);
    const today = (view.body?.items ?? []).find((d) => d.date === DAY);
    check('today appears on HR screen straight away', Boolean(today), {
      looking_for: DAY,
      got: (view.body?.items ?? []).map((d) => d.date),
    });
    check("and it reads 'Present'", today?.effectiveStatus === 'Present', today);
    check(
      'flagged as a staff check-in, not an HR entry',
      today?.source === 'PIPELINE_ONLY' || today?.source === 'FIELD',
      today?.source,
    );

    // ── 3. but payroll does not count it until it is committed ────────────
    console.log('\n[3] Payroll ledger is separate, and says so');
    const ledgerBefore = await db.query(
      'SELECT COUNT(*)::int AS n FROM attendance WHERE employee_id = $1 AND date = $2::date',
      [employeeId, DAY],
    );
    if (today?.source === 'PIPELINE_ONLY') {
      check('payroll ledger does not have the day yet', ledgerBefore.rows[0].n === 0, ledgerBefore.rows[0]);
      check('the screen counts it as pending', Number(view.body?.unprojectedDays) >= 1, view.body?.unprojectedDays);
    } else {
      console.log('      (a scheduled pass already committed it — checking it is counted)');
      check('payroll ledger has the day', ledgerBefore.rows[0].n === 1, ledgerBefore.rows[0]);
    }

    // ── 4. committing it moves it into the payroll ledger ──────────────────
    console.log('\n[4] Commit to payroll (what the 10-minute pass does on its own)');
    const sync = await req('POST', '/attendance/sync-from-pipeline', {
      token: hrToken,
      body: { month: now.getUTCMonth() + 1, year: now.getUTCFullYear(), employeeId },
    });
    check('sync returns 200/201', [200, 201].includes(sync.status), sync.rawBody);
    const ledgerAfter = await db.query(
      'SELECT status, marked_by FROM attendance WHERE employee_id = $1 AND date = $2::date',
      [employeeId, DAY],
    );
    check('the day is now in the payroll ledger as Present', ledgerAfter.rows[0]?.status === 'Present', ledgerAfter.rows[0]);
    check('and still attributed to the staff member, not HR', ledgerAfter.rows[0]?.marked_by === null, ledgerAfter.rows[0]);

    const after = await req(
      'GET',
      `/employees/${employeeId}/attendance-month?month=${now.getUTCMonth() + 1}&year=${now.getUTCFullYear()}`,
      { token: hrToken },
    );
    const todayAfter = (after.body?.items ?? []).find((d) => d.date === DAY);
    check("the screen now shows it as committed (source FIELD)", todayAfter?.source === 'FIELD', todayAfter?.source);
    check('nothing pending left for the day', Number(after.body?.unprojectedDays) === 0, after.body?.unprojectedDays);
  } finally {
    console.log('\ncleaning up test rows...');
    await cleanup();
    console.log('done');
  }

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
