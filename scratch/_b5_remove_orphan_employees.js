/**
 * B5 — remove employees that never came from the pipeline.
 *
 * Every employee is a candidate the pipeline carried to S5_DEPLOY and placed
 * with a client (ONE_STAFF_MODEL_PLAN.md §B4). A row with a null
 * `staff_applicant_id` belongs to nobody: it was minted through the direct
 * `POST /employees` door, which B4 has since closed.
 *
 * Production held two — `ANAMIKA001` (designation "Caretaker") and `JJ001`
 * ("Office Boy"). Both are placed-staff roles, not office roles, and the
 * Anamika record duplicated a `staff_applicants` row that had only reached
 * S2_VERIFY, so she had never been deployed at all.
 *
 * Safety: every FK into `employees` is ON DELETE CASCADE, so this script
 * REFUSES to delete any orphan that actually carries attendance, payroll,
 * documents or a tax profile. Losing real records as a side effect of tidying
 * identity rows would be the wrong trade — such a row needs a person to link
 * it to its candidate instead.
 *
 * Logins are left alone. A `users` row has no FK to `employees` and may belong
 * to the person in their own right: 9975280366 is Anamika's actual staff login,
 * linked to `staff_applicants.anamika002`. The script reports which logins are
 * left without any owner rather than deleting them.
 */
const { Client } = require('pg');
require('dotenv').config();

const DEPENDENTS = [
  ['attendance', 'employee_id'],
  ['employee_documents', 'employee_id'],
  ['employee_payrolls', 'employee_id'],
  ['employee_tax_profiles', 'employee_id'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();
  console.log(`\nTarget: ${new URL(url).hostname}${isLocal ? ' (local)' : '  ** REMOTE **'}\n`);

  try {
    const orphans = await c.query(
      `SELECT id, employee_id, full_name, mobile, department, designation
         FROM employees
        WHERE staff_applicant_id IS NULL
        ORDER BY employee_id`,
    );

    if (!orphans.rowCount) {
      console.log('  ok    no orphan employees — nothing to do');
      return;
    }

    // ── refuse to cascade real records away ──────────────────────────────
    const blocked = [];
    for (const e of orphans.rows) {
      const carries = [];
      for (const [table, col] of DEPENDENTS) {
        try {
          const n = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [e.id]);
          if (n.rows[0].n) carries.push(`${n.rows[0].n} in ${table}`);
        } catch {
          // Table absent in this environment — nothing to lose from it.
        }
      }
      if (carries.length) blocked.push({ ...e, carries });
    }

    if (blocked.length) {
      console.error('  REFUSING — these orphans carry records that would cascade away:\n');
      for (const b of blocked) {
        console.error(`    ${b.employee_id}  ${b.full_name}  →  ${b.carries.join(', ')}`);
      }
      console.error(
        '\n  Link each to its staff_applicants row instead, or move the records first.\n' +
          '  Nothing was changed.\n',
      );
      process.exitCode = 1;
      return;
    }

    await c.query('BEGIN');
    for (const e of orphans.rows) {
      await c.query(`DELETE FROM employees WHERE id = $1`, [e.id]);
      console.log(
        `  ok    removed ${e.employee_id}  ${e.full_name}  (${e.department} / ${e.designation})`,
      );
    }
    await c.query('COMMIT');

    // ── report logins nobody owns any more ───────────────────────────────
    const mobiles = orphans.rows.map((e) => e.mobile).filter(Boolean);
    if (mobiles.length) {
      const stranded = await c.query(
        `SELECT u.phone, u.full_name, u.role::text AS role
           FROM users u
          WHERE u.phone = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM staff_applicants sa WHERE sa.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.mobile = u.phone)`,
        [mobiles],
      );
      if (stranded.rowCount) {
        console.log('\n  Logins now owned by nothing (left in place, not deleted):');
        for (const s of stranded.rows) {
          console.log(`    ${s.phone}  ${s.full_name}  role=${s.role}`);
        }
        console.log('  Deactivate or remove these separately if they are not wanted.');
      }
    }

    console.log('\nB5 migration applied.');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nRolled back — nothing was changed.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
