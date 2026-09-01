/**
 * Deploy pre-flight check — READ ONLY. Changes nothing, ever.
 *
 * Run this against a database BEFORE deploying, to answer two questions:
 *
 *   1. Which tables and columns does the new code need that this database
 *      does not have yet?
 *   2. Would `prisma db push --accept-data-loss` — which `npm start` and
 *      `render:start` both run — destroy anything here?
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL="postgresql://user:pass@host:port/db"; node scratch/_preflight_check.js
 *
 * Usage (bash):
 *   DATABASE_URL="postgresql://user:pass@host:port/db" node scratch/_preflight_check.js
 */
const { Client } = require('pg');
require('dotenv').config();

/** Everything the finance remediation added. */
const REQUIRED_TABLES = [
  'credit_notes',
  'exit_settlements',
  'professional_tax_slabs',
  'professional_tax_states',
  'income_tax_slabs',
  'employee_tax_profiles',
  'staff_bank_accounts',
  'invoice_items',
  'esic_reports',
  'pf_reports',
  'payment_reminders',
];

const REQUIRED_COLUMNS = [
  ['client_invoices', 'esic_employer'],
  ['client_invoices', 'pf_employer'],
  ['client_invoices', 'credited_amount'],
  ['client_invoices', 'is_consolidated'],
  ['client_invoices', 'document_type'],
  ['client_invoices', 'taxable_value'],
  ['client_invoices', 'cgst_amount'],
  ['client_invoices', 'sgst_amount'],
  ['client_invoices', 'igst_amount'],
  ['client_invoices', 'invoice_seq'],
  ['finance_customers', 'credit_note_seq'],
  ['placements', 'confirmed_at'],
  ['payroll_records', 'status'],
  ['payroll_records', 'approved_at'],
  ['payroll_records', 'disbursement_status'],
  ['payroll_details', 'esic_employer'],
  ['payroll_details', 'pf_employer'],
  ['payroll_details', 'recovery_breakdown'],
  ['payroll_processing_batches', 'recoveries_applied_at'],
  ['employee_payrolls', 'esic_employer'],
  ['employee_payrolls', 'pf_employer'],
  ['deposits', 'event'],
  ['deposits', 'refund_amount'],
  ['invoice_items', 'staff_id'],
];

/** Tables the code expects to be GONE (F-13 dropped them). */
const SHOULD_BE_ABSENT = [
  'payroll_batches', 'payroll_entries', 'payroll_payslips',
  'refunds', 'salary_ledgers', 'branch_financial_reports',
];

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const host = new URL(url).hostname;
  const isLocal = /localhost|127\.0\.0\.1/.test(host);
  console.log(`\nChecking: ${host} ${isLocal ? '(local)' : bad('(REMOTE — likely production)')}`);
  console.log('This script only reads. It will not change anything.\n');

  const c = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();

  let missing = 0;

  // ── 1. Tables the new code needs ────────────────────────────────────────
  console.log('── Tables the new code needs ─────────────────────────────');
  for (const t of REQUIRED_TABLES) {
    const r = await c.query(`SELECT to_regclass($1) AS t`, [`public.${t}`]);
    if (r.rows[0].t) {
      console.log(`  ${ok('present')}  ${t}`);
    } else {
      console.log(`  ${bad('MISSING')}  ${t}`);
      missing++;
    }
  }

  // ── 2. Columns the new code needs ───────────────────────────────────────
  console.log('\n── Columns the new code needs ────────────────────────────');
  let missingCols = 0;
  for (const [table, col] of REQUIRED_COLUMNS) {
    const r = await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
      [table, col],
    );
    if (!r.rowCount) {
      console.log(`  ${bad('MISSING')}  ${table}.${col}`);
      missingCols++;
    }
  }
  if (!missingCols) console.log(`  ${ok('all present')}`);

  // ── 3. Tables that should have been dropped ─────────────────────────────
  console.log('\n── Dead tables that should be gone (F-13) ────────────────');
  let stillThere = 0;
  for (const t of SHOULD_BE_ABSENT) {
    const r = await c.query(`SELECT to_regclass($1) AS t`, [`public.${t}`]);
    if (r.rows[0].t) {
      const n = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
      console.log(`  ${warn('still present')}  ${t} (${n.rows[0].n} rows)`);
      stillThere++;
    }
  }
  if (!stillThere) console.log(`  ${ok('all removed')}`);

  // ── 4. Row counts worth knowing before a deploy ─────────────────────────
  console.log('\n── Data that a bad deploy would destroy ──────────────────');
  for (const t of ['finance_wage_config', 'finance_customers', 'client_invoices',
                   'payroll_records', 'employees', 'deposits']) {
    try {
      const r = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
      console.log(`  ${String(r.rows[0].n).padStart(6)}  rows in ${t}`);
    } catch {
      console.log(`  ${warn('     ?')}  ${t} (table not present)`);
    }
  }

  await c.end();

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('\n── What to do ────────────────────────────────────────────');
  if (missing || missingCols) {
    console.log(bad(`  ${missing} table(s) and ${missingCols} column(s) are missing.`));
    console.log('  The new code WILL error against this database.');
    console.log('\n  Fix, in this order:');
    console.log('    1. npm run migrate:f1     (additive — creates what is missing)');
    console.log('    2. node scratch/_preflight_check.js   (run this again; expect all green)');
    console.log('    3. deploy the code');
  } else {
    console.log(ok('  This database has everything the new code needs.'));
    console.log('  Safe to deploy.');
  }

  console.log('\n  Before deploying, also run the destructive-change check:');
  console.log('    npx prisma migrate diff \\');
  console.log('      --from-schema-datasource prisma/schema.prisma \\');
  console.log('      --to-schema-datamodel   prisma/schema.prisma --script | grep "DROP"');
  console.log('  Any DROP in that output is something `db push` would delete on boot.\n');
}

main().catch((e) => {
  console.error('\nCould not check:', e.message);
  process.exit(1);
});
