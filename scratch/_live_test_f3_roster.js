/**
 * Live HTTP verification for §F3 of docs/HOURLY_MULTI_CLIENT_PLAN.md — marking
 * a day when the same person works at more than one house.
 *
 * The old HR screen listed people, one row each, and marked "Present" with no
 * way to say where. That is unmarkable for a maid doing three houses, and the
 * day has to name a client: it decides whose invoice carries it, and for an
 * hourly placement the hours decide what it costs. So the roster returns one
 * row per placement, and marking takes a placement and its hours.
 *
 * Builds one staff member placed at two clients — one permanent, one hourly —
 * marks a day at each, and removes everything it made.
 *
 *   node scratch/_live_test_f3_roster.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const HR_PHONE = '9800000008';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_DATE = '2026-02-11';
const HOURLY_RATE = 250;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

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

async function main() {
  const url = process.env.DATABASE_URL;
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const db = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await db.connect();

  const made = { staffId: null, employeeId: null, customerIds: [], placementIds: [] };

  try {
    const token = await login(HR_PHONE);
    check('HR can log in', !!token);

    const branch = await db.query(`SELECT id FROM branches LIMIT 1`);
    const branchId = branch.rows[0]?.id;
    if (!branchId) throw new Error('no branch in this database');

    // One maid, two houses.
    const staff = await db.query(
      `INSERT INTO staff_applicants
         (id, staff_code, series, full_name, mobile, date_of_birth, address, branch_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'F3ROST01', 'MAID', 'Do Ghar Wali', '9700000077',
               '1995-01-01', 'Test address', $1, now(), now()) RETURNING id`,
      [branchId],
    );
    made.staffId = staff.rows[0].id;

    // The HR-side record — POST /attendance/mark takes an employee id.
    const category = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
    const emp = await db.query(
      `INSERT INTO employees
         (id, employee_id, full_name, mobile, date_of_birth, gender, address, city, state,
          pincode, emergency_contact, joining_date, branch_id, department, designation,
          category_id, employment_type, salary, status, staff_applicant_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'F3EMP01', 'Do Ghar Wali', '9700000077', make_date(1995,1,1),
               'Female', 'Test address', 'New Delhi', 'Delhi', '110001', '9700000078',
               make_date(2026,1,1), $2, 'Housekeeping', 'Maid', $3, 'Full Time', 18000,
               'Active', $1, now(), now()) RETURNING id`,
      [made.staffId, branchId, category.rows[0]?.id ?? null],
    );
    made.employeeId = emp.rows[0].id;

    for (const [code, name] of [['F3-HOUSE-A', 'House A'], ['F3-HOUSE-B', 'House B']]) {
      await db.query(`DELETE FROM finance_customers WHERE unit_code = $1`, [code]);
      const c = await db.query(
        `INSERT INTO finance_customers
           (id, customer_name, unit_code, unit_name, address, pan_card, bill_no_prefix,
            status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $1, 'Somewhere', 'AAAPL9999C', $2,
                 'ACTIVE', now(), now()) RETURNING id`,
        [name, code],
      );
      made.customerIds.push(c.rows[0].id);
    }

    const perm = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               staff_salary, management_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', 18000, 2500, 8, now(), now(), now())
       RETURNING id`,
      [made.staffId, made.customerIds[0], branchId],
    );
    const hourly = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               hourly_rate, hourly_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'TEMPORARY', $4, 40, 3, now(), now(), now())
       RETURNING id`,
      [made.staffId, made.customerIds[1], branchId, HOURLY_RATE],
    );
    made.placementIds = [perm.rows[0].id, hourly.rows[0].id];

    // ── the roster ────────────────────────────────────────────────────────
    const r = await req('GET', `/attendance/roster?date=${TEST_DATE}`, { token });
    check('roster returns 200', r.status === 200, r.status);

    const mine = (r.body?.rows ?? []).filter((x) => x.staff_code === 'F3ROST01');
    check('the same person appears once per house', mine.length === 2, mine.length);

    const permRow = mine.find((x) => x.placement_type === 'PERMANENT');
    const hourRow = mine.find((x) => x.placement_type === 'TEMPORARY');
    check('each row names its client',
      permRow?.client_name === 'House A' && hourRow?.client_name === 'House B',
      { perm: permRow?.client_name, hourly: hourRow?.client_name });
    check('the hourly row carries its rate', Number(hourRow?.hourly_rate) === HOURLY_RATE,
      hourRow?.hourly_rate);
    check('the permanent row carries its shift', Number(permRow?.shift_hours) === 8,
      permRow?.shift_hours);
    check('rows carry the HR id that marking needs',
      mine.every((x) => x.employee_id === made.employeeId),
      mine.map((x) => x.employee_id));
    check('nothing is marked yet', mine.every((x) => x.marked_status === null),
      mine.map((x) => x.marked_status));

    const noDate = await req('GET', '/attendance/roster', { token });
    check('a missing date is a clean 400', noDate.status === 400, noDate.status);

    // ── marking without saying where ──────────────────────────────────────
    const vague = await req('POST', '/attendance/mark', {
      token, body: { employeeId: made.employeeId, date: TEST_DATE, status: 'Present' },
    });
    check('marking without naming the house is refused', vague.status === 400, vague.status);
    // The error body is wrapped, so match the whole payload rather than
    // guessing how deep the message sits.
    check('and the refusal says why',
      /placed with 2 clients|which one/i.test(JSON.stringify(vague.body ?? '')),
      vague.body);

    // ── marking each house ────────────────────────────────────────────────
    const markPerm = await req('POST', '/attendance/mark', {
      token,
      body: {
        employeeId: made.employeeId, date: TEST_DATE, status: 'Present',
        placementId: made.placementIds[0], hoursWorked: 8,
      },
    });
    check('the permanent day is marked', markPerm.status === 200 || markPerm.status === 201, markPerm.status);

    const markHourly = await req('POST', '/attendance/mark', {
      token,
      body: {
        employeeId: made.employeeId, date: TEST_DATE, status: 'Present',
        placementId: made.placementIds[1], hoursWorked: 3.5,
      },
    });
    check('the hourly day is marked, same date, different house',
      markHourly.status === 200 || markHourly.status === 201, markHourly.status);

    const after = await req('GET', `/attendance/roster?date=${TEST_DATE}`, { token });
    const mineAfter = (after.body?.rows ?? []).filter((x) => x.staff_code === 'F3ROST01');
    check('both days now read as marked',
      mineAfter.length === 2 && mineAfter.every((x) => x.marked_status === 'PRESENT'),
      mineAfter.map((x) => x.marked_status));
    const hourAfter = mineAfter.find((x) => x.placement_type === 'TEMPORARY');
    check('the hours are kept against the hourly house',
      Number(hourAfter?.marked_hours) === 3.5, hourAfter?.marked_hours);
    const permAfter = mineAfter.find((x) => x.placement_type === 'PERMANENT');
    check('and the permanent house has its own hours',
      Number(permAfter?.marked_hours) === 8, permAfter?.marked_hours);

    // Both rows exist in the table payroll actually reads.
    const stored = await db.query(
      `SELECT placement_id, hours_worked FROM staff_daily_attendance
        WHERE staff_id = $1 AND attendance_date = $2::date ORDER BY hours_worked`,
      [made.staffId, TEST_DATE],
    );
    check('two separate attendance rows exist for the one day', stored.rows.length === 2,
      stored.rows.length);
    check('they belong to different placements',
      new Set(stored.rows.map((x) => x.placement_id)).size === 2);

    // Marking a house she does not work at must not be accepted.
    const wrongHouse = await req('POST', '/attendance/mark', {
      token,
      body: {
        employeeId: made.employeeId, date: TEST_DATE, status: 'Present',
        placementId: '00000000-0000-0000-0000-000000000000',
      },
    });
    check('marking a house she is not placed at is refused', wrongHouse.status === 400,
      wrongHouse.status);
  } finally {
    try {
      if (made.staffId) {
        await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = $1`, [made.staffId]);
      }
      if (made.employeeId) {
        await db.query(`DELETE FROM attendance WHERE employee_id = $1`, [made.employeeId]).catch(() => {});
        await db.query(`DELETE FROM employees WHERE id = $1`, [made.employeeId]);
      }
      if (made.placementIds.length) {
        await db.query(`DELETE FROM deployments WHERE placement_id = ANY($1::uuid[])`, [made.placementIds]).catch(() => {});
        await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placementIds]);
      }
      if (made.staffId) await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [made.staffId]);
      if (made.customerIds.length) {
        await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customerIds]);
      }
      // Anything a crashed earlier run left behind.
      await db.query(`DELETE FROM employees WHERE employee_id = 'F3EMP01'`);
      await db.query(`DELETE FROM staff_applicants WHERE staff_code = 'F3ROST01'`);
      await db.query(`DELETE FROM finance_customers WHERE unit_code IN ('F3-HOUSE-A','F3-HOUSE-B')`);
      console.log('\n  (fixture removed)');
    } catch (e) {
      console.log(`\n  CLEANUP WARNING: ${e.message}`);
    }
    await db.end();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
