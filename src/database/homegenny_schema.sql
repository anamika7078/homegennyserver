-- ═══════════════════════════════════════════════════════════════════════════
-- HomeGenny Domestic Staffing Platform — Complete Database Schema
-- PostgreSQL 15 · Google Cloud SQL
--
-- Run this on a fresh database:
--   psql -h CLOUD_SQL_IP -U hguser -d homegenny -f homegenny_schema.sql
--
-- Or via Docker (local dev):
--   docker compose exec db psql -U hguser -d homegenny -f /homegenny_schema.sql
--
-- Tables created (13 total):
--   branches, users, staff_applicants, pipeline_events,
--   video_certs, agreements, placements, payroll_records,
--   shift_logs, client_invoices, restricted_list,
--   upgrade_paths, notification_logs
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- trigram text search

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN

  -- ENUMS aligned with Entities
  CREATE TYPE staff_series AS ENUM ('MAID', 'SKILLED_CARE', 'UNSKILLED_CARE', 'DRIVER', 'SC', 'UC', 'DR');

  CREATE TYPE pipeline_stage AS ENUM (
    'S1_INTAKE', 'S2_VERIFY', 'S2_5_ASSESS', 'S3_TRAIN',
    'S4_AGREEMENTS', 'S5_DEPLOY', 'TERMINAL', 'DEFERRED'
  );

  CREATE TYPE terminal_outcome AS ENUM (
    'ENROLLED', 'CONDITIONAL', 'DEFERRED', 'DENIED', 'ABANDONED', 'LATE_EXIT',
    'PLACED', 'REJECTED', 'RESTRICTED', 'CANCELLED'
  );

  CREATE TYPE language_tier AS ENUM ('T1', 'T2', 'T3', 'T4');

  CREATE TYPE pv_status AS ENUM (
    'NOT_INITIATED', 'IN_PROGRESS', 'CLEAR', 'ADVERSE', 'EXPIRED',
    'PENDING', 'FAILED', 'EXEMPT'
  );

  CREATE TYPE placement_status AS ENUM (
    'TRIAL', 'CONFIRMED', 'EXITED', 'TERMINATED'
  );

  CREATE TYPE user_role AS ENUM (
    'STAFF', 'CLIENT', 'RM', 'BM', 'FINANCE', 'ADMIN',
    'TRAINER', 'ASSESSOR', 'SUPPORT'
  );

  CREATE TYPE agreement_type AS ENUM (
    'A1', 'A2', 'A3', 'A4', 'A5',
    'A1_EOR', 'A2_SOW', 'A3_INDEMNITY', 'A4_MED_ADDENDUM', 'A5_MED_EXCLUSION'
  );

  CREATE TYPE agreement_status AS ENUM (
    'PENDING', 'SIGNED', 'VOID', 'EXPIRED',
    'DRAFT', 'SENT', 'REJECTED'
  );

  CREATE TYPE alarm_status AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
  CREATE TYPE alarm_severity AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
  CREATE TYPE client_status AS ENUM ('PROSPECT', 'ACTIVE', 'INACTIVE', 'BLACKLISTED');

EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 1. BRANCHES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  city        VARCHAR(100) NOT NULL,
  state       VARCHAR(100) NOT NULL,
  gstin       VARCHAR(20),
  address     TEXT,
  phone       VARCHAR(20),
  email       VARCHAR(100),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default branch
INSERT INTO branches (id, name, city, state, gstin, email)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'HomeGenny Mumbai HQ',
  'Mumbai',
  'Maharashtra',
  '27AABCH1234A1Z5',
  'mumbai@homegenny.com'
) ON CONFLICT DO NOTHING;

-- ── 2. USERS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id           UUID        REFERENCES branches(id),
  role                user_role   NOT NULL,
  full_name           VARCHAR(200) NOT NULL,
  phone               VARCHAR(20) UNIQUE NOT NULL,
  email               VARCHAR(200) UNIQUE,
  password_hash       VARCHAR(255),
  refresh_token_hash  VARCHAR(255),
  active_session_id   VARCHAR(64),
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  last_login_at       TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone    ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_branch   ON users(branch_id);

-- ── 3. STAFF APPLICANTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_applicants (
  id                      UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_code              VARCHAR(30)     UNIQUE NOT NULL,
  user_id                 UUID            REFERENCES users(id),
  branch_id               UUID            NOT NULL REFERENCES branches(id),
  assigned_rm_id          UUID            REFERENCES users(id),
  series                  staff_series    NOT NULL,
  role_types              TEXT[]          NOT NULL DEFAULT '{}',
  language_tier           language_tier,
  pipeline_stage          pipeline_stage  NOT NULL DEFAULT 'S1_INTAKE',
  current_scenario_code   VARCHAR(20),
  terminal_outcome        terminal_outcome,
  terminal_reason         TEXT,
  restrictions            JSONB           NOT NULL DEFAULT '{}',
  verified_docs           JSONB           NOT NULL DEFAULT '{}',
  pv_status               pv_status       NOT NULL DEFAULT 'NOT_INITIATED',
  restricted_list_flag    BOOLEAN         NOT NULL DEFAULT false,
  video_cert_id           UUID,
  deposit_amount          DECIMAL(10,2)   NOT NULL DEFAULT 0,
  deposit_paid            BOOLEAN         NOT NULL DEFAULT false,
  training_start_date     DATE,
  training_end_date       DATE,
  deployment_ready_date   DATE,
  mobile                  VARCHAR(20),
  email                   VARCHAR(200),
  full_name               VARCHAR(200),
  date_of_birth           DATE,
  address                 TEXT,
  emergency_contact_name   VARCHAR(200),
  emergency_contact_mobile VARCHAR(20),
  metadata                JSONB           NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_staff_stage     ON staff_applicants(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_staff_branch    ON staff_applicants(branch_id);
CREATE INDEX IF NOT EXISTS idx_staff_rm        ON staff_applicants(assigned_rm_id);
CREATE INDEX IF NOT EXISTS idx_staff_series    ON staff_applicants(series);
CREATE INDEX IF NOT EXISTS idx_staff_code      ON staff_applicants(staff_code);

-- ── 4. PIPELINE EVENTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_events (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id        UUID            NOT NULL REFERENCES staff_applicants(id),
  event_type      VARCHAR(100)    NOT NULL,
  from_stage      VARCHAR(30),
  to_stage        VARCHAR(30),
  actor_id        UUID,
  scenario_code   VARCHAR(20),
  reason_code     VARCHAR(80),
  payload         JSONB           NOT NULL DEFAULT '{}',
  notes           TEXT,
  occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pe_staff  ON pipeline_events(staff_id);
CREATE INDEX IF NOT EXISTS idx_pe_time   ON pipeline_events(occurred_at DESC);

-- ── 5. VIDEO CERTIFICATIONS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_certs (
  id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id            UUID            NOT NULL REFERENCES staff_applicants(id),
  series              staff_series    NOT NULL,
  prompt_set_version  VARCHAR(20)     NOT NULL DEFAULT 'v1',
  prompt_count        INT             NOT NULL,
  duration_seconds    INT,
  storage_url         TEXT            NOT NULL,
  storage_key         TEXT            NOT NULL,
  sha256_hash         VARCHAR(64)     NOT NULL UNIQUE,
  rm_signed_off       BOOLEAN         NOT NULL DEFAULT false,
  rm_id               UUID,
  rm_signed_at        TIMESTAMPTZ,
  never_delete        BOOLEAN         NOT NULL DEFAULT false,
  retention_until     DATE,
  attempt_number      INT             NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── 6. AGREEMENTS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agreements (
  id                  UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id            UUID              REFERENCES staff_applicants(id),
  client_id           UUID              NOT NULL,
  placement_id        UUID,
  type                agreement_type    NOT NULL,
  status              agreement_status  NOT NULL DEFAULT 'PENDING',
  signatures          JSONB             NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- ── 7. PLACEMENTS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placements (
  id                          UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id                    UUID              NOT NULL REFERENCES staff_applicants(id),
  client_id                   UUID              NOT NULL,
  branch_id                   UUID              NOT NULL REFERENCES branches(id),
  rm_id                       UUID,
  status                      placement_status  NOT NULL DEFAULT 'TRIAL',
  exit_scenario_code          VARCHAR(20),
  scope_of_work               JSONB             NOT NULL DEFAULT '{}',
  trial_start_date            DATE,
  trial_end_date              DATE,
  billing_start_date          DATE,
  exit_date                   DATE,
  staff_salary                DECIMAL(10,2),
  management_fee              DECIMAL(10,2),
  replacement_count           INT               NOT NULL DEFAULT 0,
  metadata                    JSONB             NOT NULL DEFAULT '{}',
  created_at                  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- ── 8. PAYROLL RECORDS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_records (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  placement_id        UUID        NOT NULL REFERENCES placements(id),
  staff_id            UUID        NOT NULL REFERENCES staff_applicants(id),
  period_month        INT         NOT NULL,
  period_year         INT         NOT NULL,
  shift_days          INT         NOT NULL DEFAULT 0,
  gross_salary        DECIMAL(10,2) NOT NULL,
  deductions          JSONB       NOT NULL DEFAULT '{}',
  net_salary          DECIMAL(10,2) NOT NULL,
  esic_employer       DECIMAL(10,2) NOT NULL DEFAULT 0,
  esic_employee       DECIMAL(10,2) NOT NULL DEFAULT 0,
  pf_employer         DECIMAL(10,2) NOT NULL DEFAULT 0,
  pf_employee         DECIMAL(10,2) NOT NULL DEFAULT 0,
  disbursed_at        TIMESTAMPTZ,
  disbursement_ref    VARCHAR(100),
  client_invoice_id   UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 9. SHIFT LOGS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shift_logs (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  placement_id      UUID        NOT NULL REFERENCES placements(id),
  staff_id          UUID        NOT NULL REFERENCES staff_applicants(id),
  log_date          DATE        NOT NULL,
  check_in          TIMESTAMPTZ,
  check_out         TIMESTAMPTZ,
  hours_worked      DECIMAL(4,2),
  status            VARCHAR(20) NOT NULL DEFAULT 'PRESENT',
  notes             TEXT,
  client_confirmed  BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 10. CLIENT INVOICES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_invoices (
  id                        UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  placement_id              UUID        NOT NULL REFERENCES placements(id),
  client_id                 UUID        NOT NULL,
  invoice_number            VARCHAR(50) UNIQUE NOT NULL,
  period_month              INT         NOT NULL,
  period_year               INT         NOT NULL,
  staff_salary_component    DECIMAL(10,2) NOT NULL,
  management_fee            DECIMAL(10,2) NOT NULL,
  gst_amount                DECIMAL(10,2) NOT NULL,
  total_amount              DECIMAL(10,2) NOT NULL,
  due_date                  DATE        NOT NULL,
  paid_at                   TIMESTAMPTZ,
  payment_ref               VARCHAR(100),
  razorpay_order_id         VARCHAR(100),
  status                    VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 11. RESTRICTED LIST ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restricted_list (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id      UUID        REFERENCES staff_applicants(id),
  aadhaar_hash  VARCHAR(64),
  phone_hash    VARCHAR(64),
  name          VARCHAR(200),
  reason        VARCHAR(100)   NOT NULL,
  added_by      UUID,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 12. ALARMS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alarms (
  id                  UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  ref_code            VARCHAR(32)       UNIQUE NOT NULL,
  title               VARCHAR(255)      NOT NULL,
  description         TEXT,
  status              alarm_status      NOT NULL DEFAULT 'OPEN',
  severity            alarm_severity    NOT NULL,
  category            VARCHAR(32)       NOT NULL,
  list_meta           TEXT              NOT NULL,
  list_footer         TEXT              NOT NULL,
  assigned_to         VARCHAR(120)      NOT NULL,
  detail_meta         TEXT,
  recommended_action  TEXT,
  is_read             BOOLEAN           NOT NULL DEFAULT false,
  bm_note             TEXT,
  bm_action_status    VARCHAR(40),
  bm_action_at        TIMESTAMPTZ,
  bm_action_by        UUID,
  resolved_by         UUID,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- ── 13. CLIENTS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id            UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name     VARCHAR(255)      NOT NULL,
  phone         VARCHAR(20)       UNIQUE NOT NULL,
  email         VARCHAR(255),
  address       TEXT,
  city          VARCHAR(100),
  status        client_status     NOT NULL DEFAULT 'PROSPECT',
  kyc_verified  BOOLEAN           NOT NULL DEFAULT false,
  metadata      JSONB             NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- ── 14. NOTIFICATION LOGS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_logs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient   VARCHAR(200) NOT NULL,
  channel     VARCHAR(20)  NOT NULL,
  template    VARCHAR(100) NOT NULL,
  payload     JSONB        NOT NULL DEFAULT '{}',
  status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 15. UPGRADE PATHS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upgrade_paths (
  id                UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id          UUID            NOT NULL REFERENCES staff_applicants(id),
  from_series       staff_series    NOT NULL,
  to_series         staff_series    NOT NULL,
  eligibility_date  DATE,
  triggered_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  status            VARCHAR(20)     NOT NULL DEFAULT 'ELIGIBLE',
  notes             TEXT,
  UNIQUE (staff_id, from_series, to_series)
);

CREATE INDEX IF NOT EXISTS idx_rl_aadhaar ON restricted_list(aadhaar_hash);
CREATE INDEX IF NOT EXISTS idx_rl_phone   ON restricted_list(phone_hash);

-- ── 12. UPGRADE PATHS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upgrade_paths (
  id                UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id          UUID            NOT NULL REFERENCES staff_applicants(id),
  from_series       staff_series    NOT NULL,
  to_series         staff_series    NOT NULL,
  -- Valid upgrades: UC → SC, MAID → UC
  eligibility_date  DATE,
  triggered_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  status            VARCHAR(20)     NOT NULL DEFAULT 'ELIGIBLE',
  -- ELIGIBLE, IN_PROGRESS, COMPLETED, EXPIRED, DECLINED
  notes             TEXT,
  UNIQUE (staff_id, from_series, to_series)
);

CREATE INDEX IF NOT EXISTS idx_up_staff   ON upgrade_paths(staff_id);
CREATE INDEX IF NOT EXISTS idx_up_status  ON upgrade_paths(status);

-- ── 13. NOTIFICATION LOGS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_logs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient   VARCHAR(200) NOT NULL,   -- FCM token or email address
  channel     VARCHAR(20)  NOT NULL,   -- FCM | EMAIL
  template    VARCHAR(100) NOT NULL,   -- DL_EXPIRY_30D, SALARY_DISPATCHED etc.
  payload     JSONB        NOT NULL DEFAULT '{}',
  status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  -- PENDING, SENT, FAILED
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nl_status    ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_nl_channel   ON notification_logs(channel);
CREATE INDEX IF NOT EXISTS idx_nl_created   ON notification_logs(created_at DESC);

-- ── Add FK back-reference: staff_applicants.video_cert_id → video_certs ──────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_staff_video_cert'
  ) THEN
    ALTER TABLE staff_applicants
      ADD CONSTRAINT fk_staff_video_cert
      FOREIGN KEY (video_cert_id) REFERENCES video_certs(id);
  END IF;
END $$;

-- ── Auto-update updated_at trigger ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches','users','staff_applicants','placements','agreements','client_invoices'
  ] LOOP
    EXECUTE format('
      DROP TRIGGER IF EXISTS trg_updated_at ON %I;
      CREATE TRIGGER trg_updated_at
        BEFORE UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    ', t, t);
  END LOOP;
END $$;

-- ── Row-level security: pipeline_events is append-only ────────────────────────
-- (Skipping REVOKE for specific users to ensure compatibility)

-- ── Seed: default branch already inserted above ──────────────────────────────
-- Default admin user is seeded via: npm run seed:run
-- (not inserted here to avoid hardcoding passwords in SQL)

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- Run this to confirm all 13 tables were created:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' ORDER BY table_name;
-- ═══════════════════════════════════════════════════════════════════════════
