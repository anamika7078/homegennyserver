/**
 * Live HTTP verification of the invoice approval gate (P0).
 *
 * Nothing leaves before Finance approves the invoice: a payroll row on a DRAFT
 * invoice is not a payslip in the staff app or HR, cannot be approved or paid,
 * and RM/BM cannot approve or send invoices. Approving releases the slips and
 * tells the staff member; cancelling takes them back; an Admin can release a
 * stuck one after 3 days with a reason.
 *
 *  - RM: approve / send / attendance-generate → 403
 *  - DRAFT: staff app shows no slip and says Finance is checking it; HR sees
 *    released=false; payroll approve + disburse → 400; slips print "DRAFT"
 *  - approve: approver recorded, rows released, staff told in-app, slip visible
 *  - one staff at two clients, one approved: slip carries that share and
 *    pending_houses = 1
 *  - cancel: slips taken back
 *  - Admin release: refused inside 3 days and without a reason, allowed after
 *
 * Uses November 2025 so it cannot collide with real billing. Builds and
 * removes its own rows.
 *
 *   node scratch/_live_test_approval_gate.js
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const RM_PHONE = '9800000002';
const ADMIN_PHONE = '9800000003';
const HR_PHONE = '9800000008';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const STAFF_PASSWORD = 'Gate@2026';
const MONTH = 11;
const YEAR = 2025;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''}`); }
}
async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}
async function req(method, path, { token, body, raw } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, text: await res.text() };
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  const payload = json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(e) {
  const s = String(e).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    const i = BASE32.indexOf(ch); if (i === -1) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secret) {
  const { createHmac } = require('crypto');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const d = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = d[d.length - 1] & 0x0f;
  const c = ((d[o] & 0x7f) << 24) | ((d[o + 1] & 0xff) << 16) | ((d[o + 2] & 0xff) << 8) | (d[o + 3] & 0xff);
  return String(c % 1000000).padStart(6, '0');
}
// The admin account has 2FA: its TOTP secret is read from the user row.
let DB = null;
async function login(phone, passwords = PASSWORDS) {
  const secret = DB
    ? ((await DB.query(`SELECT metadata FROM users WHERE phone = $1`, [phone])).rows[0]?.metadata ?? {}).totp_secret
    : null;
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password, ...(secret ? { totp: totpCode(secret) } : {}) } });
    const t = r.body?.access_token || r.body?.accessToken;
    if (t) return t;
  }
  throw new Error(`Could not log in as ${phone}`);
}
const day = (d) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const msg = (r) => JSON.stringify(r.body ?? '');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  DB = db;
  const made = { customers: [], staff: [], users: [], placements: [] };

  try {
    const [finance, rm, admin, hr] = [
      await login(FINANCE_PHONE), await login(RM_PHONE), await login(ADMIN_PHONE), await login(HR_PHONE),
    ];
    check('finance, RM, admin and HR log in', !!(finance && rm && admin && hr));
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const marker = (await db.query(`SELECT id FROM users WHERE phone = $1`, [FINANCE_PHONE])).rows[0].id;
    const financeUserId = marker;

    const client = async (tag) => {
      const c = await db.query(
        `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                        bill_no_prefix, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'x', 'x', 'New Delhi', 'Delhi', $3, 'ACTIVE', now(), now()) RETURNING id`,
        [`Gate Test ${tag}`, `GATE-${tag}`, `GATE${tag}`],
      );
      made.customers.push(c.rows[0].id);
      return c.rows[0].id;
    };
    const A = await client('A');
    const B = await client('B');

    const hash = await bcrypt.hash(STAFF_PASSWORD, 10);
    const staff = async (code, name) => {
      const phone = '6' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);
      const u = await db.query(
        `INSERT INTO users (id, role, full_name, phone, password_hash, is_active, updated_at)
         VALUES (gen_random_uuid(), 'STAFF', $1, $2, $3, true, now()) RETURNING id`, [name, phone, hash]);
      made.users.push(u.rows[0].id);
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, user_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'x', $4, $5, now(), now()) RETURNING id`,
        [code, name, phone, branchId, u.rows[0].id],
      );
      made.staff.push(s.rows[0].id);
      return { id: s.rows[0].id, phone, userId: u.rows[0].id };
    };
    const place = async (staffId, clientId, type) => {
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', $4, 24, 'PER_DUTY', 500, 600, false, false,
                 $5::date, $5::date, now(), now()) RETURNING id`,
        [staffId, clientId, branchId, type, day(1)],
      );
      made.placements.push(p.rows[0].id);
      return p.rows[0].id;
    };
    const mark = async (staffId, placementId, days) => {
      for (const d of days) {
        await db.query(
          `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                               hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 24, $5, now(), now())`,
          [staffId, placementId, branchId, day(d), marker],
        );
      }
    };

    // S1: live-in at A all month. S2: relief at A (1–10) and at B (11–20).
    const s1 = await staff('GATE01', 'Gate Live-in');
    const s2 = await staff('GATE02', 'Gate Relief');
    const s1A = await place(s1.id, A, 'PERMANENT');
    const s2A = await place(s2.id, A, 'TEMPORARY');
    const s2B = await place(s2.id, B, 'TEMPORARY');
    await mark(s1.id, s1A, range(1, 20));
    await mark(s2.id, s2A, range(21, 25));
    await mark(s2.id, s2B, range(11, 15));
    const t1 = await login(s1.phone, [STAFF_PASSWORD]);
    const t2 = await login(s2.phone, [STAFF_PASSWORD]);

    // ── DRAFT ──────────────────────────────────────────────────────────────
    let r = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: A, month: MONTH, year: YEAR },
    });
    const invA = r.body?.invoice;
    check('invoice for A generated as DRAFT', r.status === 201 && invA?.status === 'DRAFT', r.body);
    const rowsA = (await db.query(
      `SELECT id, staff_id, released_at FROM payroll_records WHERE client_invoice_id = $1`, [invA.id])).rows;
    check('its payroll rows exist and are not released', rowsA.length === 2 && rowsA.every((x) => !x.released_at), rowsA);
    const s1Row = rowsA.find((x) => x.staff_id === s1.id).id;

    r = await req('POST', `/finance/invoices/${invA.id}/approve`, { token: rm });
    check('RM cannot approve an invoice (403)', r.status === 403, r);
    r = await req('POST', `/finance/invoices/${invA.id}/send`, { token: rm });
    check('RM cannot send an invoice (403)', r.status === 403, r);
    r = await req('POST', '/finance/payroll/attendance-generate', { token: rm, body: { code: 'x', month: MONTH, year: YEAR } });
    check('RM cannot generate payroll (403)', r.status === 403, r);

    r = await req('GET', '/staff/payslips', { token: t1 });
    check('staff app: no payslip while the invoice is DRAFT',
      r.status === 200 && r.body?.total === 0, r.body);
    check('staff app: the month is listed as awaiting approval',
      (r.body?.awaiting_approval ?? []).some((m) => m.period_month === MONTH && m.period_year === YEAR), r.body);
    r = await req('GET', `/staff/salary?month=${MONTH}&year=${YEAR}`, { token: t1 });
    check('staff app: salary says Finance is checking it',
      r.body?.salary === null && /being checked by Finance/.test(r.body?.message ?? ''), r.body);

    r = await req('GET', `/employees/payslips?month=${MONTH}&year=${YEAR}`, { token: hr });
    const hrS1 = (r.body?.items ?? []).find((x) => x.staffName === 'Gate Live-in');
    check('HR month view shows the slip as not released', hrS1 && hrS1.released === false, hrS1);

    r = await req('POST', `/finance/payroll/${s1Row}/approve`, { token: finance });
    check('payroll approve refused while the invoice is DRAFT',
      r.status === 400 && /approve the invoice first/.test(msg(r)), r.body);
    r = await req('POST', `/finance/payroll/${s1Row}/disburse`, { token: finance });
    check('disburse refused while the invoice is DRAFT', r.status === 400, r.body);

    r = await req('GET', `/finance/invoices/${invA.id}/salary-slips`, { token: finance, raw: true });
    check('draft salary slips print "DRAFT — not issued"', r.status === 200 && /DRAFT — not issued/.test(r.text), r.status);

    r = await req('POST', `/finance/payroll/${s1Row}/release`, { token: admin, body: { reason: 'invoice stuck with Finance' } });
    check('Admin release refused inside 3 days', r.status === 400 && /Finance has until/.test(msg(r)), r.body);
    r = await req('POST', `/finance/payroll/${s1Row}/release`, { token: finance, body: { reason: 'invoice stuck with Finance' } });
    check('Finance cannot use the Admin release (403)', r.status === 403, r);

    // ── APPROVE ────────────────────────────────────────────────────────────
    r = await req('POST', `/finance/invoices/${invA.id}/approve`, { token: finance });
    check('Finance approves → 2 slips released', r.status === 201 && r.body?.payslips_released === 2, r.body);
    const ci = (await db.query(`SELECT approved_by, approved_at FROM client_invoices WHERE id = $1`, [invA.id])).rows[0];
    check('approver and time recorded on the invoice', ci.approved_by === financeUserId && ci.approved_at, ci);
    const rel = (await db.query(`SELECT released_at, released_by FROM payroll_records WHERE client_invoice_id = $1`, [invA.id])).rows;
    check('rows released by the approver', rel.every((x) => x.released_at && x.released_by === financeUserId), rel);
    const note = (await db.query(`SELECT title, body FROM notifications WHERE user_id = $1`, [s1.userId])).rows;
    check('staff member told in-app that the slip is ready',
      note.some((n) => n.title === 'Salary slip ready' && /Nov 2025/.test(n.body)), note);

    r = await req('GET', '/staff/payslips', { token: t1 });
    const slip1 = (r.body?.payslips ?? [])[0];
    check('staff app: slip now visible, 20 duties × ₹500 gross',
      slip1 && slip1.period_month === MONTH && Number(slip1.gross_salary) === 10000 && slip1.pending_houses === 0, r.body);

    r = await req('GET', `/finance/invoices/${invA.id}/salary-slips`, { token: finance, raw: true });
    check('approved salary slips print without the DRAFT banner', r.status === 200 && !/DRAFT — not issued/.test(r.text));

    // S2: A approved, B still a DRAFT.
    r = await req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id: B, month: MONTH, year: YEAR },
    });
    const invB = r.body?.invoice;
    check('invoice for B generated as DRAFT', r.status === 201 && invB?.status === 'DRAFT', r.body);
    r = await req('GET', '/staff/payslips', { token: t2 });
    const slip2 = (r.body?.payslips ?? [])[0];
    check('two clients, one approved: slip shows A only (5 duties) and 1 house pending',
      slip2 && Number(slip2.gross_salary) === 2500 && slip2.pending_houses === 1, r.body);

    r = await req('POST', `/finance/payroll/${s1Row}/approve`, { token: finance });
    check('payroll approve works once the invoice is approved', r.status === 201 && r.body?.status === 'APPROVED', r.body);

    // ── ADMIN RELEASE after the grace period ───────────────────────────────
    const s2BRow = (await db.query(`SELECT id FROM payroll_records WHERE client_invoice_id = $1`, [invB.id])).rows[0].id;
    await db.query(`UPDATE client_invoices SET created_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [invB.id]);
    r = await req('POST', `/finance/payroll/${s2BRow}/release`, { token: admin, body: { reason: 'short' } });
    check('Admin release needs a real reason', r.status === 400 && /reason/.test(msg(r)), r.body);
    r = await req('POST', `/finance/payroll/${s2BRow}/release`, { token: admin, body: { reason: 'Client B invoice on hold, staff must be paid' } });
    check('Admin release after 3 days, reason kept', r.status === 201 && /^admin: Client B/.test(r.body?.release_reason ?? ''), r.body);
    r = await req('GET', '/staff/payslips', { token: t2 });
    const slip2b = (r.body?.payslips ?? [])[0];
    check('slip now carries both clients, nothing pending',
      slip2b && Number(slip2b.gross_salary) === 5000 && slip2b.pending_houses === 0, r.body);

    // ── CANCEL takes the slips back ────────────────────────────────────────
    await db.query(`UPDATE payroll_records SET status = 'PENDING', approved_by = NULL, approved_at = NULL, locked_at = NULL WHERE id = $1`, [s1Row]);
    r = await req('POST', `/finance/invoices/${invA.id}/cancel`, { token: finance, body: { reason: 'wrong rate on placement' } });
    check('Finance cancels invoice A', r.status === 201, r.body);
    // An unsent invoice's payroll is voided on cancel — off payroll, so no
    // slip, and kept whole in payroll_records_voided.
    const back = (await db.query(`SELECT COUNT(*)::int n FROM payroll_records WHERE placement_id = ANY($1::uuid[])`, [[s1A, s2A]])).rows[0].n;
    const kept = (await db.query(`SELECT COUNT(*)::int n FROM payroll_records_voided WHERE client_invoice_id = $1`, [invA.id])).rows[0].n;
    check('its payroll is voided (kept on record), so no slip remains', back === 0 && kept === 2, { back, kept });
    r = await req('GET', '/staff/payslips', { token: t1 });
    check('staff app: slip gone again after cancel', r.body?.total === 0, r.body);
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.stack || e.message}`);
  } finally {
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    for (const { id } of invs) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM payroll_records_voided WHERE staff_id = ANY($1::uuid[])`, [made.staff]).catch(() => {});
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [made.users]).catch(() => {});
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [made.users]).catch((e) => console.log('  cleanup users:', e.message));
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
