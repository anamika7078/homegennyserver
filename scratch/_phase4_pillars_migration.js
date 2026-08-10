const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  await c.query(`
    CREATE TABLE IF NOT EXISTS scope_of_work (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      placement_id UUID NOT NULL,
      client_id UUID NOT NULL,
      staff_id UUID NOT NULL,
      content TEXT NOT NULL,
      version INT NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
      is_non_standard BOOLEAN NOT NULL DEFAULT false,
      bm_approved_by UUID,
      bm_approved_at TIMESTAMPTZ,
      created_by UUID NOT NULL,
      amended_by UUID,
      sent_at TIMESTAMPTZ,
      acknowledged_by UUID,
      acknowledged_at TIMESTAMPTZ,
      supersedes_id UUID UNIQUE,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_sow_placement ON scope_of_work(placement_id);
    CREATE INDEX IF NOT EXISTS idx_sow_client ON scope_of_work(client_id);
  `);
  console.log('scope_of_work ready');

  await c.query(`
    CREATE TABLE IF NOT EXISTS client_indemnities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      placement_id UUID NOT NULL,
      client_id UUID NOT NULL,
      clause_version VARCHAR(40) NOT NULL,
      clause_text TEXT NOT NULL,
      sent_by UUID NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      acknowledged_by UUID,
      acknowledged_at TIMESTAMPTZ,
      contested BOOLEAN NOT NULL DEFAULT false,
      bm_reviewed_by UUID,
      bm_review_notes TEXT,
      bm_reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_indemnity_placement ON client_indemnities(placement_id);
    CREATE INDEX IF NOT EXISTS idx_indemnity_client ON client_indemnities(client_id);
  `);
  console.log('client_indemnities ready');

  await c.query(`
    CREATE TABLE IF NOT EXISTS right_to_refuse_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id UUID NOT NULL,
      placement_id UUID,
      invoked_by UUID NOT NULL,
      reason TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'LOGGED',
      bm_decision_by UUID,
      bm_decision_notes TEXT,
      bm_decision_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_rtr_staff ON right_to_refuse_log(staff_id);
  `);
  console.log('right_to_refuse_log ready');

  await c.query(`
    DO $$ BEGIN
      ALTER TABLE incidents ADD COLUMN legal_hold BOOLEAN NOT NULL DEFAULT false;
    EXCEPTION WHEN duplicate_column THEN NULL; END $$;
  `);
  console.log('incidents.legal_hold ready');

  await c.end();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
