/**
 * Live HTTP verification for F-18 and F-20.
 *
 *   F-18  A credit note is a real document with its own number, amount and
 *         proportional GST reversal — and analytics stops counting what was
 *         credited back.
 *   F-20  PF is computed on one rule across every payroll path, using the base
 *         actually agreed rather than three different implicit ones.
 *
 *   node scratch/_live_test_finance_f18_f20.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

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
  const made = { invoiceIds: [], noteIds: [], customerId: null, seqBefore: null, cnSeqBefore: null };

  try {
    const finance = await login(FINANCE_PHONE);
    console.log('logged in as FINANCE\n');

    // ── build two invoices of our own to credit ─────────────────────────────
    const cust = (await db.query(
      `SELECT id, bill_no_prefix, bill_seq, credit_note_seq FROM finance_customers ORDER BY created_at LIMIT 1`,
    )).rows[0];
    made.customerId = cust.id;
    made.seqBefore = cust.bill_seq;
    made.cnSeqBefore = cust.credit_note_seq;

    // salary 10000, fee 2000, GST 360 (18% of fee), total 12360 — round
    // numbers make the proportional reversal easy to read.
    const mkInvoice = async (suffix) => {
      const r = await db.query(
        `INSERT INTO client_invoices
           (id, placement_id, client_id, invoice_number, period_month, period_year,
            staff_salary_component, management_fee, gst_amount, esic_employer, pf_employer,
            total_amount, due_date, status, taxable_value, cgst_amount, sgst_amount, igst_amount)
         VALUES (gen_random_uuid(), NULL, $1, $2, 12, 2026, 10000, 2000, 360, 0, 0,
                 12360, CURRENT_DATE, 'SENT', 2000, 180, 180, 0)
         RETURNING id, invoice_number, total_amount`,
        [cust.id, `F18TEST/${Date.now().toString().slice(-6)}/${suffix}`],
      );
      made.invoiceIds.push(r.rows[0].id);
      return r.rows[0];
    };
    const invFull = await mkInvoice('A');
    const invPartial = await mkInvoice('B');

    // ── F-18 · a credit note is a real document ────────────────────────────
    console.log('F-18  Credit notes are documents, not a status flip');

    const noRes = await req('POST', `/finance/settlements/${invFull.id}/credit-note`, {
      token: finance, body: { reason: '' },
    });
    check('a credit note without a reason is refused', noRes.status === 400, noRes.status);

    const full = await req('POST', `/finance/settlements/${invFull.id}/credit-note`, {
      token: finance, body: { reason: 'Client disputed the whole month' },
    });
    check('a full credit note issues', full.status === 200 || full.status === 201, { status: full.status, body: full.body });
    const fullNote = full.body;
    check('it has its own number', /^CN\//.test(fullNote?.credit_note_number ?? ''), fullNote?.credit_note_number);
    check('it credits the whole invoice', money(fullNote?.credit_amount) === 12360, fullNote?.credit_amount);
    check('it is marked a full reversal', fullNote?.is_full_reversal === true, fullNote);

    // GST reverses in proportion, and only the fee ever carried tax.
    check('tax reverses in full too',
      money(fullNote?.tax_reversed?.cgst) === 180 && money(fullNote?.tax_reversed?.sgst) === 180,
      fullNote?.tax_reversed);
    check('taxable value reversed is the fee, not the total',
      money(fullNote?.tax_reversed?.taxable_value) === 2000, fullNote?.tax_reversed);

    const storedNote = (await db.query(
      `SELECT * FROM credit_notes WHERE invoice_id = $1`, [invFull.id],
    )).rows[0];
    made.noteIds.push(storedNote?.id);
    check('the note is persisted', !!storedNote, storedNote);
    check('the reason is stored', /disputed/i.test(storedNote?.reason ?? ''), storedNote?.reason);
    check('the note records who issued it', storedNote?.issued_by !== undefined, storedNote?.issued_by);

    const invAfter = (await db.query(
      `SELECT status, credited_amount FROM client_invoices WHERE id = $1`, [invFull.id],
    )).rows[0];
    check('a full reversal moves the invoice to CREDIT_NOTE', invAfter?.status === 'CREDIT_NOTE', invAfter);
    check('the credited amount is recorded on the invoice', money(invAfter?.credited_amount) === 12360, invAfter);

    const again = await req('POST', `/finance/settlements/${invFull.id}/credit-note`, {
      token: finance, body: { reason: 'second attempt' },
    });
    check('a fully-credited invoice cannot be credited again', again.status === 400, again.status);

    // ── F-18 · partial credit ───────────────────────────────────────────────
    console.log('\nF-18  Partial credits leave the invoice payable for the balance');

    const tooMuch = await req('POST', `/finance/settlements/${invPartial.id}/credit-note`, {
      token: finance, body: { reason: 'over', amount: 99999 },
    });
    check('crediting more than the invoice is refused', tooMuch.status === 400, tooMuch.status);

    const partial = await req('POST', `/finance/settlements/${invPartial.id}/credit-note`, {
      token: finance, body: { reason: 'One day disputed', amount: 6180 },
    });
    check('a partial credit issues', partial.status === 200 || partial.status === 201, partial.status);
    const pNote = partial.body;
    made.noteIds.push(pNote?.credit_note?.id);
    check('it is not a full reversal', pNote?.is_full_reversal === false, pNote);
    check('tax reverses proportionally (half)',
      money(pNote?.tax_reversed?.cgst) === 90 && money(pNote?.tax_reversed?.sgst) === 90,
      pNote?.tax_reversed);
    check('it reports what is left', money(pNote?.remaining_on_invoice) === 6180, pNote?.remaining_on_invoice);

    const partialInv = (await db.query(
      `SELECT status, credited_amount FROM client_invoices WHERE id = $1`, [invPartial.id],
    )).rows[0];
    check('a partial credit leaves the invoice status alone', partialInv?.status === 'SENT', partialInv);
    check('but records the credited amount', money(partialInv?.credited_amount) === 6180, partialInv);

    const second = await req('POST', `/finance/settlements/${invPartial.id}/credit-note`, {
      token: finance, body: { reason: 'Rest of it too', amount: 6180 },
    });
    check('the balance can be credited afterwards', second.status === 200 || second.status === 201, second.status);
    made.noteIds.push(second.body?.credit_note?.id);
    const afterSecond = (await db.query(
      `SELECT credited_amount FROM client_invoices WHERE id = $1`, [invPartial.id],
    )).rows[0];
    check('credits accumulate', money(afterSecond?.credited_amount) === 12360, afterSecond);

    const notes = await req('GET', '/finance/settlements/credit-notes', { token: finance });
    check('credit notes are listable', Array.isArray(notes.body) && notes.body.length >= 3, notes.body?.length);
    check('each carries its original invoice number',
      (notes.body ?? []).slice(0, 3).every((n) => !!n.original_invoice_number), notes.body?.[0]);

    const numbers = new Set((notes.body ?? []).map((n) => n.credit_note_number));
    check('every credit-note number is distinct', numbers.size === (notes.body ?? []).length, [...numbers].slice(0, 5));

    const seqNow = (await db.query(
      `SELECT credit_note_seq FROM finance_customers WHERE id = $1`, [made.customerId],
    )).rows[0];
    check('the credit-note series advanced once per note',
      seqNow.credit_note_seq === made.cnSeqBefore + 3, { before: made.cnSeqBefore, after: seqNow.credit_note_seq });

    // ── F-18 · revenue nets the reversal off ────────────────────────────────
    console.log('\nF-18  Revenue no longer counts what was credited back');
    const revenue = await req('GET', '/finance/analytics/revenue', { token: finance });
    const dec = (revenue.body ?? []).find((m) => m.period_month === 12 && m.period_year === 2026);
    // Both test invoices are fully credited, so neither should contribute.
    check('a fully-credited invoice contributes no fee income',
      !dec || money(dec.management_fee_income) === 0, dec);

    // ── F-20 · one PF rule ──────────────────────────────────────────────────
    console.log('\nF-20  One PF base rule across every path');
    const pfb = await req('GET', '/finance/tax/pf-base', { token: finance });
    check('the PF base rule is reported', pfb.status === 200 && !!pfb.body?.current_rule, pfb.body);
    check('it defaults to the agreed base', pfb.body?.current_rule === 'AGREED_BASE', pfb.body?.current_rule);
    check('the impact report names the ceiling', money(pfb.body?.pf_ceiling) === 15000, pfb.body?.pf_ceiling);
    check('it counts placements with an agreed base',
      typeof pfb.body?.placements_with_agreed_base === 'number', pfb.body);
    check('it explains itself in words', typeof pfb.body?.note === 'string' && pfb.body.note.length > 20, pfb.body?.note);

    // Every base and gross currently sits above the ceiling, so both rules cap
    // to the same PF. The report must say that rather than imply no bases exist.
    if (pfb.body?.placements_with_agreed_base > 0 && pfb.body?.placements_that_differ === 0) {
      check('it explains why identical figures are not an absence of data',
        /ceiling/i.test(pfb.body.note), pfb.body.note);
    }

    // The arithmetic itself, independent of today's data.
    const tax = async (state, gross) => (await req('POST', '/finance/tax/preview', {
      token: finance, body: { state, monthly_gross: gross, month: 6, year: 2026 },
    })).body;
    const t = await tax('Delhi', 12000);
    check('the tax preview still works after the PF change', !!t?.professional_tax, t);

    const pfRows = await db.query(
      `SELECT COUNT(*)::int n FROM placements
       WHERE status = 'CONFIRMED' AND metadata->'wage_breakup' ? 'pfBase'`,
    );
    check('placements with an agreed base are found by the same key the resolver reads',
      pfRows.rows[0].n === pfb.body?.placements_with_agreed_base,
      { db: pfRows.rows[0].n, api: pfb.body?.placements_with_agreed_base });
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.invoiceIds.length) {
        await db.query(`DELETE FROM credit_notes WHERE invoice_id = ANY($1::uuid[])`, [made.invoiceIds]);
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = ANY($1::uuid[])`, [made.invoiceIds]);
        await db.query(`DELETE FROM payment_reminders WHERE invoice_id = ANY($1::uuid[])`, [made.invoiceIds]);
        await db.query(`DELETE FROM client_invoices WHERE id = ANY($1::uuid[])`, [made.invoiceIds]);
      }
      // Put both series back so the test leaves no gap in either.
      if (made.customerId) {
        await db.query(
          `UPDATE finance_customers SET bill_seq = $1, credit_note_seq = $2 WHERE id = $3`,
          [made.seqBefore, made.cnSeqBefore, made.customerId],
        );
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
