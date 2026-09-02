/**
 * F-13 / F-14 / F-15 migration — additive, plus guarded drops of empty tables.
 *
 *   F-13  Eleven tables existed in the schema with no writer. Each one is now
 *         either filled or removed — the middle state is what caused F-04,
 *         where a bridge assumed `payroll_entries` was populated.
 *   F-14  A tax invoice needs both parties' GSTIN, a SAC code, place of supply
 *         and a CGST/SGST-or-IGST split, and a continuous per-customer series.
 *         None of it existed.
 *   F-15  One invoice per customer per month instead of one per placement,
 *         which needs `placement_id` to become nullable.
 *
 * The drops are guarded: a table is only removed if it is empty, so this can
 * never destroy data even if someone starts using one of them first.
 *
 *   node scratch/_f13_f14_f15_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const ALTERS = [
  // ── F-15 · a consolidated invoice spans placements ────────────────────────
  {
    label: 'client_invoices.placement_id nullable',
    sql: `ALTER TABLE client_invoices ALTER COLUMN placement_id DROP NOT NULL`,
  },
  {
    label: 'client_invoices.is_consolidated',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS is_consolidated BOOLEAN NOT NULL DEFAULT false`,
  },

  // ── F-14 · tax-invoice fields ─────────────────────────────────────────────
  {
    label: 'client_invoices.document_type',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) NOT NULL DEFAULT 'BILL_OF_SUPPLY'`,
  },
  {
    label: 'client_invoices.supplier_gstin',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS supplier_gstin VARCHAR(20)`,
  },
  {
    label: 'client_invoices.supplier_state',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS supplier_state VARCHAR(100)`,
  },
  {
    label: 'client_invoices.recipient_gstin',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS recipient_gstin VARCHAR(20)`,
  },
  {
    label: 'client_invoices.recipient_state',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS recipient_state VARCHAR(100)`,
  },
  {
    label: 'client_invoices.place_of_supply',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(100)`,
  },
  {
    label: 'client_invoices.sac_code',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS sac_code VARCHAR(20)`,
  },
  {
    // The management fee is the only taxable value — salary and statutory
    // contributions are a reimbursement, never a supply.
    label: 'client_invoices.taxable_value',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS taxable_value NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'client_invoices.cgst_amount',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'client_invoices.sgst_amount',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'client_invoices.igst_amount',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0`,
  },
  {
    label: 'client_invoices.invoice_seq',
    sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS invoice_seq INTEGER`,
  },
  {
    label: 'client_invoices document_type CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE client_invoices ADD CONSTRAINT client_invoices_doctype_chk
              CHECK (document_type IN ('TAX_INVOICE','BILL_OF_SUPPLY'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },

  // ── F-15 · line items belong to a staff member ────────────────────────────
  {
    label: 'invoice_items.staff_id',
    sql: `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS staff_id UUID`,
  },
  {
    label: 'invoice_items.staff_name',
    sql: `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS staff_name VARCHAR(200)`,
  },
  {
    label: 'invoice_items.placement_id',
    sql: `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS placement_id UUID`,
  },
  {
    label: 'invoice_items.sac_code',
    sql: `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS sac_code VARCHAR(20)`,
  },
  {
    label: 'invoice_items.sort_order',
    sql: `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
  },

  // ── F-13 · tables that are now genuinely used ─────────────────────────────
  {
    label: 'esic_reports.report_type',
    sql: `ALTER TABLE esic_reports ADD COLUMN IF NOT EXISTS mismatch_count INTEGER NOT NULL DEFAULT 0`,
  },
  {
    label: 'esic_reports.by_source',
    sql: `ALTER TABLE esic_reports ADD COLUMN IF NOT EXISTS by_source JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  {
    label: 'pf_reports.mismatch_count',
    sql: `ALTER TABLE pf_reports ADD COLUMN IF NOT EXISTS mismatch_count INTEGER NOT NULL DEFAULT 0`,
  },
  {
    label: 'pf_reports.by_source',
    sql: `ALTER TABLE pf_reports ADD COLUMN IF NOT EXISTS by_source JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  {
    label: 'payment_reminders.channel default',
    sql: `ALTER TABLE payment_reminders ALTER COLUMN channel SET DEFAULT 'IN_APP'`,
  },
  {
    // How many days past due this reminder was for. Keyed on so the same
    // client is not chased twice for the same milestone.
    label: 'payment_reminders.reminder_day',
    sql: `ALTER TABLE payment_reminders ADD COLUMN IF NOT EXISTS reminder_day INTEGER NOT NULL DEFAULT 0`,
  },
  {
    label: 'payment_reminders unique per invoice+day',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_reminders_invoice_day
          ON payment_reminders(invoice_id, reminder_day)`,
  },
];

/**
 * F-13's other half. These four were never written by anything and nothing
 * reads them any more either — `payroll_entries` in particular is what made
 * the HR payslip bridge silently empty for every field staff member (F-04).
 * A schema that describes tables nobody fills is how that happens, so they go.
 */
const DROP_IF_EMPTY = [
  'payroll_payslips',  // child of payroll_entries — dropped first for the FK
  'payroll_entries',
  'payroll_batches',
  'refunds',                    // superseded by the deposit event columns (F-05)
  'salary_ledgers',             // never wired into any flow
  'branch_financial_reports',   // branch P&L is computed live (F-10)
];

/** Supplier-side tax identity. Left blank on purpose — see F-14. */
const SETTINGS = [
  ['finance.supplier_legal_name', 'HomeGenny', 'Legal name printed on invoices'],
  ['finance.supplier_gstin', '', 'Company GSTIN. Until this is set, invoices are issued as a Bill of Supply rather than a Tax Invoice.'],
  ['finance.supplier_state', '', 'State of supply for the company, used to decide CGST+SGST vs IGST'],
  ['finance.sac_code', '', 'SAC code for the management-fee supply. Confirm with your CA before setting.'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  // Managed Postgres (Render, Neon, RDS) refuses plaintext external connections.
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    await c.query('BEGIN');

    for (const step of ALTERS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }

    for (const table of DROP_IF_EMPTY) {
      const exists = await c.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
      if (!exists.rows[0].t) { console.log(`  skip  ${table} (already gone)`); continue; }
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
      if (rows[0].n > 0) {
        console.log(`  KEEP  ${table} — has ${rows[0].n} row(s), refusing to drop`);
        continue;
      }
      await c.query(`DROP TABLE ${table}`);
      console.log(`  ok    dropped ${table} (was empty)`);
    }

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
    console.log('\nF13/F14/F15 migration applied.');
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
