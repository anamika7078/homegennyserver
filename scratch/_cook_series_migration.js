/**
 * staff_applicants_series_enum learns COOK.
 *
 * Additive and safe: ADD VALUE never touches existing rows, and IF NOT EXISTS
 * makes a re-run a no-op. Nothing else in the type changes — MAID and DRIVER
 * stay as values (old staff still carry them); they are switched off for new
 * intake in src/common/config/active-series.ts, not removed here.
 *
 * The enum is owned by `postgres`, not the app user, and only the owner may
 * ALTER TYPE. So this reads MIGRATION_DATABASE_URL (an owner connection) when
 * it is set and falls back to DATABASE_URL otherwise:
 *
 *   MIGRATION_DATABASE_URL=postgresql://postgres:...@host:5432/homegenny \
 *     node scratch/_cook_series_migration.js
 *
 * upgrade_requests.from_series / to_series use the same type, so they get
 * COOK too — no separate step needed.
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: "staff_applicants_series_enum + 'COOK'",
    // ADD VALUE cannot run inside a transaction block on older Postgres;
    // pg's Client.query runs each statement on its own, so this is fine.
    sql: `ALTER TYPE staff_applicants_series_enum ADD VALUE IF NOT EXISTS 'COOK'`,
  },
];

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows: [who] } = await db.query(
      `SELECT current_user AS me, pg_get_userbyid(typowner) AS owner
         FROM pg_type WHERE typname = 'staff_applicants_series_enum'`,
    );
    console.log(`  connected as ${who.me}; enum owner is ${who.owner}`);
    for (const step of STEPS) {
      await db.query(step.sql);
      console.log(`  ok  ${step.label}`);
    }
    const { rows: [r] } = await db.query(`SELECT enum_range(NULL::staff_applicants_series_enum)::text AS v`);
    console.log(`  values now: ${r.v}`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  if (/must be owner/i.test(e.message)) {
    console.error('  → run again with MIGRATION_DATABASE_URL set to an owner (postgres) connection.');
  }
  process.exit(1);
});
