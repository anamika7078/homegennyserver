const { Client } = require('pg');
require('dotenv').config();

const SQL = `
CREATE TABLE IF NOT EXISTS login_audits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  ip_address  VARCHAR(45),
  user_agent  TEXT,
  device_id   VARCHAR(64),
  success     BOOLEAN DEFAULT true NOT NULL,
  fail_reason VARCHAR(120),
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_audits_user ON login_audits(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS restricted_list (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     UUID,
  aadhaar_hash VARCHAR(64),
  phone_hash   VARCHAR(64),
  name         VARCHAR(200),
  reason       VARCHAR(100) NOT NULL,
  added_by     UUID,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_restricted_list_aadhaar ON restricted_list(aadhaar_hash);
CREATE INDEX IF NOT EXISTS idx_restricted_list_phone ON restricted_list(phone_hash);

CREATE TABLE IF NOT EXISTS deposits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     UUID NOT NULL REFERENCES staff_applicants(id),
  amount       DECIMAL(10,2) NOT NULL,
  status       VARCHAR(20) DEFAULT 'PENDING' NOT NULL,
  payment_ref  VARCHAR(100),
  collected_at TIMESTAMPTZ,
  metadata     JSONB DEFAULT '{}' NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);
`;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to DB');
  
  try {
    await client.query(SQL);
    console.log('Successfully created missing tables (login_audits, restricted_list, deposits)');
  } catch (e) {
    console.error('Error creating tables:', e.message);
  }
  
  await client.end();
}

main();
