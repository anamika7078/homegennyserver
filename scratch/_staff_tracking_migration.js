/**
 * Staff check-in fixes + location during the shift —
 * docs/STAFF_TRACKING_AND_CLIENT_VISIBILITY_PLAN.md (2026-10-15).
 *
 *   shift_logs            one row per staff, placement and day (was staff and day),
 *                         so a staff member can check in at a second house the same day
 *   staff_location_pings  where a checked-in staff member is, about every 5 minutes
 *
 * Safe and re-runnable:
 *   - the new unique index is created first; existing rows are already unique
 *     by (staff, day), so they are unique by (staff, placement, day) too
 *   - only then is the old (staff, day) unique index dropped
 *   - the pings table is new; nothing else is touched
 * Both are declared in schema.prisma, so a `db push` has nothing to change.
 *
 *   node scratch/_staff_tracking_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'shift_logs: unique (staff, placement, day)',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS shift_logs_staff_id_placement_id_shift_date_key
            ON shift_logs (staff_id, placement_id, shift_date)`,
  },
  {
    label: 'shift_logs: drop the old unique (staff, day)',
    sql: `DROP INDEX IF EXISTS shift_logs_staff_id_shift_date_key`,
  },
  {
    label: 'staff_location_pings',
    sql: `CREATE TABLE IF NOT EXISTS staff_location_pings (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            staff_id      UUID NOT NULL,
            placement_id  UUID NOT NULL,
            shift_log_id  UUID NOT NULL,
            lat           NUMERIC(10,7) NOT NULL,
            lng           NUMERIC(10,7) NOT NULL,
            accuracy_m    INT,
            battery_pct   INT,
            -- the phone's time; points collected offline arrive later
            recorded_at   TIMESTAMPTZ NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'staff_location_pings indexes',
    sql: `CREATE INDEX IF NOT EXISTS staff_location_pings_placement_id_recorded_at_idx ON staff_location_pings (placement_id, recorded_at);
          CREATE INDEX IF NOT EXISTS staff_location_pings_shift_log_id_recorded_at_idx ON staff_location_pings (shift_log_id, recorded_at)`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }
  console.log(`Target: ${new URL(url).hostname}\n`);
  // SSL only for managed hosts; inside the compose network the host is `postgres` with no SSL.
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const c = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');
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
