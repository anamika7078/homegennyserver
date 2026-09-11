/**
 * `assessments` on the dev server does not match the column names the code
 * uses, so advancing a DRIVER to S5_DEPLOY dies with a bare 500.
 *
 * The deployment gate for a driver checks their practical test:
 *
 *   SELECT id FROM assessments
 *    WHERE staff_id = $1 AND skill_scores->>'assessmentType' = 'DRIVER_PRACTICAL'
 *      AND result = 'PASS'
 *
 * The server's table has `candidate_id` and a flat `assessment_type`/`score`
 * pair instead — a different generation of the same table, created by whatever
 * built that database first. Nobody noticed because nobody had tried to deploy
 * a driver: the maid and caretaker gates never touch this table.
 *
 * Additive where it can be. The old columns are kept, not dropped, so anything
 * still reading them keeps working and this stays reversible.
 *
 * Refuses to run if the table holds rows — backfilling real assessments is a
 * judgement call, not something to do silently.
 *
 *   node scratch/_fix_assessments_schema.js               # dekhne ke liye
 *   node scratch/_fix_assessments_schema.js --yes         # karne ke liye
 */
const { Client } = require('pg');
require('dotenv').config();

const MANAGED_HOSTS = /render\.com|amazonaws\.com|azure|googleapis|neon\.tech|supabase|planetscale/i;

const STEPS = [
  {
    label: 'assessments.staff_id',
    sql: `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS staff_id UUID`,
  },
  {
    // Carry anything the old column holds, so a populated table is not left
    // half-migrated even though we refuse to run on one.
    label: 'candidate_id → staff_id (backfill)',
    sql: `UPDATE assessments SET staff_id = candidate_id
           WHERE staff_id IS NULL AND candidate_id IS NOT NULL`,
    skipIfNoColumn: 'candidate_id',
  },
  {
    label: 'assessments.skill_scores',
    sql: `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS skill_scores JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  {
    // The gate reads skill_scores->>'assessmentType'; the old shape kept that
    // in a flat column. Fold it in so both spellings answer the same question.
    label: 'assessment_type/score → skill_scores (backfill)',
    sql: `UPDATE assessments
             SET skill_scores = jsonb_strip_nulls(
                   skill_scores
                   || jsonb_build_object('assessmentType', assessment_type)
                   || jsonb_build_object('score', score))
           WHERE assessment_type IS NOT NULL`,
    skipIfNoColumn: 'assessment_type',
  },
  {
    label: 'assessments.overreach_flags',
    sql: `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS overreach_flags JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  {
    label: 'assessments.approved_at',
    sql: `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
  },
  {
    label: 'staff_id foreign key',
    sql: `DO $$ BEGIN
            ALTER TABLE assessments ADD CONSTRAINT assessments_staff_id_fkey
              FOREIGN KEY (staff_id) REFERENCES staff_applicants(id) ON DELETE RESTRICT;
          EXCEPTION WHEN duplicate_object THEN NULL;
                    WHEN duplicate_table THEN NULL; END $$`,
  },
  {
    label: 'lookup index on staff_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_assessments_staff ON assessments (staff_id)`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }
  const host = new URL(url).hostname;
  if (MANAGED_HOSTS.test(host)) {
    console.error(`\n  ${host} is a managed database. Run this deliberately, not from a script that guessed.\n`);
    process.exit(1);
  }
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
  console.log(`Target: ${host}${isLocal ? '' : '  ** REMOTE **'}\n`);

  const c = new Client({
    connectionString: url,
    ssl: isLocal || host === 'postgres' ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    const has = async (col) => {
      const r = await c.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'assessments' AND column_name = $1`,
        [col],
      );
      return r.rowCount > 0;
    };

    const before = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assessments' ORDER BY ordinal_position`,
    );
    console.log('  abhi:  ' + before.rows.map((r) => r.column_name).join(', ') + '\n');

    if (await has('staff_id')) {
      console.log('  staff_id pehle se hai — kuch karne ki zaroorat nahi.\n');
      return;
    }

    const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM assessments');
    console.log(`  rows: ${rows[0].n}`);
    if (rows[0].n > 0) {
      console.error(
        `\n  Table is not empty. Backfilling real assessments is a judgement call —\n` +
        `  check what is in there before running this.\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (!process.argv.includes('--yes')) {
      console.log('\n  Kuch chhua nahi gaya. Karne ke liye:  --yes\n');
      return;
    }

    await c.query('BEGIN');
    for (const step of STEPS) {
      if (step.skipIfNoColumn && !(await has(step.skipIfNoColumn))) {
        console.log(`  skip  ${step.label}  (${step.skipIfNoColumn} is table me nahi hai)`);
        continue;
      }
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');

    const after = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assessments' ORDER BY ordinal_position`,
    );
    console.log('\n  ab:    ' + after.rows.map((r) => r.column_name).join(', '));
    console.log('\n  Ho gaya — ab ek DRIVER S5_DEPLOY tak ja sakta hai.\n');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\n  Rolled back — kuch nahi badla.');
    console.error('  ' + err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
