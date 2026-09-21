/**
 * Placements learn which RM they belong to.
 *
 * Neither the web nor the mobile create flow ever sent rm_id, and the backend
 * didn't fill it, so every placement has rm_id NULL — and the RM's trial list
 * and placement list, both scoped by rm_id, came back empty for every RM.
 * create() now takes it from the staff's assigned RM; this fills the rows made
 * before that.
 *
 * Safe: touches only rows where rm_id IS NULL, and only sets it to the RM the
 * staff is already assigned to. Re-running is a no-op.
 *
 *   node scratch/_rm_placement_rm_backfill_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const r = await db.query(`
      UPDATE placements p
         SET rm_id = sa.assigned_rm_id
        FROM staff_applicants sa
       WHERE sa.id = p.staff_id
         AND p.rm_id IS NULL
         AND sa.assigned_rm_id IS NOT NULL`);
    console.log(`placements.rm_id backfilled from the staff's assigned RM: ${r.rowCount} row(s)`);
    const { rows: [left] } = await db.query(`SELECT count(*)::int AS n FROM placements WHERE rm_id IS NULL`);
    console.log(`still without an RM (staff has no assigned RM): ${left.n}`);
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
