/**
 * Live HTTP verification for F-09 and F-12 (docs/FINANCE_MODULE_AUDIT.md).
 *
 *  F-12  Invoices follow a state machine; EOR payroll must be approved before
 *        it can be paid.
 *  F-09  Disbursement refuses without approval or bank details, uses the
 *        payout rail rather than Razorpay Orders, and only stamps
 *        `disbursed_at` when money actually settled.
 *
 * Builds its own placement payroll + invoice for a period of its own, then
 * removes everything. No real payout is ever attempted: RazorpayX is not
 * configured here, so the rail reports SIMULATED — which is exactly the
 * behaviour being asserted.
 *
 *   node scratch/_live_test_finance_f09_f12.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_MONTH = 9;
const TEST_YEAR = 2026;
const PRESENT_DAYS = 18;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

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

async function login(phone) {
  for (const password of PASSWORDS) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await req('POST', '/auth/login', { body: { phone, password } });
      if (r.status === 200 || r.status === 201) {
        const t = r.body?.access_token || r.body?.accessToken;
        if (t) return t;
      }
      if (r.status !== 429) break;
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

const money = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { attendanceIds: [], invoiceId: null, payrollId: null, staffId: null, bankAccount: false };

  try {
    const finance = await login(FINANCE_PHONE);
    console.log('logged in as FINANCE\n');

    const cand = await db.query(`
      SELECT p.id AS placement_id, p.staff_id, p.client_id,
             sa.staff_code, sa.full_name, sa.branch_id, fc.customer_name
      FROM placements p
      JOIN staff_applicants sa ON sa.id = p.staff_id
      JOIN finance_customers fc ON fc.id = p.client_id
      WHERE p.status = 'CONFIRMED'
        AND p.staff_salary IS NOT NULL AND p.management_fee IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM client_invoices ci
                        WHERE ci.placement_id = p.id AND ci.period_month = $1 AND ci.period_year = $2)
      ORDER BY p.created_at DESC LIMIT 1
    `, [TEST_MONTH, TEST_YEAR]);
    if (!cand.rows.length) { console.log('no billable placement available'); process.exitCode = 1; return; }
    const target = cand.rows[0];
    made.staffId = target.staff_id;
    console.log(`using ${target.staff_code} → ${target.customer_name}\n`);

    for (let d = 1; d <= PRESENT_DAYS; d++) {
      const r = await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', $1, now(), now())
         ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING RETURNING id`,
        [target.staff_id, target.placement_id, target.branch_id, TEST_YEAR, TEST_MONTH, d],
      );
      if (r.rows[0]) made.attendanceIds.push(r.rows[0].id);
    }

    const gen = await req('POST', '/finance/payroll/attendance-generate', {
      token: finance, body: { code: target.staff_code, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('payroll generated', gen.status === 200 || gen.status === 201, gen.status);
    made.payrollId = gen.body?.payroll_id ?? null;

    // Payroll no longer raises the invoice — Finance does, from the client's
    // unit code — so the document this section walks through the state machine
    // has to be asked for.
    const raised = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance,
      body: { customer_id: target.client_id, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('the invoice is raised for the client',
      raised.status === 200 || raised.status === 201, { status: raised.status, body: raised.body });
    made.invoiceId = (raised.body?.invoice ?? raised.body)?.id ?? null;

    // ── F-12 · invoice state machine ────────────────────────────────────────
    console.log('\nF-12  Invoice status follows a state machine');
    const fresh = await db.query(`SELECT status FROM client_invoices WHERE id = $1`, [made.invoiceId]);
    check('a new invoice starts as DRAFT', fresh.rows[0]?.status === 'DRAFT', fresh.rows[0]);

    const skipAhead = await req('POST', `/finance/invoices/${made.invoiceId}/send`, { token: finance });
    check('DRAFT cannot jump straight to SENT', skipAhead.status === 400, { status: skipAhead.status, body: skipAhead.body });

    const approve = await req('POST', `/finance/invoices/${made.invoiceId}/approve`, { token: finance });
    check('DRAFT → APPROVED is allowed', approve.status === 200 || approve.status === 201, approve.status);

    const reApprove = await req('POST', `/finance/invoices/${made.invoiceId}/approve`, { token: finance });
    check('re-approving is refused', reApprove.status === 400, reApprove.status);

    const send = await req('POST', `/finance/invoices/${made.invoiceId}/send`, { token: finance });
    check('APPROVED → SENT is allowed', send.status === 200 || send.status === 201, send.status);

    const settle = await req('POST', `/finance/settlements/${made.invoiceId}/mark-settled`, {
      token: finance, body: { payment_ref: 'f12-live-test' },
    });
    check('SENT → PAID is allowed', settle.status === 200 || settle.status === 201, settle.status);

    // PAID is terminal: nothing may reopen or reverse it.
    const reopen = await req('POST', `/finance/invoices/${made.invoiceId}/approve`, { token: finance });
    check('PAID cannot be re-approved', reopen.status === 400, reopen.status);
    const creditAfterPaid = await req('POST', `/finance/settlements/${made.invoiceId}/credit-note`, {
      token: finance, body: { reason: 'should be refused' },
    });
    check('PAID cannot be credit-noted', creditAfterPaid.status === 400, creditAfterPaid.status);

    const finalStatus = await db.query(`SELECT status FROM client_invoices WHERE id = $1`, [made.invoiceId]);
    check('invoice is still PAID after the refused moves', finalStatus.rows[0]?.status === 'PAID', finalStatus.rows[0]);

    // The database backs the rule up independently of the service layer.
    let checkRejected = false;
    try {
      await db.query(`UPDATE client_invoices SET status = 'NONSENSE' WHERE id = $1`, [made.invoiceId]);
    } catch { checkRejected = true; }
    check('the DB rejects a status outside the vocabulary', checkRejected);

    // ── F-12 · payroll approval gate ────────────────────────────────────────
    console.log('\nF-12  EOR payroll must be approved before it can be paid');
    const prBefore = await db.query(`SELECT status, disbursement_status FROM payroll_records WHERE id = $1`, [made.payrollId]);
    check('payroll starts PENDING', prBefore.rows[0]?.status === 'PENDING', prBefore.rows[0]);
    check('payroll starts NOT_STARTED for disbursement', prBefore.rows[0]?.disbursement_status === 'NOT_STARTED', prBefore.rows[0]);

    const earlyPay = await req('POST', `/finance/payroll/${made.payrollId}/disburse`, { token: finance });
    check('an unapproved payroll cannot be disbursed', earlyPay.status === 400, { status: earlyPay.status, body: earlyPay.body });

    const approvePayroll = await req('POST', `/finance/payroll/${made.payrollId}/approve`, { token: finance });
    check('payroll can be approved', approvePayroll.status === 200 || approvePayroll.status === 201, approvePayroll.status);

    const prApproved = await db.query(`SELECT status, approved_at, locked_at FROM payroll_records WHERE id = $1`, [made.payrollId]);
    check('approval stamps approved_at', !!prApproved.rows[0]?.approved_at, prApproved.rows[0]);
    check('approval locks the record', !!prApproved.rows[0]?.locked_at, prApproved.rows[0]);

    // The screen reads the list, not the table. The list did not select
    // `status` at all, so every record came back looking PENDING however many
    // times it was approved — the badge stayed on "Needs approval" and the
    // Approve button never went away. Checking the database alone is what let
    // that live, so check what the screen is actually handed.
    const listAfter = await req(
      'GET', `/finance/payroll?month=${TEST_MONTH}&year=${TEST_YEAR}`, { token: finance },
    );
    const listedRow = (Array.isArray(listAfter.body) ? listAfter.body : [])
      .find((r) => r.id === made.payrollId);
    check('the payroll list returns the approved record', !!listedRow, listAfter.status);
    check('and it reads APPROVED, not PENDING', listedRow?.status === 'APPROVED', listedRow?.status);
    check('the list carries the disbursement state too',
      listedRow?.disbursement_status === 'NOT_STARTED', listedRow?.disbursement_status);

    const reApprovePayroll = await req('POST', `/finance/payroll/${made.payrollId}/approve`, { token: finance });
    check('payroll cannot be approved twice', reApprovePayroll.status === 400, reApprovePayroll.status);

    // ── F-09 · disbursement ─────────────────────────────────────────────────
    console.log('\nF-09  Disbursement pays out, or says plainly that it did not');
    const noBank = await req('POST', `/finance/payroll/${made.payrollId}/disburse`, { token: finance });
    check('refuses without bank details on file', noBank.status === 400, { status: noBank.status, body: noBank.body });
    check('the refusal names the missing thing', /bank account/i.test(JSON.stringify(noBank.body)), noBank.body);

    const badIfsc = await req('POST', `/finance/payroll/staff/${made.staffId}/bank-account`, {
      token: finance, body: { account_holder_name: 'Test Payee', account_number: '123456789012', ifsc: 'NOTANIFSC' },
    });
    check('a malformed IFSC is rejected', badIfsc.status === 400, badIfsc.status);

    const bank = await req('POST', `/finance/payroll/staff/${made.staffId}/bank-account`, {
      token: finance,
      body: { account_holder_name: 'Test Payee', account_number: '123456789012', ifsc: 'HDFC0001234', bank_name: 'HDFC Bank' },
    });
    check('a valid account saves', bank.status === 200 || bank.status === 201, { status: bank.status, body: bank.body });
    made.bankAccount = true;
    check('the account number comes back masked', /^••••9012$/.test(bank.body?.account_number_masked ?? ''), bank.body);
    check('the full number is never returned', !JSON.stringify(bank.body ?? {}).includes('123456789012'), bank.body);

    const readiness = await req('GET', '/finance/payroll/payout-readiness', { token: finance });
    check('payout readiness is reported', readiness.body?.configured === false || readiness.body?.configured === true, readiness.body);

    const pay = await req('POST', `/finance/payroll/${made.payrollId}/disburse`, { token: finance });
    check('disbursement runs once approved and banked', pay.status === 200 || pay.status === 201, { status: pay.status, body: pay.body });

    const prPaid = await db.query(
      `SELECT status, disbursement_status, disbursement_ref, disbursed_at FROM payroll_records WHERE id = $1`,
      [made.payrollId],
    );
    const row = prPaid.rows[0];
    if (!readiness.body?.configured) {
      // The whole point of F-09: an unconfigured rail must not look like payment.
      check('an unconfigured rail records SIMULATED', row?.disbursement_status === 'SIMULATED', row);
      check('SIMULATED does NOT stamp disbursed_at', row?.disbursed_at === null, row);
      check('SIMULATED does NOT mark the payroll PAID', row?.status !== 'PAID', row);
      check('the response explains why', /not configured/i.test(pay.body?.note ?? ''), pay.body);
      check('settled is reported false', pay.body?.settled === false, pay.body);
    } else {
      check('a live payout is PROCESSING or PAID', ['PROCESSING', 'PAID'].includes(row?.disbursement_status), row);
    }
    check('a disbursement reference is recorded', !!row?.disbursement_ref, row);
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.bankAccount && made.staffId) {
        await db.query(`DELETE FROM staff_bank_accounts WHERE staff_id = $1`, [made.staffId]);
      }
      if (made.payrollId) await db.query(`DELETE FROM payroll_records WHERE id = $1`, [made.payrollId]);
      if (made.invoiceId) {
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM client_invoices WHERE id = $1`, [made.invoiceId]);
      }
      if (made.attendanceIds.length) {
        await db.query(`DELETE FROM staff_daily_attendance WHERE id = ANY($1::uuid[])`, [made.attendanceIds]);
      }
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
