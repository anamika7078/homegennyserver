/**
 * F-16 / F-17 migration — additive only, safe to re-run.
 *
 *   F-16  Professional tax was a flat ₹200 above ₹15,000 and TDS a flat 5%
 *         above ₹50,000. PT is levied by the state, not the country — and
 *         **Delhi and Haryana do not levy it at all**, which is where almost
 *         every HomeGenny employee sits. TDS needs an annual projection, not a
 *         monthly percentage.
 *   F-17  The late-exit fee matrix and full & final settlement existed only in
 *         the spec.
 *
 * Rates live in tables, not in code, because they change every Budget and
 * because nobody should have to redeploy to correct a slab. Everything seeded
 * here is marked `needs_confirmation` until Finance signs it off.
 *
 *   node scratch/_f16_f17_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const TABLES = [
  {
    label: 'professional_tax_slabs',
    sql: `CREATE TABLE IF NOT EXISTS professional_tax_slabs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            state VARCHAR(100) NOT NULL,
            /* Inclusive lower bound of monthly gross, in rupees. */
            min_monthly_gross NUMERIC(10,2) NOT NULL DEFAULT 0,
            /* Exclusive upper bound; NULL means "and above". */
            max_monthly_gross NUMERIC(10,2),
            monthly_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            /* Maharashtra charges a higher figure in the last month of the
               financial year; NULL means the normal amount applies. */
            february_amount NUMERIC(10,2),
            /* Some states exempt women up to a higher threshold. */
            applies_to_gender VARCHAR(20),
            effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
            effective_to DATE,
            needs_confirmation BOOLEAN NOT NULL DEFAULT true,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'professional_tax_slabs state index',
    sql: `CREATE INDEX IF NOT EXISTS idx_pt_slabs_state ON professional_tax_slabs(state)`,
  },
  {
    /* A state with no rows and no "not levied" marker is unknown, which is
       different from a state that levies nothing. The distinction matters:
       one is a data gap, the other is a fact. */
    label: 'professional_tax_states',
    sql: `CREATE TABLE IF NOT EXISTS professional_tax_states (
            state VARCHAR(100) PRIMARY KEY,
            levies_pt BOOLEAN NOT NULL,
            needs_confirmation BOOLEAN NOT NULL DEFAULT true,
            notes TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'income_tax_slabs',
    sql: `CREATE TABLE IF NOT EXISTS income_tax_slabs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            regime VARCHAR(20) NOT NULL,
            financial_year VARCHAR(10) NOT NULL,
            min_annual NUMERIC(12,2) NOT NULL,
            max_annual NUMERIC(12,2),
            rate_pct NUMERIC(5,2) NOT NULL,
            needs_confirmation BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'income_tax_slabs lookup index',
    sql: `CREATE INDEX IF NOT EXISTS idx_it_slabs_lookup ON income_tax_slabs(regime, financial_year, min_annual)`,
  },
  {
    label: 'employee_tax_profiles',
    sql: `CREATE TABLE IF NOT EXISTS employee_tax_profiles (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            employee_id UUID UNIQUE NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            regime VARCHAR(20) NOT NULL DEFAULT 'NEW',
            /* Declared deductions (80C etc.) — only meaningful under the old regime. */
            declared_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
            /* Tax already deducted this financial year, so the projection can
               spread only what remains across the remaining months. */
            tds_paid_this_fy NUMERIC(12,2) NOT NULL DEFAULT 0,
            pan VARCHAR(20),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'exit_settlements',
    sql: `CREATE TABLE IF NOT EXISTS exit_settlements (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id UUID NOT NULL REFERENCES placements(id),
            staff_id UUID NOT NULL REFERENCES staff_applicants(id),
            client_id UUID,
            exit_date DATE NOT NULL,
            exit_reason VARCHAR(40) NOT NULL,
            exit_scenario_code VARCHAR(20),
            /* Which row of the spec's matrix was applied. */
            fee_band VARCHAR(40) NOT NULL,
            days_since_confirmation INTEGER,
            monthly_salary NUMERIC(10,2) NOT NULL DEFAULT 0,
            /* Client-facing: cancellation fee charged, in days and rupees. */
            cancellation_fee_days INTEGER NOT NULL DEFAULT 0,
            cancellation_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            /* Staff-facing: goodwill paid, final month pro-rata, deposit. */
            goodwill_days INTEGER NOT NULL DEFAULT 0,
            goodwill_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            final_month_days INTEGER NOT NULL DEFAULT 0,
            final_month_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            deposit_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            deposit_action VARCHAR(20) NOT NULL DEFAULT 'REFUND',
            deposit_refund_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            net_payable_to_staff NUMERIC(10,2) NOT NULL DEFAULT 0,
            net_receivable_from_client NUMERIC(10,2) NOT NULL DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
            approved_by UUID,
            approved_at TIMESTAMPTZ,
            settled_at TIMESTAMPTZ,
            breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'exit_settlements unique per placement',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_exit_settlements_placement ON exit_settlements(placement_id)`,
  },
  {
    label: 'exit_settlements status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE exit_settlements ADD CONSTRAINT exit_settlements_status_chk
              CHECK (status IN ('DRAFT','APPROVED','SETTLED','CANCELLED'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    label: 'placements.confirmed_at',
    // The fee band depends on how long after confirmation the exit happened,
    // and nothing recorded when confirmation occurred.
    sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`,
  },
];

/**
 * Professional tax by state.
 *
 * Only the states HomeGenny actually operates in are seeded. Padding this with
 * states nobody works in would mean shipping numbers nobody will check.
 *
 * **Delhi and Haryana do not levy professional tax.** That is the single most
 * consequential fact here: every Delhi employee has been having a flat ₹200 a
 * month deducted for a tax their state does not charge.
 */
const PT_STATES = [
  ['Delhi', false, 'Delhi does not levy professional tax.'],
  ['Haryana', false, 'Haryana does not levy professional tax.'],
  ['Maharashtra', true, 'Levies PT. Slabs seeded below — confirm the current-year figures and the February differential before relying on them.'],
];

const PT_SLABS = [
  // Maharashtra, monthly. Confirm against the current Maharashtra State Tax on
  // Professions notification before a live payroll run.
  ['Maharashtra', 0, 7500, 0, null, 'MALE', 'Nil up to ₹7,500'],
  ['Maharashtra', 7500, 10000, 175, null, 'MALE', '₹175/month'],
  ['Maharashtra', 10000, null, 200, 300, 'MALE', '₹200/month, higher in the last month of the FY'],
  ['Maharashtra', 0, 25000, 0, null, 'FEMALE', 'Women exempt to a higher threshold'],
  ['Maharashtra', 25000, null, 200, 300, 'FEMALE', '₹200/month, higher in the last month of the FY'],
];

/**
 * Income tax slabs, new regime.
 *
 * Seeded as data and flagged for confirmation rather than compiled in: slabs
 * move with the Budget, and a wrong rate here quietly under- or over-deducts
 * from every salary. Finance must confirm the financial year's figures — and
 * the old regime, if anyone elects it — before this drives a real payroll.
 */
const IT_SLABS_FY = '2026-27';
const IT_SLABS = [
  ['NEW', IT_SLABS_FY, 0, 400000, 0],
  ['NEW', IT_SLABS_FY, 400000, 800000, 5],
  ['NEW', IT_SLABS_FY, 800000, 1200000, 10],
  ['NEW', IT_SLABS_FY, 1200000, 1600000, 15],
  ['NEW', IT_SLABS_FY, 1600000, 2000000, 20],
  ['NEW', IT_SLABS_FY, 2000000, 2400000, 25],
  ['NEW', IT_SLABS_FY, 2400000, null, 30],
];

const SETTINGS = [
  ['tax.financial_year', IT_SLABS_FY, 'Financial year whose slabs TDS uses'],
  ['tax.default_regime', 'NEW', 'Regime assumed when an employee has not declared one'],
  ['tax.standard_deduction', '75000', 'Standard deduction applied to salary income — confirm for the current FY'],
  ['tax.rebate_87a_limit', '1200000', 'Taxable income up to which the 87A rebate zeroes the liability — confirm'],
  ['tax.cess_pct', '4', 'Health and education cess on the computed tax'],
  ['tax.slabs_confirmed', 'false', 'Set to true once Finance has verified the seeded slabs against the current Budget'],
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

    for (const t of TABLES) {
      await c.query(t.sql);
      console.log(`  ok    ${t.label}`);
    }

    for (const [state, levies, notes] of PT_STATES) {
      await c.query(
        `INSERT INTO professional_tax_states (state, levies_pt, notes, updated_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (state) DO NOTHING`,
        [state, levies, notes],
      );
    }
    console.log(`  ok    seeded ${PT_STATES.length} PT state rule(s)`);

    const existingSlabs = await c.query(`SELECT count(*)::int n FROM professional_tax_slabs`);
    if (existingSlabs.rows[0].n === 0) {
      for (const [state, min, max, amount, feb, gender, notes] of PT_SLABS) {
        await c.query(
          `INSERT INTO professional_tax_slabs
             (state, min_monthly_gross, max_monthly_gross, monthly_amount,
              february_amount, applies_to_gender, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [state, min, max, amount, feb, gender, notes],
        );
      }
      console.log(`  ok    seeded ${PT_SLABS.length} PT slab(s)`);
    } else {
      console.log(`  skip  PT slabs (${existingSlabs.rows[0].n} already present)`);
    }

    const existingIt = await c.query(`SELECT count(*)::int n FROM income_tax_slabs WHERE financial_year = $1`, [IT_SLABS_FY]);
    if (existingIt.rows[0].n === 0) {
      for (const [regime, fy, min, max, rate] of IT_SLABS) {
        await c.query(
          `INSERT INTO income_tax_slabs (regime, financial_year, min_annual, max_annual, rate_pct)
           VALUES ($1,$2,$3,$4,$5)`,
          [regime, fy, min, max, rate],
        );
      }
      console.log(`  ok    seeded ${IT_SLABS.length} income-tax slab(s) for FY ${IT_SLABS_FY}`);
    } else {
      console.log(`  skip  income-tax slabs for FY ${IT_SLABS_FY} (already present)`);
    }

    for (const [key, value, description] of SETTINGS) {
      await c.query(
        `INSERT INTO system_settings (id, key, value, description, updated_at)
         VALUES (gen_random_uuid(), $1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [key, JSON.stringify(value), description],
      );
    }
    console.log(`  ok    seeded ${SETTINGS.length} tax setting(s)`);

    // Placements confirmed before this column existed have no timestamp; the
    // best available proxy is when the row was last updated.
    const backfill = await c.query(
      `UPDATE placements SET confirmed_at = updated_at
       WHERE status IN ('CONFIRMED','EXITED','TERMINATED') AND confirmed_at IS NULL`,
    );
    console.log(`  ok    backfilled confirmed_at on ${backfill.rowCount} placement(s)`);

    await c.query('COMMIT');
    console.log('\nF16/F17 migration applied.');
    console.log('\n  NOTE: every seeded rate is flagged needs_confirmation.');
    console.log('        Set tax.slabs_confirmed = true only after Finance verifies them.');
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
