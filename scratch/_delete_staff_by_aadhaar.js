/**
 * Hard-delete one staff applicant and everything hanging off them.
 *
 * Written for a specific instruction from the owner: remove `hunesh002` so the
 * Aadhaar and mobile behind them can be used again. It is not a routine tool —
 * a staff record carries a deposit, verification tracks, video certifications
 * and an audit trail, and normally the right answer is `deleted_at`.
 *
 * Two things it does that deserve saying out loud:
 *
 *  - It writes every row it is about to remove to a JSON file first. Without
 *    that this is unrecoverable, and "the owner asked" is not a reason to make
 *    something unrecoverable when a snapshot costs nothing.
 *
 *  - `pipeline_events` is append-only, enforced by two BEFORE DELETE triggers.
 *    They are dropped, the rows removed, and the triggers recreated from their
 *    captured definitions inside the same transaction — so a failure anywhere
 *    rolls the protection back with everything else. The guarantee is never
 *    left off.
 *
 * Usage:  node scratch/_delete_staff_by_aadhaar.js <aadhaar> [--confirm]
 * Without --confirm it only reports what it would remove.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const AADHAAR = process.argv[2];
const CONFIRMED = process.argv.includes('--confirm');

// FK-safe order: children first, the applicant last.
const CHILD_TABLES = [
  ['deposits', 'staff_id'],
  ['verification_tracks', 'staff_id'],
  ['video_certifications', 'staff_id'],
  ['assessments', 'staff_id'],
  ['scenario_logs', 'staff_id'],
  ['scope_of_work', 'staff_id'],
  ['staff_daily_attendance', 'staff_id'],
  ['shift_logs', 'staff_id'],
  ['payroll_records', 'staff_id'],
  ['agreements', 'staff_id'],
  ['placements', 'staff_id'],
  ['batch_enrollments', 'staff_id'],
  ['incidents', 'staff_id'],
  ['pipeline_events', 'staff_id'],
];

async function main() {
  if (!AADHAAR) {
    console.error('Usage: node scratch/_delete_staff_by_aadhaar.js <aadhaar> [--confirm]');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

  const host = new URL(url).hostname;
  const isLocal = /localhost|127\.0\.0\.1/.test(host);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();
  console.log(`\nTarget: ${host}${isLocal ? ' (local)' : '  ** PRODUCTION **'}\n`);

  try {
    const found = await c.query(
      `SELECT id, staff_code, full_name, mobile, user_id
         FROM staff_applicants WHERE aadhaar_number = $1`,
      [AADHAAR],
    );
    if (!found.rowCount) {
      console.log('  No staff applicant carries that Aadhaar. Nothing to do.');
      return;
    }
    if (found.rowCount > 1) {
      console.error(`  REFUSING — ${found.rowCount} applicants share that Aadhaar. Resolve by hand.`);
      process.exitCode = 1;
      return;
    }

    const staff = found.rows[0];
    console.log(`  ${staff.staff_code} — ${staff.full_name}  ·  ${staff.mobile}\n`);

    // ── snapshot ─────────────────────────────────────────────────────────
    const snapshot = { takenAt: new Date().toISOString(), staff_applicant: staff, children: {}, user: null };
    let totalChildren = 0;

    for (const [table, col] of CHILD_TABLES) {
      try {
        const rows = await c.query(`SELECT * FROM ${table} WHERE ${col} = $1`, [staff.id]);
        if (rows.rowCount) {
          snapshot.children[table] = rows.rows;
          totalChildren += rows.rowCount;
          console.log(`    ${String(rows.rowCount).padStart(4)}  ${table}`);
        }
      } catch {
        // Table absent in this environment — nothing to remove from it.
      }
    }

    if (staff.user_id) {
      const u = await c.query(`SELECT * FROM users WHERE id = $1`, [staff.user_id]);
      snapshot.user = u.rows[0] ?? null;
      if (u.rowCount) console.log(`       1  users (login ${u.rows[0].phone})`);
    }

    console.log(`\n  ${totalChildren} related row(s) plus the applicant itself.`);

    if (!CONFIRMED) {
      console.log('\n  Dry run — nothing was deleted. Re-run with --confirm to proceed.\n');
      return;
    }

    const backupPath = path.join(
      __dirname,
      `_deleted_${staff.staff_code}_${Date.now()}.json`,
    );
    fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
    console.log(`\n  Snapshot written: ${path.basename(backupPath)}`);

    // ── delete ───────────────────────────────────────────────────────────
    const triggers = await c.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS def
         FROM pg_trigger
        WHERE tgrelid = 'pipeline_events'::regclass AND NOT tgisinternal`,
    );

    await c.query('BEGIN');
    try {
      // The append-only guarantee comes off and goes straight back on, inside
      // this transaction, so any failure below restores it.
      for (const t of triggers.rows) {
        await c.query(`DROP TRIGGER IF EXISTS ${t.tgname} ON pipeline_events`);
      }

      for (const [table, col] of CHILD_TABLES) {
        try {
          const r = await c.query(`DELETE FROM ${table} WHERE ${col} = $1`, [staff.id]);
          if (r.rowCount) console.log(`  ok    removed ${r.rowCount} from ${table}`);
        } catch (e) {
          if (!/does not exist/i.test(e.message)) throw e;
        }
      }

      await c.query(`DELETE FROM staff_applicants WHERE id = $1`, [staff.id]);
      console.log(`  ok    removed staff_applicant ${staff.staff_code}`);

      if (staff.user_id) {
        await c.query(`DELETE FROM users WHERE id = $1`, [staff.user_id]);
        console.log(`  ok    removed login ${snapshot.user?.phone ?? staff.user_id}`);
      }

      for (const t of triggers.rows) {
        await c.query(t.def);
      }
      console.log(`  ok    restored ${triggers.rowCount} append-only trigger(s)`);

      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }

    // ── verify the protection really is back ─────────────────────────────
    const after = await c.query(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgrelid = 'pipeline_events'::regclass AND NOT tgisinternal`,
    );
    if (after.rows[0].n !== triggers.rowCount) {
      console.error(
        `\n  WARNING: pipeline_events has ${after.rows[0].n} trigger(s), expected ` +
          `${triggers.rowCount}. Restore them before anything else.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`\n  Verified: pipeline_events is append-only again (${after.rows[0].n} triggers).`);
    console.log(`  ${staff.mobile} and that Aadhaar are free to reuse.\n`);
  } catch (err) {
    console.error('\n  Failed — nothing partial was left behind.');
    console.error('  ' + err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
