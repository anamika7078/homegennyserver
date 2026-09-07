/**
 * A client's replacement request is written down.
 *
 * POST /client/replacements returned `{ success: true, requestId: "REQ_REPLACE_<timestamp>" }`
 * and wrote nothing anywhere. The client saw "RM will contact you within 24
 * hours"; no RM was ever told, and nothing could be looked up afterwards. A
 * silent 200 is worse than a 501 — nobody goes looking for a request that
 * appeared to work.
 *
 * Additive: one new table, nothing existing is touched.
 *
 *   node scratch/_replacement_requests_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'replacement_requests table',
    sql: `CREATE TABLE IF NOT EXISTS replacement_requests (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            client_id     UUID NOT NULL REFERENCES finance_customers(id) ON DELETE RESTRICT,
            placement_id  UUID REFERENCES placements(id) ON DELETE SET NULL,
            staff_id      UUID REFERENCES staff_applicants(id) ON DELETE SET NULL,
            branch_id     UUID REFERENCES branches(id) ON DELETE SET NULL,
            rm_id         UUID REFERENCES users(id) ON DELETE SET NULL,
            reason        TEXT NOT NULL,
            preferred_date DATE,
            status        VARCHAR(24) NOT NULL DEFAULT 'UNDER_RM_REVIEW',
            resolution    TEXT,
            resolved_at   TIMESTAMPTZ,
            raised_by     UUID REFERENCES users(id) ON DELETE SET NULL,
            metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'status CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE replacement_requests ADD CONSTRAINT replacement_requests_status_check
              CHECK (status IN ('UNDER_RM_REVIEW','APPROVED','REJECTED','FULFILLED','CANCELLED'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    // The RM queue reads by client and by status; the client's own list reads
    // by client, newest first.
    label: 'lookup index',
    sql: `CREATE INDEX IF NOT EXISTS idx_replacement_requests_client
            ON replacement_requests (client_id, created_at DESC)`,
  },
  {
    label: 'open-queue index',
    sql: `CREATE INDEX IF NOT EXISTS idx_replacement_requests_status
            ON replacement_requests (status, created_at DESC)`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }
  const host = new URL(url).hostname;
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
  console.log(`Target: ${host}${isLocal ? '' : '  ** REMOTE **'}\n`);

  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');

    const n = await c.query('SELECT COUNT(*)::int AS n FROM replacement_requests');
    console.log(`\nMigration applied — replacement requests are recorded now (${n.rows[0].n} rows).\n`);
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
