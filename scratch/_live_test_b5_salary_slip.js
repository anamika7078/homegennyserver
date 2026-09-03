/**
 * Live HTTP verification for §B5 of docs/HOURLY_MULTI_CLIENT_PLAN.md — one
 * salary slip for a month worked across several clients.
 *
 * `payroll_records` is keyed by placement, which is right: each row is what one
 * client owes. But the staff member is paid once. Three houses in a month used
 * to appear as three payslips for the same month, three net figures, none of
 * them what she actually received. The slip is now one row per month with the
 * houses listed under it.
 *
 * Builds one staff member at two clients, runs both payrolls, reads her slips,
 * and removes everything it made.
 *
 *   node scratch/_live_test_b5_salary_slip.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const HR_PHONE = '9800000008';
// Running payroll is Finance's; reading the slip is HR's. The point of the
// test is that they see one slip for what Finance ran as several rows.
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_MONTH = 4;
const TEST_YEAR = 2026;
const PERM_SALARY = 21000;         // 30 days in April
const PERM_DAYS = [6, 7, 8, 9, 10, 13];
const HOURLY_RATE = 180;
const HOURLY_DAYS = [6, 7, 8];
const HOURS_PER_DAY = 4;

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

const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const url = process.env.DATABASE_URL;
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const db = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await db.connect();

  const made = { staffId: null, employeeId: null, customerIds: [], placementIds: [] };

  try {
    const token = await login(HR_PHONE);
    check('HR can log in', !!token);
    const financeToken = await login(FINANCE_PHONE);
    check('Finance can log in', !!financeToken);

    const branch = await db.query(`SELECT id FROM branches LIMIT 1`);
    const branchId = branch.rows[0]?.id;
    if (!branchId) throw new Error('no branch in this database');

    const staff = await db.query(
      `INSERT INTO staff_applicants
         (id, staff_code, series, full_name, mobile, date_of_birth, address, branch_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'B5SLIP01', 'MAID', 'Teen Ghar Wali', '9700000088',
               '1995-01-01', 'Test address', $1, now(), now()) RETURNING id`,
      [branchId],
    );
    made.staffId = staff.rows[0].id;

    const category = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
    const emp = await db.query(
      `INSERT INTO employees
         (id, employee_id, full_name, mobile, date_of_birth, gender, address, city, state,
          pincode, emergency_contact, joining_date, branch_id, department, designation,
          category_id, employment_type, salary, status, staff_applicant_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'B5EMP01', 'Teen Ghar Wali', '9700000088', make_date(1995,1,1),
               'Female', 'Test address', 'New Delhi', 'Delhi', '110001', '9700000089',
               make_date(2026,1,1), $2, 'Housekeeping', 'Maid', $3, 'Full Time', 21000,
               'Active', $1, now(), now()) RETURNING id`,
      [made.staffId, branchId, category.rows[0]?.id ?? null],
    );
    made.employeeId = emp.rows[0].id;

    for (const [code, name] of [['B5-HOUSE-A', 'B5 House A'], ['B5-HOUSE-B', 'B5 House B']]) {
      await db.query(`DELETE FROM finance_customers WHERE unit_code = $1`, [code]);
      const c = await db.query(
        `INSERT INTO finance_customers
           (id, customer_name, unit_code, unit_name, address, pan_card, bill_no_prefix,
            status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $1, 'Somewhere', 'AAAPL8888C', $2,
                 'ACTIVE', now(), now()) RETURNING id`,
        [name, code],
      );
      made.customerIds.push(c.rows[0].id);
    }

    const perm = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               staff_salary, management_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', $4, 3000, 8,
               make_date($5,$6,1), now(), now()) RETURNING id`,
      [made.staffId, made.customerIds[0], branchId, PERM_SALARY, TEST_YEAR, TEST_MONTH],
    );
    const hourly = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               hourly_rate, hourly_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'TEMPORARY', $4, 25, 4,
               make_date($5,$6,1), now(), now()) RETURNING id`,
      [made.staffId, made.customerIds[1], branchId, HOURLY_RATE, TEST_YEAR, TEST_MONTH],
    );
    made.placementIds = [perm.rows[0].id, hourly.rows[0].id];

    const mark = async (placementId, days, hours) => {
      for (const day of days) {
        await db.query(
          `INSERT INTO staff_daily_attendance
             (id, staff_id, placement_id, branch_id, attendance_date, status, hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', $7, $1, now(), now())
           ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING`,
          [made.staffId, placementId, branchId, TEST_YEAR, TEST_MONTH, day, hours],
        );
      }
    };
    await mark(made.placementIds[0], PERM_DAYS, 8);
    await mark(made.placementIds[1], HOURLY_DAYS, HOURS_PER_DAY);

    // One call runs every house she works at — running the most recent one and
    // stopping left the other client unbilled and her unpaid for that work.
    const run = await req('POST', '/finance/payroll/attendance-generate', {
      token: financeToken, body: { code: 'B5SLIP01', month: TEST_MONTH, year: TEST_YEAR },
    });
    check('payroll runs', run.status === 200 || run.status === 201,
      { status: run.status, body: run.body });
    check('one call covers both houses', (run.body?.runs ?? []).length === 2,
      (run.body?.runs ?? []).map((x) => x.client_name));

    // Running again must not fail — it has simply nothing left to do.
    const again = await req('POST', '/finance/payroll/attendance-generate', {
      token: financeToken, body: { code: 'B5SLIP01', month: TEST_MONTH, year: TEST_YEAR },
    });
    check('running again is refused, not silently duplicated', again.status === 400, again.status);
    check('and says both houses are already done',
      /already exists/i.test(JSON.stringify(again.body ?? '')), again.body);

    const stored = await db.query(
      `SELECT placement_id, gross_salary, net_salary FROM payroll_records
        WHERE staff_id = $1 AND period_month = $2 AND period_year = $3`,
      [made.staffId, TEST_MONTH, TEST_YEAR],
    );
    check('two payroll rows exist, one per house', stored.rows.length === 2, stored.rows.length);

    // ── the slip ──────────────────────────────────────────────────────────
    const slips = await req('GET', `/employees/${made.employeeId}/payslips`, { token });
    check('payslips load', slips.status === 200, slips.status);

    const items = (slips.body?.items ?? slips.body ?? []).filter(
      (i) => i.periodMonth === TEST_MONTH && i.periodYear === TEST_YEAR && i.source === 'FIELD_PAYROLL',
    );
    check('one slip for the month, not one per house', items.length === 1, items.length);

    const slip = items[0];
    const permEarned = round2((PERM_SALARY * PERM_DAYS.length) / 30);   // April
    const hourlyEarned = HOURLY_DAYS.length * HOURS_PER_DAY * HOURLY_RATE;
    check('the gross is both houses added up',
      Math.abs(slip?.grossSalary - (permEarned + hourlyEarned)) < 1,
      { got: slip?.grossSalary, expected: round2(permEarned + hourlyEarned) });
    check('the net is what she is actually paid',
      Math.abs(slip?.netSalary - (slip?.grossSalary - slip?.totalDeductions)) < 1,
      { gross: slip?.grossSalary, deductions: slip?.totalDeductions, net: slip?.netSalary });

    check('the houses are listed under it', (slip?.clientBreakdown ?? []).length === 2,
      slip?.clientBreakdown);
    const names = (slip?.clientBreakdown ?? []).map((b) => b.clientName).sort();
    check('and named', names.join(',') === 'B5 House A,B5 House B', names);
    const hourlyPart = (slip?.clientBreakdown ?? []).find((b) => b.placementType === 'TEMPORARY');
    check('the hourly house shows hours',
      hourlyPart?.worked === `${HOURLY_DAYS.length * HOURS_PER_DAY} hours`, hourlyPart?.worked);
    const permPart = (slip?.clientBreakdown ?? []).find((b) => b.placementType === 'PERMANENT');
    check('the permanent house shows days',
      permPart?.worked === `${PERM_DAYS.length} days`, permPart?.worked);
    check('the parts add up to the gross',
      Math.abs((slip?.clientBreakdown ?? []).reduce((s, b) => s + b.grossSalary, 0) - slip?.grossSalary) < 1,
      slip?.clientBreakdown?.map((b) => b.grossSalary));

    check('days paid is not the sum of both houses (a month has no 9 extra days)',
      slip?.presentDays === Math.max(PERM_DAYS.length, HOURLY_DAYS.length),
      slip?.presentDays);

    // The PDF must render from the folded ref rather than 404 on it.
    const pdf = await fetchWithBackoff(
      `${BASE}/employees/${made.employeeId}/payslips/pdf?ref=${encodeURIComponent(slip.ref)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    check('the slip PDF still downloads', pdf.status === 200, pdf.status);
  } finally {
    try {
      if (made.staffId) {
        await db.query(
          `UPDATE payroll_records SET client_invoice_id = NULL WHERE staff_id = $1`, [made.staffId],
        );
        const inv = await db.query(
          `SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customerIds],
        );
        for (const row of inv.rows) {
          await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [row.id]);
          await db.query(`DELETE FROM client_invoices WHERE id = $1`, [row.id]);
        }
        await db.query(`DELETE FROM payroll_records WHERE staff_id = $1`, [made.staffId]);
        await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = $1`, [made.staffId]);
      }
      if (made.employeeId) await db.query(`DELETE FROM employees WHERE id = $1`, [made.employeeId]);
      if (made.placementIds.length) {
        await db.query(`DELETE FROM deployments WHERE placement_id = ANY($1::uuid[])`, [made.placementIds]).catch(() => {});
        await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placementIds]);
      }
      if (made.staffId) await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [made.staffId]);
      if (made.customerIds.length) {
        await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customerIds]);
      }
      await db.query(`DELETE FROM employees WHERE employee_id = 'B5EMP01'`);
      await db.query(`DELETE FROM staff_applicants WHERE staff_code = 'B5SLIP01'`);
      await db.query(`DELETE FROM finance_customers WHERE unit_code IN ('B5-HOUSE-A','B5-HOUSE-B')`);
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
