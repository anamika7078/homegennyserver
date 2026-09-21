/**
 * stage_holds learns a second kind: COMPLETE.
 *
 * A HOLD says "this stage's work is still pending" — temporary, meant to be
 * released once the work is actually done, and it blocks placement in the
 * meantime. A COMPLETE says "this stage's work already happened outside the
 * system" (a migrated or previously-vetted staff member) — permanent, never
 * re-checked, and it does NOT block placement, because the work is done, not
 * deferred. Both still suppress the same S5_DEPLOY/S2_VERIFY gate blockers;
 * only placement-blocking and release-time re-checking tell them apart.
 *
 * Additive and safe: every existing row defaults to 'HOLD', which is exactly
 * what it already meant. Re-running is a no-op.
 *
 *   node scratch/_stage_overrides_kind_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'stage_holds.kind',
    sql: `ALTER TABLE stage_holds ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'HOLD'`,
  },
  {
    label: 'kind is HOLD or COMPLETE',
    sql: `DO $$ BEGIN
            ALTER TABLE stage_holds ADD CONSTRAINT stage_holds_kind_check
              CHECK (kind IN ('HOLD','COMPLETE'));
          EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  },
];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    for (const step of STEPS) {
      await db.query(step.sql);
      console.log(`  ok  ${step.label}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
