/**
 * A2 — indexes the sign-in path actually uses.
 *
 * Logging in with an email address had no index to stand on: the lookup
 * compared LOWER(email), and there is no index on that expression, so every
 * sign-in scanned the whole users table. A staff member's login then did the
 * same again on staff_applicants.mobile while assembling their role metadata.
 *
 * Additive and idempotent — CREATE INDEX IF NOT EXISTS only. Nothing is
 * dropped, no row changes, and the indexes are small.
 *
 * Note for whoever deploys: `prisma db push` does not know about the
 * expression index below (Prisma cannot express LOWER(email) in the schema)
 * and may remove it as drift. Apply this script after any db push, or better,
 * stop running db push against a live database.
 *
 * See docs/AUTH_REMEDIATION_PLAN.md §2.3.
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'users.lower(email) — email sign-in',
    sql: `CREATE INDEX IF NOT EXISTS idx_users_email_lower
            ON users (LOWER(email))
            WHERE email IS NOT NULL AND email <> ''`,
  },
  {
    label: 'staff_applicants.mobile — staff login metadata',
    sql: `CREATE INDEX IF NOT EXISTS idx_staff_applicants_mobile
            ON staff_applicants (mobile)`,
  },
  {
    label: 'user_sessions cleanup lookup',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_live
            ON user_sessions (user_id)
            WHERE revoked_at IS NULL`,
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
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }

    // Show that the planner will actually use the email index.
    const plan = await c.query(
      `EXPLAIN SELECT id FROM users
        WHERE LOWER(email) = LOWER('someone@example.com')
          AND email IS NOT NULL AND email <> '' LIMIT 1`,
    );
    console.log('\nPlan for an email sign-in:');
    for (const r of plan.rows) console.log(`  ${r['QUERY PLAN']}`);
    console.log('\nA2 applied. Nothing was dropped.\n');
  } catch (err) {
    console.error('\nFailed — no index was left half-created.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
