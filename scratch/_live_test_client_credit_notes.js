/**
 * Live HTTP check: the client app counts credit notes.
 *
 * A credit note (a correction of a sent invoice) reduces what the client owes.
 * The client app ignored it: the invoice still showed its full total as due,
 * and the dashboard added up whole totals.
 *
 * Issues a ₹100 credit note on the demo client's visible invoice, checks the
 * list, the detail and the dashboard, then removes it and restores the invoice.
 *
 *   node scratch/_live_test_client_credit_notes.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
let pass = 0, fail = 0;
const check = (l, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 500) : ''}`); };
async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let j = null; try { j = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: j && j.success === true && 'data' in j ? j.data : j };
}
async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken; if (t) return t;
  }
  throw new Error(`no login for ${phone}`);
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  let invoice = null; let before = null; let noteId = null;
  try {
    const { rows: [c] } = await db.query(
      `SELECT fc.id, u.phone FROM finance_customers fc JOIN users u ON u.id = fc.user_id
        WHERE fc.customer_name = 'Sharma Residence' LIMIT 1`);
    const client = await login(c.phone);
    const finance = await login('9800000004');
    ({ rows: [invoice] } = await db.query(
      `SELECT id, invoice_number, total_amount::float AS total, credited_amount::float AS credited, status
         FROM client_invoices WHERE client_id = $1 AND status IN ('SENT','OVERDUE','PARTIALLY_PAID') ORDER BY created_at LIMIT 1`, [c.id]));
    if (!invoice) throw new Error('demo client has no sent invoice');
    before = (await req('GET', '/client/dashboard', { token: client })).body;
    const d0 = (await req('GET', `/client/invoices/${invoice.id}`, { token: client })).body;
    check('before: nothing credited, due = total − paid', d0.creditedAmount === invoice.credited && near(d0.amountDue, d0.totalAmount - d0.creditedAmount - d0.amountPaid), d0);

    const cn = await req('POST', `/finance/settlements/${invoice.id}/credit-note`, { token: finance, body: { reason: 'client app credit check', amount: 100 } });
    check('₹100 credit note issued', cn.status === 201, cn.body);
    noteId = cn.body?.credit_note?.id;

    const d1 = (await req('GET', `/client/invoices/${invoice.id}`, { token: client })).body;
    check('detail: creditedAmount ₹100 more', near(d1.creditedAmount, d0.creditedAmount + 100), d1.creditedAmount);
    check('detail: amount due down by ₹100', near(d1.amountDue, d0.amountDue - 100), { before: d0.amountDue, after: d1.amountDue });
    const list = (await req('GET', '/client/invoices', { token: client })).body?.invoices ?? [];
    const row = list.find((x) => x.invoiceId === invoice.id);
    check('list: the invoice carries creditedAmount', row && near(row.creditedAmount, d1.creditedAmount), row);
    const after = (await req('GET', '/client/dashboard', { token: client })).body;
    check('dashboard: outstanding down by ₹100', near(after.totalUnpaidAmount, before.totalUnpaidAmount - 100), { before: before.totalUnpaidAmount, after: after.totalUnpaidAmount });
  } catch (e) {
    fail++; console.error('  ERROR', e.message);
  } finally {
    if (noteId) {
      const { rows: [n] } = await db.query(`SELECT client_id, credit_note_seq FROM credit_notes WHERE id = $1`, [noteId]);
      await db.query(`DELETE FROM credit_notes WHERE id = $1`, [noteId]);
      if (n) await db.query(`UPDATE finance_customers SET credit_note_seq = credit_note_seq - 1 WHERE id = $1 AND credit_note_seq = $2`, [n.client_id, n.credit_note_seq]);
    }
    if (invoice) await db.query(`UPDATE client_invoices SET credited_amount = $2, status = $3 WHERE id = $1`, [invoice.id, invoice.credited, invoice.status]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
