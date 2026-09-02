/**
 * B1 — the month-end cron must issue ONE invoice per client, not one per
 * placement.
 *
 * The bug this proves is fixed: a client with two staff used to receive two
 * unrelated invoices, each numbered from a placement id.
 *
 * This boots the real Nest application context and calls the real cron method
 * — not a reimplementation of it — against a fixture of one customer with two
 * placements. Everything it creates is torn down in the finally block.
 *
 * Run:  node scratch/_live_test_b1_consolidated_cron.js
 */
require('dotenv').config();
const { Client } = require('pg');

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m    ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// A period far enough back that no real data or cron run can collide with it.
const MONTH = 2;
const YEAR = 2019;
const TAG = 'B1TEST';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const made = { customerId: null, staffIds: [], placementIds: [], branchId: null };

  try {
    // ── purge anything a previous interrupted run left behind ──────────────
    await purge(db);

    // ── fixture: one customer, two staff, two placements ──────────────────
    const branch = await db.query(`SELECT id FROM branches LIMIT 1`);
    if (!branch.rowCount) throw new Error('no branch in database — cannot build fixture');
    made.branchId = branch.rows[0].id;

    const anyUser = await db.query(`SELECT id FROM users LIMIT 1`);
    const markedBy = anyUser.rows[0].id;

    const cust = await db.query(
      `INSERT INTO finance_customers
         (id, customer_name, bill_no_prefix, bill_seq, state, city, address,
          pan_card, unit_code, unit_name, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 0, 'Delhi', 'Delhi', 'Test address',
               'AAAAA0000A', $3, $1, now())
       RETURNING id`,
      [`${TAG} Consolidated Client`, `${TAG}/2019`, `${TAG}-UNIT`],
    );
    made.customerId = cust.rows[0].id;

    for (const [i, name] of [[1, 'B1 Driver'], [2, 'B1 Cook']]) {
      const staff = await db.query(
        `INSERT INTO staff_applicants
           (id, staff_code, full_name, mobile, date_of_birth, address,
            series, pipeline_stage, branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-01-01', 'Test address',
                 'DRIVER', 'S5_DEPLOY', $4, now(), now())
         RETURNING id`,
        [`${TAG}00${i}`, name, `98999900${i}0`, made.branchId],
      );
      made.staffIds.push(staff.rows[0].id);

      const pl = await db.query(
        `INSERT INTO placements
           (id, staff_id, client_id, branch_id, status, staff_salary, management_fee,
            confirmed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 18000, 2000,
                 $4, now(), now())
         RETURNING id`,
        [staff.rows[0].id, made.customerId, made.branchId, `${YEAR}-0${MONTH}-01`],
      );
      made.placementIds.push(pl.rows[0].id);

      // 26 present days each, so payroll has something billable to compute.
      for (let d = 1; d <= 26; d++) {
        await db.query(
          `INSERT INTO staff_daily_attendance
             (id, staff_id, placement_id, branch_id, attendance_date, status,
              marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PRESENT', $5, now(), now())`,
          [
            staff.rows[0].id,
            pl.rows[0].id,
            made.branchId,
            `${YEAR}-0${MONTH}-${String(d).padStart(2, '0')}`,
            markedBy,
          ],
        );
      }
    }

    console.log(`\n  fixture: 1 customer, ${made.placementIds.length} placements, 26 days each\n`);

    // ── run the real cron ─────────────────────────────────────────────────
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../dist/app.module');
    const { EnterpriseCronService } = require('../dist/modules/cron/enterprise-cron.service');

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const cron = app.get(EnterpriseCronService);

    // The cron always bills the *previous* month, so drive the clock to the
    // month after the fixture period rather than reimplementing its date math.
    const realNow = Date.now;
    Date.now = () => new Date(YEAR, MONTH, 15).getTime();
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(YEAR, MONTH, 15);
        else super(...args);
      }
      static now() { return new RealDate(YEAR, MONTH, 15).getTime(); }
    };

    try {
      await cron.autoGenerateAttendanceInvoices();
    } finally {
      global.Date = RealDate;
      Date.now = realNow;
      await app.close();
    }

    // ── what should have happened ─────────────────────────────────────────
    const payrolls = await db.query(
      `SELECT id, placement_id FROM payroll_records
        WHERE placement_id = ANY($1::uuid[]) AND period_month = $2 AND period_year = $3`,
      [made.placementIds, MONTH, YEAR],
    );
    check(
      'payroll runs per placement — both staff paid',
      payrolls.rowCount === 2,
      `expected 2 payroll_records, got ${payrolls.rowCount}`,
    );

    const invoices = await db.query(
      `SELECT id, invoice_number, is_consolidated, placement_id, total_amount
         FROM client_invoices
        WHERE client_id = $1 AND period_month = $2 AND period_year = $3`,
      [made.customerId, MONTH, YEAR],
    );
    check(
      'ONE invoice for the client, not one per placement',
      invoices.rowCount === 1,
      `expected 1 invoice, got ${invoices.rowCount}` +
        (invoices.rowCount > 1
          ? ` (${invoices.rows.map((r) => r.invoice_number).join(', ')})`
          : ''),
    );

    if (invoices.rowCount === 1) {
      const inv = invoices.rows[0];

      check('invoice is marked consolidated', inv.is_consolidated === true);

      check(
        'invoice is not tied to a single placement',
        inv.placement_id === null,
        `placement_id = ${inv.placement_id}`,
      );

      check(
        'invoice number comes from the client prefix, not a placement id',
        String(inv.invoice_number).startsWith(`${TAG}/2019`),
        `got ${inv.invoice_number}`,
      );

      const items = await db.query(
        `SELECT staff_id, amount FROM invoice_items WHERE invoice_id = $1`,
        [inv.id],
      );
      const distinctStaff = new Set(items.rows.map((r) => String(r.staff_id))).size;
      check(
        'both staff appear as line items on that one invoice',
        distinctStaff === 2,
        `distinct staff on invoice = ${distinctStaff}`,
      );

      const itemsTotal = items.rows.reduce((s, r) => s + Number(r.amount), 0);
      check(
        'line items reconcile to the invoice total',
        Math.abs(itemsTotal - Number(inv.total_amount)) < 0.01,
        `items ${itemsTotal.toFixed(2)} vs total ${Number(inv.total_amount).toFixed(2)}`,
      );

      const linked = await db.query(
        `SELECT count(*)::int AS n FROM payroll_records
          WHERE client_invoice_id = $1`,
        [inv.id],
      );
      check(
        'both payroll records are linked to the invoice',
        linked.rows[0].n === 2,
        `linked = ${linked.rows[0].n}`,
      );
    }

    // ── running it twice must not double-bill ─────────────────────────────
    const app2 = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const cron2 = app2.get(EnterpriseCronService);
    const RealDate2 = Date;
    global.Date = class extends RealDate2 {
      constructor(...args) {
        if (args.length === 0) super(YEAR, MONTH, 15);
        else super(...args);
      }
      static now() { return new RealDate2(YEAR, MONTH, 15).getTime(); }
    };
    try {
      await cron2.autoGenerateAttendanceInvoices();
    } finally {
      global.Date = RealDate2;
      await app2.close();
    }

    const after = await db.query(
      `SELECT count(*)::int AS inv FROM client_invoices
        WHERE client_id = $1 AND period_month = $2 AND period_year = $3`,
      [made.customerId, MONTH, YEAR],
    );
    const afterPay = await db.query(
      `SELECT count(*)::int AS n FROM payroll_records
        WHERE placement_id = ANY($1::uuid[]) AND period_month = $2 AND period_year = $3`,
      [made.placementIds, MONTH, YEAR],
    );
    check('re-running the cron does not create a second invoice', after.rows[0].inv === 1,
      `invoices now ${after.rows[0].inv}`);
    check('re-running the cron does not pay anyone twice', afterPay.rows[0].n === 2,
      `payroll_records now ${afterPay.rows[0].n}`);
  } finally {
    await purge(db);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
}

/** Remove everything this test creates, in FK-safe order. */
async function purge(db) {
  await db.query(
    `DELETE FROM invoice_items WHERE invoice_id IN (
       SELECT ci.id FROM client_invoices ci
        JOIN finance_customers fc ON fc.id = ci.client_id
       WHERE fc.bill_no_prefix LIKE '${TAG}%')`,
  );
  await db.query(
    `UPDATE payroll_records SET client_invoice_id = NULL
      WHERE client_invoice_id IN (
        SELECT ci.id FROM client_invoices ci
         JOIN finance_customers fc ON fc.id = ci.client_id
        WHERE fc.bill_no_prefix LIKE '${TAG}%')`,
  );
  await db.query(
    `DELETE FROM client_invoices WHERE client_id IN (
       SELECT id FROM finance_customers WHERE bill_no_prefix LIKE '${TAG}%')`,
  );
  await db.query(
    `DELETE FROM payroll_records WHERE staff_id IN (
       SELECT id FROM staff_applicants WHERE staff_code LIKE '${TAG}%')`,
  );
  await db.query(
    `DELETE FROM staff_daily_attendance WHERE staff_id IN (
       SELECT id FROM staff_applicants WHERE staff_code LIKE '${TAG}%')`,
  );
  await db.query(
    `DELETE FROM placements WHERE staff_id IN (
       SELECT id FROM staff_applicants WHERE staff_code LIKE '${TAG}%')`,
  );
  await db.query(`DELETE FROM staff_applicants WHERE staff_code LIKE '${TAG}%'`);
  await db.query(`DELETE FROM finance_customers WHERE bill_no_prefix LIKE '${TAG}%'`);
}

main().catch((e) => {
  console.error('\nCould not run:', e.message);
  process.exit(1);
});
