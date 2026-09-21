/**
 * Stage holds — a pipeline stage whose work is still pending, while the staff
 * moves on to the next one.
 *
 * Not a stage and not a status: the staff keeps their pipeline_stage and a
 * hold is a tag on one of the stages they have reached. Holding a stage lets
 * the staff advance past its exit gate; releasing the hold is where that gate
 * is checked instead, and no placement can be made while any hold is open.
 * See pipeline-fsm.service.ts (placeHold / releaseHold).
 *
 * Additive and safe: one new table, nothing existing is altered. Re-running is
 * a no-op. The model is also declared in schema.prisma, so `db push` keeps it.
 *
 *   node scratch/_stage_holds_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'stage_holds table',
    sql: `CREATE TABLE IF NOT EXISTS stage_holds (
            id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            staff_id       UUID NOT NULL,
            stage          pipeline_stage NOT NULL,
            reason         VARCHAR(40) NOT NULL,
            notes          TEXT,
            held_by        UUID,
            held_at        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
            released_by    UUID,
            released_at    TIMESTAMPTZ(6),
            release_notes  TEXT
          )`,
  },
  {
    // Declared with the actions Prisma's relation expects, so `db push` finds
    // nothing to change.
    label: 'stage_holds → staff_applicants foreign key',
    sql: `DO $$ BEGIN
            ALTER TABLE stage_holds DROP CONSTRAINT IF EXISTS stage_holds_staff_id_fkey;
            ALTER TABLE stage_holds ADD CONSTRAINT stage_holds_staff_id_fkey
              FOREIGN KEY (staff_id) REFERENCES staff_applicants(id) ON DELETE RESTRICT ON UPDATE CASCADE;
          END $$`,
  },
  {
    label: 'stage_holds staff index',
    sql: `CREATE INDEX IF NOT EXISTS stage_holds_staff_id_idx ON stage_holds (staff_id)`,
  },
  {
    // A stage is either on hold or not — two open holds on the same stage
    // would each need releasing and neither would mean anything more.
    label: 'one open hold per staff and stage',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS stage_holds_one_open_per_stage
            ON stage_holds (staff_id, stage) WHERE released_at IS NULL`,
  },
  {
    label: 'hold stage is S1–S5',
    sql: `DO $$ BEGIN
            ALTER TABLE stage_holds ADD CONSTRAINT stage_holds_stage_check
              CHECK (stage IN ('S1_INTAKE','S2_VERIFY','S2_5_ASSESS','S3_TRAIN','S4_AGREEMENTS','S5_DEPLOY'));
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
