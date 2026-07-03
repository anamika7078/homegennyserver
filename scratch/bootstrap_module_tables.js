/**
 * Create training + finance tables on the target database.
 * Usage: node scratch/bootstrap_module_tables.js
 *        DATABASE_URL=postgresql://... node scratch/bootstrap_module_tables.js
 */
const { Client } = require('pg');
require('dotenv').config({ path: '.env' });

const SQL = `
CREATE TABLE IF NOT EXISTS training_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code   VARCHAR(40) UNIQUE NOT NULL,
  series       VARCHAR(10) NOT NULL,
  trainer_name VARCHAR(100),
  classroom    VARCHAR(80),
  start_date   DATE NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'UPCOMING',
  branch_id    UUID,
  rm_id        UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batch_enrollments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id   UUID NOT NULL REFERENCES training_batches(id) ON DELETE CASCADE,
  staff_id   UUID NOT NULL REFERENCES staff_applicants(id),
  attendance INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_training_batches_branch ON training_batches(branch_id);
CREATE INDEX IF NOT EXISTS idx_batch_enrollments_batch ON batch_enrollments(batch_id);
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log('Connected — creating training tables...');
  await client.query(SQL);
  const check = await client.query(
    `SELECT to_regclass('public.training_batches') AS batches, to_regclass('public.batch_enrollments') AS enrollments`,
  );
  console.log('Done:', check.rows[0]);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
