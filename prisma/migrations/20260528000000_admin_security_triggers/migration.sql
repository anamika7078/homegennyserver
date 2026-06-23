-- Migration: admin_security_triggers
-- Append-only enforcement for pipeline_events and admin_audit_logs

-- Ensure pipeline_events table exists before creating triggers
CREATE TABLE IF NOT EXISTS pipeline_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      UUID NOT NULL REFERENCES staff_applicants(id),
  event_type    VARCHAR(100) NOT NULL,
  from_stage    VARCHAR(30),
  to_stage      VARCHAR(30),
  actor_id      UUID,
  scenario_code VARCHAR(20),
  reason_code   VARCHAR(80),
  payload       JSONB NOT NULL DEFAULT '{}',
  notes         TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_staff ON pipeline_events(staff_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_occurred ON pipeline_events(occurred_at DESC);

-- Ensure admin_audit_logs table exists before creating triggers
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(60),
  entity_id   UUID,
  payload     JSONB NOT NULL DEFAULT '{}',
  ip_address  VARCHAR(45),
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION prevent_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table is append-only. Modification or deletion is not allowed.';
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to pipeline_events
DROP TRIGGER IF EXISTS prevent_update_delete_pipeline_events ON pipeline_events;
CREATE TRIGGER prevent_update_delete_pipeline_events
BEFORE UPDATE OR DELETE ON pipeline_events
FOR EACH ROW EXECUTE FUNCTION prevent_update_delete();

-- Apply trigger to admin_audit_logs
DROP TRIGGER IF EXISTS prevent_update_delete_admin_audit_logs ON admin_audit_logs;
CREATE TRIGGER prevent_update_delete_admin_audit_logs
BEFORE UPDATE OR DELETE ON admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_update_delete();
