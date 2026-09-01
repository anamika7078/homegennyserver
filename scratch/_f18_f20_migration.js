/**
 * F-18 / F-20 migration — additive only, safe to re-run.
 *
 *   F-18  A credit note flipped the invoice status and returned an object that
 *         was never stored. No number, no amount, no GST reversal, no audit
 *         trail — and the original invoice still counted in full in analytics.
 *   F-20  Three different PF bases were in use at once (see the service for
 *         the full story). This adds the setting that makes the rule explicit.
 *
 *   node scratch/_f18_f20_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'credit_notes table',
    sql: `CREATE TABLE IF NOT EXISTS credit_notes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            credit_note_number VARCHAR(60) UNIQUE NOT NULL,
            credit_note_seq INTEGER,
            invoice_id UUID NOT NULL REFERENCES client_invoices(id),
            client_id UUID NOT NULL,
            issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
            reason TEXT NOT NULL,
            /* A credit note can reverse the whole invoice or part of it. */
            is_full_reversal BOOLEAN NOT NULL DEFAULT true,
            taxable_value NUMERIC(10,2) NOT NULL DEFAULT 0,
            cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            total_amount NUMERIC(10,2) NOT NULL,
            /* Carried from the invoice so the note is a standalone document. */
            document_type VARCHAR(20) NOT NULL DEFAULT 'CREDIT_NOTE',
            supplier_gstin VARCHAR(20),
            recipient_gstin VARCHAR(20),
            place_of_supply VARCHAR(100),
            status VARCHAR(20) NOT NULL DEFAULT 'ISSUED',
            issued_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'credit_notes invoice index',
    sql: `CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(invoice_id)`,
  },
  {
    label: 'credit_notes client index',
    sql: `CREATE INDEX IF NOT EXISTS idx_credit_notes_client ON credit_notes(client_id)`,
  },
  {
    label: 'credit_notes status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_status_chk
              CHECK (status IN ('ISSUED','CANCELLED'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    /* Each customer gets its own credit-note series, like invoices do. */
    label: 'finance_customers.credit_note_seq',
    sql: `ALTER TABLE finance_customers ADD COLUMN IF NOT EXISTS credit_note_seq INTEGER NOT NULL DEFAULT 0`,
  },
  {
    /* How much of this invoice has been credited back. Lets analytics net it
       off instead of counting a reversed invoice at full value. */
    label: 'client_invoices.credited_amount',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS credited_amount NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
];

const SETTINGS = [
  ['pf.base_rule', 'AGREED_BASE',
   'How the PF base is derived. AGREED_BASE (recommended) uses the pfBase agreed on the placement, ' +
   'the salary structure basic for office employees, and the whole wage where no breakdown exists. ' +
   'GROSS forces the legacy behaviour of computing PF on full gross for every payroll path.'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set — aborting.'); process.exit(1); }
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const s of STEPS) { await c.query(s.sql); console.log(`  ok    ${s.label}`); }
    for (const [key, value, description] of SETTINGS) {
      await c.query(
        `INSERT INTO system_settings (id, key, value, description, updated_at)
         VALUES (gen_random_uuid(), $1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [key, JSON.stringify(value), description],
      );
      console.log(`  ok    setting ${key}`);
    }
    await c.query('COMMIT');
    console.log('\nF18/F20 migration applied.');
  } catch (err) {
    await c.query('ROLLBACK');
    console.error('\nRolled back — nothing was changed.\n' + err.message);
    process.exitCode = 1;
  } finally { await c.end(); }
}
main();
