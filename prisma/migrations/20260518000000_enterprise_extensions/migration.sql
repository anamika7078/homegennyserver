-- Enterprise extensions: RBAC, audit, scenarios, verification, training, deployments

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Extend user_role enum (idempotent)
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'TRAINER';
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ASSESSOR';
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'SUPPORT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Permissions
CREATE TABLE IF NOT EXISTS permissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(80) UNIQUE NOT NULL,
  name        VARCHAR(120) NOT NULL,
  module      VARCHAR(40) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role          user_role NOT NULL,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE (role, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role);

-- Audit logs
DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM (
    'LOGIN', 'LOGOUT', 'STAGE_TRANSITION', 'APPROVAL', 'DENIAL',
    'AGREEMENT_SIGN', 'DEPLOYMENT_ACTION', 'SCENARIO_TRIGGER',
    'RESTRICTED_LIST', 'SETTINGS_CHANGE', 'PAYROLL_ACTION', 'NOTIFICATION_SENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID REFERENCES users(id),
  action      audit_action NOT NULL,
  entity_type VARCHAR(60),
  entity_id   UUID,
  ip_address  VARCHAR(45),
  user_agent  TEXT,
  before      JSONB,
  after       JSONB,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- Scenario engine
CREATE TABLE IF NOT EXISTS scenario_definitions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            VARCHAR(20) UNIQUE NOT NULL,
  series          staff_series NOT NULL,
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  severity        VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
  locks_actions   TEXT[] NOT NULL DEFAULT '{}',
  unlocks_actions TEXT[] NOT NULL DEFAULT '{}',
  notify_roles    user_role[] NOT NULL DEFAULT '{}',
  requires_bm     BOOLEAN NOT NULL DEFAULT false,
  ui_state        JSONB NOT NULL DEFAULT '{}',
  routing_rules   JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scenario_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id        UUID NOT NULL REFERENCES staff_applicants(id),
  scenario_code   VARCHAR(20) NOT NULL,
  definition_id   UUID REFERENCES scenario_definitions(id),
  triggered_by    UUID,
  pipeline_stage  pipeline_stage,
  flags           JSONB NOT NULL DEFAULT '{}',
  actions_taken   JSONB NOT NULL DEFAULT '[]',
  escalated_to_bm BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scenario_logs_staff ON scenario_logs(staff_id);

-- Verification tracks
DO $$ BEGIN
  CREATE TYPE verification_track_type AS ENUM (
    'AADHAAR_EKYC', 'POLICE_VERIFICATION', 'HEALTH_SCREENING',
    'CREDENTIAL', 'REFERENCE', 'SARATHI_API', 'ECHALLAN_API'
  );
  CREATE TYPE verification_track_status AS ENUM (
    'PENDING', 'IN_PROGRESS', 'CLEAR', 'FAILED', 'EXPIRED', 'WAIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS verification_tracks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id     UUID NOT NULL REFERENCES staff_applicants(id),
  track_type   verification_track_type NOT NULL,
  status       verification_track_status NOT NULL DEFAULT 'PENDING',
  external_ref VARCHAR(120),
  result       JSONB NOT NULL DEFAULT '{}',
  verified_by  UUID,
  verified_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_id, track_type)
);

-- Assessments
DO $$ BEGIN
  CREATE TYPE assessment_result AS ENUM ('PASS', 'PARTIAL', 'FAIL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS assessments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id        UUID NOT NULL REFERENCES staff_applicants(id),
  assessor_id     UUID,
  attempt_number  INT NOT NULL DEFAULT 1,
  skill_scores    JSONB NOT NULL DEFAULT '{}',
  result          assessment_result,
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  overreach_flags JSONB NOT NULL DEFAULT '[]',
  remarks         TEXT,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Training
CREATE TABLE IF NOT EXISTS training_sessions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id       UUID NOT NULL REFERENCES staff_applicants(id),
  trainer_id     UUID,
  day_number     INT NOT NULL,
  curriculum_key VARCHAR(40) NOT NULL,
  attended       BOOLEAN NOT NULL DEFAULT false,
  score          DECIMAL(5,2),
  video_cert_url TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  training_session_id UUID NOT NULL REFERENCES training_sessions(id),
  staff_id            UUID NOT NULL,
  check_in_at         TIMESTAMPTZ,
  check_out_at        TIMESTAMPTZ,
  gps_lat             DECIMAL(10,7),
  gps_lng             DECIMAL(10,7),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deployments (extends placements concept)
CREATE TABLE IF NOT EXISTS deployments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id          UUID NOT NULL REFERENCES staff_applicants(id),
  client_id         UUID NOT NULL REFERENCES clients(id),
  placement_id      UUID UNIQUE REFERENCES placements(id),
  status            placement_status NOT NULL DEFAULT 'TRIAL',
  trial_start_date  DATE,
  trial_end_date    DATE,
  buddy_staff_id    UUID,
  daily_log_required BOOLEAN NOT NULL DEFAULT true,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS care_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  staff_id      UUID NOT NULL REFERENCES staff_applicants(id),
  log_date      DATE NOT NULL,
  activities    JSONB NOT NULL DEFAULT '[]',
  vitals        JSONB NOT NULL DEFAULT '{}',
  escalation    BOOLEAN NOT NULL DEFAULT false,
  signed_off    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deployment_id, log_date)
);

CREATE TABLE IF NOT EXISTS medication_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  staff_id      UUID NOT NULL REFERENCES staff_applicants(id),
  log_date      DATE NOT NULL,
  medications   JSONB NOT NULL DEFAULT '[]',
  administered  BOOLEAN NOT NULL DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escalation_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id      UUID REFERENCES staff_applicants(id),
  client_id     UUID,
  severity      VARCHAR(20) NOT NULL,
  scenario_code VARCHAR(20),
  title         VARCHAR(255) NOT NULL,
  description   TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  assigned_to   UUID,
  resolved_at   TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id     UUID NOT NULL REFERENCES staff_applicants(id),
  amount       DECIMAL(10,2) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  payment_ref  VARCHAR(100),
  collected_at TIMESTAMPTZ,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- In-app notifications (separate from notification_logs)
DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('SMS', 'EMAIL', 'WHATSAPP', 'PUSH', 'IN_APP');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id),
  channel    notification_channel NOT NULL,
  title      VARCHAR(255) NOT NULL,
  body       TEXT NOT NULL,
  template   VARCHAR(100),
  payload    JSONB NOT NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  sent_at    TIMESTAMPTZ,
  status     VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

-- Staff aadhaar hash for intake
ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS aadhaar_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id VARCHAR(64);
