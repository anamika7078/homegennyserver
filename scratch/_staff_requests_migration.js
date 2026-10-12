/**
 * Staff requests — a client (app) or an RM (web) asks for staff, and the RM
 * answers with a shortlist. Phase B of docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md.
 *
 * Before this there was no way to ask for staff at all: the client app had
 * complaints and replacements, and every placement started with an RM who
 * already knew what was wanted.
 *
 * Additive: two new tables and a sequence, nothing existing is touched.
 * Re-running is a no-op. Both tables are declared in prisma/schema.prisma, so
 * a `db push` keeps them.
 *
 *   node scratch/_staff_requests_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'staff_request_no_seq',
    sql: `CREATE SEQUENCE IF NOT EXISTS staff_request_no_seq START 1`,
  },
  {
    label: 'staff_requests table',
    sql: `CREATE TABLE IF NOT EXISTS staff_requests (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_no       VARCHAR(20) NOT NULL UNIQUE,
            -- NULL while the request is a lead with no client account yet.
            client_id        UUID REFERENCES finance_customers(id) ON DELETE RESTRICT,
            lead_name        VARCHAR(200),
            lead_phone       VARCHAR(20),
            lead_city        VARCHAR(100),
            branch_id        UUID REFERENCES branches(id) ON DELETE SET NULL,
            rm_id            UUID REFERENCES users(id) ON DELETE SET NULL,
            source           VARCHAR(20) NOT NULL,
            -- No FK: replacement_requests is not in prisma/schema.prisma, and a db push
            -- drops foreign keys it does not know about.
            replacement_request_id UUID,
            series           staff_applicants_series_enum NOT NULL,
            placement_type   VARCHAR(20) NOT NULL DEFAULT 'PERMANENT',
            shift_hours      NUMERIC(4,1) NOT NULL DEFAULT 8,
            start_date       DATE,
            address          TEXT,
            language         VARCHAR(50),
            gender_pref      VARCHAR(10) NOT NULL DEFAULT 'ANY',
            budget_min       NUMERIC(10,2),
            budget_max       NUMERIC(10,2),
            headcount        INT NOT NULL DEFAULT 1,
            requirements     JSONB NOT NULL DEFAULT '{}'::jsonb,
            notes            TEXT,
            status           VARCHAR(20) NOT NULL DEFAULT 'NEW',
            cancel_reason    TEXT,
            assigned_at      TIMESTAMPTZ,
            shortlisted_at   TIMESTAMPTZ,
            selected_at      TIMESTAMPTZ,
            fulfilled_at     TIMESTAMPTZ,
            cancelled_at     TIMESTAMPTZ,
            created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
            metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'no FK to replacement_requests (first draft had one)',
    sql: `ALTER TABLE staff_requests DROP CONSTRAINT IF EXISTS staff_requests_replacement_request_id_fkey`,
  },
  {
    label: 'staff_requests CHECKs',
    sql: `DO $$ BEGIN
            ALTER TABLE staff_requests ADD CONSTRAINT staff_requests_status_check
              CHECK (status IN ('NEW','ASSIGNED','SHORTLISTED','CLIENT_SELECTED','FULFILLED','CANCELLED'));
            ALTER TABLE staff_requests ADD CONSTRAINT staff_requests_source_check
              CHECK (source IN ('CLIENT_APP','RM_WEB','REPLACEMENT'));
            ALTER TABLE staff_requests ADD CONSTRAINT staff_requests_type_check
              CHECK (placement_type IN ('PERMANENT','TEMPORARY'));
            ALTER TABLE staff_requests ADD CONSTRAINT staff_requests_gender_check
              CHECK (gender_pref IN ('ANY','FEMALE','MALE'));
            ALTER TABLE staff_requests ADD CONSTRAINT staff_requests_headcount_check
              CHECK (headcount BETWEEN 1 AND 20);
            -- Either a client account or enough of a lead to call back.
            ALTER TABLE staff_requests ADD CONSTRAINT staff_requests_who_check
              CHECK (client_id IS NOT NULL OR (lead_name IS NOT NULL AND lead_phone IS NOT NULL));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    label: 'staff_requests indexes',
    sql: `CREATE INDEX IF NOT EXISTS idx_staff_requests_client ON staff_requests (client_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_staff_requests_queue  ON staff_requests (status, branch_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_staff_requests_rm     ON staff_requests (rm_id, status)`,
  },
  {
    label: 'staff_request_candidates table',
    sql: `CREATE TABLE IF NOT EXISTS staff_request_candidates (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id    UUID NOT NULL REFERENCES staff_requests(id) ON DELETE CASCADE,
            staff_id      UUID NOT NULL REFERENCES staff_applicants(id) ON DELETE RESTRICT,
            status        VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
            rm_note       TEXT,
            client_note   TEXT,
            placement_id  UUID REFERENCES placements(id) ON DELETE SET NULL,
            added_by      UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (request_id, staff_id)
          )`,
  },
  {
    label: 'staff_request_candidates CHECK',
    sql: `DO $$ BEGIN
            ALTER TABLE staff_request_candidates ADD CONSTRAINT staff_request_candidates_status_check
              CHECK (status IN ('PROPOSED','CLIENT_SELECTED','CLIENT_REJECTED','WITHDRAWN','PLACED'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
  {
    label: 'staff_request_candidates index',
    sql: `CREATE INDEX IF NOT EXISTS idx_staff_request_candidates_staff ON staff_request_candidates (staff_id)`,
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

  const c = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');
    console.log('\nMigration applied — staff requests can be recorded now.\n');
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
