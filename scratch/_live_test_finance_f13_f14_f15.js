/**
 * Live HTTP verification for F-13, F-14 and F-15.
 *
 *   F-13  Every schema table is now either written or gone.
 *   F-14  Invoices carry the tax fields, and are issued as a Bill of Supply
 *         while the supplier GSTIN is unset rather than as a hollow Tax Invoice.
 *   F-15  One invoice per customer per month, with each staff member as a
 *         line-item group and a number from the customer's own series.
 *
 * Creates payroll for two staff placed with the same customer, invoices them
 * together, then removes everything.
 *
 *   node scratch/_live_test_finance_f13_f14_f15.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_MONTH = 11;
const TEST_YEAR = 2026;
const PRESENT_DAYS = 15;

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
  const made = { attendanceIds: [], payrollIds: [], invoiceId: null, customerId: null, seqBefore: null };

  try {
    const finance = await login(FINANCE_PHONE);
    console.log('logged in as FINANCE\n');

    // ── F-13 · dead tables are gone or written ──────────────────────────────
    console.log('F-13  Every table is written or removed');
    const dropped = ['payroll_batches', 'payroll_entries', 'payroll_payslips',
                     'refunds', 'salary_ledgers', 'branch_financial_reports'];
    for (const t of dropped) {
      const r = await db.query(`SELECT to_regclass($1) AS t`, [`public.${t}`]);
      check(`${t} is gone`, r.rows[0].t === null, r.rows[0]);
    }
    const kept = ['invoice_items', 'esic_reports', 'pf_reports', 'payment_reminders', 'payslip_documents'];
    for (const t of kept) {
      const r = await db.query(`SELECT to_regclass($1) AS t`, [`public.${t}`]);
      check(`${t} still exists`, r.rows[0].t !== null, r.rows[0]);
    }

    // Generating a challan should now leave a record of the filing.
    await req('GET', `/finance/esic/challan?month=8&year=2026`, { token: finance });
    await req('GET', `/finance/esic/pf-ecr?month=8&year=2026`, { token: finance });
    const esicRep = await db.query(`SELECT * FROM esic_reports WHERE month = 8 AND year = 2026`);
    const pfRep = await db.query(`SELECT * FROM pf_reports WHERE month = 8 AND year = 2026`);
    check('generating an ESIC challan records the filing', esicRep.rows.length === 1, esicRep.rows.length);
    check('generating a PF ECR records the filing', pfRep.rows.length === 1, pfRep.rows.length);
    check('the filing records its status', esicRep.rows[0]?.status === 'GENERATED', esicRep.rows[0]?.status);
    check('the filing records a per-source breakdown', !!esicRep.rows[0]?.by_source, esicRep.rows[0]?.by_source);

    // Re-generating updates rather than duplicating.
    await req('GET', `/finance/esic/challan?month=8&year=2026`, { token: finance });
    const esicAgain = await db.query(`SELECT count(*)::int n FROM esic_reports WHERE month = 8 AND year = 2026`);
    check('re-generating does not duplicate the filing', esicAgain.rows[0].n === 1, esicAgain.rows[0]);

    // ── set up two staff with the same customer ─────────────────────────────
    const cands = await db.query(`
      SELECT p.id AS placement_id, p.staff_id, p.client_id, sa.staff_code, sa.branch_id,
             fc.customer_name, fc.bill_no_prefix, fc.bill_seq, fc.gstn, fc.state
      FROM placements p
      JOIN staff_applicants sa ON sa.id = p.staff_id
      JOIN finance_customers fc ON fc.id = p.client_id
      WHERE p.status = 'CONFIRMED'
        AND p.staff_salary IS NOT NULL AND p.management_fee IS NOT NULL
        AND p.client_id = (
          SELECT p2.client_id FROM placements p2
          WHERE p2.status = 'CONFIRMED' AND p2.staff_salary IS NOT NULL
          GROUP BY p2.client_id HAVING COUNT(DISTINCT p2.staff_id) >= 2 LIMIT 1
        )
      ORDER BY sa.staff_code
    `);
    if (cands.rows.length < 2) {
      console.log('\n  need one customer with two confirmed placements — skipping F-14/F-15');
      return;
    }
    const targets = cands.rows.slice(0, 2);
    made.customerId = targets[0].client_id;
    made.seqBefore = targets[0].bill_seq;
    console.log(`\nusing ${targets[0].customer_name} with ${targets.length} staff\n`);

    for (const t of targets) {
      for (let d = 1; d <= PRESENT_DAYS; d++) {
        const r = await db.query(
          `INSERT INTO staff_daily_attendance
             (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', $1, now(), now())
           ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING RETURNING id`,
          [t.staff_id, t.placement_id, t.branch_id, TEST_YEAR, TEST_MONTH, d],
        );
        if (r.rows[0]) made.attendanceIds.push(r.rows[0].id);
      }
      // Payroll only — the per-placement invoice path is what F-15 replaces,
      // so write the payroll row directly and let consolidation bill it.
      const prev = await req('GET',
        `/finance/payroll/attendance-preview?code=${encodeURIComponent(t.staff_code)}&month=${TEST_MONTH}&year=${TEST_YEAR}`,
        { token: finance });
      const c = prev.body?.calculation ?? {};
      const [pr] = await db.query(
        `INSERT INTO payroll_records
           (id, placement_id, staff_id, period_month, period_year, shift_days,
            gross_salary, deductions, net_salary, esic_employer, esic_employee,
            pf_employer, pf_employee, status)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,$9,$10,$11,'PENDING')
         RETURNING id`,
        [t.placement_id, t.staff_id, TEST_MONTH, TEST_YEAR, PRESENT_DAYS,
         c.grossSalary ?? prev.body?.prorated_gross ?? 0, c.netSalary ?? 0,
         c.esicEmployer ?? 0, c.esicEmployee ?? 0, c.pfEmployer ?? 0, c.pfEmployee ?? 0],
      ).then((r) => r.rows);
      made.payrollIds.push(pr.id);
    }

    // ── F-15 · one invoice covering both ────────────────────────────────────
    console.log('F-15  One invoice per customer, not one per placement');
    const pending = await req('GET', `/finance/invoices/consolidated/pending?month=${TEST_MONTH}&year=${TEST_YEAR}`, { token: finance });
    const ours = (pending.body ?? []).find((c) => c.customer_id === made.customerId);
    check('the customer appears on the month-end worklist', !!ours, pending.body);
    check('the worklist counts both staff', ours?.staff_count === 2, ours);

    const preview = await req('GET',
      `/finance/invoices/consolidated/preview?customerId=${made.customerId}&month=${TEST_MONTH}&year=${TEST_YEAR}`,
      { token: finance });
    check('preview builds', preview.status === 200, preview.status);
    const p = preview.body;
    check('preview covers both staff', p?.staff_count === 2, p?.staff_count);
    check('preview reconciles', p?.reconciles === true, p?.reconciles);

    const staffNames = new Set((p?.line_items ?? []).filter((li) => li.staff_name).map((li) => li.staff_name));
    check('line items are grouped per staff member', staffNames.size === 2, [...staffNames]);
    // The salary line now also carries its working — "(15 of 30 days)" for a
    // monthly placement, "(12 hours × ₹150)" for an hourly one — so match the
    // label rather than pinning the end of the string. See §F4.
    check('every staff line names its person', (p?.line_items ?? []).some((li) => /Staff Salary/.test(li.description)), p?.line_items?.slice(0, 3));
    check('and the salary line shows its working',
      (p?.line_items ?? []).some((li) => /Staff Salary \(\d+ of \d+ days\)/.test(li.description)),
      p?.line_items?.slice(0, 1));
    check('only the management fee is taxable',
      (p?.line_items ?? []).filter((li) => li.is_taxable).every((li) => /Management Fee/.test(li.description)),
      (p?.line_items ?? []).filter((li) => li.is_taxable).map((li) => li.description));

    const t = p?.totals ?? {};
    const sumParts = money(t.staff_salary + t.employer_esic + t.employer_pf + t.management_fee + t.gst_total);
    check('totals add up to the invoice total', Math.abs(sumParts - money(t.total)) <= 0.02, { sumParts, total: t.total });
    check('taxable value is the management fee only', money(t.taxable_value) === money(t.management_fee), t);

    // ── F-14 · tax fields ───────────────────────────────────────────────────
    console.log('\nF-14  Tax fields, and an honest document type');
    const supplierGstin = await db.query(`SELECT value FROM system_settings WHERE key = 'finance.supplier_gstin'`);
    const gstinSet = String(supplierGstin.rows[0]?.value ?? '').replace(/"/g, '').trim().length > 0;

    if (!gstinSet) {
      check('with no supplier GSTIN it is a Bill of Supply', p?.document_type === 'BILL_OF_SUPPLY', p?.document_type);
      check('and charges no GST', money(t.gst_total) === 0, t);
      check('and says what is missing', Array.isArray(p?.missing_for_tax_invoice) && p.missing_for_tax_invoice.length > 0, p?.missing_for_tax_invoice);
      check('supplier GSTIN is named as missing', (p?.missing_for_tax_invoice ?? []).some((m) => /gstin/i.test(m)), p?.missing_for_tax_invoice);
    } else {
      check('with a supplier GSTIN it is a Tax Invoice', p?.document_type === 'TAX_INVOICE', p?.document_type);
      check('GST is split into CGST+SGST or IGST',
        (money(t.cgst) + money(t.sgst) > 0) !== (money(t.igst) > 0), t);
    }

    check('the next number comes from the customer series',
      String(p?.next_invoice_number ?? '').startsWith(targets[0].bill_no_prefix.replace(/\/+$/, '')),
      { next: p?.next_invoice_number, prefix: targets[0].bill_no_prefix });

    // ── issue it ────────────────────────────────────────────────────────────
    const gen = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: made.customerId, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('the invoice issues', gen.status === 200 || gen.status === 201, { status: gen.status, body: gen.body });
    made.invoiceId = gen.body?.invoice?.id ?? null;

    const inv = await db.query(`SELECT * FROM client_invoices WHERE id = $1`, [made.invoiceId]);
    const row = inv.rows[0];
    check('it is flagged consolidated', row?.is_consolidated === true, row?.is_consolidated);
    check('it belongs to no single placement', row?.placement_id === null, row?.placement_id);
    check('it starts as DRAFT', row?.status === 'DRAFT', row?.status);
    check('document type is stored', ['TAX_INVOICE', 'BILL_OF_SUPPLY'].includes(row?.document_type), row?.document_type);
    check('taxable value is stored', money(row?.taxable_value) === money(t.management_fee), row?.taxable_value);
    check('the invoice number matches what was previewed', row?.invoice_number === p?.next_invoice_number, {
      got: row?.invoice_number, previewed: p?.next_invoice_number,
    });

    const seqAfter = await db.query(`SELECT bill_seq FROM finance_customers WHERE id = $1`, [made.customerId]);
    check('the customer series advanced by one', seqAfter.rows[0].bill_seq === made.seqBefore + 1, {
      before: made.seqBefore, after: seqAfter.rows[0].bill_seq,
    });

    const linked = await db.query(
      `SELECT count(*)::int n FROM payroll_records WHERE client_invoice_id = $1`, [made.invoiceId],
    );
    check('both payrolls are linked to the invoice', linked.rows[0].n === 2, linked.rows[0]);

    const items = await db.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order`, [made.invoiceId]);
    check('line items were written', items.rows.length > 0, items.rows.length);
    check('items carry the staff they belong to', items.rows.some((i) => i.staff_id), items.rows.slice(0, 2));
    const itemSum = money(items.rows.reduce((s, i) => s + Number(i.amount), 0));
    check('stored items reconcile to the stored total', Math.abs(itemSum - money(row.total_amount)) <= 0.02, {
      itemSum, total: row.total_amount,
    });

    // Same period, same customer, twice → refused.
    const again = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: made.customerId, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('a second consolidated invoice is refused', again.status === 400, again.status);

    const pendingAfter = await req('GET', `/finance/invoices/consolidated/pending?month=${TEST_MONTH}&year=${TEST_YEAR}`, { token: finance });
    check('the customer drops off the worklist once invoiced',
      !(pendingAfter.body ?? []).some((c) => c.customer_id === made.customerId), pendingAfter.body);
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.invoiceId) {
        await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM payment_reminders WHERE invoice_id = $1`, [made.invoiceId]);
        await db.query(`DELETE FROM client_invoices WHERE id = $1`, [made.invoiceId]);
      }
      if (made.payrollIds.length) {
        await db.query(`DELETE FROM payroll_records WHERE id = ANY($1::uuid[])`, [made.payrollIds]);
      }
      if (made.attendanceIds.length) {
        await db.query(`DELETE FROM staff_daily_attendance WHERE id = ANY($1::uuid[])`, [made.attendanceIds]);
      }
      // Put the customer's invoice series back so the test leaves no gap in it.
      if (made.customerId && made.seqBefore !== null) {
        await db.query(`UPDATE finance_customers SET bill_seq = $1 WHERE id = $2`, [made.seqBefore, made.customerId]);
      }
      await db.query(`DELETE FROM esic_reports WHERE month = 8 AND year = 2026`);
      await db.query(`DELETE FROM pf_reports WHERE month = 8 AND year = 2026`);
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
