-- Additive: extend incident_type enum with client-complaint categories from the pipeline spec.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in Postgres —
-- each statement commits independently, which is fine since these are pure additions.
ALTER TYPE "incident_type" ADD VALUE IF NOT EXISTS 'SCOPE_VIOLATION';
ALTER TYPE "incident_type" ADD VALUE IF NOT EXISTS 'ABSENTEEISM';
ALTER TYPE "incident_type" ADD VALUE IF NOT EXISTS 'CONDUCT';
ALTER TYPE "incident_type" ADD VALUE IF NOT EXISTS 'PROPERTY_DAMAGE';
ALTER TYPE "incident_type" ADD VALUE IF NOT EXISTS 'INVOICE_DISPUTE';
