/**
 * Live HTTP verification for the mobile endpoints added for the staff and
 * client apps.
 *
 * The one that matters most is the replacement request. It used to return a
 * made-up ticket number and write nothing anywhere — the client was told an RM
 * would call, and no RM was ever told. A silent 200 is worse than a 501,
 * because nobody goes looking for a request that appeared to work. So this
 * asserts the row actually lands in the table, not merely that the call
 * returned 201.
 *
 * Everything it creates, it removes.
 *
 *   node scratch/_live_test_mobile_endpoints.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
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
  try { json = await res.json(); } catch { /* not JSON — a PDF, say */ }
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
  return null;
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { replacementIds: [], bankAccountTouched: false, staffId: null };

  try {
    // ── who is available to test with ─────────────────────────────────────
    const staffRow = await db.query(
      `SELECT sa.id, sa.staff_code, u.phone
         FROM staff_applicants sa JOIN users u ON u.id = sa.user_id
        WHERE u.role::text = 'STAFF' AND u.is_active
        ORDER BY sa.created_at LIMIT 1`,
    );
    const clientRow = await db.query(
      `SELECT fc.id, fc.customer_name, u.phone
         FROM finance_customers fc JOIN users u ON u.id = fc.user_id
        WHERE u.role::text = 'CLIENT' AND u.is_active LIMIT 1`,
    );
    if (!staffRow.rows.length || !clientRow.rows.length) {
      console.log('no staff or client login in this database — nothing to test against');
      return;
    }
    made.staffId = staffRow.rows[0].id;

    // ── staff side ────────────────────────────────────────────────────────
    console.log(`\n[1] Staff app  (${staffRow.rows[0].staff_code})`);
    const staffToken = await login(staffRow.rows[0].phone);
    check('staff can log in', !!staffToken);
    if (!staffToken) return;

    const salary = await req('GET', '/staff/salary', { token: staffToken });
    check('salary answers', salary.status === 200, salary.status);
    check('salary is either a month or a plain reason',
      salary.body?.salary !== undefined || !!salary.body?.message, salary.body);
    if (salary.body?.salary) {
      const s = salary.body.salary;
      check('deductions reconcile to net',
        Math.abs((s.gross_salary - s.total_deductions) - s.net_salary) < 0.02,
        { gross: s.gross_salary, ded: s.total_deductions, net: s.net_salary });
      check('every house is named', Array.isArray(s.houses) && s.houses.length > 0, s.houses);
      check('the houses add up to the month',
        Math.abs(s.houses.reduce((t, h) => t + h.gross_salary, 0) - s.gross_salary) < 0.02,
        s.houses);
    }

    const slips = await req('GET', '/staff/payslips', { token: staffToken });
    check('payslip history answers', slips.status === 200, slips.status);
    check('history is newest first', (() => {
      const p = slips.body?.payslips ?? [];
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1].period_year * 12 + p[i - 1].period_month;
        const b = p[i].period_year * 12 + p[i].period_month;
        if (a < b) return false;
      }
      return true;
    })());

    // A missing month is a 200 with a reason, not an error — the app renders it.
    const old = await req('GET', '/staff/salary?month=1&year=2019', { token: staffToken });
    check('a month with no payroll is a 200 and says why',
      old.status === 200 && old.body?.salary === null && !!old.body?.message, old.body);

    const agreements = await req('GET', '/staff/agreement', { token: staffToken });
    check('agreements answer', agreements.status === 200, agreements.status);
    check('it says whether one is signed', typeof agreements.body?.hasSigned === 'boolean',
      agreements.body);

    const video = await req('GET', '/staff/video-certification', { token: staffToken });
    check('video certification answers', video.status === 200, video.status);
    check('approved never exceeds required',
      video.body?.approved <= video.body?.required, video.body);
    check('complete agrees with the count',
      video.body?.complete === (video.body?.approved >= video.body?.required), video.body);

    const notif = await req('GET', '/staff/notifications', { token: staffToken });
    check('staff notifications answer', notif.status === 200, notif.status);

    // ── bank account, the one that takes a write ──────────────────────────
    console.log('\n[2] Bank account');
    const before = await db.query(
      `SELECT * FROM staff_bank_accounts WHERE staff_id = $1::uuid`, [made.staffId],
    );
    made.bankAccountTouched = true;

    const badIfsc = await req('PUT', '/staff/bank-account', {
      token: staffToken,
      body: { account_holder_name: 'Test Name', account_number: '50100123456789', ifsc: 'NOPE' },
    });
    check('a bad IFSC is refused', badIfsc.status === 400, badIfsc.status);
    const badAcc = await req('PUT', '/staff/bank-account', {
      token: staffToken,
      body: { account_holder_name: 'Test Name', account_number: '12', ifsc: 'HDFC0000133' },
    });
    check('a two-digit account number is refused', badAcc.status === 400, badAcc.status);

    const saved = await req('PUT', '/staff/bank-account', {
      token: staffToken,
      body: {
        account_holder_name: 'Live Test Holder',
        account_number: '50100999888777',
        ifsc: 'HDFC0000133',
        bank_name: 'HDFC Bank',
      },
    });
    check('a good account saves', saved.status === 200 || saved.status === 201, saved.status);
    check('and is not verified by saving it', saved.body?.verified === false, saved.body);

    const read = await req('GET', '/staff/bank-account', { token: staffToken });
    const acct = read.body?.bankAccount;
    check('it reads back', !!acct, read.body);
    check('the number is masked, not returned whole',
      !!acct && !acct.accountNumberMasked.includes('50100999'), acct?.accountNumberMasked);
    check('the last four are shown', acct?.last4 === '8777', acct?.last4);

    // ── client side ───────────────────────────────────────────────────────
    console.log(`\n[3] Client app  (${clientRow.rows[0].customer_name})`);
    const clientToken = await login(clientRow.rows[0].phone);
    check('client can log in', !!clientToken);
    if (!clientToken) return;

    const invoices = await req('GET', '/client/invoices', { token: clientToken });
    check('invoice list answers', invoices.status === 200, invoices.status);

    const first = (invoices.body?.invoices ?? [])[0];
    if (first) {
      const detail = await req('GET', `/client/invoices/${encodeURIComponent(first.id)}`, { token: clientToken });
      check('an invoice opens by its number', detail.status === 200, detail.status);
      check('it carries line items',
        Array.isArray(detail.body?.lineItems) && detail.body.lineItems.length > 0,
        detail.body?.lineItems?.length);
      // A breakdown a customer cannot add up is worse than no breakdown.
      const sum = (detail.body?.lineItems ?? []).reduce((t, i) => t + Number(i.amount), 0);
      check('the line items add up to the total',
        Math.abs(sum - Number(detail.body?.totalAmount)) < 0.02,
        { sum, total: detail.body?.totalAmount });
      check('paid + due equals the total',
        Math.abs((Number(detail.body?.amountPaid) + Number(detail.body?.amountDue))
          - Number(detail.body?.totalAmount)) < 0.02, detail.body);
    }

    const mine = await req('GET', '/client/invoices/NOT-YOURS-0001', { token: clientToken });
    check('an invoice that is not theirs is refused',
      mine.status === 400 || mine.status === 404, mine.status);

    for (const [label, path] of [
      ['payment history', '/client/payments/history'],
      ['complaints', '/client/complaints'],
      ['client notifications', '/client/notifications'],
    ]) {
      const r = await req('GET', path, { token: clientToken });
      check(`${label} answers`, r.status === 200, r.status);
    }

    // ── the replacement request, which used to vanish ─────────────────────
    console.log('\n[4] Replacement requests are actually written down');
    const noReason = await req('POST', '/client/replacements', { token: clientToken, body: {} });
    check('a request with no reason is refused', noReason.status === 400, noReason.status);

    const placements = await db.query(
      `SELECT id FROM placements WHERE client_id = $1::uuid AND status IN ('CONFIRMED','TRIAL')`,
      [clientRow.rows[0].id],
    );
    if (placements.rows.length > 1) {
      const ambiguous = await req('POST', '/client/replacements', {
        token: clientToken, body: { reason: 'Live test — ambiguity check' },
      });
      check('with several staff placed, it asks which one', ambiguous.status === 400, ambiguous.status);
    }

    if (placements.rows.length) {
      const raised = await req('POST', '/client/replacements', {
        token: clientToken,
        body: {
          reason: 'Live test — please ignore',
          placement_id: placements.rows[0].id,
          preferred_date: '2026-12-01',
        },
      });
      check('a proper request is accepted',
        raised.status === 200 || raised.status === 201, raised.status);
      const id = raised.body?.requestId;
      if (id) made.replacementIds.push(id);

      // The whole point: it is in the table, not just in the response.
      const row = await db.query(
        `SELECT id, status, reason FROM replacement_requests WHERE id = $1::uuid`, [id],
      );
      check('the request is really in the database', row.rowCount === 1, { id, found: row.rowCount });
      check('it starts under RM review', row.rows[0]?.status === 'UNDER_RM_REVIEW', row.rows[0]?.status);

      const listed = await req('GET', '/client/replacements', { token: clientToken });
      check('the client can read it back',
        (listed.body?.requests ?? []).some((r) => r.id === id), listed.body?.total);
      check('and it names the staff member',
        !!(listed.body?.requests ?? []).find((r) => r.id === id)?.staffName,
        listed.body?.requests?.[0]);
    }
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.replacementIds.length) {
        await db.query(`DELETE FROM replacement_requests WHERE id = ANY($1::uuid[])`,
          [made.replacementIds]);
      }
      // Anything a crashed earlier run left behind.
      await db.query(`DELETE FROM replacement_requests WHERE reason LIKE 'Live test%'`);
      if (made.bankAccountTouched && made.staffId) {
        await db.query(`DELETE FROM staff_bank_accounts
                         WHERE staff_id = $1::uuid AND account_number = '50100999888777'`,
          [made.staffId]);
      }
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) process.exitCode = 1;
  }
}

main();
