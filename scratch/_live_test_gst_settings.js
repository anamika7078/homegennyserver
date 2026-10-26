/**
 * Live HTTP verification for the GST fixes and the Company & GST settings page.
 *
 *  - settings validate: bad GSTIN, GSTIN/state mismatch, bad SAC are refused
 *  - with no GSTIN the invoice is a Bill of Supply with no tax
 *  - an APPROVED Bill of Supply can be recalculated into a Tax Invoice once the
 *    GSTIN is in — same number, same status
 *  - place of supply is decided by state code: "HR" → IGST from Delhi,
 *    "New Delhi" → CGST+SGST, blank state → refused
 *  - the list returns taxable_value so the rate reads 18%, not "170% on fee"
 *  - cancelling releases the payroll so a corrected invoice can be issued
 *
 * Builds its own customers, staff, placements and payroll rows, and restores
 * the finance.* settings it found.
 *
 *   node scratch/_live_test_gst_settings.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const MONTH = 1;
const YEAR = 2026;
const DELHI_GSTIN = '07AABCH1234A1Z8';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 6) {
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}

async function req(method, path, { token, body, raw } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, text: await res.text() };
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

const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const url = process.env.DATABASE_URL;
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const db = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await db.connect();

  const saved = (await db.query(`SELECT key, value FROM system_settings WHERE key LIKE 'finance.%'`)).rows;
  const made = { customers: [], staff: [], placements: [] };

  try {
    const token = await login(FINANCE_PHONE);
    check('finance can log in', !!token);

    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;

    // ── fixture: three customers, one staff + payroll each ───────────────
    const fixture = async (tag, state) => {
      const c = await db.query(
        `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                        bill_no_prefix, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'Test', 'Test', 'Test', $3, $4, 'ACTIVE', now(), now())
         RETURNING id`,
        [`GST Test ${tag}`, `GSTT-${tag}`, state, `GSTT${tag}`],
      );
      const customerId = c.rows[0].id;
      made.customers.push(customerId);
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [`GSTT${tag}`, `Gst ${tag}`, `96000000${String(made.staff.length).padStart(2, '0')}`, branchId],
      );
      const staffId = s.rows[0].id;
      made.staff.push(staffId);
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type,
                                 staff_salary, management_fee, shift_hours, confirmed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', 15500, 1550, 8,
                 make_date($4,$5,1), now(), now()) RETURNING id`,
        [staffId, customerId, branchId, YEAR, MONTH],
      );
      made.placements.push(p.rows[0].id);
      // 31 of 31 days: gross 15,500, employer ESIC 503.75, PF 1,800, fee 1,550
      await db.query(
        `INSERT INTO payroll_records (id, placement_id, staff_id, period_month, period_year, shift_days,
                                      gross_salary, deductions, net_salary, esic_employer, esic_employee,
                                      pf_employer, pf_employee, placement_type, management_fee)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 31, 15500, '{}', 13583.75, 503.75, 116.25,
                 1800, 1800, 'PERMANENT', 1550)`,
        [p.rows[0].id, staffId, MONTH, YEAR],
      );
      return customerId;
    };
    const haryana = await fixture('HR', 'HR');          // abbreviation
    const delhi = await fixture('DL', 'New Delhi');     // alias
    const blank = await fixture('NA', null);            // no state
    const taxable = round2(15500 + 503.75 + 1800 + 1550);
    const gst18 = round2(taxable * 0.18);

    // ── settings validation ──────────────────────────────────────────────
    let r = await req('GET', '/finance/settings/company', { token });
    check('GET settings → 200 with states list', r.status === 200 && r.body?.states?.length > 30, r.status);

    r = await req('PUT', '/finance/settings/company', { token, body: { gstin: '07ABC' } });
    check('malformed GSTIN refused', r.status === 400, r.status);
    r = await req('PUT', '/finance/settings/company', { token, body: { gstin: DELHI_GSTIN, state: 'Haryana' } });
    check('GSTIN/state mismatch refused', r.status === 400 && /registered in Delhi/.test(JSON.stringify(r.body)), r.body);
    r = await req('PUT', '/finance/settings/company', { token, body: { sac_code: '123456' } });
    check('non-services SAC refused', r.status === 400, r.status);
    r = await req('PUT', '/finance/settings/company', { token, body: { gst_rate_pct: 17 } });
    check('GST rate outside the slabs refused', r.status === 400, r.status);

    // Unregistered: clear GSTIN.
    r = await req('PUT', '/finance/settings/company', { token, body: { gstin: '', state: 'Delhi', sac_code: '998513', gst_rate_pct: 18 } });
    check('clearing GSTIN → not ready for tax invoice', r.status === 200 && r.body?.ready_for_tax_invoice === false
      && r.body.missing.includes('GSTIN'), r.body);

    // ── Bill of Supply, approved, then recalculated ──────────────────────
    r = await req('POST', '/finance/invoices/consolidated/generate', { token, body: { customer_id: haryana, month: MONTH, year: YEAR } });
    const inv = r.body?.invoice;
    check('unregistered → BILL_OF_SUPPLY, no GST', r.status === 201 && inv?.document_type === 'BILL_OF_SUPPLY'
      && Number(inv.gst_amount) === 0 && round2(Number(inv.total_amount)) === taxable, r.body);
    const invNumber = inv?.invoice_number;
    r = await req('POST', `/finance/invoices/${inv?.id}/approve`, { token });
    check('approve the Bill of Supply', r.status === 201, r.status);

    r = await req('PUT', '/finance/settings/company', { token, body: { gstin: DELHI_GSTIN } });
    check('valid Delhi GSTIN → ready, state follows GSTIN', r.status === 200 && r.body?.ready_for_tax_invoice === true
      && r.body.state === 'Delhi', r.body);
    check('settings report the unsent Bill of Supply', r.body?.unsent_bills_of_supply >= 1, r.body?.unsent_bills_of_supply);

    r = await req('POST', `/finance/invoices/${inv?.id}/recalculate`, { token });
    check('recalculate → 201', r.status === 201, r.body);
    const after = (await req('GET', `/finance/invoices/${inv?.id}`, { token })).body;
    check('same invoice number kept', after?.invoice_number === invNumber, after?.invoice_number);
    check('still APPROVED after recalculation', after?.status === 'APPROVED', after?.status);
    check('now TAX_INVOICE', after?.document_type === 'TAX_INVOICE', after?.document_type);
    check('"HR" read as Haryana → IGST, not CGST/SGST',
      round2(Number(after?.igst_amount)) === gst18 && Number(after?.cgst_amount) === 0, after);
    check('GST is 18% of the whole taxable value', round2(Number(after?.gst_amount)) === gst18
      && round2(Number(after?.taxable_value)) === taxable, { gst: after?.gst_amount, taxable: after?.taxable_value });
    check('header refreshed: supplier GSTIN stored', after?.supplier_gstin === DELHI_GSTIN, after?.supplier_gstin);
    check('place of supply stored as the state name', after?.place_of_supply === 'Haryana', after?.place_of_supply);
    check('line items still reconcile', after?.reconciles === true, after?.line_items_total);

    const html = (await req('GET', `/finance/invoices/${inv?.id}/download`, { token, raw: true })).text;
    check('document titled Tax Invoice', /<p class="doc">Tax Invoice<\/p>/.test(html));
    check('document labels the tax "18% IGST"', html.includes('18% IGST'));
    check('no Bill-of-Supply notice on a Tax Invoice', !html.includes('This is a Bill of Supply'));

    const list = (await req('GET', '/finance/invoices', { token })).body;
    const row = (list?.data ?? []).find((x) => x.id === inv?.id);
    check('list carries taxable_value for the rate', row && round2(Number(row.taxable_value)) === taxable, row?.taxable_value);

    // ── intra-state via alias ────────────────────────────────────────────
    r = await req('POST', '/finance/invoices/consolidated/generate', { token, body: { customer_id: delhi, month: MONTH, year: YEAR } });
    const d = r.body?.invoice;
    check('"New Delhi" read as Delhi → CGST + SGST', r.status === 201 && Number(d?.igst_amount) === 0
      && round2(Number(d?.cgst_amount) + Number(d?.sgst_amount)) === gst18, r.body);
    const dHtml = (await req('GET', `/finance/invoices/${d?.id}/download`, { token, raw: true })).text;
    check('document labels "9% CGST" and "9% SGST"', dHtml.includes('9% CGST') && dHtml.includes('9% SGST'));

    // ── blank state refused ──────────────────────────────────────────────
    r = await req('POST', '/finance/invoices/consolidated/generate', { token, body: { customer_id: blank, month: MONTH, year: YEAR } });
    check('blank customer state → refused, not assumed intra-state',
      r.status === 400 && /no state on record/.test(JSON.stringify(r.body)), r.body);

    // ── cancel releases payroll, reissue works ───────────────────────────
    r = await req('POST', `/finance/invoices/${d?.id}/cancel`, { token, body: { reason: 'live test' } });
    check('cancel → 201', r.status === 201, r.body);
    const linked = (await db.query(`SELECT COUNT(*)::int n FROM payroll_records WHERE client_invoice_id = $1`, [d?.id])).rows[0].n;
    check('cancel released the payroll', linked === 0, linked);
    r = await req('POST', '/finance/invoices/consolidated/generate', { token, body: { customer_id: delhi, month: MONTH, year: YEAR } });
    check('corrected invoice can be issued after cancel', r.status === 201 && r.body?.invoice?.id !== d?.id, r.body);

    // ── sent invoices are not recalculable ───────────────────────────────
    await db.query(`UPDATE client_invoices SET status = 'SENT' WHERE id = $1`, [inv?.id]);
    r = await req('POST', `/finance/invoices/${inv?.id}/recalculate`, { token });
    check('SENT invoice cannot be recalculated', r.status === 400 && /credit note/.test(JSON.stringify(r.body)), r.body);
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.message}`);
  } finally {
    // ── teardown ────────────────────────────────────────────────────────
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    for (const { id } of invs) {
      await db.query(`DELETE FROM credit_notes WHERE invoice_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM invoice_payments WHERE invoice_id = $1`, [id]);
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);

    const savedKeys = saved.map((s) => s.key);
    await db.query(`DELETE FROM system_settings WHERE key LIKE 'finance.%' AND NOT (key = ANY($1::text[]))`, [savedKeys]);
    for (const s of saved) {
      await db.query(`UPDATE system_settings SET value = $2::jsonb WHERE key = $1`, [s.key, JSON.stringify(s.value)]);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
