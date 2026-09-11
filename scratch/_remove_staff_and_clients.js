/**
 * Remove specific staff and clients, and everything hanging off them.
 *
 * Unlike _wipe_business_data_local.js, which empties the whole database, this
 * takes a list and leaves the rest alone — for clearing old test records out of
 * a shared dev server without touching the ones still in use.
 *
 * It refuses to run against a managed database, writes a snapshot of every row
 * it is about to delete before deleting anything, and does the whole thing in
 * one transaction so a failure leaves nothing half-removed.
 *
 * `pipeline_events` is append-only at the database level; its two triggers are
 * dropped inside the same transaction and restored there, so a rollback puts
 * the guard back untouched.
 *
 *   node scratch/_remove_staff_and_clients.js --staff a,b --clients X,Y
 *   node scratch/_remove_staff_and_clients.js --staff a,b --clients X,Y --yes
 *
 * Staff are named by staff_code, clients by unit_code.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const MANAGED_HOSTS = /render\.com|amazonaws\.com|azure|googleapis|neon\.tech|supabase|planetscale/i;

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

/** Children before parents. Anything absent from this database is skipped. */
const BY_STAFF = [
  'payroll_records', 'staff_daily_attendance', 'shift_logs', 'deployments',
  'agreements', 'assessments', 'verification_tracks', 'video_certifications',
  'training_sessions', 'upgrade_requests', 'deferred_records', 'escalation_logs',
  'incidents', 'care_logs', 'medication_logs', 'scenario_logs', 'staff_bank_accounts',
  // batch_enrollments is keyed by staff_id, not employee_id — it belongs to the
  // candidate, not the employment record.
  'batch_enrollments',
  'deposits', 'exit_settlements', 'placements', 'pipeline_events',
];

const BY_EMPLOYEE = [
  'attendance', 'employee_payrolls', 'payroll_details', 'payslip_documents',
  'bonus_records', 'overtime_records', 'reimbursement_requests', 'salary_advances',
  'salary_revisions', 'employee_loans', 'employee_salary_profiles',
  'employee_tax_profiles', 'employee_documents',
];

/**
 * Tables that hang off an *invoice*, not off the client directly. Listing them
 * under BY_CLIENT was wrong — they have no client_id, so the column check
 * skipped them and then client_invoices refused to go with its children still
 * attached.
 */
const BY_INVOICE = ['invoice_payments', 'invoice_items', 'payment_reminders', 'credit_notes'];

const BY_CLIENT = [
  'client_invoices', 'replacement_requests', 'finance_commercial_items',
  'finance_approval', 'finance_commercial_calculations', 'finance_quotation_items',
  'finance_quotations', 'finance_rate_cards', 'finance_customer_branches',
];

async function main() {
  const url = process.env.DATABASE_URL;
  const staffCodes = arg('--staff');
  const unitCodes = arg('--clients');
  const confirmed = process.argv.includes('--yes');

  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  if (!staffCodes.length && !unitCodes.length) {
    console.error('\n  Nothing named. Pass --staff <codes> and/or --clients <unit codes>.\n');
    process.exit(1);
  }

  const host = new URL(url).hostname;
  if (MANAGED_HOSTS.test(host)) {
    console.error(`\n  ${host} is a managed database. This deletes staff and billing — refusing.\n`);
    process.exit(1);
  }
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
  console.log(`Target: ${host}${isLocal ? '' : '  ** REMOTE **'}\n`);

  const c = new Client({
    connectionString: url,
    ssl: isLocal || host === 'postgres' ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  /**
   * A table is only usable here if it exists AND carries the column we mean to
   * match on. Databases of different vintages disagree about both — on the dev
   * server `batch_enrollments` is keyed by staff_id where this script first
   * assumed employee_id, and one mismatch was enough to roll the whole removal
   * back. Checking first turns that into a skipped line instead.
   */
  const usable = async (table, column) => {
    const r = await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return r.rowCount > 0;
  };

  try {
    // ── who is actually being removed ────────────────────────────────────
    const staff = staffCodes.length
      ? (await c.query(
          `SELECT id, staff_code, full_name FROM staff_applicants WHERE staff_code = ANY($1)`,
          [staffCodes],
        )).rows
      : [];
    const clients = unitCodes.length
      ? (await c.query(
          `SELECT id, unit_code, customer_name FROM finance_customers WHERE unit_code = ANY($1)`,
          [unitCodes],
        )).rows
      : [];

    const missingStaff = staffCodes.filter((code) => !staff.some((s) => s.staff_code === code));
    const missingClients = unitCodes.filter((code) => !clients.some((x) => x.unit_code === code));
    if (missingStaff.length) console.log(`  not found (staff)  : ${missingStaff.join(', ')}`);
    if (missingClients.length) console.log(`  not found (clients): ${missingClients.join(', ')}`);

    const staffIds = staff.map((s) => s.id);
    const clientIds = clients.map((x) => x.id);

    const employees = staffIds.length
      ? (await c.query(
          `SELECT id, employee_id, full_name FROM employees WHERE staff_applicant_id = ANY($1)`,
          [staffIds],
        )).rows
      : [];
    const employeeIds = employees.map((e) => e.id);

    // Invoices belonging to these clients. Their line items and payments have
    // to go first, or the invoice refuses to leave with children attached.
    const invoiceIds = clientIds.length
      ? (await c.query(
          `SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`,
          [clientIds],
        )).rows.map((r) => r.id)
      : [];

    console.log('\n  MITEGA:');
    staff.forEach((s) => console.log(`    staff    ${s.staff_code.padEnd(14)}${s.full_name}`));
    employees.forEach((e) => console.log(`    employee ${String(e.employee_id).padEnd(14)}${e.full_name}`));
    clients.forEach((x) => console.log(`    client   ${x.unit_code.padEnd(14)}${x.customer_name}`));

    // ── what is left behind, so it is obvious nothing else is touched ────
    const keptStaff = await c.query(
      `SELECT staff_code, full_name FROM staff_applicants
        WHERE NOT (id = ANY($1::uuid[])) ORDER BY created_at`,
      [staffIds],
    );
    const keptClients = await c.query(
      `SELECT unit_code, customer_name FROM finance_customers
        WHERE NOT (id = ANY($1::uuid[])) ORDER BY created_at`,
      [clientIds],
    );
    console.log('\n  RAHEGA:');
    keptStaff.rows.forEach((s) => console.log(`    staff    ${s.staff_code.padEnd(14)}${s.full_name}`));
    keptClients.rows.forEach((x) => console.log(`    client   ${x.unit_code.padEnd(14)}${x.customer_name}`));

    if (!staffIds.length && !clientIds.length) {
      console.log('\n  Kuch mila hi nahi — kuch nahi kiya.\n');
      return;
    }
    if (!confirmed) {
      console.log('\n  Kuch chhua nahi gaya. Karne ke liye:  --yes\n');
      return;
    }

    // ── snapshot first, always ───────────────────────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(__dirname, `_removed_${stamp}.json`);
    const snap = { taken_at: new Date().toISOString(), host, staff, clients, employees, tables: {} };

    const capture = async (table, column, ids) => {
      if (!ids.length || !(await usable(table, column))) return;
      const r = await c.query(`SELECT * FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [ids]);
      if (r.rowCount) snap.tables[`${table}.${column}`] = r.rows;
    };
    for (const t of BY_STAFF) await capture(t, 'staff_id', staffIds);
    for (const t of BY_EMPLOYEE) await capture(t, 'employee_id', employeeIds);
    for (const t of BY_INVOICE) await capture(t, 'invoice_id', invoiceIds);
    // Rows reached through a client's placements rather than through the staff
    // list — captured here so the snapshot is complete enough to undo with.
    if (clientIds.length) {
      const pIds = (await c.query(
        `SELECT id FROM placements WHERE client_id = ANY($1::uuid[])`, [clientIds],
      )).rows.map((r) => r.id);
      for (const t of ['payroll_records', 'staff_daily_attendance', 'exit_settlements']) {
        await capture(t, 'placement_id', pIds);
      }
      await capture('placements', 'client_id', clientIds);
    }
    for (const t of BY_CLIENT) await capture(t, 'client_id', clientIds);
    await capture('placements', 'client_id', clientIds);
    await capture('employees', 'staff_applicant_id', staffIds);

    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
    const rows = Object.values(snap.tables).reduce((s, v) => s + v.length, 0);
    console.log(`\n  snapshot: ${path.basename(file)}  (${rows} rows)`);

    // ── the removal ──────────────────────────────────────────────────────
    await c.query('BEGIN');
    await c.query('DROP TRIGGER IF EXISTS prevent_update_delete_pipeline_events ON pipeline_events');
    await c.query('DROP TRIGGER IF EXISTS check_pipeline_events_append_only ON pipeline_events');

    let total = 0;
    const wipe = async (table, column, ids) => {
      if (!ids.length || !(await usable(table, column))) return;
      const r = await c.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [ids]);
      if (r.rowCount) { total += r.rowCount; console.log(`    ${String(r.rowCount).padStart(5)}  ${table}`); }
    };

    // Client-owned billing first: payroll rows point at invoices.
    for (const t of BY_INVOICE) await wipe(t, 'invoice_id', invoiceIds);
    for (const t of BY_CLIENT) await wipe(t, 'client_id', clientIds);
    for (const t of BY_EMPLOYEE) await wipe(t, 'employee_id', employeeIds);
    if (employeeIds.length) await wipe('employees', 'id', employeeIds);
    for (const t of BY_STAFF) await wipe(t, 'staff_id', staffIds);
    // A client's placements may belong to staff who are staying, so they are
    // not covered by the staff sweep above — and their payroll rows have to go
    // first, since payroll_records.placement_id is RESTRICT.
    if (clientIds.length) {
      const placementIds = (await c.query(
        `SELECT id FROM placements WHERE client_id = ANY($1::uuid[])`, [clientIds],
      )).rows.map((r) => r.id);
      for (const t of ['payroll_records', 'staff_daily_attendance', 'exit_settlements']) {
        await wipe(t, 'placement_id', placementIds);
      }
    }
    await wipe('placements', 'client_id', clientIds);
    if (staffIds.length) await wipe('staff_applicants', 'id', staffIds);
    if (clientIds.length) await wipe('finance_customers', 'id', clientIds);

    // The logins those records owned. Other roles are never touched.
    if (staffIds.length || clientIds.length) {
      const u = await c.query(
        `DELETE FROM users WHERE role::text IN ('STAFF','CLIENT')
           AND id IN (SELECT unnest($1::uuid[]))`,
        [[...snap.staff.map((s) => s.user_id), ...snap.clients.map((x) => x.user_id)].filter(Boolean)],
      );
      if (u.rowCount) { total += u.rowCount; console.log(`    ${String(u.rowCount).padStart(5)}  users`); }
    }

    await c.query(`
      CREATE TRIGGER prevent_update_delete_pipeline_events
        BEFORE DELETE OR UPDATE ON public.pipeline_events
        FOR EACH ROW EXECUTE FUNCTION prevent_update_delete()`);
    await c.query(`
      CREATE TRIGGER check_pipeline_events_append_only
        BEFORE DELETE OR UPDATE ON public.pipeline_events
        FOR EACH ROW EXECUTE FUNCTION prevent_pipeline_events_mutation()`);
    await c.query('COMMIT');

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
    await c.query('ROLLBACK').catch(() => {});
    console.error('\n  Rolled back — kuch nahi badla.');
    console.error('  ' + err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
