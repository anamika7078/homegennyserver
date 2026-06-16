-- Migration: admin_security_triggers
-- Append-only enforcement for pipeline_events and admin_audit_logs

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
