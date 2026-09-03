/**
 * Live HTTP verification for §F1 of docs/HOURLY_MULTI_CLIENT_PLAN.md —
 * finding a client by their unit code and billing them from that one screen.
 *
 * The point of the screen is that Finance types a code and everything they
 * need to decide is on the page: who the client is, who is working there this
 * period, permanent and hourly shown apart, and whether it has been billed.
 * So that is what this asserts — over HTTP, as the browser sees it.
 *
 * It builds its own client, staff, two placements (one permanent, one hourly),
 * attendance and payroll, bills them, then removes every row it made.
 *
 *   node scratch/_live_test_f1_unit_code.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

// Far enough back that it cannot collide with real billing.
const TEST_MONTH = 2;
const TEST_YEAR = 2026;
const UNIT_CODE = 'F1-UNITTEST-01';
const BILL_PREFIX = 'F1TEST';
const HOURLY_RATE = 200;
const HOURS_PER_DAY = 3;
const HOURLY_DAYS = [4, 5, 6];        //  3 days × 3 hours × ₹200 = ₹1,800
const PERM_DAYS = [4, 5, 6, 7, 10];
const PERM_SALARY = 20000;

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

  const made = {
    customerId: null, staffIds: [], placementIds: [], attendanceIds: [], invoiceId: null,
    oneDayCustomerId: null, oneDayInvoiceId: null,
  };

  try {
    const token = await login(FINANCE_PHONE);
    check('finance can log in', !!token);

    // ── fixture ───────────────────────────────────────────────────────────
    const branch = await db.query(`SELECT id FROM branches LIMIT 1`);
    const branchId = branch.rows[0]?.id;
    if (!branchId) throw new Error('no branch in this database');

    await db.query(`DELETE FROM finance_customers WHERE unit_code = $1`, [UNIT_CODE]);
    const cust = await db.query(
      `INSERT INTO finance_customers
         (id, customer_name, unit_code, unit_name, address, city, state, pan_card,
          bill_no_prefix, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'F1 Unit Code Test Client', $1, 'Hauz Khas Flat',
               '9, Hauz Khas', 'New Delhi', 'Delhi', 'AAAPL1234C', $2, 'ACTIVE', now(), now())
       RETURNING id`,
      [UNIT_CODE, BILL_PREFIX],
    );
    made.customerId = cust.rows[0].id;

    for (const [code, name] of [['F1UC001', 'Perm Wali'], ['F1UC002', 'Ghante Wali']]) {
      const s = await db.query(
        `INSERT INTO staff_applicants
           (id, staff_code, series, full_name, mobile, date_of_birth, address, branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'Test address', $4, now(), now())
         RETURNING id`,
        [code, name, '97000000' + code.slice(-2), branchId],
      );
      made.staffIds.push(s.rows[0].id);
    }
    const [permStaff, hourlyStaff] = made.staffIds;

    const perm = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               staff_salary, management_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', $4, 2000, 8,
               make_date($5,$6,1), now(), now()) RETURNING id`,
      [permStaff, made.customerId, branchId, PERM_SALARY, TEST_YEAR, TEST_MONTH],
    );
    const hourly = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               hourly_rate, hourly_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'TEMPORARY', $4, 30, 3,
               make_date($5,$6,1), now(), now()) RETURNING id`,
      [hourlyStaff, made.customerId, branchId, HOURLY_RATE, TEST_YEAR, TEST_MONTH],
    );
    made.placementIds = [perm.rows[0].id, hourly.rows[0].id];

    const markAttendance = async (staffId, placementId, days, hours) => {
      for (const day of days) {
        const r = await db.query(
          `INSERT INTO staff_daily_attendance
             (id, staff_id, placement_id, branch_id, attendance_date, status, hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', $7, $1, now(), now())
           ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING
           RETURNING id`,
          [staffId, placementId, branchId, TEST_YEAR, TEST_MONTH, day, hours],
        );
        if (r.rows[0]) made.attendanceIds.push(r.rows[0].id);
      }
    };
    await markAttendance(permStaff, made.placementIds[0], PERM_DAYS, 8);
    await markAttendance(hourlyStaff, made.placementIds[1], HOURLY_DAYS, HOURS_PER_DAY);

    // ── the lookup itself ─────────────────────────────────────────────────
    const q = `?unit_code=${encodeURIComponent(UNIT_CODE)}&month=${TEST_MONTH}&year=${TEST_YEAR}`;
    let look = await req('GET', '/finance/invoices/by-unit-code' + q, { token });
    check('unit code returns 200', look.status === 200, look.status);
    check('it is the right client', look.body?.customer?.customer_name === 'F1 Unit Code Test Client',
      look.body?.customer?.customer_name);
    check('address comes back for the header', !!look.body?.customer?.address);

    const rows = look.body?.placements ?? [];
    check('both placements listed', rows.length === 2, rows.length);

    const permRow = rows.find((r) => r.placement_type === 'PERMANENT');
    const hourRow = rows.find((r) => r.placement_type === 'TEMPORARY');
    check('permanent is separated from hourly', !!permRow && !!hourRow);
    check('permanent shows days worked', permRow?.days_this_period === PERM_DAYS.length,
      permRow?.days_this_period);
    check('permanent carries its monthly salary', Number(permRow?.staff_salary) === PERM_SALARY,
      permRow?.staff_salary);
    check('hourly shows hours, not days',
      hourRow?.hours_this_period === HOURLY_DAYS.length * HOURS_PER_DAY, hourRow?.hours_this_period);
    check('hourly carries its own rate', Number(hourRow?.hourly_rate) === HOURLY_RATE,
      hourRow?.hourly_rate);
    check('nothing is billed yet', look.body?.existing_invoice === null, look.body?.existing_invoice);
    check('payroll has not run yet', rows.every((r) => r.payroll_run === false));

    // A bad code must say so plainly rather than 500.
    const missing = await req('GET', '/finance/invoices/by-unit-code?unit_code=NO-SUCH-CODE&month=2&year=2026', { token });
    check('unknown code is a clean 404', missing.status === 404, missing.status);
    const blank = await req('GET', '/finance/invoices/by-unit-code?unit_code=&month=2&year=2026', { token });
    check('blank code is a clean 400', blank.status === 400, blank.status);
    const noAuth = await req('GET', '/finance/invoices/by-unit-code' + q);
    check('the lookup needs a login', noAuth.status === 401, noAuth.status);

    // ── run payroll, then bill from the lookup ────────────────────────────
    for (const code of ['F1UC001', 'F1UC002']) {
      const gen = await req('POST', '/finance/payroll/attendance-generate', {
        token, body: { code, month: TEST_MONTH, year: TEST_YEAR },
      });
      check(`payroll runs for ${code}`, gen.status === 200 || gen.status === 201, gen.status);
    }

    // Payroll works out what is owed and stops. No document goes out as a side
    // effect of that button — billing is raised deliberately, from the unit
    // code, and lands as a draft.
    look = await req('GET', '/finance/invoices/by-unit-code' + q, { token });
    check('lookup now says payroll has run',
      (look.body?.placements ?? []).every((r) => r.payroll_run === true));
    check('payroll raised no invoice on its own', look.body?.existing_invoice === null,
      look.body?.existing_invoice);
    check('both staff are waiting to be billed', look.body?.un_invoiced?.staff_count === 2,
      look.body?.un_invoiced);

    const issued = await req('POST', '/finance/invoices/consolidated/generate', {
      token, body: { customer_id: made.customerId, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('the unit-code screen raises the invoice',
      issued.status === 200 || issued.status === 201, issued.status);
    check('it arrives as a DRAFT',
      (issued.body?.invoice ?? issued.body)?.status === 'DRAFT',
      (issued.body?.invoice ?? issued.body)?.status);

    look = await req('GET', '/finance/invoices/by-unit-code' + q, { token });
    check('one invoice, not one per staff member',
      (look.body?.placements ?? []).every((r) => r.invoiced === true));
    check('nothing is left waiting to be billed', look.body?.un_invoiced?.staff_count === 0,
      look.body?.un_invoiced);

    made.invoiceId = look.body.existing_invoice.id;
    const firstNumber = look.body.existing_invoice.invoice_number;

    const hourlyEarned = HOURLY_DAYS.length * HOURS_PER_DAY * HOURLY_RATE;
    const permEarned = round2((PERM_SALARY * PERM_DAYS.length) / 28);   // Feb 2026

    // The hourly line must show its working — hours × rate, not a bare total.
    let detail = await req('GET', `/finance/invoices/${made.invoiceId}`, { token });
    let items = detail.body?.line_items ?? [];
    const hourlyLine = items.find((i) => /ghante wali.*salary/i.test(i.description ?? ''));
    check('the hourly staff member has a line item', !!hourlyLine,
      items.map((i) => i.description));
    check('the hourly line adds up to hours × rate',
      Math.abs(Number(hourlyLine?.amount ?? 0) - hourlyEarned) < 1,
      { got: hourlyLine?.amount, expected: hourlyEarned });
    const permLine = items.find((i) => /perm wali.*salary/i.test(i.description ?? ''));
    check('the permanent line is pro-rated on days',
      Math.abs(Number(permLine?.amount ?? 0) - permEarned) < 1,
      { got: permLine?.amount, expected: permEarned });

    // §F4 — the line shows its working, so the client can check the total.
    check('the hourly line spells out hours × rate',
      new RegExp(`${HOURLY_DAYS.length * HOURS_PER_DAY} hours × ₹${HOURLY_RATE}`)
        .test(hourlyLine?.description ?? ''),
      hourlyLine?.description);
    check('the permanent line spells out the days pro-rated',
      new RegExp(`${PERM_DAYS.length} of 28 days`).test(permLine?.description ?? ''),
      permLine?.description);

    // The hourly placement's fee is per hour, not per month — deriving it from
    // the placement's (null) monthly fee billed nothing at all.
    const hourlyFeeLine = items.find((i) => /ghante wali.*management fee/i.test(i.description ?? ''));
    check('the hourly placement is charged a management fee too',
      Math.abs(Number(hourlyFeeLine?.amount ?? 0) - HOURLY_DAYS.length * HOURS_PER_DAY * 30) < 1,
      { got: hourlyFeeLine?.amount, expected: HOURLY_DAYS.length * HOURS_PER_DAY * 30 });

    // ── someone joins after the invoice was raised ────────────────────────
    // This is what the lookup's button is really for: a third staff member
    // starts mid-month, their payroll runs, and their work has to reach the
    // client's existing draft rather than becoming a second invoice.
    const late = await db.query(
      `INSERT INTO staff_applicants
         (id, staff_code, series, full_name, mobile, date_of_birth, address, branch_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'F1UC003', 'MAID', 'Baad Wali', '9700000033',
               '1995-01-01', 'Test address', $1, now(), now()) RETURNING id`,
      [branchId],
    );
    made.staffIds.push(late.rows[0].id);
    const latePlacement = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               hourly_rate, hourly_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'TEMPORARY', 100, 20, 2,
               make_date($4,$5,1), now(), now()) RETURNING id`,
      [late.rows[0].id, made.customerId, branchId, TEST_YEAR, TEST_MONTH],
    );
    made.placementIds.push(latePlacement.rows[0].id);
    await markAttendance(late.rows[0].id, latePlacement.rows[0].id, [20, 21], 2);  // 4 hrs × ₹100

    const lateGen = await req('POST', '/finance/payroll/attendance-generate', {
      token, body: { code: 'F1UC003', month: TEST_MONTH, year: TEST_YEAR },
    });
    check('payroll runs for the staff member who joined later',
      lateGen.status === 200 || lateGen.status === 201, lateGen.status);

    look = await req('GET', '/finance/invoices/by-unit-code' + q, { token });
    check('the later joiner shows as waiting on the open draft',
      look.body?.un_invoiced?.staff_count === 1, look.body?.un_invoiced);

    const amend = await req('POST', '/finance/invoices/consolidated/generate', {
      token, body: { customer_id: made.customerId, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('pressing create again amends rather than duplicating',
      amend.status === 200 || amend.status === 201, amend.status);

    look = await req('GET', '/finance/invoices/by-unit-code' + q, { token });
    check('the later joiner is folded into the same invoice, not a new one',
      look.body?.existing_invoice?.invoice_number === firstNumber,
      { was: firstNumber, now: look.body?.existing_invoice?.invoice_number });
    check('all three placements now read as invoiced',
      (look.body?.placements ?? []).length === 3 &&
      look.body.placements.every((r) => r.invoiced === true),
      look.body?.placements?.map((r) => r.invoiced));

    detail = await req('GET', `/finance/invoices/${made.invoiceId}`, { token });
    items = detail.body?.line_items ?? [];
    check('the later joiner has their own line', items.some((i) => /baad wali/i.test(i.description ?? '')),
      items.map((i) => i.description));
    check('the invoice still reconciles to its line items', detail.body?.reconciles !== false,
      { total: detail.body?.total_amount, lines: detail.body?.line_items_total });

    // ── §B6: a single day is a real invoice ──────────────────────────────
    // "agr koi staff kisi client ke yha 1 din ke lie placed h bus to uska
    // invoice kaise bnega?" — it bills like any other, with no special case.
    const oneDayCustomer = await db.query(
      `INSERT INTO finance_customers
         (id, customer_name, unit_code, unit_name, address, pan_card, bill_no_prefix,
          status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'F1 One Day Client', 'F1-ONEDAY-01', 'One Day',
               '1, Test Lane', 'AAAPL1111C', 'F1DAY', 'ACTIVE', now(), now())
       RETURNING id`,
    );
    made.oneDayCustomerId = oneDayCustomer.rows[0].id;
    const oneDayStaff = await db.query(
      `INSERT INTO staff_applicants
         (id, staff_code, series, full_name, mobile, date_of_birth, address, branch_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'F1UC004', 'MAID', 'Ek Din Ki', '9700000044',
               '1995-01-01', 'Test address', $1, now(), now()) RETURNING id`,
      [branchId],
    );
    made.staffIds.push(oneDayStaff.rows[0].id);
    const oneDayPlacement = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                               hourly_rate, hourly_fee, shift_hours, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'TEMPORARY', 500, 100, 5,
               make_date($4,$5,1), now(), now()) RETURNING id`,
      [oneDayStaff.rows[0].id, made.oneDayCustomerId, branchId, TEST_YEAR, TEST_MONTH],
    );
    made.placementIds.push(oneDayPlacement.rows[0].id);
    await markAttendance(oneDayStaff.rows[0].id, oneDayPlacement.rows[0].id, [17], 5);  // one day, 5 hrs

    const oneDayRun = await req('POST', '/finance/payroll/attendance-generate', {
      token, body: { code: 'F1UC004', month: TEST_MONTH, year: TEST_YEAR },
    });
    check('payroll runs for a one-day placement',
      oneDayRun.status === 200 || oneDayRun.status === 201, oneDayRun.status);

    const oneDayIssue = await req('POST', '/finance/invoices/consolidated/generate', {
      token, body: { customer_id: made.oneDayCustomerId, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('a one-day client bills from the unit code like any other',
      oneDayIssue.status === 200 || oneDayIssue.status === 201, oneDayIssue.status);

    const oneDayLook = await req(
      'GET', `/finance/invoices/by-unit-code?unit_code=F1-ONEDAY-01&month=${TEST_MONTH}&year=${TEST_YEAR}`,
      { token },
    );
    check('one day produces a real invoice', !!oneDayLook.body?.existing_invoice?.invoice_number,
      oneDayLook.body?.existing_invoice);

    made.oneDayInvoiceId = oneDayLook.body?.existing_invoice?.id;
    const oneDayDetail = await req('GET', `/finance/invoices/${made.oneDayInvoiceId}`, { token });
    const oneDayItems = oneDayDetail.body?.line_items ?? [];
    const oneDaySalary = oneDayItems.find((i) => /ek din ki.*salary/i.test(i.description ?? ''));
    check('the single day is priced at its hours × rate',
      Math.abs(Number(oneDaySalary?.amount ?? 0) - 5 * 500) < 1,
      { got: oneDaySalary?.amount, expected: 2500 });
    check('and says so on the line', /5 hours × ₹500/.test(oneDaySalary?.description ?? ''),
      oneDaySalary?.description);
    check('the one-day invoice reconciles', oneDayDetail.body?.reconciles !== false,
      { total: oneDayDetail.body?.total_amount, lines: oneDayDetail.body?.line_items_total });
  } finally {
    // ── cleanup ───────────────────────────────────────────────────────────
    try {
      // By number, not by the id this run happened to capture — a run that
      // dies after issuing still has to take its invoice back with it.
      const mine = await db.query(
        `SELECT id FROM client_invoices WHERE invoice_number LIKE $1 OR invoice_number LIKE 'F1DAY/%'`,
        [`${BILL_PREFIX}/%`],
      );
      for (const row of mine.rows) {
        await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [row.id]);
        await db.query(`DELETE FROM invoice_payments WHERE invoice_id = $1`, [row.id]);
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [row.id]);
        await db.query(`DELETE FROM client_invoices WHERE id = $1`, [row.id]);
      }
      if (made.staffIds.length) {
        await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staffIds]);
      }
      if (made.attendanceIds.length) {
        await db.query(`DELETE FROM staff_daily_attendance WHERE id = ANY($1::uuid[])`, [made.attendanceIds]);
      }
      if (made.placementIds.length) {
        await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placementIds]);
      }
      if (made.staffIds.length) {
        await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staffIds]);
      }
      if (made.customerId) {
        await db.query(`DELETE FROM finance_customers WHERE id = $1`, [made.customerId]);
      }
      // Anything a crashed earlier run left behind.
      await db.query(`DELETE FROM staff_applicants WHERE staff_code LIKE 'F1UC%'`);
      await db.query(`DELETE FROM finance_customers WHERE unit_code IN ($1, 'F1-ONEDAY-01')`, [UNIT_CODE]);
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
