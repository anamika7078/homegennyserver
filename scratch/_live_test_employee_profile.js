/**
 * Live HTTP test for the per-employee reads and the unified payslip + PDF.
 *
 *   node scratch/_live_test_employee_profile.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const HR_PHONE = '9800000008';
const HR_PASSWORD = 'HomeGenny@2024';

const YEAR = 2032;
const MONTH = 5;
const FIELD_DAYS = ['2032-05-03', '2032-05-04', '2032-05-05'];
const UNPROJECTED_DAY = '2032-05-20';

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

async function req(method, path, { token, body, raw } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) {
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      disposition: res.headers.get('content-disposition'),
      buffer: Buffer.from(await res.arrayBuffer()),
    };
  }
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

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const login = await req('POST', '/auth/login', {
    body: { phone: HR_PHONE, password: HR_PASSWORD },
  });
  const token = login.body?.access_token || login.body?.data?.access_token;
  if (!token) {
    console.log('could not log in as HR — aborting', login.status, login.rawBody);
    process.exit(1);
  }
  console.log(`logged in as HR (${HR_PHONE})`);

  const pending = await req('GET', '/employees/pending-onboarding', { token });
  const target = (pending.body?.items ?? [])[0];
  if (!target) {
    console.log('no S5 candidate available — aborting');
    process.exit(1);
  }
  const cat = await db.query('SELECT id FROM employee_categories LIMIT 1');
  const onboarded = await req('POST', '/employees/onboard-from-pipeline', {
    token,
    body: {
      staffApplicantId: target.id,
      department: 'Field Operations',
      designation: 'Housemaid',
      categoryId: cat.rows[0].id,
      employmentType: 'Full Time',
      salary: 24000,
      joiningDate: '2032-01-01',
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
  console.log(`set up: ${target.staffCode} -> employee ${onboarded.body.employee.employeeId}`);

  const branchId = (
    await db.query('SELECT branch_id FROM staff_applicants WHERE id = $1', [target.id])
  ).rows[0].branch_id;
  let incidentId = null;

  async function cleanup() {
    if (incidentId) await db.query('DELETE FROM incidents WHERE id = $1', [incidentId]);
    await db.query('DELETE FROM employee_payrolls WHERE employee_id = $1', [employeeId]);
    await db.query('DELETE FROM attendance WHERE employee_id = $1', [employeeId]);
    await db.query(
      "DELETE FROM staff_daily_attendance WHERE staff_id = $1 AND attendance_date >= '2032-01-01'",
      [target.id],
    );
    await db.query("DELETE FROM audit_logs WHERE entity_id = $1 AND entity_type = 'employee'", [
      employeeId,
    ]);
    await db.query('DELETE FROM employees WHERE id = $1', [employeeId]);
  }

  try {
    for (const day of [...FIELD_DAYS, UNPROJECTED_DAY]) {
      await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::date, 'PRESENT', $1, now(), now())
         ON CONFLICT (staff_id, attendance_date) DO UPDATE SET status = 'PRESENT'`,
        [target.id, branchId, day],
      );
    }

    // ── 1. pipeline history ────────────────────────────────────────────────
    console.log('\n[1] GET /employees/:id/pipeline-history');
    const hist = await req('GET', `/employees/${employeeId}/pipeline-history`, { token });
    check('returns 200', hist.status === 200, hist.status);
    check('linkedToPipeline is true', hist.body?.linkedToPipeline === true, hist.body);
    check(
      'carries the candidate staff code',
      hist.body?.applicant?.staffCode === target.staffCode,
      hist.body?.applicant,
    );
    const onboardEvent = (hist.body?.events ?? []).find(
      (e) => e.eventType === 'EMPLOYEE_ONBOARDED',
    );
    check('the onboarding event is in the history', Boolean(onboardEvent), hist.body?.events?.length);
    check(
      'the acting HR user is resolved to a name, not just an id',
      Boolean(onboardEvent?.actor?.fullName),
      onboardEvent?.actor,
    );

    // ── 2. incidents ───────────────────────────────────────────────────────
    console.log('\n[2] GET /employees/:id/incidents');
    const ins = await db.query(
      `INSERT INTO incidents (id, staff_id, type, status, title, description, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'CLIENT_COMPLAINT', 'OPEN', 'Late arrival complaint',
               'Client reported repeated late arrivals', now(), now())
       RETURNING id`,
      [target.id],
    );
    incidentId = ins.rows[0].id;
    const inc = await req('GET', `/employees/${employeeId}/incidents`, { token });
    check('returns 200', inc.status === 200, inc.status);
    check('the incident is visible from the employee record', inc.body?.total === 1, inc.body);
    check('open incidents are counted', inc.body?.openCount === 1, inc.body);

    // ── 3. merged attendance month ─────────────────────────────────────────
    console.log('\n[3] GET /employees/:id/attendance-month');
    // Project only part of the month, so an unprojected day is visible.
    await req('POST', '/attendance/sync-from-pipeline', {
      token,
      body: { month: MONTH, year: YEAR, employeeId },
    });
    // Then add one more field day AFTER the sync — it must show as PIPELINE_ONLY.
    await db.query(
      `UPDATE staff_daily_attendance SET status = 'ABSENT'
        WHERE staff_id = $1 AND attendance_date = $2::date`,
      [target.id, FIELD_DAYS[0]],
    );
    // And let HR override one day, so divergence shows up.
    await req('POST', '/attendance/mark', {
      token,
      body: {
        employeeId,
        date: FIELD_DAYS[0],
        status: 'Present',
        notes: 'Verified with client',
        overrideSelfCheckIn: true,
      },
    });
    await db.query(
      `UPDATE staff_daily_attendance SET status = 'ABSENT'
        WHERE staff_id = $1 AND attendance_date = $2::date`,
      [target.id, FIELD_DAYS[0]],
    );
    await db.query('DELETE FROM attendance WHERE employee_id = $1 AND date = $2::date', [
      employeeId,
      UNPROJECTED_DAY,
    ]);

    const month = await req(
      'GET',
      `/employees/${employeeId}/attendance-month?month=${MONTH}&year=${YEAR}`,
      { token },
    );
    check('returns 200', month.status === 200, month.status);
    const byDate = Object.fromEntries((month.body?.items ?? []).map((d) => [d.date, d]));
    check(
      'a day HR marked is sourced to HR',
      byDate[FIELD_DAYS[0]]?.source === 'HR',
      byDate[FIELD_DAYS[0]],
    );
    check(
      'a projected day is sourced to FIELD',
      byDate[FIELD_DAYS[1]]?.source === 'FIELD',
      byDate[FIELD_DAYS[1]],
    );
    check(
      'a field day not yet projected shows as PIPELINE_ONLY',
      byDate[UNPROJECTED_DAY]?.source === 'PIPELINE_ONLY',
      byDate[UNPROJECTED_DAY],
    );
    check(
      'the HR override is flagged as diverging from the field record',
      byDate[FIELD_DAYS[0]]?.divergesFromField === true,
      byDate[FIELD_DAYS[0]],
    );
    check('unprojected days are counted', Number(month.body?.unprojectedDays) >= 1, month.body?.unprojectedDays);
    check('bad month is rejected', (await req('GET', `/employees/${employeeId}/attendance-month?month=13&year=${YEAR}`, { token })).status === 400);

    // ── 4. unified payslips ────────────────────────────────────────────────
    console.log('\n[4] GET /employees/:id/payslips');
    const gen = await req('POST', `/attendance/${employeeId}/generate-payroll`, {
      token,
      body: { month: MONTH, year: YEAR },
    });
    check('payroll generated for the period', [200, 201].includes(gen.status), gen.rawBody);
    const slips = await req('GET', `/employees/${employeeId}/payslips`, { token });
    check('returns 200', slips.status === 200, slips.status);
    check('at least one payslip is listed', Number(slips.body?.total) >= 1, slips.body);
    const slip = (slips.body?.items ?? [])[0];
    check('the row names its source', Boolean(slip?.sourceLabel), slip);
    check('the row carries a usable ref', /^[A-Z_]+:[0-9a-f-]{36}$/.test(slip?.ref ?? ''), slip?.ref);
    check(
      'the period matches the payroll that was run',
      slip?.periodMonth === MONTH && slip?.periodYear === YEAR,
      { month: slip?.periodMonth, year: slip?.periodYear },
    );
    check('net salary is greater than zero', Number(slip?.netSalary) > 0, slip?.netSalary);

    // ── 5. payslip PDF ─────────────────────────────────────────────────────
    console.log('\n[5] GET /employees/:id/payslips/pdf');
    const pdf = await req(
      'GET',
      `/employees/${employeeId}/payslips/pdf?ref=${encodeURIComponent(slip.ref)}`,
      { token, raw: true },
    );
    check('returns 200', pdf.status === 200, pdf.status);
    check('content type is application/pdf', pdf.contentType?.includes('application/pdf'), pdf.contentType);
    check(
      'body really is a PDF (starts with %PDF)',
      pdf.buffer.subarray(0, 4).toString() === '%PDF',
      pdf.buffer.subarray(0, 8).toString(),
    );
    check('the file is not empty', pdf.buffer.length > 1000, pdf.buffer.length);
    check(
      'it downloads with a named file',
      /filename="payslip-.*\.pdf"/.test(pdf.disposition ?? ''),
      pdf.disposition,
    );

    const badRef = await req('GET', `/employees/${employeeId}/payslips/pdf?ref=NONSENSE`, { token });
    check('a malformed ref is rejected with 400', badRef.status === 400, badRef.status);
    const missingRef = await req('GET', `/employees/${employeeId}/payslips/pdf`, { token });
    check('a missing ref is rejected with 400', missingRef.status === 400, missingRef.status);

    // ── 6. direct hires degrade gracefully ─────────────────────────────────
    console.log('\n[6] A direct hire has no pipeline side, and says so');
    const office = await db.query(
      'SELECT id FROM employees WHERE staff_applicant_id IS NULL AND deleted_at IS NULL LIMIT 1',
    );
    if (office.rows.length) {
      const oid = office.rows[0].id;
      const oh = await req('GET', `/employees/${oid}/pipeline-history`, { token });
      check('pipeline-history returns 200, not an error', oh.status === 200, oh.status);
      check('linkedToPipeline is false', oh.body?.linkedToPipeline === false, oh.body);
      check('and it explains why', Boolean(oh.body?.note), oh.body?.note);
      const oi = await req('GET', `/employees/${oid}/incidents`, { token });
      check('incidents returns an empty list, not an error', oi.status === 200 && oi.body?.total === 0, oi.body);
    } else {
      console.log('      (no direct-hire employee in this database — skipped)');
    }

    // ── 7. a missing employee is a clean 404 ───────────────────────────────
    console.log('\n[7] Unknown employee');
    const ghost = await req(
      'GET',
      '/employees/00000000-0000-0000-0000-0000000000ff/pipeline-history',
      { token },
    );
    check('returns 404', ghost.status === 404, ghost.status);
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
