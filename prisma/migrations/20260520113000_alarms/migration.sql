-- Alarms table for Issues & Alarms (TypeORM AlarmsModule)

DO $$ BEGIN
  CREATE TYPE alarm_status AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE alarm_severity AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS alarms (
  id                  UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE INDEX IF NOT EXISTS idx_alarms_status ON alarms (status);
CREATE INDEX IF NOT EXISTS idx_alarms_severity ON alarms (severity);
CREATE INDEX IF NOT EXISTS idx_alarms_created_at ON alarms (created_at DESC);
