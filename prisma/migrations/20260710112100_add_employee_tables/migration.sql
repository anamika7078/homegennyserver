-- CreateEnum
CREATE TYPE "pipeline_stage" AS ENUM ('S1_INTAKE', 'S2_VERIFY', 'S2_5_ASSESS', 'S3_TRAIN', 'S4_AGREEMENTS', 'S5_DEPLOY', 'DEFERRED', 'TERMINAL');

-- CreateEnum
CREATE TYPE "placement_status" AS ENUM ('TRIAL', 'CONFIRMED', 'EXITED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'STAGE_TRANSITION', 'APPROVAL', 'DENIAL', 'AGREEMENT_SIGN', 'DEPLOYMENT_ACTION', 'SCENARIO_TRIGGER', 'RESTRICTED_LIST', 'SETTINGS_CHANGE', 'PAYROLL_ACTION', 'NOTIFICATION_SENT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP', 'PUSH', 'IN_APP');

-- CreateEnum
CREATE TYPE "VerificationTrackType" AS ENUM ('AADHAAR_EKYC', 'POLICE_VERIFICATION', 'HEALTH_SCREENING', 'CREDENTIAL', 'REFERENCE', 'SARATHI_API', 'ECHALLAN_API');

-- CreateEnum
CREATE TYPE "VerificationTrackStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'CLEAR', 'FAILED', 'EXPIRED', 'WAIVED');

-- CreateEnum
CREATE TYPE "AssessmentResult" AS ENUM ('PASS', 'PARTIAL', 'FAIL');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "staff_attendance_status" ADD VALUE 'HALF_DAY';

-- AlterEnum
ALTER TYPE "user_role" ADD VALUE 'HR';

-- DropForeignKey
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_actor_id_fkey";

-- DropForeignKey
ALTER TABLE "agreements" DROP CONSTRAINT "agreements_client_id_fkey";

-- DropForeignKey
ALTER TABLE "agreements" DROP CONSTRAINT "agreements_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "assessments" DROP CONSTRAINT "assessments_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "attendance_logs" DROP CONSTRAINT "attendance_logs_training_session_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_id_fkey";

-- DropForeignKey
ALTER TABLE "batch_enrollments" DROP CONSTRAINT "batch_enrollments_batch_id_fkey";

-- DropForeignKey
ALTER TABLE "batch_enrollments" DROP CONSTRAINT "batch_enrollments_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "care_logs" DROP CONSTRAINT "care_logs_deployment_id_fkey";

-- DropForeignKey
ALTER TABLE "care_logs" DROP CONSTRAINT "care_logs_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "deferred_records" DROP CONSTRAINT "deferred_records_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_client_id_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "deposits" DROP CONSTRAINT "deposits_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "escalation_logs" DROP CONSTRAINT "escalation_logs_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "incident_comments" DROP CONSTRAINT "incident_comments_incident_id_fkey";

-- DropForeignKey
ALTER TABLE "incidents" DROP CONSTRAINT "incidents_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "medication_logs" DROP CONSTRAINT "medication_logs_deployment_id_fkey";

-- DropForeignKey
ALTER TABLE "medication_logs" DROP CONSTRAINT "medication_logs_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_fkey";

-- DropForeignKey
ALTER TABLE "payroll_records" DROP CONSTRAINT "payroll_records_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "pipeline_events" DROP CONSTRAINT "pipeline_events_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_id_fkey";

-- DropForeignKey
ALTER TABLE "scenario_logs" DROP CONSTRAINT "scenario_logs_definition_id_fkey";

-- DropForeignKey
ALTER TABLE "scenario_logs" DROP CONSTRAINT "scenario_logs_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "shift_logs" DROP CONSTRAINT "shift_logs_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "staff_applicants" DROP CONSTRAINT "staff_applicants_user_id_fkey";

-- DropForeignKey
ALTER TABLE "staff_daily_attendance" DROP CONSTRAINT "staff_daily_attendance_branch_id_fkey";

-- DropForeignKey
ALTER TABLE "staff_daily_attendance" DROP CONSTRAINT "staff_daily_attendance_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "training_sessions" DROP CONSTRAINT "training_sessions_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "upgrade_requests" DROP CONSTRAINT "upgrade_requests_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_branch_id_fkey";

-- DropForeignKey
ALTER TABLE "verification_tracks" DROP CONSTRAINT "verification_tracks_staff_id_fkey";

-- DropForeignKey
ALTER TABLE "video_certifications" DROP CONSTRAINT "video_certifications_staff_id_fkey";

-- DropIndex
DROP INDEX "idx_batch_enrollments_batch";

-- DropIndex
DROP INDEX "idx_client_invoices_status";

-- DropIndex
DROP INDEX "idx_payroll_period";

-- DropIndex
DROP INDEX "idx_staff_user";

-- DropIndex
DROP INDEX "idx_users_phone";

-- AlterTable
ALTER TABLE "admin_audit_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "agreements" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "assessments" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "result",
ADD COLUMN     "result" "AssessmentResult";

-- AlterTable
ALTER TABLE "attendance_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "action",
ADD COLUMN     "action" "AuditAction" NOT NULL;

-- AlterTable
ALTER TABLE "batch_enrollments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "branches" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "care_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "client_invoices" DROP COLUMN "payment_ref",
DROP COLUMN "razorpay_order_id",
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "clients" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "deferred_records" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "resume_stage",
ADD COLUMN     "resume_stage" "pipeline_stage";

-- AlterTable
ALTER TABLE "deployments" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "status",
ADD COLUMN     "status" "placement_status" NOT NULL DEFAULT 'TRIAL',
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "deposits" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "escalation_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "incident_comments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "incidents" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "login_audits" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "medication_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "channel",
ADD COLUMN     "channel" "NotificationChannel" NOT NULL;

-- AlterTable
ALTER TABLE "payroll_records" DROP COLUMN "client_invoice_id",
DROP COLUMN "disbursement_ref",
DROP COLUMN "shift_days",
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "permissions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pipeline_events" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "role_permissions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scenario_definitions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scenario_logs" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "pipeline_stage",
ADD COLUMN     "pipeline_stage" "pipeline_stage";

-- AlterTable
ALTER TABLE "shift_logs" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "staff_applicants" DROP COLUMN "aadhaar_hash",
DROP COLUMN "current_scenario_code",
DROP COLUMN "deployment_ready_date",
DROP COLUMN "deposit_amount",
DROP COLUMN "deposit_paid",
DROP COLUMN "restricted_list_flag",
DROP COLUMN "terminal_reason",
DROP COLUMN "training_end_date",
DROP COLUMN "training_start_date",
DROP COLUMN "user_id",
ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "branch_id",
ADD COLUMN     "branch_id" UUID,
DROP COLUMN "assigned_rm_id",
ADD COLUMN     "assigned_rm_id" UUID,
DROP COLUMN "role_types",
ADD COLUMN     "role_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
DROP COLUMN "pipeline_stage",
ADD COLUMN     "pipeline_stage" "pipeline_stage" NOT NULL DEFAULT 'S1_INTAKE',
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "staff_daily_attendance" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "training_batches" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "training_sessions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "upgrade_requests" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "deleted_at",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "verification_tracks" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "track_type",
ADD COLUMN     "track_type" "VerificationTrackType" NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "VerificationTrackStatus" NOT NULL DEFAULT 'PENDING',
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "video_certifications" ALTER COLUMN "id" DROP DEFAULT;

-- DropTable
DROP TABLE "alarms";

-- DropTable
DROP TABLE "notification_logs";

-- DropEnum
DROP TYPE "alarm_severity";

-- DropEnum
DROP TYPE "alarm_status";

-- DropEnum
DROP TYPE "assessment_result";

-- DropEnum
DROP TYPE "audit_action";

-- DropEnum
DROP TYPE "notification_channel";

-- DropEnum
DROP TYPE "staff_applicants_pipeline_stage_enum";

-- DropEnum
DROP TYPE "verification_track_status";

-- DropEnum
DROP TYPE "verification_track_type";

-- CreateTable
CREATE TABLE "placements" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "rm_id" UUID,
    "status" "placement_status" NOT NULL DEFAULT 'TRIAL',
    "trial_start_date" DATE,
    "trial_end_date" DATE,
    "staff_salary" DECIMAL(10,2),
    "management_fee" DECIMAL(10,2),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restricted_list" (
    "id" UUID NOT NULL,
    "staff_id" UUID,
    "aadhaar_hash" VARCHAR(64),
    "phone_hash" VARCHAR(64),
    "name" VARCHAR(200),
    "reason" VARCHAR(100) NOT NULL,
    "added_by" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restricted_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_batches" (
    "id" UUID NOT NULL,
    "batch_number" VARCHAR(50) NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "total_gross" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_net" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_esic" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_pf" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payroll_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_entries" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "branch_id" UUID,
    "shift_days" INTEGER NOT NULL DEFAULT 0,
    "gross_salary" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "esic_employee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "esic_employer" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pf_employee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pf_employer" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "net_salary" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "razorpay_payout_id" VARCHAR(100),
    "razorpay_status" VARCHAR(50),
    "payment_date" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payroll_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_payslips" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "payslip_url" TEXT,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "payroll_payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "is_taxable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "payment_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_method" VARCHAR(50) NOT NULL,
    "transaction_id" VARCHAR(100),
    "status" VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "razorpay_transactions" (
    "id" UUID NOT NULL,
    "transaction_id" VARCHAR(100) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'INR',
    "status" VARCHAR(50) NOT NULL,
    "reference_id" VARCHAR(100),
    "event" VARCHAR(100),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "razorpay_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_ledgers" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "shift_id" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "type" VARCHAR(20) NOT NULL DEFAULT 'CREDIT',
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esic_reports" (
    "id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "total_employees" INTEGER NOT NULL DEFAULT 0,
    "total_wages" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_employee_contribution" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_employer_contribution" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "file_url" TEXT,
    "generated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "esic_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pf_reports" (
    "id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "total_employees" INTEGER NOT NULL DEFAULT 0,
    "total_wages" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_employee_contribution" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_employer_contribution" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "ecr_file_url" TEXT,
    "generated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pf_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_financial_reports" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "total_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_payroll" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_gst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "profit_margin" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_financial_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_reminders" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(20) NOT NULL DEFAULT 'SENT',
    "channel" VARCHAR(20) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "payment_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "deposit_id" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "approved_by" UUID,
    "processed_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "subject" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "priority" VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
    "assigned_to" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_approvals" (
    "id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "target_user_id" UUID,
    "requested_by" UUID NOT NULL,
    "approved_by" UUID,
    "payload" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "employee_id" VARCHAR(50) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "profile_photo" TEXT,
    "mobile" VARCHAR(20) NOT NULL,
    "alternate_mobile" VARCHAR(20),
    "email" VARCHAR(200),
    "date_of_birth" DATE NOT NULL,
    "gender" VARCHAR(20) NOT NULL,
    "blood_group" VARCHAR(10),
    "marital_status" VARCHAR(20),
    "address" TEXT NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(100) NOT NULL,
    "pincode" VARCHAR(20) NOT NULL,
    "emergency_contact" JSONB NOT NULL,
    "joining_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department" VARCHAR(100) NOT NULL,
    "designation" VARCHAR(100) NOT NULL,
    "category_id" UUID NOT NULL,
    "reporting_manager" VARCHAR(100),
    "employment_type" VARCHAR(50) NOT NULL,
    "salary" DECIMAL(10,2) NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "doc_number" VARCHAR(100),
    "file_url" TEXT NOT NULL,
    "issue_date" DATE,
    "issued_by" VARCHAR(150),
    "valid_from" DATE,
    "valid_till" DATE,
    "status" VARCHAR(50) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "check_in" TIMESTAMPTZ(6),
    "check_out" TIMESTAMPTZ(6),
    "working_hours" DECIMAL(4,2),
    "status" VARCHAR(50) NOT NULL,
    "marked_by" UUID,
    "approved_by" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restricted_list_aadhaar_hash_idx" ON "restricted_list"("aadhaar_hash");

-- CreateIndex
CREATE INDEX "restricted_list_phone_hash_idx" ON "restricted_list"("phone_hash");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_batches_batch_number_key" ON "payroll_batches"("batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payslips_entry_id_key" ON "payroll_payslips"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "razorpay_transactions_transaction_id_key" ON "razorpay_transactions"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "esic_reports_month_year_key" ON "esic_reports"("month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "pf_reports_month_year_key" ON "pf_reports"("month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "branch_financial_reports_branch_id_month_year_key" ON "branch_financial_reports"("branch_id", "month", "year");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_categories_name_key" ON "employee_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_id_key" ON "employees"("employee_id");

-- CreateIndex
CREATE INDEX "attendance_date_idx" ON "attendance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_employee_id_date_key" ON "attendance"("employee_id", "date");

-- CreateIndex
CREATE INDEX "assessments_staff_id_idx" ON "assessments"("staff_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "deferred_records_staff_id_idx" ON "deferred_records"("staff_id");

-- CreateIndex
CREATE INDEX "deployments_staff_id_idx" ON "deployments"("staff_id");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "escalation_logs_status_idx" ON "escalation_logs"("status");

-- CreateIndex
CREATE INDEX "incident_comments_incident_id_idx" ON "incident_comments"("incident_id");

-- CreateIndex
CREATE INDEX "incidents_staff_id_idx" ON "incidents"("staff_id");

-- CreateIndex
CREATE INDEX "scenario_logs_scenario_code_idx" ON "scenario_logs"("scenario_code");

-- CreateIndex
CREATE INDEX "staff_applicants_pipeline_stage_series_idx" ON "staff_applicants"("pipeline_stage", "series");

-- CreateIndex
CREATE INDEX "staff_applicants_branch_id_assigned_rm_id_idx" ON "staff_applicants"("branch_id", "assigned_rm_id");

-- CreateIndex
CREATE INDEX "training_sessions_staff_id_idx" ON "training_sessions"("staff_id");

-- CreateIndex
CREATE INDEX "upgrade_requests_staff_id_idx" ON "upgrade_requests"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tracks_staff_id_track_type_key" ON "verification_tracks"("staff_id", "track_type");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_applicants" ADD CONSTRAINT "staff_applicants_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_applicants" ADD CONSTRAINT "staff_applicants_assigned_rm_id_fkey" FOREIGN KEY ("assigned_rm_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_logs" ADD CONSTRAINT "scenario_logs_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_logs" ADD CONSTRAINT "scenario_logs_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "scenario_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tracks" ADD CONSTRAINT "verification_tracks_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_training_session_id_fkey" FOREIGN KEY ("training_session_id") REFERENCES "training_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_enrollments" ADD CONSTRAINT "batch_enrollments_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "training_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_enrollments" ADD CONSTRAINT "batch_enrollments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placements" ADD CONSTRAINT "placements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_logs" ADD CONSTRAINT "care_logs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_logs" ADD CONSTRAINT "care_logs_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_logs" ADD CONSTRAINT "medication_logs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_logs" ADD CONSTRAINT "medication_logs_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_logs" ADD CONSTRAINT "escalation_logs_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_logs" ADD CONSTRAINT "shift_logs_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_daily_attendance" ADD CONSTRAINT "staff_daily_attendance_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_daily_attendance" ADD CONSTRAINT "staff_daily_attendance_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrade_requests" ADD CONSTRAINT "upgrade_requests_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deferred_records" ADD CONSTRAINT "deferred_records_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_certifications" ADD CONSTRAINT "video_certifications_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payroll_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payslips" ADD CONSTRAINT "payroll_payslips_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "payroll_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "client_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "client_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_ledgers" ADD CONSTRAINT "salary_ledgers_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_financial_reports" ADD CONSTRAINT "branch_financial_reports_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "client_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approvals" ADD CONSTRAINT "admin_approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approvals" ADD CONSTRAINT "admin_approvals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "employee_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;


