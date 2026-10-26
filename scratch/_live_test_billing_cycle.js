/**
 * Live HTTP verification for per-client billing cycles.
 *
 * Four clients with identical work all November (one live-in, every day):
 *   W — WEEKLY       invoiced 1–7, 8–14, 15–21, 22–30
 *   F — FORTNIGHTLY  invoiced 1–15, 16–30
 *   M — MONTHLY      invoiced 1–30
 *   X — MANUAL       never invoiced automatically
 *
 * The morning job is driven through POST /finance/invoices/billing-cycle/run
 * for each date — exactly what the cron calls for yesterday. Running a date
 * twice must bill nothing twice; all three billed clients must end the month
 * at the same total. Also: the cycle and the client's state are set over the
 * customer API, with a bad state refused.
 *
 * November 2025. Builds and removes its own rows.
 *
 *   node scratch/_live_test_billing_cycle.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const YEAR = 2025;
const MONTH = 11;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''}`); }
}
async function req(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < 8) { await new Promise((r) => setTimeout(r, 6000 * (attempt + 1))); continue; }
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json && json.success === true && 'data' in json ? json.data : json };
  }
}
async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken;
    if (t) return t;
  }
  throw new Error(`Could not log in as ${phone}`);
}
const day = (d) => `${YEAR}-11-${String(d).padStart(2, '0')}`;

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customers: [], staff: [], placements: [] };
  try {
    const token = await login(FINANCE_PHONE);
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const marker = (await db.query(`SELECT id FROM users WHERE phone = $1`, [FINANCE_PHONE])).rows[0].id;

    const ids = {};
    for (const tag of ['W', 'F', 'M', 'X']) {
      const c = await db.query(
        `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                        bill_no_prefix, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'x', 'x', 'Dehradun', NULL, $3, 'ACTIVE', now(), now()) RETURNING id`,
        [`Cycle Test ${tag}`, `CYCT-${tag}`, `CYCT${tag}`]);
      ids[tag] = c.rows[0].id;
      made.customers.push(c.rows[0].id);
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address, branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'SKILLED_CARE', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [`CYCT${tag}1`, `Cycle Staff ${tag}`, `93000000${tag.charCodeAt(0) % 100}`, branchId]);
      made.staff.push(s.rows[0].id);
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', 24, 'PER_DUTY', 517, 585, false, false,
                 $4::date, $4::date, now(), now()) RETURNING id`,
        [s.rows[0].id, c.rows[0].id, branchId, day(1)]);
      made.placements.push(p.rows[0].id);
      for (let d = 1; d <= 30; d++) {
        await db.query(
          `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', $5, now(), now())`,
          [s.rows[0].id, p.rows[0].id, branchId, day(d), marker]);
      }
    }

    // ── settings over the customer API ───────────────────────────────────
    let r = await req('PUT', `/finance/customers/${ids.W}`, { token, body: { billing_cycle: 'DAILY' } });
    check('unknown cycle refused', r.status === 400, r.status);
    r = await req('PUT', `/finance/customers/${ids.W}`, { token, body: { state: 'Atlantis' } });
    check('unknown state refused', r.status === 400 && /not a recognised/.test(JSON.stringify(r.body)), r.body);
    const set = async (tag, cycle) => req('PUT', `/finance/customers/${ids[tag]}`, { token, body: { billing_cycle: cycle, state: 'uk' } });
    r = await set('W', 'WEEKLY');
    check('weekly set; "uk" stored as Uttarakhand', r.status === 200 && r.body?.billing_cycle === 'WEEKLY' && r.body?.state === 'Uttarakhand', r.body);
    await set('F', 'FORTNIGHTLY');
    await set('M', 'MONTHLY');
    r = await set('X', 'MANUAL');
    check('manual set', r.body?.billing_cycle === 'MANUAL', r.body);

    // ── the morning job, day by day ──────────────────────────────────────
    const run = async (d) => (await req('POST', '/finance/invoices/billing-cycle/run', { token, body: { date: day(d) } })).body;
    const mine = (out) => (out?.issued ?? []).filter((i) => /^Cycle Test /.test(i.customer));
    const names = (out) => mine(out).map((i) => `${i.customer.slice(-1)}:${i.period}`).sort();

    let out = await run(6);
    check('6th: nobody — no period ends', mine(out).length === 0, names(out));
    out = await run(7);
    check('7th: weekly client gets 1–7', JSON.stringify(names(out)) === JSON.stringify(['W:01 Nov – 07 Nov 2025']), names(out));
    out = await run(7);
    check('7th run again: nothing billed twice', mine(out).length === 0, names(out));
    out = await run(14);
    check('14th: weekly 8–14', JSON.stringify(names(out)) === JSON.stringify(['W:08 Nov – 14 Nov 2025']), names(out));
    out = await run(15);
    check('15th: fortnightly 1–15', JSON.stringify(names(out)) === JSON.stringify(['F:01 Nov – 15 Nov 2025']), names(out));
    out = await run(21);
    check('21st: weekly 15–21', JSON.stringify(names(out)) === JSON.stringify(['W:15 Nov – 21 Nov 2025']), names(out));
    out = await run(30);
    check('30th (month end): weekly 22–30, fortnightly 16–30, monthly 1–30, manual nothing',
      JSON.stringify(names(out)) === JSON.stringify(['F:16 Nov – 30 Nov 2025', 'M:01 Nov – 30 Nov 2025', 'W:22 Nov – 30 Nov 2025']),
      names(out));

    // ── what each client ended up with ───────────────────────────────────
    const totals = async (tag) => (await db.query(
      `SELECT COUNT(*)::int n, COALESCE(SUM(taxable_value), 0)::float tv, COALESCE(SUM(total_amount), 0)::float t,
              BOOL_AND(status = 'DRAFT') drafts
         FROM client_invoices WHERE client_id = $1`, [ids[tag]])).rows[0];
    const W = await totals('W'), F = await totals('F'), M = await totals('M'), X = await totals('X');
    check('weekly: 4 invoices, fortnightly: 2, monthly: 1, manual: 0', W.n === 4 && F.n === 2 && M.n === 1 && X.n === 0, { W, F, M, X });
    check('every client billed the same 30 duties × ₹585 = ₹17,550', [W, F, M].every((x) => Math.abs(x.tv - 17550) < 0.01), { W: W.tv, F: F.tv, M: M.tv });
    check('all raised as DRAFT — nothing sent without Finance', W.drafts && F.drafts && M.drafts);
    check('the manual client still has its work waiting, unbilled',
      (await db.query(`SELECT COUNT(*)::int n FROM staff_daily_attendance WHERE placement_id = $1`, [made.placements[3]])).rows[0].n === 30
        && (await db.query(`SELECT COUNT(*)::int n FROM payroll_records WHERE placement_id = $1`, [made.placements[3]])).rows[0].n === 0);

    r = await req('POST', '/finance/invoices/billing-cycle/run', { token, body: { date: 'yesterday' } });
    check('a bad date is refused', r.status === 400, r.status);
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.message}`);
  } finally {
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    for (const { id } of invs) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
