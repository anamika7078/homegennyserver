/**
 * S2 — placements learn whether they are permanent or hourly.
 *
 * A maid works several houses in a day. Some clients take her whole shift and
 * pay monthly; others book her by the hour, at a rate that differs from client
 * to client. The table only ever held a monthly figure, so the second kind had
 * nowhere to live.
 *
 * Additive and safe: every existing row defaults to PERMANENT with the shift
 * hours it already carried, so no figure any client is charged today changes.
 *
 * `shift_hours` is not new information — `wage-calculator.util.ts` has always
 * read `shift_pattern` / `working_hours` out of `placements.metadata` to decide
 * the 12-hour uplift. This lifts it into a column so payroll and the UI can see
 * it without unpacking JSON, and backfills it from that same metadata.
 *
 * See docs/HOURLY_MULTI_CLIENT_PLAN.md §S2.
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'placements.placement_type',
    sql: `ALTER TABLE placements
          ADD COLUMN IF NOT EXISTS placement_type VARCHAR(20) NOT NULL DEFAULT 'PERMANENT'`,
  },
  {
    label: 'placements.shift_hours',
    sql: `ALTER TABLE placements
          ADD COLUMN IF NOT EXISTS shift_hours NUMERIC(4,1) NOT NULL DEFAULT 8`,
  },
  {
    label: 'placements.hourly_rate',
    sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2)`,
  },
  {
    label: 'placements.hourly_fee',
    sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS hourly_fee NUMERIC(10,2)`,
  },
  {
    label: 'placement_type CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE placements ADD CONSTRAINT placements_type_check
              CHECK (placement_type IN ('PERMANENT','TEMPORARY'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    // A temporary placement that cannot price an hour is not billable. The
    // permanent side keeps its own guard where it already lives, in
    // placement.service.ts.
    label: 'a TEMPORARY placement must carry an hourly rate',
    sql: `DO $$ BEGIN
            ALTER TABLE placements ADD CONSTRAINT placements_temporary_needs_rate
              CHECK (placement_type = 'PERMANENT' OR hourly_rate IS NOT NULL);
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    label: 'shift_hours backfilled from metadata',
    sql: `UPDATE placements
             SET shift_hours = COALESCE(
                   NULLIF(metadata #>> '{wage_config,working_hours}', '')::numeric,
                   NULLIF(metadata #>> '{wage_config,shift_pattern}', '')::numeric,
                   8)
           WHERE metadata ? 'wage_config'`,
    reportRows: true,
  },
  {
    label: 'placements type index',
    sql: `CREATE INDEX IF NOT EXISTS idx_placements_staff_status
            ON placements (staff_id, status)`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      const res = await c.query(step.sql);
      console.log(
        `  ok    ${step.label}${step.reportRows ? ` (${res.rowCount} row(s))` : ''}`,
      );
    }
    await c.query('COMMIT');

    const summary = await c.query(
      `SELECT placement_type, count(*)::int AS n, min(shift_hours) AS min_h, max(shift_hours) AS max_h
         FROM placements GROUP BY placement_type ORDER BY placement_type`,
    );
    console.log('\nS2 migration applied.\n');
    for (const r of summary.rows) {
      console.log(
        `  ${String(r.n).padStart(4)}  ${r.placement_type.padEnd(10)} shift hours ${r.min_h}–${r.max_h}`,
      );
    }
    console.log('\n  Everything defaults to PERMANENT — no existing charge changes.\n');
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
