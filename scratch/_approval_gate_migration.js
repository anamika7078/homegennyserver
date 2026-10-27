/**
 * Invoice approval gate — additive, safe to re-run.
 *
 * A payroll row used to reach the staff app the moment it was written, and
 * could be approved and paid out while the client's invoice built from it was
 * still a DRAFT nobody had checked. A wrong rate typed on a placement went
 * straight onto a payslip and, potentially, into a bank account.
 *
 * Now a row is "released" when Finance approves the invoice it is on. Only a
 * released row shows as a payslip or can be paid.
 *
 *   payroll_records  released_at, released_by, release_reason
 *   client_invoices  approved_by, approved_at
 *
 * Backfill releases what was already past review, so nobody's existing slips
 * disappear:
 *   - rows on an invoice that is APPROVED or further along
 *   - rows already paid out, or approved/locked/paid as payroll
 * Rows on a DRAFT invoice, or on no invoice and never approved, stay unreleased
 * and are counted below.
 *
 *   node scratch/_approval_gate_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  { label: 'payroll_records.released_at', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ` },
  { label: 'payroll_records.released_by', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS released_by UUID` },
  { label: 'payroll_records.release_reason', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS release_reason TEXT` },
  { label: 'client_invoices.approved_by', sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS approved_by UUID` },
  { label: 'client_invoices.approved_at', sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ` },
  {
    label: 'backfill: rows past review are released',
    sql: `UPDATE payroll_records pr
             SET released_at = COALESCE(pr.approved_at, pr.created_at, NOW()),
                 release_reason = 'backfill: reviewed before the approval gate'
           WHERE pr.released_at IS NULL
             AND (
               pr.disbursed_at IS NOT NULL
               OR pr.status IN ('APPROVED','LOCKED','PAID')
               OR EXISTS (SELECT 1 FROM client_invoices ci
                           WHERE ci.id = pr.client_invoice_id
                             AND ci.status NOT IN ('DRAFT','CANCELLED','PENDING'))
             )`,
  },
  {
    label: 'index for the staff-app read',
    sql: `CREATE INDEX IF NOT EXISTS idx_payroll_records_staff_released ON payroll_records (staff_id, released_at)`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  // SSL only for hosted databases that require it (Render). The dev server runs
  // postgres in a sibling container without SSL, so "not localhost" is not enough.
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const db = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await db.connect();
  console.log(`Migrating ${new URL(url).hostname}/${new URL(url).pathname.slice(1)}`);
  for (const step of STEPS) {
    const r = await db.query(step.sql);
    console.log(`  ok  ${step.label}${r.command === 'UPDATE' ? ` (${r.rowCount} rows)` : ''}`);
  }
  const held = await db.query(
    `SELECT COALESCE(ci.status, 'no invoice') AS invoice_status, COUNT(*)::int AS rows
       FROM payroll_records pr
       LEFT JOIN client_invoices ci ON ci.id = pr.client_invoice_id
      WHERE pr.released_at IS NULL
      GROUP BY 1 ORDER BY 1`,
  );
  console.log('\nHeld until Finance approves (not visible to staff, not payable):');
  console.log(held.rows.length ? held.rows : '  none');
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
