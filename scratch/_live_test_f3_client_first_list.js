/**
 * F3 — the invoice list must describe a client's invoice, not a placement's.
 *
 * The list used to carry a "Staff" column fed by a join through
 * `client_invoices.placement_id`. A consolidated invoice leaves that column
 * NULL, so every invoice the system now produces would have rendered a bare
 * dash where the people should be. The list reports `staff_count` instead.
 *
 * Boots the real Nest context and calls the real service — no HTTP, no login.
 * Everything it creates is torn down in the finally block.
 *
 * Run:  node scratch/_live_test_f3_client_first_list.js
 */
require('dotenv').config();
const { Client } = require('pg');

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const MONTH = 4;
const YEAR = 2018;
const TAG = 'F3TEST';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customerId: null, staffIds: [], placementIds: [], invoiceId: null };

  try {
    await purge(db);

    const branch = await db.query(`SELECT id FROM branches LIMIT 1`);
    const branchId = branch.rows[0].id;
    const anyUser = await db.query(`SELECT id FROM users LIMIT 1`);
    const markedBy = anyUser.rows[0].id;

    const cust = await db.query(
      `INSERT INTO finance_customers
         (id, customer_name, bill_no_prefix, bill_seq, state, city, address,
          pan_card, unit_code, unit_name, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 0, 'Delhi', 'Delhi', 'Test address',
               'AAAAA0000A', $3, $1, now())
       RETURNING id`,
      [`${TAG} Client`, `${TAG}/2018`, `${TAG}-UNIT`],
    );
    made.customerId = cust.rows[0].id;

    // Three staff with the same client — the exact case the old column broke on.
    for (const [i, name] of [[1, 'F3 Driver'], [2, 'F3 Cook'], [3, 'F3 Maid']]) {
      const staff = await db.query(
        `INSERT INTO staff_applicants
           (id, staff_code, full_name, mobile, date_of_birth, address,
            series, pipeline_stage, branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-01-01', 'Test address',
                 'DRIVER', 'S5_DEPLOY', $4, now(), now())
         RETURNING id`,
        [`${TAG}00${i}`, name, `98888800${i}0`, branchId],
      );
      made.staffIds.push(staff.rows[0].id);

      const pl = await db.query(
        `INSERT INTO placements
           (id, staff_id, client_id, branch_id, status, staff_salary, management_fee,
            confirmed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 18000, 2000, $4, now(), now())
         RETURNING id`,
        [staff.rows[0].id, made.customerId, branchId, `${YEAR}-0${MONTH}-01`],
      );
      made.placementIds.push(pl.rows[0].id);

      for (let d = 1; d <= 26; d++) {
        await db.query(
          `INSERT INTO staff_daily_attendance
             (id, staff_id, placement_id, branch_id, attendance_date, status,
              marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PRESENT', $5, now(), now())`,
          [staff.rows[0].id, pl.rows[0].id, branchId,
           `${YEAR}-0${MONTH}-${String(d).padStart(2, '0')}`, markedBy],
        );
      }
    }

    console.log(`\n  fixture: 1 client, 3 placements\n`);

    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../dist/app.module');
    const { PayrollService } = require('../dist/modules/payroll/payroll.service');
    const { FinanceInvoiceService } = require('../dist/modules/finance/invoice/invoice.service');
    const { ConsolidatedInvoiceService } = require('../dist/modules/finance/invoice/consolidated-invoice.service');

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      const payroll = app.get(PayrollService);
      const invoices = app.get(FinanceInvoiceService);

      // Run each staff member's payroll one at a time — the real sequence.
      for (const pid of made.placementIds) {
        await payroll.runAttendancePayroll(pid, MONTH, YEAR);
      }

      // Payroll raises no invoice; Finance does, once, for the whole client.
      // That is the point of this check — three people, three payroll runs,
      // still one document.
      const consolidated = app.get(ConsolidatedInvoiceService);
      await consolidated.generateOrAmend(made.customerId, MONTH, YEAR);

      const rows = await db.query(
        `SELECT id, invoice_number, is_consolidated FROM client_invoices
          WHERE client_id = $1 AND period_month = $2 AND period_year = $3
            AND status <> 'CANCELLED'`,
        [made.customerId, MONTH, YEAR],
      );
      check(
        'three separate payroll runs still produce ONE invoice',
        rows.rowCount === 1,
        `got ${rows.rowCount}`,
      );
      if (rows.rowCount !== 1) return;
      made.invoiceId = rows.rows[0].id;

      const listed = await invoices.listInvoices({ page: 1, limit: 200 });
      const items = listed?.data ?? listed?.items ?? listed;
      const mine = (Array.isArray(items) ? items : []).find(
        (r) => String(r.id) === String(made.invoiceId),
      );

      check('the invoice appears in the list', !!mine);
      if (!mine) return;

      check(
        'list reports staff_count, not a single staff name',
        Number(mine.staff_count) === 3,
        `staff_count = ${mine.staff_count}`,
      );
      check(
        'staff_name is empty for a consolidated invoice',
        !mine.staff_name,
        `staff_name = ${JSON.stringify(mine.staff_name)}`,
      );
      check('list marks it consolidated', mine.is_consolidated === true,
        `is_consolidated = ${mine.is_consolidated}`);
      check(
        'list carries the client name',
        String(mine.client_name || '').includes(TAG),
        `client_name = ${mine.client_name}`,
      );

      const staffOnItems = await db.query(
        `SELECT COUNT(DISTINCT staff_id)::int AS n FROM invoice_items WHERE invoice_id = $1`,
        [made.invoiceId],
      );
      check(
        'staff_count matches the people actually on the line items',
        Number(mine.staff_count) === staffOnItems.rows[0].n,
        `list says ${mine.staff_count}, items hold ${staffOnItems.rows[0].n}`,
      );
    } finally {
      await app.close();
    }
  } finally {
    await purge(db);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
}

async function purge(db) {
  await db.query(
    `DELETE FROM invoice_items WHERE invoice_id IN (
       SELECT ci.id FROM client_invoices ci JOIN finance_customers fc ON fc.id = ci.client_id
        WHERE fc.bill_no_prefix LIKE '${TAG}%')`,
  );
  await db.query(
    `UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id IN (
       SELECT ci.id FROM client_invoices ci JOIN finance_customers fc ON fc.id = ci.client_id
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
