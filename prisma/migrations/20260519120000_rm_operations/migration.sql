-- RM Operations: DEFERRED stage + operational tables

ALTER TYPE "staff_applicants_pipeline_stage_enum" ADD VALUE IF NOT EXISTS 'DEFERRED';

CREATE TYPE "incident_type" AS ENUM (
  'CLIENT_COMPLAINT', 'STAFF_MISCONDUCT', 'SAFETY_ISSUE',
  'ATTENDANCE_FRAUD', 'DRIVING_VIOLATION', 'LATE_EXIT'
);

CREATE TYPE "incident_status" AS ENUM (
  'OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED', 'CLOSED'
);

CREATE TYPE "shift_log_status" AS ENUM (
  'PENDING', 'APPROVED', 'REJECTED', 'FLAGGED'
);

CREATE TYPE "upgrade_status" AS ENUM (
  'RECOMMENDED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED'
);

CREATE TYPE "deferred_reason" AS ENUM (
  'PV_PENDING', 'DRIVER_RETEST', 'MEDICAL_RETEST',
  'TRAINING_GAP', 'AGREEMENT_REVIEW', 'PERSONAL_PAUSE'
);

CREATE TABLE IF NOT EXISTS "incidents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_id" UUID REFERENCES "staff_applicants"("id"),
  "client_id" UUID,
  "placement_id" UUID,
  "rm_id" UUID,
  "branch_id" UUID,
  "type" "incident_type" NOT NULL,
  "status" "incident_status" NOT NULL DEFAULT 'OPEN',
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "evidence_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "resolution" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "resolved_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "incident_comments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "incident_id" UUID NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "actor_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "shift_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_id" UUID NOT NULL REFERENCES "staff_applicants"("id"),
  "placement_id" UUID,
  "shift_date" DATE NOT NULL,
  "check_in_at" TIMESTAMPTZ,
  "check_out_at" TIMESTAMPTZ,
  "check_in_lat" DECIMAL(10,7),
  "check_in_lng" DECIMAL(10,7),
  "check_out_lat" DECIMAL(10,7),
  "check_out_lng" DECIMAL(10,7),
  "status" "shift_log_status" NOT NULL DEFAULT 'PENDING',
  "approved_by" UUID,
  "notes" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("staff_id", "shift_date")
);

CREATE TABLE IF NOT EXISTS "upgrade_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_id" UUID NOT NULL REFERENCES "staff_applicants"("id"),
  "from_series" "staff_applicants_series_enum" NOT NULL,
  "to_series" "staff_applicants_series_enum" NOT NULL,
  "status" "upgrade_status" NOT NULL DEFAULT 'RECOMMENDED',
  "eligibility_score" DECIMAL(5,2),
  "rm_recommendation" TEXT,
  "approved_by" UUID,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "deferred_records" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_id" UUID NOT NULL REFERENCES "staff_applicants"("id"),
  "reason" "deferred_reason" NOT NULL,
  "resume_stage" "staff_applicants_pipeline_stage_enum",
  "deferred_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "resume_at" TIMESTAMPTZ,
  "timeout_at" TIMESTAMPTZ,
  "notes" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "video_certifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_id" UUID NOT NULL REFERENCES "staff_applicants"("id"),
  "prompt_key" VARCHAR(80) NOT NULL,
  "video_url" TEXT NOT NULL,
  "sha256_hash" VARCHAR(64) NOT NULL,
  "attempt_number" INT NOT NULL DEFAULT 1,
  "review_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "reviewed_by" UUID,
  "review_notes" TEXT,
  "never_delete" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "login_audits" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "ip_address" VARCHAR(45),
  "user_agent" TEXT,
  "device_id" VARCHAR(64),
  "success" BOOLEAN NOT NULL DEFAULT true,
  "fail_reason" VARCHAR(120),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "incidents_rm_status_idx" ON "incidents"("rm_id", "status");
CREATE INDEX IF NOT EXISTS "shift_logs_status_idx" ON "shift_logs"("status");
CREATE INDEX IF NOT EXISTS "video_certs_staff_review_idx" ON "video_certifications"("staff_id", "review_status");
CREATE INDEX IF NOT EXISTS "login_audits_user_idx" ON "login_audits"("user_id", "created_at" DESC);
