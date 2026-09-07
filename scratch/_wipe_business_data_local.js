/**
 * Clear every client and staff record from the LOCAL database, so testing can
 * start from nothing.
 *
 * What goes: clients, staff, their placements, attendance, payroll, invoices,
 * deposits, verifications, agreements, and the STAFF/CLIENT logins that belong
 * to them.
 *
 * What stays: your own logins (Admin, RM, BM, HR, Finance, Trainer, Assessor,
 * Support), branches, employee categories, system settings and tax rules —
 * delete those and nothing can be created again.
 *
 * Three things this refuses to do:
 *   - run against anything but localhost;
 *   - run without first writing a full snapshot to scratch/, so a wrong call
 *     is recoverable;
 *   - leave the pipeline_events append-only triggers off. They are dropped
 *     inside the transaction and restored in the same one, so a failure
 *     anywhere rolls back with the guard intact.
 *
 *   node scratch/_wipe_business_data_local.js          # show what would go
 *   node scratch/_wipe_business_data_local.js --yes    # actually do it
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONFIRMED = process.argv.includes('--yes');

// Delete order: children before parents. Every table here holds business data
// created by using the app — none of it is configuration.
const WIPE_ORDER = [
  // ── finance: invoices and money ────────────────────────────────────────
  'invoice_payments',
  'invoice_items',
  'payment_reminders',
  'credit_notes',
  'client_invoices',
  'exit_settlements',
  'payroll_records',
  'deposits',
  'finance_commercial_items',
  'finance_approval',
  'finance_commercial_calculations',
  'finance_quotation_items',
  'finance_quotations',
  'finance_rate_cards',
  'finance_customer_branches',

  // ── HR: the employee record and everything hanging off it ─────────────
  'attendance',
  'employee_payrolls',
  'payroll_details',
  'payslip_documents',
  'bonus_records',
  'overtime_records',
  'reimbursement_requests',
  'salary_advances',
  'salary_revisions',
  'employee_loans',
  'employee_salary_profiles',
  'employee_tax_profiles',
  'employee_documents',
  'batch_enrollments',
  'employees',

  // ── the pipeline: a candidate's whole life ────────────────────────────
  'staff_daily_attendance',
  'shift_logs',
  'placements',
  'deployments',
  'agreements',
  'assessments',
  'verification_tracks',
  'video_certifications',
  'attendance_logs',
  'training_sessions',
  'upgrade_requests',
  'deferred_records',
  'escalation_logs',
  'incident_comments',
  'incidents',
  'care_logs',
  'medication_logs',
  'scenario_logs',
  'staff_bank_accounts',
  'pipeline_events',
  'staff_applicants',

  // ── the clients themselves ────────────────────────────────────────────
  'finance_customers',
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — refusing to guess.');
    process.exit(1);
  }
  const host = new URL(url).hostname;
  if (!/^(localhost|127\.0\.0\.1)$/.test(host)) {
    console.error(`\nThis wipes business data and ${host} is not localhost. Refusing.\n`);
    process.exit(1);
  }

  const c = new Client({ connectionString: url });
  await c.connect();

  try {
    // ── what is there now ────────────────────────────────────────────────
    const counts = [];
    for (const t of WIPE_ORDER) {
      try {
        const r = await c.query(`SELECT COUNT(*)::int n FROM ${t}`);
        if (r.rows[0].n > 0) counts.push([t, r.rows[0].n]);
      } catch {
        /* table not in this database — skip silently, it holds nothing */
      }
    }
    const logins = await c.query(
      `SELECT COUNT(*)::int n FROM users WHERE role::text IN ('STAFF','CLIENT')`,
    );
    const keeping = await c.query(
      `SELECT role::text AS role, COUNT(*)::int n FROM users
        WHERE role::text NOT IN ('STAFF','CLIENT') GROUP BY role ORDER BY role`,
    );

    console.log('\n  MITEGA (business data):');
    if (!counts.length) console.log('    (kuch bhi nahi — pehle se khaali hai)');
    counts.forEach(([t, n]) => console.log(`    ${String(n).padStart(6)}  ${t}`));
    console.log(`    ${String(logins.rows[0].n).padStart(6)}  users (STAFF + CLIENT logins)`);

    console.log('\n  RAHEGA (config aur aapke logins):');
    keeping.rows.forEach((r) => console.log(`    ${String(r.n).padStart(6)}  users — ${r.role}`));
    for (const t of ['branches', 'employee_categories', 'system_settings', 'tax_rules']) {
      try {
        const r = await c.query(`SELECT COUNT(*)::int n FROM ${t}`);
        console.log(`    ${String(r.rows[0].n).padStart(6)}  ${t}`);
      } catch { /* not present */ }
    }

    if (!CONFIRMED) {
      console.log('\n  Kuch chhua nahi gaya. Karne ke liye:  --yes\n');
      return;
    }

    // ── snapshot first, always ───────────────────────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(__dirname, `_wiped_local_${stamp}.json`);
    const snapshot = { taken_at: new Date().toISOString(), database: url.split('/').pop(), tables: {} };
    for (const [t] of counts) {
      const r = await c.query(`SELECT * FROM ${t}`);
      snapshot.tables[t] = r.rows;
    }
    const u = await c.query(`SELECT * FROM users WHERE role::text IN ('STAFF','CLIENT')`);
    snapshot.tables.users_staff_client = u.rows;
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    const rows = Object.values(snapshot.tables).reduce((s, v) => s + v.length, 0);
    console.log(`\n  snapshot: ${path.basename(file)}  (${rows} rows)`);

    // ── the wipe ─────────────────────────────────────────────────────────
    await c.query('BEGIN');
    // pipeline_events is append-only at the database level. Drop the guards
    // inside the transaction so a rollback puts them back untouched.
    await c.query('DROP TRIGGER IF EXISTS prevent_update_delete_pipeline_events ON pipeline_events');
    await c.query('DROP TRIGGER IF EXISTS check_pipeline_events_append_only ON pipeline_events');

    let total = 0;
    for (const t of WIPE_ORDER) {
      try {
        const r = await c.query(`DELETE FROM ${t}`);
        if (r.rowCount) {
          total += r.rowCount;
          console.log(`    ${String(r.rowCount).padStart(6)}  ${t}`);
        }
      } catch (e) {
        if (e.code === '42P01') continue;          // table not here
        throw e;
      }
    }

    const du = await c.query(`DELETE FROM users WHERE role::text IN ('STAFF','CLIENT')`);
    total += du.rowCount;
    console.log(`    ${String(du.rowCount).padStart(6)}  users (STAFF + CLIENT)`);

    // Invoice numbering restarts too, or the first new invoice carries a
    // sequence from customers that no longer exist.
    await c.query(`UPDATE finance_customers SET bill_seq = 0, credit_note_seq = 0`);

    await c.query(`
      CREATE TRIGGER prevent_update_delete_pipeline_events
        BEFORE DELETE OR UPDATE ON public.pipeline_events
        FOR EACH ROW EXECUTE FUNCTION prevent_update_delete()`);
    await c.query(`
      CREATE TRIGGER check_pipeline_events_append_only
        BEFORE DELETE OR UPDATE ON public.pipeline_events
        FOR EACH ROW EXECUTE FUNCTION prevent_pipeline_events_mutation()`);

    await c.query('COMMIT');

    // The guards must be back on. Say so out loud rather than assuming.
    const tg = await c.query(
      `SELECT COUNT(*)::int n FROM pg_trigger
        WHERE tgrelid = 'pipeline_events'::regclass AND NOT tgisinternal`,
    );
    console.log(`\n  ${total} rows deleted.`);
    console.log(`  pipeline_events append-only triggers: ${tg.rows[0].n}/2 wapas lage`);
    if (tg.rows[0].n !== 2) {
      console.error('  WARNING: the append-only guard is not fully back. Restore it before using this database.');
      process.exitCode = 1;
    }
    console.log(`  Wapas chahiye to: ${path.basename(file)}\n`);
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* already rolled back */ }
    console.error('\n  Rolled back — kuch nahi badla.');
    console.error('  ' + err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
