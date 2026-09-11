/**
 * Throw away a period's draft invoices and payroll for some clients, and raise
 * them again through the current code.
 *
 * Invoices and payroll are computed once, when they are generated, and stored.
 * When the rules change — GST moving from the fee alone to the whole
 * consideration, or a supplier GSTIN arriving that turns a Bill of Supply into
 * a Tax Invoice — documents already raised keep the old figures. For drafts
 * nobody has seen, the right move is to raise them again; for anything issued,
 * the right move is a credit note, never this.
 *
 * So this refuses to touch:
 *   - any invoice that is not DRAFT (approved means someone signed it off;
 *     sent means the client has it),
 *   - any invoice with a payment or a credit note against it,
 *   - any payroll that is approved, locked, or has started disbursing,
 *   - anything else in the database that still points at the rows it would
 *     delete — checked from the foreign keys, not from a list kept by hand.
 *
 * Attendance, placements, clients, staff and employee records are left alone:
 * none of them depend on the code version, and the regenerated documents are
 * built from them.
 *
 * Before deleting anything it writes every row it is about to remove to a
 * snapshot file, so a mistake can be put back.
 *
 *   node scratch/_regenerate_period.js --units KAPOO-01,MEHTA-01 --month 9 --year 2026
 *   node scratch/_regenerate_period.js --units ... --month 9 --year 2026 --apply
 *   ... --breakup 11000/2500/3200/1300   record an agreed wage split first
 *   ... --out /tmp/regen                 where the new documents are written
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];
const MANAGED_HOST = /render\.com|amazonaws|azure|googleapis|neon\.tech|supabase|planetscale/i;

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const APPLY = process.argv.includes('--apply');
const UNITS = String(arg('--units', '')).split(',').map((s) => s.trim()).filter(Boolean);
const MONTH = Number(arg('--month', 0));
const YEAR = Number(arg('--year', 0));
const BREAKUP = arg('--breakup', null);
const OUT = arg('--out', path.join(os.tmpdir(), 'regenerated'));

/** Where the rows about to be deleted are kept. Real names — never commit one. */
const SNAPSHOT = path.join(os.tmpdir(), `_regenerate_snapshot_${Date.now()}.json`);

// The deletes this script performs itself. Any other table found pointing at
// these rows is a reason to stop.
const HANDLED = new Set([
  'invoice_items.invoice_id',
  'payment_reminders.invoice_id',
  'payroll_records.client_invoice_id',
]);

async function req(method, p, { token, body, raw } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  const payload = json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload, text };
}

async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.status === 200 || r.status === 201) {
      const t = r.body?.access_token || r.body?.accessToken;
      if (t) return t;
    }
  }
  throw new Error(`could not log in as ${phone}`);
}

async function main() {
  if (!UNITS.length || !MONTH || !YEAR) {
    throw new Error('usage: --units A,B,C --month M --year YYYY [--apply] [--breakup b/da/hra/skill]');
  }
  const url = process.env.DATABASE_URL || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!host) throw new Error('DATABASE_URL is not a URL');
  if (MANAGED_HOST.test(host)) throw new Error(`refusing to run against a managed host (${host})`);

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    // ── what is there ────────────────────────────────────────────────────
    const clients = (await db.query(
      `SELECT id, unit_code, customer_name, bill_seq FROM finance_customers WHERE unit_code = ANY($1)`,
      [UNITS])).rows;
    const missing = UNITS.filter((u) => !clients.some((c) => c.unit_code === u));
    if (missing.length) throw new Error(`no client with unit code: ${missing.join(', ')}`);
    const clientIds = clients.map((c) => c.id);

    const placements = (await db.query(
      `SELECT p.id, p.staff_id, p.client_id, p.staff_salary, p.metadata,
              sa.staff_code, sa.full_name
         FROM placements p JOIN staff_applicants sa ON sa.id = p.staff_id
        WHERE p.client_id = ANY($1) AND p.status IN ('CONFIRMED', 'TRIAL')
        ORDER BY sa.staff_code`, [clientIds])).rows;
    const placementIds = placements.map((p) => p.id);

    const invoices = (await db.query(
      `SELECT ci.id, ci.invoice_number, ci.status, ci.client_id, ci.taxable_value, ci.total_amount,
              (SELECT count(*) FROM invoice_payments ip WHERE ip.invoice_id = ci.id)::int AS payments,
              (SELECT count(*) FROM credit_notes cn WHERE cn.invoice_id = ci.id)::int AS credit_notes
         FROM client_invoices ci
        WHERE ci.client_id = ANY($1) AND ci.period_month = $2 AND ci.period_year = $3
        ORDER BY ci.invoice_number`, [clientIds, MONTH, YEAR])).rows;
    const invoiceIds = invoices.map((i) => i.id);

    const payrolls = placementIds.length ? (await db.query(
      `SELECT pr.id, pr.placement_id, pr.status, pr.locked_at, pr.disbursed_at,
              pr.disbursement_status, sa.staff_code
         FROM payroll_records pr JOIN staff_applicants sa ON sa.id = pr.staff_id
        WHERE pr.placement_id = ANY($1) AND pr.period_month = $2 AND pr.period_year = $3`,
      [placementIds, MONTH, YEAR])).rows : [];
    const payrollIds = payrolls.map((p) => p.id);

    console.log(`\nperiod ${String(MONTH).padStart(2, '0')}/${YEAR} · ${clients.length} client(s) · ${placements.length} placement(s)\n`);
    console.log('would delete:');
    for (const i of invoices) {
      console.log(`  invoice  ${i.invoice_number.padEnd(24)} ${i.status.padEnd(8)} taxable ${i.taxable_value} total ${i.total_amount}`);
    }
    for (const p of payrolls) {
      console.log(`  payroll  ${p.staff_code.padEnd(24)} ${p.status}`);
    }
    if (!invoices.length && !payrolls.length) console.log('  (nothing — only regeneration will run)');

    // ── the refusals ─────────────────────────────────────────────────────
    const problems = [];
    for (const i of invoices) {
      if (i.status !== 'DRAFT') {
        problems.push(`${i.invoice_number} is ${i.status}, not DRAFT — an issued invoice is corrected with a credit note, not regenerated`);
      }
      if (i.payments) problems.push(`${i.invoice_number} has ${i.payments} payment(s) against it`);
      if (i.credit_notes) problems.push(`${i.invoice_number} has ${i.credit_notes} credit note(s) against it`);
    }
    for (const p of payrolls) {
      if (p.status !== 'PENDING' || p.locked_at) problems.push(`payroll for ${p.staff_code} is ${p.status}${p.locked_at ? ', locked' : ''}`);
      if (p.disbursed_at || (p.disbursement_status && p.disbursement_status !== 'NOT_STARTED')) {
        problems.push(`payroll for ${p.staff_code} has started paying out (${p.disbursement_status})`);
      }
    }

    // Anything else still pointing at these rows, found from the schema itself.
    const fks = (await db.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND ccu.table_name IN ('client_invoices', 'payroll_records')`)).rows;
    for (const fk of fks) {
      const key = `${fk.table_name}.${fk.column_name}`;
      if (HANDLED.has(key)) continue;
      const ids = fk.ref_table === 'client_invoices' ? invoiceIds : payrollIds;
      if (!ids.length) continue;
      const n = (await db.query(
        `SELECT count(*)::int AS n FROM "${fk.table_name}" WHERE "${fk.column_name}" = ANY($1::uuid[])`,
        [ids])).rows[0].n;
      if (n) problems.push(`${n} row(s) in ${key} still point at ${fk.ref_table} being deleted`);
    }

    // A wage split has to add up to the wage, or the register would state an
    // entitlement the placement does not pay.
    let split = null;
    if (BREAKUP) {
      const [basic, da, hra, skill] = BREAKUP.split('/').map(Number);
      split = { basic, da, hra, skill };
      for (const p of placements) {
        const sum = basic + da + hra + skill;
        if (!Number.isFinite(sum) || Math.round(sum) !== Math.round(Number(p.staff_salary))) {
          problems.push(`--breakup adds to ${sum}, but ${p.staff_code}'s wage is ${p.staff_salary}`);
        }
      }
    }

    if (problems.length) {
      console.log('\nREFUSED:');
      for (const m of problems) console.log(`  - ${m}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nchecks passed: every invoice is an unpaid draft, every payroll is pending and unpaid,');
    console.log('and nothing else in the database points at what would be deleted.');

    if (!APPLY) {
      console.log('\ndry run — nothing changed. Re-run with --apply to do it.\n');
      return;
    }

    // ── snapshot, then delete ────────────────────────────────────────────
    const snapshot = {
      taken_at: new Date().toISOString(),
      period: { month: MONTH, year: YEAR },
      units: UNITS,
      client_invoices: invoiceIds.length ? (await db.query(`SELECT * FROM client_invoices WHERE id = ANY($1)`, [invoiceIds])).rows : [],
      invoice_items: invoiceIds.length ? (await db.query(`SELECT * FROM invoice_items WHERE invoice_id = ANY($1)`, [invoiceIds])).rows : [],
      payment_reminders: invoiceIds.length ? (await db.query(`SELECT * FROM payment_reminders WHERE invoice_id = ANY($1)`, [invoiceIds])).rows : [],
      payroll_records: payrollIds.length ? (await db.query(`SELECT * FROM payroll_records WHERE id = ANY($1)`, [payrollIds])).rows : [],
      placements_before: placements.map((p) => ({ id: p.id, metadata: p.metadata })),
      bill_seq_before: clients.map((c) => ({ id: c.id, unit_code: c.unit_code, bill_seq: c.bill_seq })),
    };
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2));
    console.log(`\nsnapshot written       ${SNAPSHOT}`);

    await db.query('BEGIN');
    try {
      if (invoiceIds.length) {
        await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = ANY($1)`, [invoiceIds]);
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = ANY($1)`, [invoiceIds]);
        await db.query(`DELETE FROM payment_reminders WHERE invoice_id = ANY($1)`, [invoiceIds]);
        await db.query(`DELETE FROM client_invoices WHERE id = ANY($1)`, [invoiceIds]);
      }
      if (payrollIds.length) {
        await db.query(`DELETE FROM payroll_records WHERE id = ANY($1)`, [payrollIds]);
      }
      // Restart a client's series only when none of its invoices survive:
      // the deleted drafts were never issued, so their numbers were never
      // used, and starting again at 0001 leaves no gap. A client with any
      // other invoice keeps its counter, or two documents would share a number.
      for (const c of clients) {
        const left = (await db.query(
          `SELECT count(*)::int AS n FROM client_invoices WHERE client_id = $1`, [c.id])).rows[0].n;
        if (!left) await db.query(`UPDATE finance_customers SET bill_seq = 0 WHERE id = $1`, [c.id]);
      }
      if (split) {
        for (const p of placements) {
          await db.query(
            `UPDATE placements
                SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{wage_config}', $2::jsonb, true)
              WHERE id = $1`,
            [p.id, JSON.stringify({
              basic_wage: split.basic, da: split.da, hra: split.hra, skilled_allowance: split.skill,
              bonus_pct: 8.33, bonus_applicable: true,
              lwf_amount: 62, lwf_applicable: true,
              professional_tax: 0, nfh_applicable: true,
            })]);
        }
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    console.log(`deleted                ${invoiceIds.length} invoice(s), ${payrollIds.length} payroll record(s)`);
    if (split) console.log(`wage breakup recorded  ${split.basic}/${split.da}/${split.hra}/${split.skill}`);

    // ── raise them again, through the API ────────────────────────────────
    const finance = await login(FINANCE_PHONE);
    fs.mkdirSync(OUT, { recursive: true });

    for (const p of placements) {
      const r = await req('POST', '/finance/payroll/attendance-generate', {
        token: finance, body: { code: p.staff_code, month: MONTH, year: YEAR },
      });
      if (r.status !== 200 && r.status !== 201) {
        throw new Error(`payroll for ${p.staff_code} refused (${r.status}): ${JSON.stringify(r.body)}`);
      }
    }
    console.log(`payroll re-run         ${placements.length} staff`);

    const summary = [];
    for (const c of clients) {
      const gen = await req('POST', '/finance/invoices/consolidated/generate', {
        token: finance, body: { customer_id: c.id, month: MONTH, year: YEAR },
      });
      if (gen.status !== 200 && gen.status !== 201) {
        throw new Error(`invoice for ${c.unit_code} refused (${gen.status}): ${JSON.stringify(gen.body)}`);
      }
      const invoiceId = (gen.body?.invoice ?? gen.body)?.id;
      const doc = await req('GET', `/finance/invoices/${invoiceId}/download`, { token: finance });
      fs.writeFileSync(path.join(OUT, `${c.unit_code}-invoice.html`), doc.text);
      const row = (await db.query(
        `SELECT invoice_number, document_type, taxable_value, gst_amount, total_amount
           FROM client_invoices WHERE id = $1`, [invoiceId])).rows[0];
      summary.push({ unit: c.unit_code, ...row });
    }

    // The same month from each staff member's side.
    for (const p of placements) {
      const emp = (await db.query(
        `SELECT id FROM employees WHERE staff_applicant_id = $1 AND deleted_at IS NULL`, [p.staff_id])).rows[0];
      const s = summary.find((x) => clients.find((c) => c.id === p.client_id)?.unit_code === x.unit);
      if (!emp) { if (s) s.payslip = '(not onboarded)'; continue; }
      const slips = await req('GET', `/employees/${emp.id}/payslips`, { token: finance });
      const slip = (slips.body?.items ?? []).find((x) => x.periodMonth === MONTH && x.periodYear === YEAR);
      if (!slip) { if (s) s.payslip = '(none)'; continue; }
      const pdf = await req('GET', `/employees/${emp.id}/payslips/pdf?ref=${encodeURIComponent(slip.ref)}`,
        { token: finance, raw: true });
      if (pdf.status === 200) {
        fs.writeFileSync(path.join(OUT, `${clients.find((c) => c.id === p.client_id).unit_code}-${p.staff_code}-payslip.pdf`), pdf.buf);
      }
      if (s) s.payslip_net = slip.netSalary;
    }

    console.log('\nregenerated:');
    console.table(summary);
    console.log(`documents written to    ${OUT}\n`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
});
