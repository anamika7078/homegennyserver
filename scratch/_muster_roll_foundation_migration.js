/**
 * Muster roll groundwork (M0) — additive, safe to re-run.
 *
 * Finance approves an invoice with no proof the days on it happened. The
 * client's own record is the Form XVI muster roll, signed by them; for staff
 * who check in from the app, the client confirms in their app. That needs to
 * know, for every day, where it came from and whether the client has seen it.
 *
 *   staff_daily_attendance  source        STAFF_APP | HR | RM | SYSTEM
 *                           client_status NOT_REQUIRED | PENDING | APPROVED |
 *                                         DEEMED | DISPUTED | APPROVED_PAPER
 *                           client_action_at/_by, client_note,
 *                           resolved_at/_by, resolution_note   (used from M1)
 *   placements              weekly_off_day 0–6 (0 = Sunday) — a muster roll
 *                           tells a weekly off from an absence
 *   finance_customers       attendance_proof_mode APP | PAPER | BOTH — how this
 *                           client confirms attendance
 *
 * Existing days are backfilled with their source (from the staff app when a
 * shift log or the live-in note says so, otherwise from who marked them) and
 * NOT_REQUIRED, so nothing already billed or paid starts waiting on a client.
 * Rows written straight into the table default to SYSTEM / NOT_REQUIRED.
 *
 * Father's/husband's name lives in staff_applicants.metadata like the other
 * profile details (no column needed).
 *
 *   node scratch/_muster_roll_foundation_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  { label: 'attendance.source', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'SYSTEM'` },
  {
    label: 'attendance.source CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE staff_daily_attendance ADD CONSTRAINT sda_source_chk
              CHECK (source IN ('STAFF_APP','HR','RM','SYSTEM'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  { label: 'attendance.client_status', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS client_status VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED'` },
  {
    label: 'attendance.client_status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE staff_daily_attendance ADD CONSTRAINT sda_client_status_chk
              CHECK (client_status IN ('NOT_REQUIRED','PENDING','APPROVED','DEEMED','DISPUTED','APPROVED_PAPER'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  { label: 'attendance.client_action_at', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS client_action_at TIMESTAMPTZ` },
  { label: 'attendance.client_action_by', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS client_action_by UUID` },
  { label: 'attendance.client_note', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS client_note TEXT` },
  { label: 'attendance.resolved_at', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ` },
  { label: 'attendance.resolved_by', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS resolved_by UUID` },
  { label: 'attendance.resolution_note', sql: `ALTER TABLE staff_daily_attendance ADD COLUMN IF NOT EXISTS resolution_note TEXT` },
  {
    label: 'idx client status (pending/disputed lookups)',
    sql: `CREATE INDEX IF NOT EXISTS idx_sda_client_status
            ON staff_daily_attendance (client_status, attendance_date)
            WHERE client_status IN ('PENDING','DISPUTED')`,
  },
  {
    // Only rows still on the column default — re-running never overwrites a
    // source the app has since written.
    label: 'backfill: source of existing days',
    sql: `UPDATE staff_daily_attendance sda
             SET source = CASE
               WHEN sda.notes LIKE 'Live-in:%' THEN 'STAFF_APP'
               WHEN EXISTS (SELECT 1 FROM shift_logs sl
                             WHERE sl.staff_id = sda.staff_id AND sl.shift_date = sda.attendance_date
                               AND sl.check_in_at IS NOT NULL
                               AND (sl.placement_id = sda.placement_id OR sl.placement_id IS NULL)) THEN 'STAFF_APP'
               ELSE CASE (SELECT u.role::text FROM users u WHERE u.id = sda.marked_by)
                 WHEN 'STAFF' THEN 'STAFF_APP'
                 WHEN 'HR' THEN 'HR'
                 WHEN 'ADMIN' THEN 'HR'
                 WHEN 'RM' THEN 'RM'
                 WHEN 'BM' THEN 'RM'
                 ELSE 'SYSTEM' END
             END
           WHERE sda.source = 'SYSTEM' AND sda.client_status = 'NOT_REQUIRED' AND sda.client_action_at IS NULL`,
  },
  { label: 'placements.weekly_off_day', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS weekly_off_day SMALLINT` },
  {
    label: 'weekly_off_day CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE placements ADD CONSTRAINT placements_weekly_off_day_chk
              CHECK (weekly_off_day IS NULL OR weekly_off_day BETWEEN 0 AND 6);
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  { label: 'finance_customers.attendance_proof_mode', sql: `ALTER TABLE finance_customers ADD COLUMN IF NOT EXISTS attendance_proof_mode VARCHAR(10) NOT NULL DEFAULT 'APP'` },
  {
    label: 'attendance_proof_mode CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE finance_customers ADD CONSTRAINT finance_customers_attendance_proof_chk
              CHECK (attendance_proof_mode IN ('APP','PAPER','BOTH'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
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
  for (const step of STEPS) {
    const r = await db.query(step.sql);
    console.log(`  ok  ${step.label}${r.command === 'UPDATE' ? ` (${r.rowCount} rows)` : ''}`);
  }
  const by = await db.query(`SELECT source, client_status, COUNT(*)::int AS n FROM staff_daily_attendance GROUP BY 1, 2 ORDER BY 1, 2`);
  console.log('\nAttendance by source / client status:');
  console.log(by.rows);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
