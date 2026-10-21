/**
 * Staff snapshot — docs/STAFF_SNAPSHOT_PLAN.md phase 1 (2026-10-21).
 *
 *   placements.shift_start  HH:MM (IST) the shift is meant to start; what
 *                           "late" is measured from. Null = no start time
 *                           known, and such a placement is never called late.
 *
 * Backfill: an active placement made from a staff request takes the request's
 * start_time (the booking already asked for it). Linked either way the code
 * links them: placements.metadata.staff_request_id, or a PLACED candidate row.
 *
 * Additive and re-runnable: ADD COLUMN IF NOT EXISTS; the backfill only fills
 * NULLs. Declared in schema.prisma, so a `db push` has nothing to change.
 *
 *   node scratch/_snapshot_shift_start_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'placements.shift_start',
    sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS shift_start VARCHAR(5)`,
  },
  {
    label: 'backfill from metadata.staff_request_id',
    sql: `UPDATE placements p SET shift_start = sr.start_time
            FROM staff_requests sr
           WHERE p.shift_start IS NULL AND sr.start_time IS NOT NULL
             AND p.metadata->>'staff_request_id' = sr.id::text`,
  },
  {
    label: 'backfill from placed candidates',
    sql: `UPDATE placements p SET shift_start = sr.start_time
            FROM staff_request_candidates c JOIN staff_requests sr ON sr.id = c.request_id
           WHERE p.shift_start IS NULL AND sr.start_time IS NOT NULL AND c.placement_id = p.id`,
  },
];

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }
  console.log(`Target: ${new URL(url).hostname} as ${new URL(url).username}\n`);
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const c = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      const r = await c.query(step.sql);
      console.log(`  ok    ${step.label}${r.command === 'UPDATE' ? ` (${r.rowCount} row(s))` : ''}`);
    }
    await c.query('COMMIT');
    const { rows: [n] } = await c.query(
      `SELECT count(*) FILTER (WHERE shift_start IS NOT NULL)::int AS with_start, count(*)::int AS active
         FROM placements WHERE status IN ('TRIAL','CONFIRMED')`,
    );
    console.log(`  check active placements with a start time: ${n.with_start}/${n.active}`);
    console.log('\nMigration applied.\n');
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
