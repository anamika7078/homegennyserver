/**
 * Correcting an invoice the client already has — additive, safe to re-run.
 *
 * Once an invoice is SENT it cannot be edited or rejected; a wrong rate on it
 * had no way to be put right. A correction works out, line by line, what the
 * invoice should have said at the rate now in force, and settles the
 * difference without touching what was issued:
 *   - client billed too much  → a credit note for the difference
 *   - client billed too little → a supplementary invoice (DRAFT) for it
 *   - staff paid too little   → arrears, added to their next salary
 *   - staff paid too much     → recorded only; salary is never taken back
 *
 *   invoice_corrections       one per correction: who, why, the difference,
 *                             the credit note / supplementary invoice it made
 *   invoice_correction_lines  per payroll row: before → after, client and staff
 *                             (a second correction only settles what is left)
 *   pay_adjustments           ARREARS (PENDING → APPLIED to a payroll row) or
 *                             ABSORBED (RECORDED; never deducted)
 *   payroll_records           arrears, arrears_note — paid on top of the
 *                             period's net, shown on the slip as its own line
 *
 *   node scratch/_invoice_correction_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'invoice_corrections',
    sql: `CREATE TABLE IF NOT EXISTS invoice_corrections (
            id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            invoice_id               UUID NOT NULL,
            reason                   TEXT NOT NULL,
            client_delta             NUMERIC(12,2) NOT NULL,
            gst_delta                NUMERIC(12,2) NOT NULL DEFAULT 0,
            staff_delta              NUMERIC(12,2) NOT NULL DEFAULT 0,
            credit_note_id           UUID,
            supplementary_invoice_id UUID,
            created_by               UUID,
            created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
  },
  { label: 'idx corrections by invoice', sql: `CREATE INDEX IF NOT EXISTS idx_invoice_corrections_invoice ON invoice_corrections (invoice_id)` },
  {
    label: 'invoice_correction_lines',
    sql: `CREATE TABLE IF NOT EXISTS invoice_correction_lines (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            correction_id UUID NOT NULL REFERENCES invoice_corrections(id) ON DELETE CASCADE,
            payroll_id    UUID NOT NULL,
            placement_id  UUID NOT NULL,
            staff_id      UUID NOT NULL,
            billed_before NUMERIC(12,2) NOT NULL,
            billed_after  NUMERIC(12,2) NOT NULL,
            paid_before   NUMERIC(12,2) NOT NULL,
            paid_after    NUMERIC(12,2) NOT NULL,
            client_delta  NUMERIC(12,2) NOT NULL,
            staff_delta   NUMERIC(12,2) NOT NULL
          )`,
  },
  { label: 'idx correction lines by payroll', sql: `CREATE INDEX IF NOT EXISTS idx_correction_lines_payroll ON invoice_correction_lines (payroll_id)` },
  {
    label: 'pay_adjustments',
    sql: `CREATE TABLE IF NOT EXISTS pay_adjustments (
            id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            staff_id           UUID NOT NULL,
            placement_id       UUID,
            amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
            kind               VARCHAR(20) NOT NULL CHECK (kind IN ('ARREARS','ABSORBED')),
            status             VARCHAR(20) NOT NULL CHECK (status IN ('PENDING','APPLIED','RECORDED','CANCELLED')),
            reason             TEXT NOT NULL,
            correction_id      UUID,
            source_payroll_id  UUID,
            applied_payroll_id UUID,
            applied_at         TIMESTAMPTZ,
            created_by         UUID,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
  },
  { label: 'idx pending arrears by staff', sql: `CREATE INDEX IF NOT EXISTS idx_pay_adjustments_staff ON pay_adjustments (staff_id, status)` },
  { label: 'payroll_records.arrears', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS arrears NUMERIC(12,2) NOT NULL DEFAULT 0` },
  { label: 'payroll_records.arrears_note', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS arrears_note TEXT` },
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
    await db.query(step.sql);
    console.log(`  ok  ${step.label}`);
  }
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
