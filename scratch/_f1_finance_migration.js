/**
 * Phase F1 migration — additive only, safe to re-run.
 *
 * See docs/FINANCE_MODULE_AUDIT.md:
 *   F-03  client_invoices had no columns for employer ESIC / PF, so the
 *         amount was inside total_amount but itemised nowhere and could not
 *         be recovered by regenerating the invoice.
 *   F-05  deposits rows exist but carried no event/refund fields, so the
 *         Finance console recorded refunds/forfeitures onto
 *         staff_applicants.metadata instead of the deposit they describe.
 *
 * Deliberately NOT `prisma db push` — every statement here is an additive
 * ALTER/CREATE guarded so nothing existing is dropped or rewritten.
 *
 *   node scratch/_f1_finance_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'client_invoices.esic_employer',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS esic_employer NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'client_invoices.pf_employer',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS pf_employer NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'invoice_items table',
    sql: `CREATE TABLE IF NOT EXISTS invoice_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            invoice_id UUID NOT NULL REFERENCES client_invoices(id) ON DELETE CASCADE,
            description TEXT NOT NULL,
            amount NUMERIC(10,2) NOT NULL,
            is_taxable BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'invoice_items.invoice_id index',
    sql: `CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)`,
  },
  {
    label: 'deposits.event',
    sql: `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS event VARCHAR(20)`,
  },
  {
    label: 'deposits.event_at',
    sql: `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ`,
  },
  {
    label: 'deposits.event_notes',
    sql: `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS event_notes TEXT`,
  },
  {
    label: 'deposits.event_scenario_code',
    sql: `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS event_scenario_code VARCHAR(20)`,
  },
  {
    label: 'deposits.refund_amount',
    sql: `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2)`,
  },
  {
    label: 'deposits.recorded_by',
    sql: `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS recorded_by UUID`,
  },
  {
    label: 'deposits.staff_id index',
    sql: `CREATE INDEX IF NOT EXISTS idx_deposits_staff ON deposits(staff_id)`,
  },
];

/**
 * Deposit events were previously written to staff_applicants.metadata. Carry
 * any that exist onto the deposit row they were always about, so the Finance
 * console shows the same history after the switchover instead of appearing to
 * lose it. Only fills rows that have no event yet — re-running is a no-op.
 */
const BACKFILL = `
  UPDATE deposits d
  SET event               = sa.metadata->>'deposit_event',
      event_at            = NULLIF(sa.metadata->>'deposit_event_at', '')::timestamptz,
      event_notes         = NULLIF(sa.metadata->>'deposit_event_notes', ''),
      event_scenario_code = NULLIF(sa.metadata->>'deposit_scenario_code', '')
  FROM staff_applicants sa
  WHERE sa.id = d.staff_id
    AND d.event IS NULL
    AND sa.metadata->>'deposit_event' IS NOT NULL
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  const c = new Client({ connectionString: url });
  await c.connect();

  try {
    await c.query('BEGIN');

    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }

    const res = await c.query(BACKFILL);
    console.log(`  ok    backfilled ${res.rowCount} deposit event(s) from staff_applicants.metadata`);

    await c.query('COMMIT');
    console.log('\nF1 migration applied.');
  } catch (err) {
    await c.query('ROLLBACK');
    console.error('\nRolled back — nothing was changed.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
