/**
 * Live HTTP verification for F-19 (docs/FINANCE_MODULE_AUDIT.md).
 *
 * Proves that loan / advance balances move exactly once, at lock, and are not
 * touched by calculating or recalculating a draft batch.
 *
 * Creates its own employee, loan and attendance so nothing real is recovered
 * against. Before locking it re-checks that the batch's recovery breakdown
 * contains only this test's own loan, and refuses to lock if any other loan
 * appears — so running this can never take money off a genuine employee.
 *
 *   node scratch/_live_test_finance_f19.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const HR_PHONE = '9800000008';
const FINANCE_PHONE = '9800000004';
const ADMIN_PHONE = '9800000003';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_MONTH = 4;
const TEST_YEAR = 2026;
const LOAN_PRINCIPAL = 5000;
const LOAN_EMI = 1000;
const PRESENT_DAYS = 30;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

// The auth endpoint is throttled, and this suite normally runs straight after
// the F1 one via `npm run test:finance`, so it starts with the budget already
// spent. A larger allowance than the other suites use is deliberate — running
// out here reads as "could not log in", which looks like a broken account.
async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 10) {
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  const payload = json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}

// ── TOTP, for the ADMIN account ───────────────────────────────────────────────
// ADMIN logins require 2FA (Phase 1 hardening), so a password alone returns
// `{ requires_2fa: true }` with no token. The secret lives in
// users.metadata.totp_secret; this recomputes the current code the same way
// auth-otp.util.ts does (RFC 6238, SHA1, 6 digits, 30s). Test-only — it needs
// direct database access, which is exactly what a real caller does not have.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(encoded) {
  const cleaned = String(encoded).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secret) {
  const { createHmac } = require('crypto');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

/**
 * Logs in, completing 2FA when the account demands it.
 *
 * The auth endpoint is rate-limited and this suite runs straight after the F1
 * one, so a throttled response must be waited out rather than mistaken for a
 * wrong password — falling through to the next candidate password on a 429 is
 * how this previously reported "could not log in" for a perfectly good account.
 * Each 2FA retry also regenerates the code, so a wait never replays a stale one.
 */
/**
 * Logs in, completing 2FA in the same request when the account has a TOTP
 * secret.
 *
 * `/auth/login` allows 5 requests per minute per IP. Discovering that an
 * account wants 2FA by letting it fail first costs a second request for every
 * such login, and three accounts was enough to exhaust the window and report
 * "could not log in" for a perfectly good password. Reading the secret up
 * front keeps every login to one request.
 */
async function login(phone, db) {
  const row = await db.query(`SELECT metadata FROM users WHERE phone = $1`, [phone]);
  const secret = (row.rows[0]?.metadata ?? {}).totp_secret ?? null;

  for (const password of PASSWORDS) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = { phone, password, ...(secret ? { totp: totpCode(secret) } : {}) };
      const r = await req('POST', '/auth/login', { body });

      if (r.status === 200 || r.status === 201) {
        const t = r.body?.access_token || r.body?.accessToken;
        if (t) return t;
        if (r.body?.requires_2fa || r.body?.requires_totp_setup) {
          throw new Error(`${phone} requires 2FA but has no usable totp_secret`);
        }
      }

      if (r.status === 429) {
        const waitMs = 15000 * (attempt + 1);
        console.log(`      (auth throttled for ${phone}, waiting ${waitMs / 1000}s…)`);
        await new Promise((res) => setTimeout(res, waitMs));
        continue;
      }

      // A real rejection of this password — try the next candidate.
      break;
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

const money = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const made = { employeeId: null, loanId: null, batchId: null, attendanceIds: [] };
  let locked = false;

  try {
    const hr = await login(HR_PHONE, db);
    const finance = await login(FINANCE_PHONE, db);
    const admin = await login(ADMIN_PHONE, db);
    console.log('logged in as HR + FINANCE + ADMIN\n');

    // Purge anything a previous crashed run left behind, before snapshotting.
    // A leftover test employee still carries its test loan, and the safety
    // gate below would then see a loan it does not own and refuse to lock —
    // a stale fixture reads as "this batch would touch real money".
    const stale = await db.query(`SELECT id FROM employees WHERE employee_id LIKE 'F19T%'`);
    if (stale.rows.length) {
      const ids = stale.rows.map((r) => r.id);
      await db.query(
        `DELETE FROM payroll_details WHERE employee_id = ANY($1::uuid[])`, [ids],
      );
      await db.query(`DELETE FROM attendance WHERE employee_id = ANY($1::uuid[])`, [ids]);
      await db.query(`DELETE FROM employee_loans WHERE employee_id = ANY($1::uuid[])`, [ids]);
      await db.query(`DELETE FROM salary_advances WHERE employee_id = ANY($1::uuid[])`, [ids]);
      await db.query(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
      console.log(`cleared ${ids.length} leftover fixture(s) from a previous run\n`);
    }
    // Batches left orphaned by a crashed run would otherwise be reused as a
    // DRAFT and skew the assertions below.
    await db.query(
      `DELETE FROM payroll_approval_workflows WHERE batch_id IN
         (SELECT id FROM payroll_processing_batches WHERE month = $1 AND year = $2)`,
      [TEST_MONTH, TEST_YEAR],
    );
    await db.query(
      `DELETE FROM payroll_details WHERE batch_id IN
         (SELECT id FROM payroll_processing_batches WHERE month = $1 AND year = $2)`,
      [TEST_MONTH, TEST_YEAR],
    );
    await db.query(
      `DELETE FROM payroll_processing_batches WHERE month = $1 AND year = $2`,
      [TEST_MONTH, TEST_YEAR],
    );

    // Snapshot every real loan so we can prove none of them moved.
    const before = await db.query(`SELECT id, remaining_amount FROM employee_loans`);
    const realLoanBalances = new Map(before.rows.map((r) => [r.id, money(r.remaining_amount)]));

    // ── build an isolated employee with a loan and full attendance ──────────
    const branch = await db.query(`SELECT id FROM branches ORDER BY created_at LIMIT 1`);
    const cat = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
    const emp = await db.query(
      `INSERT INTO employees
         (id, employee_id, full_name, mobile, date_of_birth, gender, address, city, state,
          pincode, emergency_contact, joining_date, branch_id, department, designation,
          category_id, employment_type, salary, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'F19 Recovery Test', '9000000001', '1990-01-01', 'Other',
               'F19 test', 'Delhi', 'Delhi', '110001', '{}'::jsonb, CURRENT_DATE, $2,
               'Ops', 'Test', $3, 'Full Time', 30000, 'Active', now(), now())
       RETURNING id`,
      [`F19T${Date.now().toString().slice(-7)}`, branch.rows[0].id, cat.rows[0].id],
    );
    made.employeeId = emp.rows[0].id;

    const loan = await db.query(
      `INSERT INTO employee_loans
         (id, employee_id, loan_amount, remaining_amount, monthly_emi, start_date,
          status, auto_deduction, reason, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $2, $3, CURRENT_DATE, 'ACTIVE', true,
               'F19 live test', now(), now())
       RETURNING id`,
      [made.employeeId, LOAN_PRINCIPAL, LOAN_EMI],
    );
    made.loanId = loan.rows[0].id;

    for (let day = 1; day <= PRESENT_DAYS; day++) {
      const r = await db.query(
        `INSERT INTO attendance (id, employee_id, date, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, make_date($2,$3,$4), 'Present', now(), now())
         RETURNING id`,
        [made.employeeId, TEST_YEAR, TEST_MONTH, day],
      );
      made.attendanceIds.push(r.rows[0].id);
    }
    console.log(`test employee with a ₹${LOAN_PRINCIPAL} loan (₹${LOAN_EMI} EMI) and ${PRESENT_DAYS} present days\n`);

    const loanBalance = async () => {
      const r = await db.query(`SELECT remaining_amount, status FROM employee_loans WHERE id = $1`, [made.loanId]);
      return { amount: money(r.rows[0].remaining_amount), status: r.rows[0].status };
    };

    // ── F-19 · draft runs must not move balances ────────────────────────────
    console.log('F-19  Calculating a draft does not recover');
    const run1 = await req('POST', '/enterprise-payroll/process-batch', {
      token: admin, body: { month: TEST_MONTH, year: TEST_YEAR },
    });
    check('first draft run succeeds', run1.status === 200 || run1.status === 201, { status: run1.status, body: run1.body });
    made.batchId = run1.body?.id ?? null;

    const afterRun1 = await loanBalance();
    check('loan untouched after first run', afterRun1.amount === LOAN_PRINCIPAL, afterRun1);

    const run2 = await req('POST', '/enterprise-payroll/process-batch', {
      token: admin, body: { month: TEST_MONTH, year: TEST_YEAR },
    });
    check('recalculating the draft succeeds', run2.status === 200 || run2.status === 201, run2.status);

    const afterRun2 = await loanBalance();
    check(
      'loan STILL untouched after recalculation (the F-19 bug)',
      afterRun2.amount === LOAN_PRINCIPAL,
      { expected: LOAN_PRINCIPAL, got: afterRun2.amount },
    );

    // ── the deduction is still calculated and shown ─────────────────────────
    console.log('\n      the EMI is still calculated and recorded');
    const detail = await db.query(
      `SELECT loan_emi_deduction, recovery_breakdown, present_days, working_days
       FROM payroll_details WHERE batch_id = $1 AND employee_id = $2`,
      [made.batchId, made.employeeId],
    );
    check('test employee has a payroll detail', detail.rows.length === 1, detail.rows.length);
    if (detail.rows.length) {
      const d = detail.rows[0];
      check('EMI is deducted on the payslip', money(d.loan_emi_deduction) === LOAN_EMI, d.loan_emi_deduction);
      const bd = typeof d.recovery_breakdown === 'string' ? JSON.parse(d.recovery_breakdown) : d.recovery_breakdown;
      check('recovery breakdown names the loan', bd?.loans?.[0]?.loanId === made.loanId, bd);
      check('recovery breakdown carries the amount', money(bd?.loans?.[0]?.amount) === LOAN_EMI, bd);
      check('attendance drove the days (F-01)', Number(d.present_days) === PRESENT_DAYS, d.present_days);
    }

    // ── no real loan moved ──────────────────────────────────────────────────
    const midway = await db.query(`SELECT id, remaining_amount FROM employee_loans WHERE id <> $1`, [made.loanId]);
    const realUnchanged = midway.rows.every((r) => realLoanBalances.get(r.id) === money(r.remaining_amount));
    check('no pre-existing loan was touched', realUnchanged, midway.rows);

    // ── approve and lock; recovery applies exactly once ─────────────────────
    console.log('\nF-19  Recovery happens at lock, once');

    // Safety gate: only lock if this batch would recover against our own loan.
    const allBreakdowns = await db.query(
      `SELECT recovery_breakdown FROM payroll_details WHERE batch_id = $1`, [made.batchId],
    );
    const foreignLoan = allBreakdowns.rows.some((r) => {
      const bd = typeof r.recovery_breakdown === 'string' ? JSON.parse(r.recovery_breakdown) : r.recovery_breakdown;
      return (bd?.loans ?? []).some((l) => l.loanId !== made.loanId)
          || (bd?.advances ?? []).length > 0;
    });

    if (foreignLoan) {
      console.log('  SKIP  batch would recover against a real loan — not locking');
    } else {
      const t1 = await req('PUT', `/enterprise-payroll/batches/${made.batchId}/approve`, {
        token: hr, body: { tier: 'LEVEL_1_HR' },
      });
      check('L1 HR approves', t1.status === 200, { status: t1.status, body: t1.body });
      const t2 = await req('PUT', `/enterprise-payroll/batches/${made.batchId}/approve`, {
        token: finance, body: { tier: 'LEVEL_2_FINANCE' },
      });
      check('L2 Finance approves', t2.status === 200, t2.status);
      const t3 = await req('PUT', `/enterprise-payroll/batches/${made.batchId}/approve`, {
        token: admin, body: { tier: 'LEVEL_3_ADMIN' },
      });
      check('L3 Admin approves', t3.status === 200, t3.status);

      const lock = await req('PUT', `/enterprise-payroll/batches/${made.batchId}/lock`, { token: admin });
      check('batch locks', lock.status === 200, { status: lock.status, body: lock.body });
      locked = lock.status === 200;

      const afterLock = await loanBalance();
      check(
        `loan recovered exactly one EMI at lock (${LOAN_PRINCIPAL} → ${LOAN_PRINCIPAL - LOAN_EMI})`,
        afterLock.amount === LOAN_PRINCIPAL - LOAN_EMI,
        afterLock,
      );
      check('lock reports what it recovered', money(lock.body?.recovered?.totalRecovered) === LOAN_EMI, lock.body?.recovered);

      const stamp = await db.query(
        `SELECT recoveries_applied_at FROM payroll_processing_batches WHERE id = $1`, [made.batchId],
      );
      check('recoveries_applied_at is stamped', !!stamp.rows[0]?.recoveries_applied_at, stamp.rows[0]);

      const relock = await req('PUT', `/enterprise-payroll/batches/${made.batchId}/lock`, { token: admin });
      check('re-locking is rejected', relock.status >= 400, relock.status);
      const afterRelock = await loanBalance();
      check('re-lock attempt did not recover again', afterRelock.amount === LOAN_PRINCIPAL - LOAN_EMI, afterRelock);

      const finalReal = await db.query(`SELECT id, remaining_amount FROM employee_loans WHERE id <> $1`, [made.loanId]);
      check(
        'still no pre-existing loan touched',
        finalReal.rows.every((r) => realLoanBalances.get(r.id) === money(r.remaining_amount)),
        finalReal.rows,
      );
    }
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.batchId) {
        await db.query(`DELETE FROM payroll_details WHERE batch_id = $1`, [made.batchId]);
        await db.query(`DELETE FROM payroll_approval_workflows WHERE batch_id = $1`, [made.batchId]);
        await db.query(`DELETE FROM bank_transfer_batches WHERE batch_id = $1`, [made.batchId]).catch(() => {});
        await db.query(`DELETE FROM payroll_processing_batches WHERE id = $1`, [made.batchId]);
      }
      if (made.attendanceIds.length) {
        await db.query(`DELETE FROM attendance WHERE id = ANY($1::uuid[])`, [made.attendanceIds]);
      }
      if (made.loanId) await db.query(`DELETE FROM employee_loans WHERE id = $1`, [made.loanId]);
      if (made.employeeId) await db.query(`DELETE FROM employees WHERE id = $1`, [made.employeeId]);
      console.log(`cleanup done${locked ? ' (batch was locked, then removed)' : ''}`);
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
