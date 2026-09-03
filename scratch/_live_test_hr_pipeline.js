/**
 * Live HTTP test for the S5 -> employee handover and HR-marked attendance.
 * Hits the running API, then verifies what actually landed in Postgres.
 *
 *   node scratch/_live_test_hr_pipeline.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const HR_PHONE = '9800000008';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123', 'hr@1234'];

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + JSON.stringify(detail) : ''}`);
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
    /* empty body */
  }
  // A global interceptor wraps every success payload as { success, data }.
  // Unwrap so assertions read the handler's own return value.
  const payload =
    json && typeof json === 'object' && json.success === true && 'data' in json
      ? json.data
      : json;
  return { status: res.status, body: payload, raw: json };
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // ── login ────────────────────────────────────────────────────────────────
  let token = null;
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone: HR_PHONE, password } });
    if (r.status === 200 || r.status === 201) {
      token =
        r.body?.access_token ||
        r.body?.data?.access_token ||
        r.body?.accessToken ||
        r.body?.data?.accessToken;
      if (token) {
        console.log(`logged in as HR (${HR_PHONE})`);
        break;
      }
      console.log('login 200 but no token in:', Object.keys(r.body || {}), r.body);
    }
  }
  if (!token) {
    console.log('could not log in as HR — aborting');
    process.exit(1);
  }

  // ── 1. pending onboarding worklist ───────────────────────────────────────
  console.log('\n[1] GET /employees/pending-onboarding');
  const pending = await req('GET', '/employees/pending-onboarding', { token });
  check('returns 200', pending.status === 200, pending);
  const items = pending.body?.items ?? [];
  check('lists S5 candidates without an employee record', items.length > 0, {
    count: items.length,
  });
  const target = items.find((i) => i.staffCode === 'retest001') || items[0];
  console.log(`      target: ${target?.staffCode} (${target?.fullName})`);

  const dbBefore = await db.query(
    'SELECT user_id FROM staff_applicants WHERE id = $1',
    [target.id],
  );
  const applicantUserId = dbBefore.rows[0]?.user_id;

  // ── 2. onboard ───────────────────────────────────────────────────────────
  console.log('\n[2] POST /employees/onboard-from-pipeline');
  const cat = await db.query('SELECT id FROM employee_categories LIMIT 1');
  const onboard = await req('POST', '/employees/onboard-from-pipeline', {
    token,
    body: {
      staffApplicantId: target.id,
      department: 'Field Operations',
      designation: 'Housemaid',
      categoryId: cat.rows[0].id,
      employmentType: 'Full Time',
      // No salary. What a placed staff member is paid was settled by the RM on
      // the placement — per client, and per hour for a temporary one — so
      // asking HR for a second figure only creates one that disagrees with
      // what is actually billed. The server reads it off the placement.
      joiningDate: '2026-08-01',
      gender: 'Female',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110001',
    },
  });
  check('returns 200/201', [200, 201].includes(onboard.status), onboard);
  check('onboarding no longer demands a salary', onboard.status !== 400, onboard.body?.message);

  // It has to match the placement, not a number someone typed twice.
  const salaryRow = await db.query(
    `SELECT e.salary::float AS employee_salary,
            p.placement_type, p.staff_salary::float AS placement_salary
       FROM employees e
       LEFT JOIN placements p ON p.staff_id = e.staff_applicant_id
                             AND p.status IN ('CONFIRMED','TRIAL')
      WHERE e.staff_applicant_id = $1
      ORDER BY p.created_at DESC NULLS LAST
      LIMIT 1`,
    [target.id],
  );
  const sal = salaryRow.rows[0];
  if (sal?.placement_type === 'PERMANENT' && sal.placement_salary != null) {
    check('salary was read off the permanent placement',
      sal.employee_salary === sal.placement_salary, sal);
  } else {
    // Hourly, or not placed: no monthly figure exists, and zero is the honest
    // answer — their pay is computed from attendance.
    check('no monthly salary invented where none exists', sal?.employee_salary === 0, sal);
  }
  const employeeId = onboard.body?.employee?.id;
  check('employee created with a generated code', Boolean(onboard.body?.employee?.employeeId), {
    code: onboard.body?.employee?.employeeId,
  });
  console.log(`      warnings: ${JSON.stringify(onboard.body?.warnings)}`);

  const linkRow = await db.query(
    'SELECT id, employee_id, staff_applicant_id, user_id FROM employees WHERE id = $1',
    [employeeId],
  );
  check(
    'employees.staff_applicant_id is the FK to the pipeline row',
    linkRow.rows[0]?.staff_applicant_id === target.id,
    linkRow.rows[0],
  );
  if (applicantUserId) {
    check(
      'reused the candidate existing login instead of creating a second one',
      linkRow.rows[0]?.user_id === applicantUserId,
      { employeeUserId: linkRow.rows[0]?.user_id, applicantUserId },
    );
    const dupes = await db.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE phone = (SELECT mobile FROM staff_applicants WHERE id = $1)',
      [target.id],
    );
    check('exactly one users row for that phone', dupes.rows[0].n === 1, dupes.rows[0]);
  }

  // ── 3. duplicate onboarding is refused ───────────────────────────────────
  console.log('\n[3] POST onboard-from-pipeline again (same candidate)');
  const dup = await req('POST', '/employees/onboard-from-pipeline', {
    token,
    body: {
      staffApplicantId: target.id,
      department: 'X',
      designation: 'Y',
      categoryId: cat.rows[0].id,
      employmentType: 'Full Time',
      salary: 1,
      joiningDate: '2026-08-01',
      gender: 'Female',
    },
  });
  check('returns 409 Conflict', dup.status === 409, dup);

  // ── 4. a non-S5 candidate is refused ─────────────────────────────────────
  console.log('\n[4] POST onboard-from-pipeline for a candidate not at S5_DEPLOY');
  const early = await db.query(
    `SELECT id, staff_code, pipeline_stage FROM staff_applicants
      WHERE pipeline_stage <> 'S5_DEPLOY' AND deleted_at IS NULL LIMIT 1`,
  );
  if (early.rows.length) {
    const notS5 = await req('POST', '/employees/onboard-from-pipeline', {
      token,
      body: {
        staffApplicantId: early.rows[0].id,
        department: 'X',
        designation: 'Y',
        categoryId: cat.rows[0].id,
        employmentType: 'Full Time',
        salary: 1,
        joiningDate: '2026-08-01',
        gender: 'Female',
      },
    });
    check(
      `returns 400 for a ${early.rows[0].pipeline_stage} candidate`,
      notS5.status === 400,
      notS5,
    );
  } else {
    console.log('      (no non-S5 candidate in this database — skipped)');
  }

  // ── 5. HR marks attendance on the staff member behalf ────────────────────
  console.log('\n[5] POST /attendance/mark (HR marking for a pipeline employee)');
  const DATE = '2026-08-11';
  // A staff member can work several houses in a day, so a bare "Present" no
  // longer says where — and the day decides whose invoice carries it. Name the
  // house whenever there is a choice; the API refuses rather than guessing.
  const placements = await db.query(
    `SELECT id FROM placements WHERE staff_id = $1 AND status IN ('CONFIRMED','TRIAL')
      ORDER BY created_at DESC`,
    [target.id],
  );
  const markPlacementId = placements.rows.length > 1 ? placements.rows[0].id : undefined;
  const marked = await req('POST', '/attendance/mark', {
    token,
    body: {
      employeeId, date: DATE, status: 'Present', notes: 'HR desk entry',
      ...(markPlacementId ? { placementId: markPlacementId } : {}),
    },
  });
  check('returns 200/201', [200, 201].includes(marked.status), marked);
  check(
    'response reports the mirrored pipeline row',
    Boolean(marked.body?.pipelineAttendance?.id),
    marked.body?.pipelineAttendance,
  );

  const hrRow = await db.query(
    'SELECT date::text AS d, status FROM attendance WHERE employee_id = $1',
    [employeeId],
  );
  check(
    `HR ledger stored the requested day (${DATE}), not the day before`,
    hrRow.rows[0]?.d === DATE,
    hrRow.rows[0],
  );

  const fieldRow = await db.query(
    'SELECT attendance_date::text AS d, status, marked_by, notes FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date = $2',
    [target.id, DATE],
  );
  check(
    'staff_daily_attendance (the table payroll counts) got the same day',
    fieldRow.rows[0]?.d === DATE,
    fieldRow.rows[0],
  );
  check('mirrored status is PRESENT', fieldRow.rows[0]?.status === 'PRESENT', fieldRow.rows[0]);

  // ── 6. Late maps to PRESENT, and an edit re-mirrors ──────────────────────
  console.log('\n[6] PUT /attendance/:id (status change re-mirrors)');
  const attId = marked.body?.id;
  const edited = await req('PUT', `/attendance/${attId}`, {
    token,
    body: { status: 'Absent' },
  });
  check('returns 200', edited.status === 200, edited);
  const afterEdit = await db.query(
    'SELECT status FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date = $2',
    [target.id, DATE],
  );
  check(
    'pipeline row followed the correction to ABSENT',
    afterEdit.rows[0]?.status === 'ABSENT',
    afterEdit.rows[0],
  );

  // ── 7. a live self-check-in is protected ─────────────────────────────────
  console.log('\n[7] HR cannot silently overwrite the staff member own GPS check-in');
  const GUARD_DATE = '2026-08-12';
  await db.query(
    `INSERT INTO shift_logs (id, staff_id, shift_date, check_in_at, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now(), 'APPROVED', now(), now())
     ON CONFLICT (staff_id, shift_date) DO UPDATE SET status = 'APPROVED'`,
    [target.id, GUARD_DATE],
  );
  const blocked = await req('POST', '/attendance/mark', {
    token,
    body: {
      employeeId, date: GUARD_DATE, status: 'Absent',
      ...(markPlacementId ? { placementId: markPlacementId } : {}),
    },
  });
  check('returns 400 while the self-check-in stands', blocked.status === 400, blocked);
  // And for that reason — a 400 about something else would pass the check
  // above while proving nothing about the guard.
  check(
    'and says the self-check-in is why',
    /check-?in/i.test(JSON.stringify(blocked.body ?? '')),
    blocked.body,
  );
  const noRow = await db.query(
    'SELECT COUNT(*)::int AS n FROM attendance WHERE employee_id = $1 AND date = $2',
    [employeeId, GUARD_DATE],
  );
  check(
    'and wrote nothing to the HR ledger either (no half-applied state)',
    noRow.rows[0].n === 0,
    noRow.rows[0],
  );

  const overridden = await req('POST', '/attendance/mark', {
    token,
    body: {
      employeeId,
      date: GUARD_DATE,
      status: 'Absent',
      overrideSelfCheckIn: true,
      notes: 'Client confirmed no-show',
      ...(markPlacementId ? { placementId: markPlacementId } : {}),
    },
  });
  check('succeeds with overrideSelfCheckIn: true', [200, 201].includes(overridden.status), overridden);
  const overrodeRow = await db.query(
    'SELECT status, notes FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date = $2',
    [target.id, GUARD_DATE],
  );
  check('override is recorded in the note', /overrode/.test(overrodeRow.rows[0]?.notes || ''), overrodeRow.rows[0]);

  // ── 8. office employee mirrors nothing ───────────────────────────────────
  console.log('\n[8] An employee with no pipeline row mirrors nothing');
  const office = await db.query(
    'SELECT id FROM employees WHERE staff_applicant_id IS NULL AND deleted_at IS NULL LIMIT 1',
  );
  if (office.rows.length) {
    const officeMark = await req('POST', '/attendance/mark', {
      token,
      body: { employeeId: office.rows[0].id, date: DATE, status: 'Present' },
    });
    check('returns 200/201', [200, 201].includes(officeMark.status), officeMark);
    check(
      'pipelineAttendance is null for a direct hire',
      officeMark.body?.pipelineAttendance === null,
      officeMark.body?.pipelineAttendance,
    );
    await db.query('DELETE FROM attendance WHERE employee_id = $1 AND date = $2', [
      office.rows[0].id,
      DATE,
    ]);
  } else {
    console.log('      (no direct-hire employee in this database — skipped)');
  }

  // ── 9. audit trail ───────────────────────────────────────────────────────
  console.log('\n[9] Onboarding left an audit trail');
  const ev = await db.query(
    `SELECT event_type FROM pipeline_events WHERE staff_id = $1 AND event_type = 'EMPLOYEE_ONBOARDED'`,
    [target.id],
  );
  // >= 1, not === 1: pipeline_events is append-only, so events from earlier
  // runs of this script are still there by design.
  check('pipeline_events has EMPLOYEE_ONBOARDED', ev.rows.length >= 1, ev.rows);
  const al = await db.query(
    `SELECT action FROM audit_logs WHERE entity_id = $1 AND entity_type = 'employee'`,
    [employeeId],
  );
  check('audit_logs has the employee entry', al.rows.length >= 1, al.rows);

  // ── cleanup ──────────────────────────────────────────────────────────────
  console.log('\ncleaning up test rows...');
  await db.query('DELETE FROM attendance WHERE employee_id = $1', [employeeId]);
  await db.query('DELETE FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date IN ($2, $3)', [
    target.id, DATE, GUARD_DATE,
  ]);
  await db.query('DELETE FROM shift_logs WHERE staff_id = $1 AND shift_date = $2', [target.id, GUARD_DATE]);
  // pipeline_events is append-only at the database level (a trigger rejects
  // DELETE), so the EMPLOYEE_ONBOARDED row from this run stays. That is the
  // intended design, and step [3] proves a repeat run is refused anyway — so
  // clear the FK link instead, which is what lets the candidate be reused.
  await db.query(`DELETE FROM audit_logs WHERE entity_id = $1 AND entity_type = 'employee'`, [employeeId]);
  await db.query('DELETE FROM employees WHERE id = $1', [employeeId]);
  console.log('done');

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
