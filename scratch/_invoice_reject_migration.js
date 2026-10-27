/**
 * Rejecting an invoice, voiding payroll, rate review — additive, safe to re-run.
 *
 * Before this, an invoice built on a wrong rate could only be cancelled, and
 * cancelling left its payroll rows in place at the wrong rate: generating
 * again produced the same wrong invoice. Nor could payroll be re-run — a row,
 * once written, blocked the period for good.
 *
 *   payroll_records_voided  every voided payroll row, kept whole (as JSON) with
 *                           who voided it, when and why. A voided row leaves
 *                           payroll_records, so nothing that reads payroll can
 *                           count it by mistake; the record is never lost.
 *   client_invoices         rejected_at, rejected_by, reject_reason
 *   placements              rate_review_status ('REVIEW_NEEDED' | NULL),
 *                           rate_review_reason, rate_review_at,
 *                           rate_review_invoice_id, rate_review_by — set when
 *                           Finance rejects an invoice; the client is not
 *                           invoiced again until the RM confirms the rate.
 *
 *   node scratch/_invoice_reject_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'payroll_records_voided',
    sql: `CREATE TABLE IF NOT EXISTS payroll_records_voided (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            payroll_id        UUID NOT NULL,
            placement_id      UUID NOT NULL,
            staff_id          UUID NOT NULL,
            period_month      INT NOT NULL,
            period_year       INT NOT NULL,
            period_from       DATE,
            period_to         DATE,
            client_invoice_id UUID,
            invoice_number    VARCHAR(50),
            gross_salary      NUMERIC(10,2),
            net_salary        NUMERIC(10,2),
            row               JSONB NOT NULL,
            void_source       VARCHAR(20) NOT NULL,
            void_reason       TEXT NOT NULL,
            voided_by         UUID,
            voided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT payroll_records_voided_source_chk
              CHECK (void_source IN ('REJECT','CANCEL','RERUN'))
          )`,
  },
  { label: 'idx voided by placement', sql: `CREATE INDEX IF NOT EXISTS idx_payroll_voided_placement ON payroll_records_voided (placement_id, period_year, period_month)` },
  { label: 'idx voided by invoice', sql: `CREATE INDEX IF NOT EXISTS idx_payroll_voided_invoice ON payroll_records_voided (client_invoice_id)` },
  { label: 'client_invoices.rejected_at', sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ` },
  { label: 'client_invoices.rejected_by', sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS rejected_by UUID` },
  { label: 'client_invoices.reject_reason', sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS reject_reason TEXT` },
  { label: 'placements.rate_review_status', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_review_status VARCHAR(20)` },
  {
    label: 'rate_review_status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE placements ADD CONSTRAINT placements_rate_review_status_chk
              CHECK (rate_review_status IS NULL OR rate_review_status = 'REVIEW_NEEDED');
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  { label: 'placements.rate_review_reason', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_review_reason TEXT` },
  { label: 'placements.rate_review_at', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_review_at TIMESTAMPTZ` },
  { label: 'placements.rate_review_invoice_id', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_review_invoice_id UUID` },
  { label: 'placements.rate_review_by', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_review_by UUID` },
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
