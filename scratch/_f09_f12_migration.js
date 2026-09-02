/**
 * F-09 / F-12 migration — additive only, safe to re-run.
 *
 *   F-12  EOR payroll and client invoices had no approval or lock, and
 *         `client_invoices.status` was free-text with no state machine, so
 *         PAID → PENDING was as legal as anything else.
 *   F-09  Disbursement used Razorpay Orders (which collect money) instead of
 *         Payouts (which send it), stamped `disbursed_at` even on a simulated
 *         run, and had nowhere to read a staff member's bank account from.
 *
 * The invoice status is constrained with a CHECK rather than converted to a
 * Postgres enum on purpose: the column already holds live data and `npm start`
 * runs `prisma db push --accept-data-loss`, so a type change is exactly the
 * kind of thing that eats rows. The CHECK gives the same guarantee without
 * rewriting the column.
 *
 *   node scratch/_f09_f12_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  // ── F-12 · payroll approval + lock ────────────────────────────────────────
  {
    label: 'payroll_records.status',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'PENDING'`,
  },
  {
    label: 'payroll_records.approved_by',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS approved_by UUID`,
  },
  {
    label: 'payroll_records.approved_at',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
  },
  {
    label: 'payroll_records.locked_at',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`,
  },
  {
    label: 'payroll_records.disbursement_status',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS disbursement_status VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED'`,
  },
  {
    label: 'payroll_records.disbursement_failure_reason',
    sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS disbursement_failure_reason TEXT`,
  },
  {
    label: 'payroll_records status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_status_chk
              CHECK (status IN ('PENDING','APPROVED','LOCKED','PAID','FAILED'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    label: 'payroll_records disbursement_status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_disb_status_chk
              CHECK (disbursement_status IN ('NOT_STARTED','SIMULATED','PROCESSING','PAID','FAILED'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },

  // ── F-12 · invoice state machine ──────────────────────────────────────────
  {
    label: 'client_invoices status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE client_invoices ADD CONSTRAINT client_invoices_status_chk
              CHECK (status IN ('DRAFT','APPROVED','SENT','PARTIALLY_PAID','PAID','OVERDUE','CREDIT_NOTE','CANCELLED'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },

  // ── F-09 · somewhere to pay staff ─────────────────────────────────────────
  {
    label: 'staff_bank_accounts table',
    sql: `CREATE TABLE IF NOT EXISTS staff_bank_accounts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            staff_id UUID NOT NULL REFERENCES staff_applicants(id) ON DELETE CASCADE,
            account_holder_name VARCHAR(200) NOT NULL,
            account_number VARCHAR(40) NOT NULL,
            ifsc VARCHAR(20) NOT NULL,
            bank_name VARCHAR(160),
            is_verified BOOLEAN NOT NULL DEFAULT false,
            verified_at TIMESTAMPTZ,
            razorpay_fund_account_id VARCHAR(100),
            razorpay_contact_id VARCHAR(100),
            created_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    // One active account per staff member: a payout has to be unambiguous
    // about where it is going.
    label: 'staff_bank_accounts unique staff',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_bank_accounts_staff ON staff_bank_accounts(staff_id)`,
  },
];

/**
 * Existing payroll rows predate the approval gate. Anything already disbursed
 * is settled history and is marked PAID; everything else starts at PENDING so
 * it has to go through the new gate rather than being grandfathered past it.
 */
const BACKFILL = [
  {
    label: 'mark already-disbursed payroll as PAID',
    sql: `UPDATE payroll_records
          SET status = 'PAID', disbursement_status = 'PAID'
          WHERE disbursed_at IS NOT NULL AND status = 'PENDING'`,
  },
  {
    // 'PENDING' was the old default and is not in the new vocabulary.
    label: 'map legacy invoice status PENDING → DRAFT',
    sql: `UPDATE client_invoices SET status = 'DRAFT' WHERE status = 'PENDING'`,
  },
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

    // The invoice CHECK must not be added before the legacy values it would
    // reject have been mapped, so backfill that one first.
    for (const b of BACKFILL) {
      if (b.label.includes('invoice status')) {
        const r = await c.query(b.sql);
        console.log(`  ok    ${b.label} (${r.rowCount} row(s))`);
      }
    }

    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }

    for (const b of BACKFILL) {
      if (!b.label.includes('invoice status')) {
        const r = await c.query(b.sql);
        console.log(`  ok    ${b.label} (${r.rowCount} row(s))`);
      }
    }

    await c.query('COMMIT');
    console.log('\nF09/F12 migration applied.');
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
