-- Core tables required by Prisma / TypeORM (clients, staff, agreements, notification_logs)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Prisma-mapped enums
DO $$ BEGIN
  CREATE TYPE staff_applicants_series_enum AS ENUM (
    'MAID', 'SKILLED_CARE', 'UNSKILLED_CARE', 'DRIVER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staff_applicants_pipeline_stage_enum AS ENUM (
    'S1_INTAKE', 'S2_VERIFY', 'S2_5_ASSESS', 'S3_TRAIN',
    'S4_AGREEMENTS', 'S5_DEPLOY', 'DEFERRED', 'TERMINAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staff_applicants_terminal_outcome_enum AS ENUM (
    'ENROLLED', 'CONDITIONAL', 'DEFERRED', 'DENIED', 'ABANDONED', 'LATE_EXIT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staff_applicants_pv_status_enum AS ENUM (
    'NOT_INITIATED', 'IN_PROGRESS', 'CLEAR', 'ADVERSE', 'EXPIRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staff_applicants_language_tier_enum AS ENUM ('T1', 'T2', 'T3', 'T4');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE agreement_status AS ENUM (
    'PENDING', 'SIGNED', 'VOID', 'EXPIRED', 'DRAFT', 'SENT', 'REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Clients
CREATE TABLE IF NOT EXISTS clients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name             VARCHAR(255) NOT NULL,
  phone                 VARCHAR(20) UNIQUE NOT NULL,
  email                 VARCHAR(255),
  address               TEXT,
  city                  VARCHAR(100),
  status                VARCHAR(32) NOT NULL DEFAULT 'PROSPECT',
  kyc_verified          BOOLEAN NOT NULL DEFAULT false,
  medical_requirements  JSONB NOT NULL DEFAULT '{}',
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ(6)
);

-- Staff applicants
CREATE TABLE IF NOT EXISTS staff_applicants (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_code               VARCHAR(30) UNIQUE NOT NULL,
  branch_id                VARCHAR(36),
  assigned_rm_id           VARCHAR(36),
  series                   staff_applicants_series_enum NOT NULL,
  role_types               TEXT,
  language_tier            staff_applicants_language_tier_enum,
  pipeline_stage           staff_applicants_pipeline_stage_enum NOT NULL DEFAULT 'S1_INTAKE',
  current_scenario         VARCHAR(20),
  terminal_outcome         staff_applicants_terminal_outcome_enum,
  full_name                VARCHAR(200) NOT NULL,
  date_of_birth            DATE NOT NULL,
  mobile                   VARCHAR(20) NOT NULL,
  email                    VARCHAR(200),
  address                  TEXT NOT NULL,
  emergency_contact_name   VARCHAR(200),
  emergency_contact_mobile VARCHAR(20),
  verified_docs            JSONB NOT NULL DEFAULT '{}',
  pv_status                staff_applicants_pv_status_enum NOT NULL DEFAULT 'NOT_INITIATED',
  restricted_list          BOOLEAN NOT NULL DEFAULT false,
  video_cert_id            VARCHAR(64),
  restrictions             JSONB NOT NULL DEFAULT '{}',
  metadata                 JSONB NOT NULL DEFAULT '{}',
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at               TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS idx_staff_applicants_pipeline_series
  ON staff_applicants (pipeline_stage, series);
CREATE INDEX IF NOT EXISTS idx_staff_applicants_branch_rm
  ON staff_applicants (branch_id, assigned_rm_id);

-- Agreements
CREATE TABLE IF NOT EXISTS agreements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      UUID REFERENCES staff_applicants(id),
  client_id     UUID NOT NULL REFERENCES clients(id),
  placement_id  UUID,
  type          VARCHAR(40) NOT NULL,
  status        agreement_status NOT NULL DEFAULT 'PENDING',
  signatures    JSONB NOT NULL DEFAULT '[]',
  pdf_url       TEXT,
  otp_verified  BOOLEAN NOT NULL DEFAULT false,
  rejected_at   TIMESTAMPTZ(6),
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agreements_staff ON agreements(staff_id);

-- Notification delivery logs (TypeORM NotificationLog)
CREATE TABLE IF NOT EXISTS notification_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient   VARCHAR(200) NOT NULL,
  channel     VARCHAR(20) NOT NULL,
  template    VARCHAR(100) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  status      VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nl_status ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_nl_channel ON notification_logs(channel);
CREATE INDEX IF NOT EXISTS idx_nl_created ON notification_logs(created_at DESC);
