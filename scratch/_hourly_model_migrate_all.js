/**
 * The three schema changes the hourly / multi-client model needs, in order.
 *
 * Runs S2 (placement type and rates), B2 (payroll rows remember their hours),
 * then S1 (attendance per placement — the destructive one). Each is already a
 * standalone script; this runs them in the only order that is safe and refuses
 * to start S1 unless the data can take it.
 *
 * The deployed code reads these columns. Applying the code without them turns
 * invoicing into a 500 — which is how the enterprise-payroll tables were left
 * (see docs/DEPLOY_RUNBOOK.md), so the check runs first and says plainly what
 * it found rather than half-applying.
 *
 * Reads DATABASE_URL. Point it at production only deliberately:
 *
 *   node -r dotenv/config scratch/_hourly_model_migrate_all.js dotenv_config_path=.env.render.local
 *
 * Pass --dry-run to check and report without changing anything.
 */
const { Client } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
require('dotenv').config();

const DRY = process.argv.includes('--dry-run');

const STEPS = [
  { file: '_s2_placement_type_migration.js', label: 'S2 — placements gain a type and rates' },
  { file: '_b2_hourly_payroll_migration.js', label: 'B2 — payroll rows remember their hours' },
  { file: '_s1_attendance_per_placement_migration.js', label: 'S1 — attendance per placement' },
];

async function preflight(c) {
  const one = async (sql) => (await c.query(sql)).rows[0];

  const total = (await one('SELECT COUNT(*)::int n FROM staff_daily_attendance')).n;
  const orphan = (await one(
    'SELECT COUNT(*)::int n FROM staff_daily_attendance WHERE placement_id IS NULL',
  )).n;
  const dupes = (await one(
    `SELECT COUNT(*)::int n FROM (
       SELECT staff_id, placement_id, attendance_date
         FROM staff_daily_attendance WHERE placement_id IS NOT NULL
        GROUP BY 1,2,3 HAVING COUNT(*) > 1) t`,
  )).n;

  console.log(`  attendance rows                : ${total}`);
  console.log(`  ...without a placement         : ${orphan}`);
  console.log(`  duplicate (staff, place, date) : ${dupes}`);

  const blockers = [];
  if (orphan > 0) {
    blockers.push(
      `${orphan} attendance rows have no placement. S1 makes placement_id NOT NULL, so ` +
      'each has to be attributed to a client first — the day decides whose invoice carries it.',
    );
  }
  if (dupes > 0) {
    blockers.push(
      `${dupes} (staff, placement, date) combinations appear more than once. S1 puts a unique ` +
      'constraint on them; the duplicates have to be reconciled first.',
    );
  }
  return blockers;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  const host = new URL(url).hostname;
  const isLocal = /localhost|127\.0\.0\.1/.test(host);
  console.log(`\n  target: ${host}${isLocal ? '  (local)' : '  ** NOT LOCAL **'}\n`);

  const c = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();

  let blockers;
  try {
    blockers = await preflight(c);
  } finally {
    await c.end();
  }

  if (blockers.length) {
    console.error('\n  REFUSING — the data cannot take S1 yet:\n');
    for (const b of blockers) console.error(`    - ${b}`);
    console.error('\n  Nothing was changed.\n');
    process.exitCode = 1;
    return;
  }
  console.log('\n  preflight clean — S1 can be applied.\n');

  if (DRY) {
    console.log('  --dry-run: stopping here. Nothing was changed.\n');
    return;
  }

  for (const step of STEPS) {
    console.log(`\n  ── ${step.label} ─────────────────────────────`);
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, step.file)], {
        env: process.env,
        encoding: 'utf8',
      });
      process.stdout.write(out.replace(/^/gm, '  '));
    } catch (e) {
      process.stdout.write(String(e.stdout ?? '').replace(/^/gm, '  '));
      console.error(`\n  ${step.label} FAILED — stopping here.`);
      console.error(`  ${String(e.stderr ?? e.message).trim()}`);
      console.error('\n  Steps before this one are applied; this one rolled itself back.\n');
      process.exitCode = 1;
      return;
    }
  }

  console.log('\n  All three applied. The hourly / multi-client code can now run here.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
