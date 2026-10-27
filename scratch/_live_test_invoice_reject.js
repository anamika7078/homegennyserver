/**
 * Live HTTP verification of P1 — rejecting an invoice, voiding payroll, rate
 * review, and re-running payroll.
 *
 * The case it was built for: an RM types a wrong rate, an invoice is generated
 * on it, and there was no way back — cancelling left the payroll at the wrong
 * rate, and payroll could not be re-run.
 *
 *  - only Finance rejects; a reason is required
 *  - only the latest invoice of the month can be rejected
 *  - reject: invoice CANCELLED with reason/who/when; payroll voided (kept whole
 *    in payroll_records_voided); placements REVIEW_NEEDED; RM told
 *  - the client cannot be invoiced until every placement is cleared — by a
 *    corrected rate (PATCH terms) or an RM confirmation with a note
 *  - re-invoicing uses the corrected rate
 *  - re-run of a row on a DRAFT invoice: old row voided, invoice rebuilt with
 *    the same number; refused on an approved invoice
 *  - a paid row is never voided; a later row for the same person (another
 *    client) blocks voiding an earlier one
 *  - cancelling an unsent invoice voids its payroll without a rate review
 *
 * Uses September 2025. Builds and removes its own rows.
 *
 *   node scratch/_live_test_invoice_reject.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const RM_PHONE = '9800000002';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const MONTH = 9;
const YEAR = 2025;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}`); }
}
async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
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
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken;
    if (t) return t;
  }
  throw new Error(`Could not log in as ${phone}`);
}
const day = (d) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const msg = (r) => JSON.stringify(r.body ?? '');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customers: [], staff: [], placements: [] };

  try {
    const finance = await login(FINANCE_PHONE);
    const rm = await login(RM_PHONE);
    check('finance and RM log in', !!(finance && rm));
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const rmUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE])).rows[0].id;
    const financeUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [FINANCE_PHONE])).rows[0].id;

    const client = async (tag) => {
      const c = await db.query(
        `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                        bill_no_prefix, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'x', 'x', 'New Delhi', 'Delhi', $3, 'ACTIVE', now(), now()) RETURNING id`,
        [`Reject Test ${tag}`, `REJ-${tag}`, `REJ${tag}`],
      );
      made.customers.push(c.rows[0].id);
      return c.rows[0].id;
    };
    const A = await client('A');
    const B = await client('B');
    const staff = async (code, name) => {
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [code, name, `93000000${code.slice(-2)}`, branchId],
      );
      made.staff.push(s.rows[0].id);
      return s.rows[0].id;
    };
    const place = async (staffId, clientId, type, rate, bill) => {
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', $5, 24, 'PER_DUTY', $6, $7, false, false,
                 $8::date, $8::date, now(), now()) RETURNING id`,
        [staffId, clientId, branchId, rmUserId, type, rate, bill, day(1)],
      );
      made.placements.push(p.rows[0].id);
      return p.rows[0].id;
    };
    const mark = async (staffId, placementId, days) => {
      for (const d of days) {
        await db.query(
          `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                               hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 24, $5, now(), now())`,
          [staffId, placementId, branchId, day(d), financeUserId],
        );
      }
    };

    // S1: live-in at A with a mistyped staff rate (5000 instead of 500).
    // S2: relief at A. S3: at A for 1–10, then at B for 11–20.
    const s1 = await staff('REJ01', 'Reject Live-in');
    const s2 = await staff('REJ02', 'Reject Relief');
    const s3 = await staff('REJ03', 'Reject Mover');
    const s1A = await place(s1, A, 'PERMANENT', 5000, 6000);
    const s2A = await place(s2, A, 'TEMPORARY', 450, 550);
    const s3A = await place(s3, A, 'TEMPORARY', 400, 500);
    const s3B = await place(s3, B, 'TEMPORARY', 400, 500);
    await mark(s1, s1A, range(1, 20));
    await mark(s2, s2A, [3, 13, 14]);
    await mark(s3, s3A, range(1, 10));
    await mark(s3, s3B, range(11, 20));

    const gen = (customer_id, to_date) => req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id, month: MONTH, year: YEAR, ...(to_date ? { to_date } : {}) },
    });

    let r = await gen(A, day(10));
    const inv1 = r.body?.invoice;
    check('A: invoice 1–10 generated (DRAFT)', r.status === 201 && inv1?.status === 'DRAFT', r.body);
    r = await gen(A, day(20));
    const inv2 = r.body?.invoice;
    check('A: invoice 11–20 generated (DRAFT)', r.status === 201 && inv2?.status === 'DRAFT', r.body);
    r = await gen(B, day(20));
    const invB = r.body?.invoice;
    check('B: invoice 1–20 generated (DRAFT)', r.status === 201 && invB?.status === 'DRAFT', r.body);

    // ── who and why ──────────────────────────────────────────────────────
    r = await req('POST', `/finance/invoices/${inv2.id}/reject`, { token: rm, body: { reason: 'rate is wrong on Live-in' } });
    check('RM cannot reject (403)', r.status === 403, r);
    r = await req('POST', `/finance/invoices/${inv2.id}/reject`, { token: finance, body: { reason: 'wrong' } });
    check('a reason is required (400)', r.status === 400 && /at least 10/.test(msg(r)), r.body);
    r = await req('POST', `/finance/invoices/${inv1.id}/reject`, { token: finance, body: { reason: 'rate is wrong on Live-in' } });
    check('only the latest invoice of the month can be rejected',
      r.status === 400 && new RegExp(inv2.invoice_number.replace(/[/]/g, '\\/')).test(msg(r)), r.body);

    // ── reject ───────────────────────────────────────────────────────────
    const before = (await db.query(`SELECT id, duty_rate FROM payroll_records WHERE client_invoice_id = $1`, [inv2.id])).rows;
    r = await req('POST', `/finance/invoices/${inv2.id}/reject`, {
      token: finance, body: { reason: 'Live-in staff rate typed as 5000, should be 500' },
    });
    check('Finance rejects 11–20: cancelled, 2 payroll rows voided, 2 placements for review',
      r.status === 201 && r.body?.status === 'CANCELLED' && r.body?.payroll_voided === 2 &&
        r.body?.placements_for_review?.length === 2, r.body);
    const ci = (await db.query(`SELECT status, rejected_by, rejected_at, reject_reason FROM client_invoices WHERE id = $1`, [inv2.id])).rows[0];
    check('who, when and why are on the invoice',
      ci.status === 'CANCELLED' && ci.rejected_by === financeUserId && ci.rejected_at && /5000/.test(ci.reject_reason), ci);
    const left = (await db.query(`SELECT COUNT(*)::int n FROM payroll_records WHERE id = ANY($1::uuid[])`, [before.map((x) => x.id)])).rows[0].n;
    check('the voided rows are out of payroll', left === 0, left);
    const voided = (await db.query(
      `SELECT payroll_id, void_source, row->>'duty_rate' AS duty_rate FROM payroll_records_voided WHERE client_invoice_id = $1`, [inv2.id])).rows;
    check('…and kept whole in payroll_records_voided (wrong rate still readable)',
      voided.length === 2 && voided.every((v) => v.void_source === 'REJECT') && voided.some((v) => Number(v.duty_rate) === 5000), voided);
    r = await req('GET', `/finance/invoices/${inv2.id}/voided-payroll`, { token: finance });
    check('GET voided-payroll lists them with the reason',
      r.status === 200 && r.body?.length === 2 && r.body.every((v) => /5000/.test(v.void_reason)), r.body);
    const flagged = (await db.query(
      `SELECT id, rate_review_status, rate_review_invoice_id FROM placements WHERE id = ANY($1::uuid[])`, [[s1A, s2A]])).rows;
    check('both placements on it are REVIEW_NEEDED, pointing at the invoice',
      flagged.every((p) => p.rate_review_status === 'REVIEW_NEEDED' && p.rate_review_invoice_id === inv2.id), flagged);
    const s3Flag = (await db.query(`SELECT rate_review_status FROM placements WHERE id = $1`, [s3A])).rows[0];
    check('a placement not on the invoice is not flagged', s3Flag.rate_review_status === null, s3Flag);
    const note = (await db.query(
      `SELECT body FROM notifications WHERE user_id = $1 AND title = 'Invoice rejected — check the rate' AND body LIKE $2`,
      [rmUserId, `%${inv2.invoice_number}%`])).rows;
    check('the RM is told, with the reason', note.length === 2 && /5000/.test(note[0].body), note);
    r = await req('GET', `/placements?client_id=${A}&limit=50`, { token: rm });
    const listed = (r.body?.items ?? r.body?.data ?? r.body ?? []).find?.((p) => p.id === s1A);
    check('the placement list shows the review to the RM',
      listed?.rate_review?.status === 'REVIEW_NEEDED' && /5000/.test(listed?.rate_review?.reason ?? ''), listed ?? r.body);

    // ── blocked until the RM answers ─────────────────────────────────────
    r = await gen(A, day(20));
    check('A cannot be invoiced while the rates are under review',
      r.status === 400 && /Waiting for the RM/.test(msg(r)) && /Reject Live-in/.test(msg(r)), r.body);
    r = await req('PATCH', `/placements/${s1A}/terms`, { token: rm, body: { duty_rate: 500, duty_billing_rate: 600 } });
    check('RM corrects the rate → review cleared', r.status === 200 && r.body?.rate_review === null && r.body?.duty_rate === 500, r.body);
    r = await gen(A, day(20));
    check('still blocked by the other placement, which is named',
      r.status === 400 && /Reject Relief/.test(msg(r)) && !/Reject Live-in/.test(msg(r)), r.body);
    r = await req('POST', `/placements/${s2A}/rate-review/confirm`, { token: rm, body: { note: 'ok' } });
    check('confirming needs a note', r.status === 400, r.body);
    r = await req('POST', `/placements/${s2A}/rate-review/confirm`, { token: rm, body: { note: 'Relief rate 450 is the agreed rate' } });
    check('RM confirms the relief rate stands → cleared', r.status === 201 && r.body?.rate_review === null, r.body);
    r = await req('POST', `/placements/${s2A}/rate-review/confirm`, { token: rm, body: { note: 'Relief rate 450 is the agreed rate' } });
    check('confirming again → 400 (not under review)', r.status === 400, r.body);

    // ── re-invoice at the corrected rate ────────────────────────────────
    r = await gen(A, day(20));
    const inv3 = r.body?.invoice;
    check('A: 11–20 invoiced again', r.status === 201 && inv3?.status === 'DRAFT', r.body);
    const s1Row = (await db.query(
      `SELECT id, duty_rate, duties, gross_salary FROM payroll_records WHERE client_invoice_id = $1 AND placement_id = $2`, [inv3.id, s1A])).rows[0];
    check('…with the corrected rate: 10 duties × ₹500 = ₹5,000',
      s1Row && Number(s1Row.duty_rate) === 500 && Number(s1Row.gross_salary) === 5000, s1Row);

    // ── re-run on a DRAFT invoice ───────────────────────────────────────
    // A day marked late: re-running picks it up.
    await mark(s2, s2A, [15]);
    const s2Row = (await db.query(
      `SELECT id, gross_salary FROM payroll_records WHERE client_invoice_id = $1 AND placement_id = $2`, [inv3.id, s2A])).rows[0];
    r = await req('POST', `/finance/payroll/${s2Row.id}/rerun`, { token: finance, body: { reason: 'the 15th was marked late' } });
    check('re-run: the late day is in — 3 duties × ₹450 (was 2)',
      r.status === 201 && r.body?.before?.gross_salary === 900 && r.body?.after?.gross_salary === 1350, r.body);
    check('…the draft invoice is rebuilt, same number',
      r.body?.invoice_rebuilt?.invoice_number === inv3.invoice_number, r.body?.invoice_rebuilt);
    const rr = (await db.query(`SELECT void_source FROM payroll_records_voided WHERE payroll_id = $1`, [s2Row.id])).rows;
    check('…and the old row is kept as RERUN', rr.length === 1 && rr[0].void_source === 'RERUN', rr);
    r = await req('POST', `/finance/payroll/${s2Row.id}/rerun`, { token: finance, body: {} });
    check('re-running a row that is gone → 404', r.status === 404, r.status);

    // ── approved: re-run refused; paid: never voided ────────────────────
    r = await req('POST', `/finance/invoices/${inv3.id}/approve`, { token: finance });
    check('Finance approves 11–20', r.status === 201, r.body);
    r = await req('POST', `/finance/payroll/${s1Row.id}/rerun`, { token: finance, body: {} });
    check('re-run on an approved invoice → 400, reject it instead', r.status === 400 && /Reject the invoice/.test(msg(r)), r.body);
    await db.query(`UPDATE payroll_records SET disbursed_at = NOW(), disbursement_ref = 'TEST-PAID' WHERE id = $1`, [s1Row.id]);
    r = await req('POST', `/finance/invoices/${inv3.id}/reject`, { token: finance, body: { reason: 'second look at Live-in duties' } });
    check('reject refused once a salary on it is paid — never taken back',
      r.status === 400 && /already been paid/.test(msg(r)) && /credit note/.test(msg(r)), r.body);
    const stillThere = (await db.query(`SELECT status FROM client_invoices WHERE id = $1`, [inv3.id])).rows[0];
    check('…and nothing changed', stillThere.status === 'APPROVED', stillThere);
    await db.query(`UPDATE payroll_records SET disbursed_at = NULL, disbursement_ref = NULL WHERE id = $1`, [s1Row.id]);

    // ── a later row elsewhere blocks voiding an earlier one ─────────────
    // A's latest is now 11–20 (inv3); reject it to get back to 1–10, whose
    // Mover row is followed by her B row for 11–20.
    r = await req('POST', `/finance/invoices/${inv3.id}/reject`, { token: finance, body: { reason: 'undo to test the order rule' } });
    check('reject the approved 11–20 (unpaid) → ok', r.status === 201, r.body);
    await db.query(`UPDATE placements SET rate_review_status = NULL WHERE id = ANY($1::uuid[])`, [[s1A, s2A]]);
    r = await req('POST', `/finance/invoices/${inv1.id}/reject`, { token: finance, body: { reason: 'checking the order rule' } });
    // Mover's later row at the other client is worked out from attendance,
    // not from this row, so it does not stand in the way.
    check('reject 1–10 allowed: another client’s later row does not depend on it', r.status === 201, r.body);

    // ── cancel an unsent invoice: payroll voided, no review ─────────────
    r = await req('POST', `/finance/invoices/${invB.id}/cancel`, { token: finance, body: { reason: 'raised by mistake' } });
    check('cancel B (DRAFT) → its payroll voided as CANCEL', r.status === 201 && r.body?.payroll_voided === 1, r.body);
    const bFlag = (await db.query(`SELECT rate_review_status FROM placements WHERE id = $1`, [s3B])).rows[0];
    check('…without a rate review', bFlag.rate_review_status === null, bFlag);
    const cv = (await db.query(`SELECT void_source FROM payroll_records_voided WHERE client_invoice_id = $1`, [invB.id])).rows;
    check('…kept as CANCEL', cv.length === 1 && cv[0].void_source === 'CANCEL', cv);
    r = await gen(B, day(20));
    check('B can be invoiced again straight away', r.status === 201, r.body);
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.stack || e.message}`);
  } finally {
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    for (const { id } of invs) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM payroll_records_voided WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM notifications WHERE title = 'Invoice rejected — check the rate' AND body LIKE '%Reject Test%'`).catch(() => {});
    await db.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])`, [made.placements]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
