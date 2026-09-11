/**
 * Fixtures the live finance suites build for themselves.
 *
 * Every suite here needs roughly the same thing — a customer with one or more
 * confirmed, priced placements — and for a long time each one went looking for
 * it in whatever data happened to be lying around. That worked until the local
 * database was wiped, and then the suites did one of two things: return early
 * with a cheerful "skipping" line and still report all green, or die on
 * `Cannot read properties of undefined`, which reads like a bug in the code
 * under test rather than a missing fixture.
 *
 * So a suite asks for what it needs. If the database already has it, it is
 * used as-is and nothing is created. If it does not, it is built here and
 * `teardown()` takes it back out, leaving the database as it was found.
 *
 * Nothing in here runs against a managed host — these write real rows.
 */
const bcrypt = require('bcryptjs');

const MANAGED_HOST = /render\.com|amazonaws|azure|googleapis|neon\.tech|supabase|planetscale/i;

function assertSafeTarget(connectionString) {
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a URL — refusing to seed fixtures');
  }
  if (MANAGED_HOST.test(host)) {
    throw new Error(`refusing to seed fixtures against a managed host (${host})`);
  }
  return host;
}

/**
 * A customer with a portal account that can actually log in.
 *
 * Two things here are deliberate, and both were learned the hard way.
 *
 * The account has NO email address: an invoice can only be marked SENT when
 * there is some way to reach the client, and the in-app channel satisfies that
 * without a suite run putting mail in anyone's inbox.
 *
 * But it does get a real password. A fixture client is indistinguishable from
 * a real one to every other suite — the mobile suite picks "a client with a
 * login" and tries to sign in as them — so a customer that cannot log in is a
 * trap left lying in the database for the next suite to trip over. It did
 * exactly that. Fully formed, or not created at all.
 */
const FIXTURE_PASSWORD = 'HomeGenny@2024';

async function createCustomer(db, label = 'Fixture') {
  assertSafeTarget(db.connectionParameters?.connectionString || process.env.DATABASE_URL || '');
  const tag = Date.now().toString().slice(-6);
  const prefix = label.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'FIX';
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 10);

  let portalUserId = null;
  let customerId = null;
  const removeWhatWasMade = async () => {
    // Partway through is the worst place to stop: a customer with no portal
    // account, or an account with no password, is picked up by the next suite
    // as though it were real. An earlier version of this function threw after
    // the inserts and left exactly that behind.
    try {
      if (customerId) await db.query(`DELETE FROM finance_customers WHERE id = $1`, [customerId]);
      if (portalUserId) await db.query(`DELETE FROM users WHERE id = $1`, [portalUserId]);
    } catch { /* the original failure is the one worth reporting */ }
  };

  try {
    const portal = await db.query(`
      INSERT INTO users (id, role, full_name, phone, password_hash, is_active, updated_at)
      VALUES (gen_random_uuid(), 'CLIENT', $1, $2, $3, true, now())
      RETURNING id`,
      [`${label} Fixture Client`, `9000${tag}`, passwordHash]);
    portalUserId = portal.rows[0].id;

    const cust = await db.query(`
      INSERT INTO finance_customers
        (id, customer_name, address, pan_card, gstn, bill_no_prefix, bill_seq,
         unit_code, unit_name, city, state, user_id, updated_at)
      VALUES (gen_random_uuid(), $1, '1 Test Lane, New Delhi', 'AAAAA0000A', NULL,
              $2, 0, $3, $4, 'New Delhi', 'Delhi', $5, now())
      RETURNING id, customer_name, bill_no_prefix, bill_seq, credit_note_seq`,
      [`${label} Household ${tag}`, `${prefix}${tag}/`, `${prefix}${tag}`,
       `${label} Unit`, portalUserId]);
    customerId = cust.rows[0].id;

    return {
      customerId,
      customerName: cust.rows[0].customer_name,
      portalUserId,
      phone: `9000${tag}`,
      password: FIXTURE_PASSWORD,
      row: cust.rows[0],
      async teardown() {
        await db.query(`DELETE FROM finance_customers WHERE id = $1`, [customerId]);
        await db.query(`DELETE FROM notifications WHERE user_id = $1`, [portalUserId]);
        await db.query(`DELETE FROM users WHERE id = $1`, [portalUserId]);
      },
    };
  } catch (err) {
    await removeWhatWasMade();
    throw err;
  }
}

/**
 * A customer with `staffCount` confirmed, priced placements.
 *
 * `withoutEmployeeRecord` matters for the suites that bill a placement and
 * then assert a payslip appears in HR: a staff member who already has an
 * `employees` row would make that assertion pass for the wrong reason.
 *
 * Returns `{ customerId, placements, seeded, teardown }`. `seeded` says
 * whether anything was created, and `teardown()` is safe to call either way.
 */
async function ensureBillableCustomer(db, opts = {}) {
  const {
    staffCount = 1,
    withoutEmployeeRecord = false,
    label = 'Fixture',
    salary = 18000,
    managementFee = 2000,
  } = opts;

  const employeeFilter = withoutEmployeeRecord
    ? `AND NOT EXISTS (SELECT 1 FROM employees e
                        WHERE e.staff_applicant_id = sa.id AND e.deleted_at IS NULL)`
    : '';

  // Is there already a customer with enough priced placements to use?
  const existing = await db.query(`
    SELECT p.id AS placement_id, p.staff_id, p.client_id, sa.staff_code,
           sa.full_name, sa.branch_id, fc.customer_name
    FROM placements p
    JOIN staff_applicants sa ON sa.id = p.staff_id
    JOIN finance_customers fc ON fc.id = p.client_id
    WHERE p.status = 'CONFIRMED'
      AND p.staff_salary IS NOT NULL AND p.management_fee IS NOT NULL
      ${employeeFilter}
      AND p.client_id = (
        SELECT p2.client_id FROM placements p2
        JOIN staff_applicants sa2 ON sa2.id = p2.staff_id
        WHERE p2.status = 'CONFIRMED'
          AND p2.staff_salary IS NOT NULL AND p2.management_fee IS NOT NULL
          ${employeeFilter.replace(/sa\.id/g, 'sa2.id')}
        GROUP BY p2.client_id
        HAVING COUNT(DISTINCT p2.staff_id) >= ${Number(staffCount)}
        LIMIT 1
      )
    ORDER BY sa.staff_code
  `);

  if (existing.rows.length >= staffCount) {
    return {
      customerId: existing.rows[0].client_id,
      customerName: existing.rows[0].customer_name,
      placements: existing.rows.slice(0, staffCount),
      seeded: false,
      async teardown() { /* nothing was created */ },
    };
  }

  assertSafeTarget(db.connectionParameters?.connectionString || process.env.DATABASE_URL || '');

  // Staff who finished the pipeline and are not working anywhere yet.
  const free = await db.query(`
    SELECT sa.id AS staff_id, sa.staff_code, sa.full_name, sa.branch_id
    FROM staff_applicants sa
    LEFT JOIN placements pl ON pl.staff_id = sa.id
    WHERE sa.pipeline_stage = 'S5_DEPLOY' AND pl.id IS NULL
      ${employeeFilter}
    ORDER BY sa.staff_code
    LIMIT ${Number(staffCount)}
  `);
  if (free.rows.length < staffCount) {
    throw new Error(
      `need ${staffCount} deployable staff with no placement to build a fixture, found ${free.rows.length}. ` +
      `Seed some with: node scratch/_seed_staff_s4.js --name <Name> --deploy`,
    );
  }

  const { customerId, customerName, portalUserId } = await createCustomer(db, label);

  const placements = [];
  for (const st of free.rows) {
    const pl = await db.query(`
      INSERT INTO placements
        (id, staff_id, client_id, branch_id, status, placement_type,
         staff_salary, management_fee, shift_hours, trial_start_date,
         confirmed_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT',
              $4, $5, 8, CURRENT_DATE, now(), now(), now())
      RETURNING id`,
      [st.staff_id, customerId, st.branch_id, salary, managementFee]);
    placements.push({
      placement_id: pl.rows[0].id,
      staff_id: st.staff_id,
      client_id: customerId,
      staff_code: st.staff_code,
      full_name: st.full_name,
      branch_id: st.branch_id,
      customer_name: customerName,
    });
  }

  const placementIds = placements.map((p) => p.placement_id);
  return {
    customerId,
    customerName,
    placements,
    seeded: true,
    async teardown() {
      // Order matters: everything that points at a placement or an invoice
      // goes before the row it points at, or the FKs roll the whole thing back.
      const invs = await db.query(
        `SELECT id FROM client_invoices WHERE client_id = $1`, [customerId]);
      const invIds = invs.rows.map((r) => r.id);
      if (invIds.length) {
        await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = ANY($1::uuid[])`, [invIds]);
        await db.query(`DELETE FROM credit_notes WHERE invoice_id = ANY($1::uuid[])`, [invIds]);
        await db.query(`DELETE FROM invoice_items WHERE invoice_id = ANY($1::uuid[])`, [invIds]);
        await db.query(`DELETE FROM invoice_payments WHERE invoice_id = ANY($1::uuid[])`, [invIds]);
        await db.query(`DELETE FROM payment_reminders WHERE invoice_id = ANY($1::uuid[])`, [invIds]);
        await db.query(`DELETE FROM client_invoices WHERE id = ANY($1::uuid[])`, [invIds]);
      }
      if (placementIds.length) {
        await db.query(`DELETE FROM staff_daily_attendance WHERE placement_id = ANY($1::uuid[])`, [placementIds]);
        await db.query(`DELETE FROM payroll_records WHERE placement_id = ANY($1::uuid[])`, [placementIds]);
        await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [placementIds]);
      }
      await db.query(`DELETE FROM finance_customers WHERE id = $1`, [customerId]);
      await db.query(`DELETE FROM notifications WHERE user_id = $1`, [portalUserId]);
      await db.query(`DELETE FROM users WHERE id = $1`, [portalUserId]);
    },
  };
}


/**
 * Make sure one particular staff member is placed with a client.
 *
 * Attendance can only be mirrored into `staff_daily_attendance` against a
 * placement — the column is NOT NULL, and the mirror deliberately does nothing
 * rather than throw when there is no active one. So a suite that onboards a
 * candidate and then expects their attendance to reach payroll needs them
 * placed first; without it the mirror assertions fail in a way that looks like
 * a broken mirror rather than an unplaced person.
 *
 * Returns `{ placementId, seeded, teardown }`. An already-placed staff member
 * is used as they are and nothing is created.
 */
async function ensurePlacementFor(db, staffId, label = 'Fixture') {
  const active = await db.query(
    `SELECT id FROM placements
      WHERE staff_id = $1 AND status IN ('CONFIRMED', 'TRIAL')
      ORDER BY created_at DESC LIMIT 1`, [staffId]);
  if (active.rows.length) {
    return { placementId: active.rows[0].id, seeded: false, async teardown() {} };
  }

  assertSafeTarget(db.connectionParameters?.connectionString || process.env.DATABASE_URL || '');
  const branch = await db.query(`SELECT branch_id FROM staff_applicants WHERE id = $1`, [staffId]);
  if (!branch.rows.length) throw new Error(`no staff applicant ${staffId} to place`);

  const customer = await createCustomer(db, label);
  const pl = await db.query(`
    INSERT INTO placements
      (id, staff_id, client_id, branch_id, status, placement_type,
       staff_salary, management_fee, shift_hours, trial_start_date,
       confirmed_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT',
            18000, 2000, 8, CURRENT_DATE, now(), now(), now())
    RETURNING id`,
    [staffId, customer.customerId, branch.rows[0].branch_id]);

  return {
    placementId: pl.rows[0].id,
    seeded: true,
    async teardown() {
      await db.query(`DELETE FROM staff_daily_attendance WHERE placement_id = $1`, [pl.rows[0].id]);
      await db.query(`DELETE FROM payroll_records WHERE placement_id = $1`, [pl.rows[0].id]);
      await db.query(`DELETE FROM placements WHERE id = $1`, [pl.rows[0].id]);
      await customer.teardown();
    },
  };
}
/**
 * Register the supplier for the length of a check, then put it back.
 *
 * Without a GSTIN every invoice is a Bill of Supply carrying no tax, so any
 * assertion about the tax charged passes trivially and proves nothing. This
 * lends the suite a real identity so the arithmetic actually runs, and returns
 * a restore function — call it in `finally`, or the database is left claiming
 * a registration HomeGenny does not have.
 */
async function withSupplierRegistered(db, { state = 'Delhi', gstin = '07AABCH1234A1Z8', sacCode = '998513' } = {}) {
  assertSafeTarget(db.connectionParameters?.connectionString || process.env.DATABASE_URL || '');
  const before = (await db.query(
    `SELECT key, value FROM system_settings WHERE key LIKE 'finance.%'`)).rows;
  const set = async (key, value) => {
    await db.query(`UPDATE system_settings SET value = to_jsonb($2::text) WHERE key = $1`, [key, value]);
  };
  await set('finance.supplier_gstin', gstin);
  await set('finance.supplier_state', state);
  await set('finance.sac_code', sacCode);
  return async function restore() {
    for (const r of before) {
      await db.query(`UPDATE system_settings SET value = $2::jsonb WHERE key = $1`,
        [r.key, JSON.stringify(r.value)]);
    }
  };
}

module.exports = { createCustomer, ensureBillableCustomer, ensurePlacementFor, withSupplierRegistered, assertSafeTarget };
