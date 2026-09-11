/**
 * One staff member, placed with one client, a week's work, one invoice.
 *
 * Built end to end through the real API — attendance, payroll, invoice — so
 * what comes out is the document Finance would actually issue, not a mock-up.
 * The finished HTML is written to scratch/_demo_invoice.html for review.
 *
 * The supplier identity (GSTIN, state, SAC) is set first, because without it
 * every document is a Bill of Supply carrying no tax, and the tax section —
 * the part worth looking at — would be empty.
 *
 *   node scratch/_demo_invoice.js
 *   node scratch/_demo_invoice.js --unit DEMO-02 --client "Kapoor Residence" --staff meera001 --days 7
 *   node scratch/_demo_invoice.js --unit DEMO-02 --state Haryana   # IGST instead of CGST+SGST
 *   node scratch/_demo_invoice.js --clean                          # take the demo data back out
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const HR_PHONE = '9800000008';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];
const MANAGED_HOST = /render\.com|amazonaws|azure|googleapis|neon\.tech|supabase|planetscale/i;

/** Which demo to build — each is a separate client with its own staff. */
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const MONTH = Number(arg('--month', 9));
const YEAR = Number(arg('--year', 2026));
const WORK_DAYS = Number(arg('--days', 7));   // a week's work inside the month
const SALARY = Number(arg('--salary', 18000)); // monthly wage agreed with the client
const FEE = Number(arg('--fee', 2500));        // HomeGenny's management fee
const UNIT = arg('--unit', 'DEMO-01');
const CLIENT_NAME = arg('--client', 'Sharma Residence');
const CLIENT_ADDRESS = arg('--address', 'B-42 Greater Kailash, New Delhi 110048');
const CLIENT_STATE = arg('--state', 'Delhi');
const CLIENT_GSTIN = arg('--client-gstin', '07AAACS1234B1Z9');
// A client in another state makes the supply inter-state, so the invoice
// carries IGST instead of CGST+SGST — worth being able to see.
const CLIENT_PHONE = arg('--phone', '9000555001');
// Optional: bill a named staff member rather than whoever is free.
const STAFF_CODE = arg('--staff', null);
const DESIGNATION = arg('--designation', 'Maid');
/**
 * The wage breakup the RM would have agreed, as "basic/da/hra/skill" summing to
 * the wage. Without one the register shows the whole wage as basic — honest,
 * but it demonstrates none of the components. Pass --breakup to fill it in.
 */
const BREAKUP = arg('--breakup', null);

// Already on file as HomeGenny Delhi NCR HQ's registration (branches.gstin).
// Confirm it is the real one before any of this reaches a client.
const SUPPLIER = {
  'finance.supplier_legal_name': 'HomeGenny Services Pvt Ltd',
  'finance.supplier_gstin': '07AABCH1234A1Z8',
  'finance.supplier_state': 'Delhi',
  'finance.sac_code': '998513',                    // manpower supply services
  'finance.supplier_address': 'HomeGenny Delhi NCR HQ, New Delhi 110001',
};

async function req(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  const payload = json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload, text };
}

async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.status === 200 || r.status === 201) {
      const t = r.body?.access_token || r.body?.accessToken;
      if (t) return t;
    }
  }
  throw new Error(`could not log in as ${phone}`);
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (MANAGED_HOST.test(host)) throw new Error(`refusing to run against a managed host (${host})`);

  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    // ── --clean: take the demo data back out ───────────────────────────────
    if (process.argv.includes('--clean')) {
      const c = await db.query(`SELECT id, user_id FROM finance_customers WHERE unit_code = $1`, [UNIT]);
      for (const row of c.rows) {
        const invs = await db.query(`SELECT id FROM client_invoices WHERE client_id = $1`, [row.id]);
        const ids = invs.rows.map((r) => r.id);
        if (ids.length) {
          await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = ANY($1::uuid[])`, [ids]);
          await db.query(`DELETE FROM invoice_items WHERE invoice_id = ANY($1::uuid[])`, [ids]);
          await db.query(`DELETE FROM payment_reminders WHERE invoice_id = ANY($1::uuid[])`, [ids]);
          await db.query(`DELETE FROM client_invoices WHERE id = ANY($1::uuid[])`, [ids]);
        }
        const pls = await db.query(`SELECT id FROM placements WHERE client_id = $1`, [row.id]);
        const plIds = pls.rows.map((r) => r.id);
        if (plIds.length) {
          await db.query(`DELETE FROM staff_daily_attendance WHERE placement_id = ANY($1::uuid[])`, [plIds]);
          await db.query(`DELETE FROM payroll_records WHERE placement_id = ANY($1::uuid[])`, [plIds]);
          await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [plIds]);
        }
        await db.query(`DELETE FROM finance_customers WHERE id = $1`, [row.id]);
        if (row.user_id) await db.query(`DELETE FROM users WHERE id = $1`, [row.user_id]);
      }
      console.log(`demo data removed for ${UNIT}`);

      // The supplier's registration is shared by every invoice in the database,
      // so clearing it while another demo still exists would turn that demo's
      // tax invoice back into a Bill of Supply. Only clear it once nothing is
      // left that depends on it.
      const others = await db.query(`SELECT count(*)::int n FROM finance_customers WHERE unit_code LIKE 'DEMO-%'`);
      if (!others.rows[0].n) {
        for (const key of Object.keys(SUPPLIER)) {
          if (key === 'finance.supplier_legal_name') continue;
          await db.query(`UPDATE system_settings SET value = to_jsonb(''::text) WHERE key = $1`, [key]);
        }
        console.log('supplier identity cleared (no demo clients left)');
      }
      return;
    }

    const finance = await login(FINANCE_PHONE);
    console.log('logged in as FINANCE');

    // ── 1 · the supplier's own registration ────────────────────────────────
    for (const [key, value] of Object.entries(SUPPLIER)) {
      await db.query(
        `INSERT INTO system_settings (id, key, value, updated_at)
         VALUES (gen_random_uuid(), $1, to_jsonb($2::text), now())
         ON CONFLICT (key) DO UPDATE SET value = to_jsonb($2::text), updated_at = now()`,
        [key, value],
      );
    }
    console.log(`supplier registered  GSTIN ${SUPPLIER['finance.supplier_gstin']} · Delhi · SAC ${SUPPLIER['finance.sac_code']}`);

    // ── 2 · a client ───────────────────────────────────────────────────────
    let cust = (await db.query(`SELECT id FROM finance_customers WHERE unit_code = $1`, [UNIT])).rows[0];
    if (!cust) {
      const user = await db.query(
        `INSERT INTO users (id, role, full_name, phone, is_active, updated_at)
         VALUES (gen_random_uuid(), 'CLIENT', $1, $2, true, now())
         RETURNING id`, [CLIENT_NAME, CLIENT_PHONE],
      );
      cust = (await db.query(
        `INSERT INTO finance_customers
           (id, customer_name, address, pan_card, gstn, bill_no_prefix, bill_seq,
            unit_code, unit_name, city, state, user_id, updated_at)
         VALUES (gen_random_uuid(), $4, $5, 'ABCDE1234F', $6, $1, 0, $2, $7,
                 'New Delhi', $8, $3, now())
         RETURNING id`,
        [`${UNIT}/${YEAR}/`, UNIT, user.rows[0].id, CLIENT_NAME, CLIENT_ADDRESS,
         CLIENT_GSTIN, `${UNIT} Unit`, CLIENT_STATE],
      )).rows[0];
      console.log(`client created        ${CLIENT_NAME} · ${CLIENT_STATE} · GSTIN ${CLIENT_GSTIN}`);
    }

    // ── 3 · place a staff member ───────────────────────────────────────────
    let placement = (await db.query(
      `SELECT p.id, sa.staff_code, sa.full_name, sa.branch_id, p.staff_id
         FROM placements p JOIN staff_applicants sa ON sa.id = p.staff_id
        WHERE p.client_id = $1 LIMIT 1`, [cust.id])).rows[0];
    if (!placement) {
      const free = (await db.query(`
        SELECT sa.id, sa.staff_code, sa.full_name, sa.branch_id
          FROM staff_applicants sa
          LEFT JOIN placements pl ON pl.staff_id = sa.id
         WHERE sa.pipeline_stage = 'S5_DEPLOY' AND pl.id IS NULL
           AND ($1::text IS NULL OR sa.staff_code = $1)
         ORDER BY sa.staff_code LIMIT 1`, [STAFF_CODE])).rows[0];
      if (!free) throw new Error('no deployable staff free — seed one with scratch/_seed_staff_s4.js --deploy');
      const pl = await db.query(`
        INSERT INTO placements
          (id, staff_id, client_id, branch_id, status, placement_type,
           staff_salary, management_fee, shift_hours, trial_start_date,
           confirmed_at, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT',
                $4, $5, 8, make_date($6, $7, 1), now(), now(), now())
        RETURNING id`,
        [free.id, cust.id, free.branch_id, SALARY, FEE, YEAR, MONTH]);
      // Spread first: `free` carries its own `id` (the staff applicant), and
      // letting it land last silently overwrote the placement id, so every
      // attendance row pointed at a placement that does not exist.
      placement = { ...free, id: pl.rows[0].id, staff_id: free.id };

      // --breakup "11000/2500/3200/1300" records what the RM would have agreed
      // on the wage form. The wage register reads it; without it the whole
      // wage shows as basic, which is truthful but shows none of the
      // components. The parts must add up to the wage, or the register would
      // state an entitlement the placement does not pay.
      if (BREAKUP) {
        const [basic, da, hra, skill] = BREAKUP.split('/').map(Number);
        const sum = basic + da + hra + skill;
        if (!Number.isFinite(sum) || Math.round(sum) !== Math.round(SALARY)) {
          throw new Error(
            `--breakup must add up to the salary: ${basic}+${da}+${hra}+${skill} = ${sum}, salary is ${SALARY}`,
          );
        }
        await db.query(
          `UPDATE placements
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{wage_config}', $2::jsonb, true)
            WHERE id = $1`,
          [placement.id, JSON.stringify({
            basic_wage: basic, da, hra, skilled_allowance: skill,
            bonus_pct: 8.33, bonus_applicable: true,
            lwf_amount: 62, lwf_applicable: true,
            professional_tax: 0, nfh_applicable: true,
          })],
        );
        console.log(`wage breakup          basic ${basic} + da ${da} + hra ${hra} + skill ${skill} = ${sum}`);
      }
      console.log(`staff placed          ${free.full_name} (${free.staff_code}) · PERMANENT · Rs.${SALARY}/month + Rs.${FEE} fee`);
    }

    // ── 4 · a week of attendance ───────────────────────────────────────────
    let marked = 0;
    for (let d = 1; d <= WORK_DAYS; d++) {
      const r = await db.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, make_date($4,$5,$6), 'PRESENT', $1, now(), now())
         ON CONFLICT (staff_id, placement_id, attendance_date) DO NOTHING RETURNING id`,
        [placement.staff_id, placement.id, placement.branch_id, YEAR, MONTH, d]);
      if (r.rows[0]) marked++;
    }
    console.log(`attendance marked     ${marked} day(s) present in ${String(MONTH).padStart(2, '0')}/${YEAR}`);

    // ── 5 · payroll, then the invoice — both through the API ───────────────
    const pay = await req('POST', '/finance/payroll/attendance-generate', {
      token: finance, body: { code: placement.staff_code, month: MONTH, year: YEAR },
    });
    if (pay.status !== 200 && pay.status !== 201) {
      throw new Error(`payroll refused (${pay.status}): ${JSON.stringify(pay.body)}`);
    }
    console.log('payroll run           via POST /finance/payroll/attendance-generate');

    const gen = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: cust.id, month: MONTH, year: YEAR },
    });
    if (gen.status !== 200 && gen.status !== 201) {
      throw new Error(`invoice refused (${gen.status}): ${JSON.stringify(gen.body)}`);
    }
    const invoiceId = (gen.body?.invoice ?? gen.body)?.id;
    console.log('invoice raised        via POST /finance/invoices/consolidated/generate');

    // ── 6 · what the client would receive ──────────────────────────────────
    const doc = await req('GET', `/finance/invoices/${invoiceId}/download`, { token: finance });
    if (doc.status !== 200) throw new Error(`download failed (${doc.status})`);
    const out = path.join(__dirname, '_demo_invoice.html');
    fs.writeFileSync(out, doc.text);

    const stored = (await db.query(
      `SELECT invoice_number, document_type, status, taxable_value, cgst_amount,
              sgst_amount, igst_amount, gst_amount, total_amount, place_of_supply, sac_code
         FROM client_invoices WHERE id = $1`, [invoiceId])).rows[0];

    console.log('\n  what the invoice says');
    console.log('  ─────────────────────────────────────────────');
    for (const [k, v] of Object.entries(stored)) {
      console.log(`  ${k.padEnd(18)} ${v}`);
    }
    console.log(`  invoice written to   ${out}`);

    // ── 7 · the same month from the staff member's side ────────────────────
    // The wage register only exists for someone with an employee record —
    // that is what HR onboarding creates, and what the payslip endpoints are
    // keyed by. A placed candidate who was never onboarded has payroll but
    // nowhere to read it from.
    if (process.argv.includes('--payslip')) {
      const hr = await login(HR_PHONE);

      let emp = (await db.query(
        `SELECT id FROM employees WHERE staff_applicant_id = $1 AND deleted_at IS NULL`,
        [placement.staff_id])).rows[0];

      if (!emp) {
        const cat = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
        const on = await req('POST', '/employees/onboard-from-pipeline', {
          token: hr,
          body: {
            staffApplicantId: placement.staff_id,
            department: 'Field Operations',
            designation: DESIGNATION,
            categoryId: cat.rows[0]?.id,
            employmentType: 'Full Time',
            // No salary: what a placed staff member is paid was settled on the
            // placement, per client. Asking HR for a second figure only
            // produces one that disagrees with what is billed.
            joiningDate: `${YEAR}-${String(MONTH).padStart(2, '0')}-01`,
            gender: 'Female',
            city: 'New Delhi',
          },
        });
        if (on.status !== 200 && on.status !== 201) {
          throw new Error(`onboarding refused (${on.status}): ${JSON.stringify(on.body)}`);
        }
        emp = { id: on.body?.employee?.id };
        console.log(`onboarded             ${placement.full_name} as ${on.body?.employee?.employeeId}`);
      }

      const slips = await req('GET', `/employees/${emp.id}/payslips`, { token: hr });
      const slip = (slips.body?.items ?? []).find(
        (s) => s.periodMonth === MONTH && s.periodYear === YEAR);
      if (!slip) throw new Error(`no payslip for ${MONTH}/${YEAR} — was payroll run?`);

      const pdfRes = await fetch(
        `${BASE}/employees/${emp.id}/payslips/pdf?ref=${encodeURIComponent(slip.ref)}`,
        { headers: { Authorization: `Bearer ${hr}` } });
      if (!pdfRes.ok) throw new Error(`payslip pdf failed (${pdfRes.status})`);
      const pdfOut = path.join(__dirname, `_demo_payslip_${UNIT}.pdf`);
      fs.writeFileSync(pdfOut, Buffer.from(await pdfRes.arrayBuffer()));

      console.log('\n  what the wage register says');
      console.log('  ─────────────────────────────────────────────');
      console.log(`  days worked        ${slip.presentDays} of ${new Date(YEAR, MONTH, 0).getDate()}`);
      console.log(`  wage earned        ${slip.grossSalary}`);
      console.log(`  deductions         ${slip.totalDeductions}  ${JSON.stringify(slip.deductionBreakdown)}`);
      console.log(`  net payable        ${slip.netSalary}`);
      console.log(`\n  payslip written to   ${pdfOut}`);
    }
    console.log('');
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
});
