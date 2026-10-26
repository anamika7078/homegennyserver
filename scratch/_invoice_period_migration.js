/**
 * Invoice periods — additive, safe to re-run.
 *
 * A client could be invoiced once a calendar month. The business needs to bill
 * part of a month — a placement starting on the 1st invoiced on the 7th — and
 * then the rest. The rule is: no two invoices for a client may cover the same
 * day, and no day of a placement may be paid or billed twice.
 *
 *   client_invoices  period_from, period_to   (+ exclusion: per client, no overlap)
 *   payroll_records  period_from, period_to   (+ exclusion: per placement, no overlap)
 *
 * Existing rows are backfilled to their whole calendar month, which is exactly
 * what they covered. A trigger fills the same default for any insert that does
 * not name a range, so older code paths and fixtures keep working.
 *
 * Replaces the unique index `uniq_client_invoice_period` (one consolidated
 * invoice per client per month), which is what made a second invoice impossible.
 *
 *   node scratch/_invoice_period_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const fillFn = (table) => `
  CREATE OR REPLACE FUNCTION ${table}_fill_period() RETURNS trigger AS $f$
  BEGIN
    IF NEW.period_from IS NULL THEN
      NEW.period_from := make_date(NEW.period_year, NEW.period_month, 1);
    END IF;
    IF NEW.period_to IS NULL THEN
      NEW.period_to := (make_date(NEW.period_year, NEW.period_month, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date;
    END IF;
    RETURN NEW;
  END $f$ LANGUAGE plpgsql`;

const STEPS = [

  // ── client_invoices ────────────────────────────────────────────────────
  { label: 'client_invoices.period_from', sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS period_from DATE` },
  { label: 'client_invoices.period_to', sql: `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS period_to DATE` },
  {
    label: 'client_invoices backfill to whole month',
    sql: `UPDATE client_invoices
             SET period_from = COALESCE(period_from, make_date(period_year, period_month, 1)),
                 period_to   = COALESCE(period_to, (make_date(period_year, period_month, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date)
           WHERE period_from IS NULL OR period_to IS NULL`,
  },
  { label: 'client_invoices fill function', sql: fillFn('client_invoices') },
  {
    label: 'client_invoices fill trigger',
    sql: `DROP TRIGGER IF EXISTS trg_client_invoices_fill_period ON client_invoices;
          CREATE TRIGGER trg_client_invoices_fill_period BEFORE INSERT ON client_invoices
            FOR EACH ROW EXECUTE FUNCTION client_invoices_fill_period()`,
  },
  { label: 'client_invoices.period_from NOT NULL', sql: `ALTER TABLE client_invoices ALTER COLUMN period_from SET NOT NULL` },
  { label: 'client_invoices.period_to NOT NULL', sql: `ALTER TABLE client_invoices ALTER COLUMN period_to SET NOT NULL` },
  {
    label: 'client_invoices range is ordered, within one month',
    sql: `DO $$ BEGIN
            ALTER TABLE client_invoices ADD CONSTRAINT client_invoices_period_chk
              CHECK (period_from <= period_to
                     AND date_trunc('month', period_from) = date_trunc('month', period_to));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    /* An EXCLUDE constraint on (client_id, daterange) needs btree_gist, which the
       application's database role is not allowed to install. A trigger does the
       same job: it takes a transaction lock on the client first, so two
       concurrent inserts are serialised and cannot both pass the check. */
    label: 'client_invoices no-overlap function',
    sql: `CREATE OR REPLACE FUNCTION client_invoices_no_overlap() RETURNS trigger AS $f$
          DECLARE clash TEXT;
          BEGIN
            IF NOT NEW.is_consolidated OR NEW.status = 'CANCELLED' THEN RETURN NEW; END IF;
            PERFORM pg_advisory_xact_lock(hashtext('client_invoices:' || NEW.client_id::text));
            SELECT invoice_number || ' (' || to_char(period_from, 'DD Mon') || ' – ' || to_char(period_to, 'DD Mon YYYY') || ')'
              INTO clash
              FROM client_invoices
             WHERE client_id = NEW.client_id AND id <> NEW.id
               AND is_consolidated AND status <> 'CANCELLED'
               AND period_from <= NEW.period_to AND period_to >= NEW.period_from
             LIMIT 1;
            IF clash IS NOT NULL THEN
              RAISE EXCEPTION 'INVOICE_PERIOD_OVERLAP: these dates are already invoiced on %', clash
                USING ERRCODE = 'exclusion_violation';
            END IF;
            RETURN NEW;
          END $f$ LANGUAGE plpgsql`,
  },
  {
    label: 'client_invoices no-overlap trigger',
    sql: `DROP TRIGGER IF EXISTS trg_client_invoices_no_overlap ON client_invoices;
          CREATE TRIGGER trg_client_invoices_no_overlap
            BEFORE INSERT OR UPDATE OF period_from, period_to, status, client_id, is_consolidated ON client_invoices
            FOR EACH ROW EXECUTE FUNCTION client_invoices_no_overlap()`,
  },
  { label: 'drop uniq_client_invoice_period (one invoice a month)', sql: `DROP INDEX IF EXISTS uniq_client_invoice_period` },

  // ── payroll_records ────────────────────────────────────────────────────
  { label: 'payroll_records.period_from', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS period_from DATE` },
  { label: 'payroll_records.period_to', sql: `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS period_to DATE` },
  {
    label: 'payroll_records backfill to whole month',
    sql: `UPDATE payroll_records
             SET period_from = COALESCE(period_from, make_date(period_year, period_month, 1)),
                 period_to   = COALESCE(period_to, (make_date(period_year, period_month, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date)
           WHERE period_from IS NULL OR period_to IS NULL`,
  },
  { label: 'payroll_records fill function', sql: fillFn('payroll_records') },
  {
    label: 'payroll_records fill trigger',
    sql: `DROP TRIGGER IF EXISTS trg_payroll_records_fill_period ON payroll_records;
          CREATE TRIGGER trg_payroll_records_fill_period BEFORE INSERT ON payroll_records
            FOR EACH ROW EXECUTE FUNCTION payroll_records_fill_period()`,
  },
  { label: 'payroll_records.period_from NOT NULL', sql: `ALTER TABLE payroll_records ALTER COLUMN period_from SET NOT NULL` },
  { label: 'payroll_records.period_to NOT NULL', sql: `ALTER TABLE payroll_records ALTER COLUMN period_to SET NOT NULL` },
  {
    label: 'payroll_records range is ordered, within one month',
    sql: `DO $$ BEGIN
            ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_period_chk
              CHECK (period_from <= period_to
                     AND date_trunc('month', period_from) = date_trunc('month', period_to));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    label: 'payroll_records no-overlap function',
    sql: `CREATE OR REPLACE FUNCTION payroll_records_no_overlap() RETURNS trigger AS $f$
          DECLARE clash TEXT;
          BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('payroll_records:' || NEW.placement_id::text));
            SELECT to_char(period_from, 'DD Mon') || ' – ' || to_char(period_to, 'DD Mon YYYY')
              INTO clash
              FROM payroll_records
             WHERE placement_id = NEW.placement_id AND id <> NEW.id
               AND period_from <= NEW.period_to AND period_to >= NEW.period_from
             LIMIT 1;
            IF clash IS NOT NULL THEN
              RAISE EXCEPTION 'PAYROLL_PERIOD_OVERLAP: payroll already covers % for this placement', clash
                USING ERRCODE = 'exclusion_violation';
            END IF;
            RETURN NEW;
          END $f$ LANGUAGE plpgsql`,
  },
  {
    /* Named so it sorts after trg_payroll_records_fill_period: triggers of one
       kind fire in name order, and the range has to be filled before it is checked. */
    label: 'payroll_records no-overlap trigger',
    sql: `DROP TRIGGER IF EXISTS trg_payroll_records_no_overlap ON payroll_records;
          CREATE TRIGGER trg_payroll_records_no_overlap
            BEFORE INSERT OR UPDATE OF period_from, period_to, placement_id ON payroll_records
            FOR EACH ROW EXECUTE FUNCTION payroll_records_no_overlap()`,
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

  // Refuse up front if existing data already breaks the rule being added.
  const dupPay = await db.query(
    `SELECT placement_id, period_month, period_year, COUNT(*) n FROM payroll_records
      GROUP BY 1, 2, 3 HAVING COUNT(*) > 1`,
  );
  if (dupPay.rows.length) {
    console.error('Refusing: placements with more than one payroll row in a month:', dupPay.rows);
    process.exit(1);
  }

  for (const step of STEPS) {
    await db.query(step.sql);
    console.log(`  ok  ${step.label}`);
  }

  const check = await db.query(
    `SELECT (SELECT COUNT(*) FROM client_invoices WHERE period_from IS NULL) AS inv_null,
            (SELECT COUNT(*) FROM payroll_records WHERE period_from IS NULL) AS pay_null,
            (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('client_invoices_period_chk','payroll_records_period_chk'))
              + (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('trg_client_invoices_no_overlap','trg_payroll_records_no_overlap')) AS constraints`,
  );
  console.log('\n', check.rows[0]);
  await db.end();
  const ok = check.rows[0].inv_null === '0' && check.rows[0].pay_null === '0' && check.rows[0].constraints === '4';
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
