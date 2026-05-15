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

  CREATE TYPE staff_series AS ENUM ('MAID', 'SC', 'UC', 'DR');

  CREATE TYPE pipeline_stage AS ENUM (
    'S1_INTAKE',
    'S2_VERIFY',
    'S2_5_ASSESS',   -- SC series only: care skills assessment
    'S3_TRAIN',
    'S4_AGREEMENTS',
    'S5_DEPLOY',
    'DEFERRED',
    'TERMINAL'
  );

  CREATE TYPE terminal_outcome AS ENUM (
    'PLACED', 'REJECTED', 'ABANDONED', 'RESTRICTED',
    'DEFERRED', 'CANCELLED', 'LATE_EXIT'
  );

  CREATE TYPE language_tier AS ENUM ('T1', 'T2', 'T3', 'T4');

  CREATE TYPE pv_status AS ENUM ('CLEAR', 'PENDING', 'FAILED', 'EXEMPT');

  CREATE TYPE placement_status AS ENUM (
    'TRIAL', 'CONFIRMED', 'EXITED', 'TERMINATED'
  );

  CREATE TYPE user_role AS ENUM (
    'STAFF', 'CLIENT', 'RM', 'BM', 'FINANCE', 'ADMIN'
  );

  CREATE TYPE agreement_type AS ENUM (
    'A1_EOR',          -- Employer-on-Record
    'A2_SOW',          -- Scope of Work
    'A3_INDEMNITY',    -- Indemnity
    'A4_MED_ADDENDUM', -- SC series: Medical Care Addendum
    'A5_MED_EXCLUSION' -- UC series: Medical Exclusion Clause
  );

  CREATE TYPE agreement_status AS ENUM (
    'DRAFT', 'SENT', 'SIGNED', 'REJECTED', 'EXPIRED'
  );

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
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  last_login_at       TIMESTAMPTZ,
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
  staff_code              VARCHAR(20)     UNIQUE NOT NULL,
  -- Staff code format: DR-ST-00001, SC-ST-00001, UC-ST-00001, M3-ST-00001
  user_id                 UUID            REFERENCES users(id),
  branch_id               UUID            NOT NULL REFERENCES branches(id),
  assigned_rm_id          UUID            REFERENCES users(id),
  series                  staff_series    NOT NULL,
  role_types              TEXT[]          NOT NULL DEFAULT '{}',
  language_tier           language_tier   NOT NULL DEFAULT 'T3',
  pipeline_stage          pipeline_stage  NOT NULL DEFAULT 'S1_INTAKE',
  current_scenario_code   VARCHAR(20),
  -- Scenario codes: DR-01 to DR-20, SC-01 to SC-20, UC-01 to UC-15, M3-01 to M3-12
  terminal_outcome        terminal_outcome,
  terminal_reason         TEXT,
  restrictions            JSONB           NOT NULL DEFAULT '{}',
  -- Example: {"restriction_type":"UPGRADE_PATH","restriction_until":"2027-01-01"}
  verified_docs           JSONB           NOT NULL DEFAULT '{}',
  -- Stores: dl_number, dl_valid_to, aadhaar_last4, pv_date, echallan_count etc.
  pv_status               pv_status       NOT NULL DEFAULT 'PENDING',
  restricted_list_flag    BOOLEAN         NOT NULL DEFAULT false,
  video_cert_id           UUID,           -- FK set after video_certs insert
  deposit_amount          DECIMAL(10,2)   NOT NULL DEFAULT 0,
  deposit_paid            BOOLEAN         NOT NULL DEFAULT false,
  training_start_date     DATE,
  training_end_date       DATE,
  deployment_ready_date   DATE,
  mobile                  VARCHAR(20),    -- staff mobile (may differ from user.phone)
  full_name               VARCHAR(200),   -- staff name (may differ from user.full_name)
  metadata                JSONB           NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_stage     ON staff_applicants(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_staff_branch    ON staff_applicants(branch_id);
CREATE INDEX IF NOT EXISTS idx_staff_rm        ON staff_applicants(assigned_rm_id);
CREATE INDEX IF NOT EXISTS idx_staff_series    ON staff_applicants(series);
CREATE INDEX IF NOT EXISTS idx_staff_code      ON staff_applicants(staff_code);
CREATE INDEX IF NOT EXISTS idx_staff_flag
  ON staff_applicants(restricted_list_flag)
  WHERE restricted_list_flag = true;

-- ── 4. PIPELINE EVENTS (append-only audit log) ───────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_events (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id        UUID            NOT NULL REFERENCES staff_applicants(id),
  event_type      VARCHAR(100)    NOT NULL,
  from_stage      pipeline_stage,
  to_stage        pipeline_stage,
  actor_id        UUID            REFERENCES users(id),
  scenario_code   VARCHAR(20),
  reason_code     VARCHAR(50),
  payload         JSONB           NOT NULL DEFAULT '{}',
  occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Pipeline events are append-only: no UPDATE, no DELETE allowed
CREATE INDEX IF NOT EXISTS idx_pe_staff  ON pipeline_events(staff_id);
CREATE INDEX IF NOT EXISTS idx_pe_time   ON pipeline_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_type   ON pipeline_events(event_type);

-- ── 5. VIDEO CERTIFICATIONS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_certs (
  id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id            UUID            NOT NULL REFERENCES staff_applicants(id),
  series              staff_series    NOT NULL,
  prompt_set_version  VARCHAR(20)     NOT NULL DEFAULT 'v1',
  prompt_count        INT             NOT NULL,
  duration_seconds    INT,
  storage_url         TEXT            NOT NULL,   -- GCS signed URL (short-lived)
  storage_key         TEXT            NOT NULL,   -- gs://homegenny-video-certs-prod/...
  sha256_hash         VARCHAR(64)     NOT NULL UNIQUE,  -- integrity proof
  rm_signed_off       BOOLEAN         NOT NULL DEFAULT false,
  rm_id               UUID            REFERENCES users(id),
  rm_signed_at        TIMESTAMPTZ,
  never_delete        BOOLEAN         NOT NULL DEFAULT false,
  retention_until     DATE,           -- EXIT_DATE + 7 years
  attempt_number      INT             NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vc_staff  ON video_certs(staff_id);
CREATE INDEX IF NOT EXISTS idx_vc_hash   ON video_certs(sha256_hash);
CREATE INDEX IF NOT EXISTS idx_vc_never
  ON video_certs(never_delete)
  WHERE never_delete = true;

-- ── 6. AGREEMENTS (eSign) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agreements (
  id                  UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id            UUID              NOT NULL REFERENCES staff_applicants(id),
  client_id           UUID              NOT NULL REFERENCES users(id),
  placement_id        UUID,             -- set when placement is created
  agreement_type      agreement_type    NOT NULL,
  status              agreement_status  NOT NULL DEFAULT 'DRAFT',
  -- Sequential lock: A2 cannot be generated until A1 is SIGNED
  -- A3 cannot be generated until A2 is SIGNED
  version             INT               NOT NULL DEFAULT 1,
  content_hash        VARCHAR(64),      -- SHA-256 of document at signing time
  storage_key         TEXT,             -- GCS key for signed PDF
  otp_verified_at     TIMESTAMPTZ,
  signed_by           UUID              REFERENCES users(id),
  signed_at           TIMESTAMPTZ,
  rejection_reason    TEXT,
  rejected_by         UUID              REFERENCES users(id),
  rejected_at         TIMESTAMPTZ,
  escalated_to_bm     BOOLEAN           NOT NULL DEFAULT false,
  bm_reviewed_at      TIMESTAMPTZ,
  bm_id               UUID              REFERENCES users(id),
  metadata            JSONB             NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agr_staff    ON agreements(staff_id);
CREATE INDEX IF NOT EXISTS idx_agr_client   ON agreements(client_id);
CREATE INDEX IF NOT EXISTS idx_agr_type     ON agreements(agreement_type);
CREATE INDEX IF NOT EXISTS idx_agr_status   ON agreements(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agr_unique
  ON agreements(staff_id, client_id, agreement_type, version);

-- ── 7. PLACEMENTS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placements (
  id                          UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id                    UUID              NOT NULL REFERENCES staff_applicants(id),
  client_id                   UUID              NOT NULL REFERENCES users(id),
  branch_id                   UUID              NOT NULL REFERENCES branches(id),
  rm_id                       UUID              REFERENCES users(id),
  status                      placement_status  NOT NULL DEFAULT 'TRIAL',
  exit_scenario_code          VARCHAR(20),
  scope_of_work               JSONB             NOT NULL DEFAULT '{}',
  -- Stores: duties[], working_hours, location, special_instructions
  trial_start_date            DATE,
  trial_end_date              DATE,
  billing_start_date          DATE,
  exit_date                   DATE,
  staff_salary                DECIMAL(10,2)     NOT NULL DEFAULT 0,
  management_fee              DECIMAL(10,2)     NOT NULL DEFAULT 12,
  -- management_fee stored as percentage e.g. 12 = 12%
  replacement_count           INT               NOT NULL DEFAULT 0,
  metadata                    JSONB             NOT NULL DEFAULT '{}',
  created_at                  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pl_staff   ON placements(staff_id);
CREATE INDEX IF NOT EXISTS idx_pl_client  ON placements(client_id);
CREATE INDEX IF NOT EXISTS idx_pl_status  ON placements(status);
CREATE INDEX IF NOT EXISTS idx_pl_trial
  ON placements(trial_end_date)
  WHERE status = 'TRIAL';

-- ── 8. PAYROLL RECORDS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_records (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  placement_id        UUID        NOT NULL REFERENCES placements(id),
  staff_id            UUID        NOT NULL REFERENCES staff_applicants(id),
  period_month        INT         NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year         INT         NOT NULL CHECK (period_year >= 2024),
  shift_days          INT         NOT NULL DEFAULT 0,
  gross_salary        DECIMAL(10,2) NOT NULL,
  deductions          JSONB       NOT NULL DEFAULT '{}',
  -- {"esic": 135.00, "pf": 1800.00}
  net_salary          DECIMAL(10,2) NOT NULL,
  esic_employer       DECIMAL(10,2) NOT NULL DEFAULT 0,
  esic_employee       DECIMAL(10,2) NOT NULL DEFAULT 0,
  pf_employer         DECIMAL(10,2) NOT NULL DEFAULT 0,
  pf_employee         DECIMAL(10,2) NOT NULL DEFAULT 0,
  disbursed_at        TIMESTAMPTZ,
  disbursement_ref    VARCHAR(100),   -- Razorpay payout ID
  client_invoice_id   UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (placement_id, period_month, period_year)
);

CREATE INDEX IF NOT EXISTS idx_pr_period  ON payroll_records(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_pr_staff   ON payroll_records(staff_id);

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
  -- PRESENT, ABSENT, HALF_DAY, HOLIDAY, LEAVE
  notes             TEXT,
  client_confirmed  BOOLEAN     NOT NULL DEFAULT false,
  gps_lat           DECIMAL(10,7),
  gps_lng           DECIMAL(10,7),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (placement_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_sl_placement ON shift_logs(placement_id);
CREATE INDEX IF NOT EXISTS idx_sl_date      ON shift_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_sl_staff     ON shift_logs(staff_id);

-- ── 10. CLIENT INVOICES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_invoices (
  id                        UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  placement_id              UUID        NOT NULL REFERENCES placements(id),
  client_id                 UUID        NOT NULL REFERENCES users(id),
  invoice_number            VARCHAR(50) UNIQUE NOT NULL,
  -- Format: INV-YYYYMM-XXXXXX
  period_month              INT         NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year               INT         NOT NULL CHECK (period_year >= 2024),
  staff_salary_component    DECIMAL(10,2) NOT NULL,
  management_fee            DECIMAL(10,2) NOT NULL,
  gst_amount                DECIMAL(10,2) NOT NULL,
  -- GST is ONLY on management_fee, NEVER on salary
  total_amount              DECIMAL(10,2) NOT NULL,
  due_date                  DATE        NOT NULL,
  paid_at                   TIMESTAMPTZ,
  payment_ref               VARCHAR(100),
  razorpay_order_id         VARCHAR(100),
  status                    VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  -- PENDING, PAID, OVERDUE, CANCELLED
  pdf_storage_key           TEXT,       -- GCS key for invoice PDF
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ci_client  ON client_invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_ci_status  ON client_invoices(status);
CREATE INDEX IF NOT EXISTS idx_ci_due
  ON client_invoices(due_date)
  WHERE status = 'PENDING';

-- ── 11. RESTRICTED LIST ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restricted_list (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id      UUID        REFERENCES staff_applicants(id),
  aadhaar_hash  VARCHAR(64),   -- SHA-256 of full Aadhaar number (never store raw)
  phone_hash    VARCHAR(64),   -- SHA-256 of mobile number
  name          VARCHAR(200),
  reason        VARCHAR(100)   NOT NULL,
  -- THEFT, MISCONDUCT, VIOLENCE, FRAUD, ABANDONMENT, CLIENT_REQUEST, OTHER
  added_by      UUID        REFERENCES users(id),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
REVOKE UPDATE, DELETE ON pipeline_events FROM PUBLIC;
REVOKE UPDATE, DELETE ON pipeline_events FROM hguser;

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
