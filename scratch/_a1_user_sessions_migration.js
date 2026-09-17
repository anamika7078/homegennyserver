/**
 * A1 — one row per signed-in device.
 *
 * Applies prisma/migrations/20260916180000_user_sessions/migration.sql through
 * plain SQL, so it can go onto a live database without `prisma db push`
 * (which would diff the whole 90-table schema and happily drop things it
 * thinks are drift). Additive and idempotent: CREATE TABLE IF NOT EXISTS,
 * indexes IF NOT EXISTS, and a backfill that skips rows it already wrote.
 *
 * Nothing is dropped. users.active_session_id and users.refresh_token_hash
 * stay exactly as they are and keep being written, so the previous build still
 * works if this has to be rolled back.
 *
 * See docs/AUTH_REMEDIATION_PLAN.md §3.1.
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'user_sessions table',
    sql: `CREATE TABLE IF NOT EXISTS user_sessions (
            id                 UUID PRIMARY KEY,
            user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            refresh_token_hash VARCHAR(128) NOT NULL,
            ip_address         VARCHAR(64),
            user_agent         VARCHAR(400),
            created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_used_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at         TIMESTAMPTZ NOT NULL,
            revoked_at         TIMESTAMPTZ
          )`,
  },
  {
    label: 'index on user_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id)`,
  },
  {
    label: 'index on refresh_token_hash',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_sessions_hash ON user_sessions (refresh_token_hash)`,
  },
  {
    label: 'index on expires_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions (expires_at)`,
  },
  {
    label: 'backfill sessions already signed in',
    reportRows: true,
    sql: `INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at)
          SELECT u.active_session_id::uuid,
                 u.id,
                 COALESCE(u.refresh_token_hash, 'migrated-no-refresh'),
                 CURRENT_TIMESTAMP + INTERVAL '7 days'
            FROM users u
           WHERE u.active_session_id IS NOT NULL
             AND u.active_session_id ~ '^[0-9a-fA-F-]{36}$'
          ON CONFLICT (id) DO NOTHING`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  // SSL only for managed hosts. Keying on "localhost" broke inside the compose
  // network, where the host is `postgres` and the server has no SSL.
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const c = new Client({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });
  await c.connect();

  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      const res = await c.query(step.sql);
      console.log(`  ok    ${step.label}${step.reportRows ? ` (${res.rowCount} row(s))` : ''}`);
    }
    await c.query('COMMIT');

    const summary = await c.query(
      `SELECT count(*)::int AS sessions,
              count(DISTINCT user_id)::int AS users
         FROM user_sessions WHERE revoked_at IS NULL`,
    );
    const { sessions, users } = summary.rows[0];
    console.log(`\nA1 migration applied. ${sessions} live session(s) across ${users} user(s).`);
    console.log('users.active_session_id is untouched — the previous build still works.\n');
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
