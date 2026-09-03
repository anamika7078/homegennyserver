/**
 * S1 — attendance becomes a record of a day at *a client*, not just a day.
 *
 * The table carried `UNIQUE (staff_id, attendance_date)`, so a maid could be
 * marked present once a day and no more. Saxena in the morning and Kapoor in
 * the afternoon was not expressible — the second row was rejected. That single
 * index is what blocked the whole multi-client model.
 *
 * Three changes:
 *
 *  - `hours_worked`, because a temporary placement bills by the hour and there
 *    was nowhere to put them.
 *  - `placement_id` becomes NOT NULL. Without it a row cannot say which client
 *    the day belongs to, and payroll would have to guess.
 *  - the old index is replaced by `(staff_id, placement_id, attendance_date)`,
 *    which still refuses a duplicate day at the same client — the thing the old
 *    one was really protecting — while allowing a second house.
 *
 * **This is the destructive step in the plan.** It refuses to run if any row
 * lacks a placement_id, or if any staff member already has two rows for one
 * date, rather than dropping the old guarantee before the new one can hold.
 *
 * See docs/HOURLY_MULTI_CLIENT_PLAN.md §S1.
 */
const { Client } = require('pg');
require('dotenv').config();

const OLD_INDEX = 'staff_daily_attendance_staff_id_attendance_date_key';
const NEW_INDEX = 'uniq_attendance_staff_placement_date';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  const host = new URL(url).hostname;
  const isLocal = /localhost|127\.0\.0\.1/.test(host);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();
  console.log(`\nTarget: ${host}${isLocal ? ' (local)' : '  ** REMOTE **'}\n`);

  try {
    // ── refuse rather than break something ────────────────────────────────
    const orphans = await c.query(
      `SELECT count(*)::int AS n FROM staff_daily_attendance WHERE placement_id IS NULL`,
    );
    if (orphans.rows[0].n) {
      console.error(
        `  REFUSING — ${orphans.rows[0].n} attendance row(s) have no placement_id.\n` +
          `  Each has to be attributed to a client before the column can be required;\n` +
          `  guessing which house a day belonged to is not something a migration should do.\n`,
      );
      process.exitCode = 1;
      return;
    }

    const dupes = await c.query(
      `SELECT count(*)::int AS n FROM (
         SELECT staff_id, placement_id, attendance_date
           FROM staff_daily_attendance
          GROUP BY 1,2,3 HAVING count(*) > 1
       ) x`,
    );
    if (dupes.rows[0].n) {
      console.error(
        `  REFUSING — ${dupes.rows[0].n} staff/client/date combination(s) already have\n` +
          `  more than one row, so the new unique index could not be created.\n`,
      );
      process.exitCode = 1;
      return;
    }

    await c.query('BEGIN');

    await c.query(
      `ALTER TABLE staff_daily_attendance
         ADD COLUMN IF NOT EXISTS hours_worked NUMERIC(4,1)`,
    );
    console.log('  ok    staff_daily_attendance.hours_worked');

    await c.query(
      `ALTER TABLE staff_daily_attendance ALTER COLUMN placement_id SET NOT NULL`,
    );
    console.log('  ok    placement_id is required');

    // New index first, so the table is never left with neither guarantee.
    await c.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${NEW_INDEX}
         ON staff_daily_attendance (staff_id, placement_id, attendance_date)`,
    );
    console.log(`  ok    ${NEW_INDEX} created`);

    await c.query(`DROP INDEX IF EXISTS ${OLD_INDEX}`);
    console.log(`  ok    ${OLD_INDEX} dropped — a second house in a day is now possible`);

    await c.query('COMMIT');

    // ── prove the new rule actually holds ────────────────────────────────
    const idx = await c.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'staff_daily_attendance' AND indexdef ILIKE '%UNIQUE%'`,
    );
    console.log('\nS1 migration applied.\n');
    console.log('  unique indexes now: ' + idx.rows.map((r) => r.indexname).join(', '));

    const stillOld = idx.rows.some((r) => r.indexname === OLD_INDEX);
    const hasNew = idx.rows.some((r) => r.indexname === NEW_INDEX);
    if (stillOld || !hasNew) {
      console.error('\n  WARNING: indexes are not in the expected state. Check before proceeding.');
      process.exitCode = 1;
      return;
    }
    console.log('\n  A staff member can now be marked at several clients on one date,');
    console.log('  and still only once per client per date.\n');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nRolled back — nothing was changed.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
