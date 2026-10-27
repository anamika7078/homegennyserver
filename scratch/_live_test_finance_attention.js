/**
 * Live HTTP verification of P4 — the morning "needs attention" list and the
 * invoice history.
 *
 * Builds one of each stuck thing and checks it is listed, that the morning
 * note reaches Finance and the RM, and that an invoice's history tells its
 * story (raised → rejected with reason → payroll voided; approved by whom).
 *
 * Uses June 2025. Builds and removes its own rows.
 *
 *   node scratch/_live_test_finance_attention.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const RM_PHONE = '9800000002';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
const YEAR = 2025;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : ''}`); }
}
async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}
async function req(method, path, { token, body } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  const payload = json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}
async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken;
    if (t) return t;
  }
  throw new Error(`Could not log in as ${phone}`);
}
const jun = (d) => `${YEAR}-06-${String(d).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { customers: [], staff: [], placements: [] };
  const started = new Date();

  try {
    const finance = await login(FINANCE_PHONE);
    const rm = await login(RM_PHONE);
    check('finance and RM log in', !!(finance && rm));
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0]?.id;
    const rmUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE])).rows[0].id;
    const financeUserId = (await db.query(`SELECT id FROM users WHERE phone = $1`, [FINANCE_PHONE])).rows[0].id;

    const client = async (tag) => {
      const c = await db.query(
        `INSERT INTO finance_customers (id, customer_name, unit_code, unit_name, address, city, state,
                                        bill_no_prefix, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'x', 'x', 'New Delhi', 'Delhi', $3, 'ACTIVE', now(), now()) RETURNING id`,
        [`Attention ${tag}`, `ATTN-${tag}`, `ATTN${tag}`],
      );
      made.customers.push(c.rows[0].id);
      return c.rows[0].id;
    };
    let n = 0;
    const placed = async (clientId, name) => {
      n += 1;
      const s = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, mobile, date_of_birth, address,
                                       branch_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, $3, '1995-01-01', 'x', $4, now(), now()) RETURNING id`,
        [`ATTN0${n}`, name, `91100000${n}0`, branchId],
      );
      made.staff.push(s.rows[0].id);
      const p = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours,
                                 rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable,
                                 confirmed_at, trial_start_date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 24, 'PER_DUTY', 500, 600, false, false,
                 $5::date, $5::date, now(), now()) RETURNING id`,
        [s.rows[0].id, clientId, branchId, rmUserId, jun(1)],
      );
      made.placements.push(p.rows[0].id);
      for (const d of range(1, 5)) {
        await db.query(
          `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status,
                                               hours_worked, marked_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'PRESENT', 24, $5, now(), now())`,
          [s.rows[0].id, p.rows[0].id, branchId, jun(d), rmUserId],
        );
      }
      return { staffId: s.rows[0].id, placementId: p.rows[0].id };
    };
    const gen = (customer_id) => req('POST', '/finance/invoices/consolidated/generate', {
      token: finance, body: { customer_id, month: 6, year: YEAR },
    });

    // 1. A draft left for 5 days (its slips are held with it).
    const A = await client('A');
    await placed(A, 'Attn Waiting');
    let r = await gen(A);
    const invA = r.body?.invoice;
    await db.query(`UPDATE client_invoices SET created_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [invA.id]);

    // 2. A rejected invoice → a rate review waiting on the RM (2 days).
    const B = await client('B');
    const b = await placed(B, 'Attn Review');
    r = await gen(B);
    const invB = r.body?.invoice;
    await req('POST', `/finance/invoices/${invB.id}/reject`, { token: finance, body: { reason: 'Rate looks wrong for Attn Review' } });
    await db.query(`UPDATE placements SET rate_review_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [b.placementId]);

    // 3. A sent invoice whose rate was then back-dated.
    const C = await client('C');
    const c = await placed(C, 'Attn Sent');
    r = await gen(C);
    const invC = r.body?.invoice;
    await req('POST', `/finance/invoices/${invC.id}/approve`, { token: finance });
    await db.query(`UPDATE client_invoices SET status = 'SENT' WHERE id = $1`, [invC.id]);
    await req('PATCH', `/placements/${c.placementId}/terms`, {
      token: rm, body: { duty_rate: 520, duty_billing_rate: 620, effective_from: jun(1), reason: 'Back-dated raise' },
    });

    // 4. Arrears waiting.
    await db.query(
      `INSERT INTO pay_adjustments (staff_id, placement_id, amount, kind, status, reason)
       VALUES ($1, $2, 150, 'ARREARS', 'PENDING', 'attention test arrears')`,
      [c.staffId, c.placementId],
    );

    r = await req('GET', '/finance/invoices/attention', { token: rm });
    check('RM cannot read the Finance attention list (403)', r.status === 403, r.status);
    r = await req('GET', '/finance/invoices/attention', { token: finance });
    const a = r.body;
    check('draft waiting 5 days is listed', (a?.draft_invoices_waiting ?? []).some((x) => x.id === invA.id && Number(x.days_waiting) >= 5), a?.draft_invoices_waiting);
    check('…its held slip is listed', (a?.slips_held ?? []).some((x) => x.staff_name === 'Attn Waiting'), a?.slips_held);
    check('rate review waiting on the RM is listed, with the reason',
      (a?.rate_reviews_open ?? []).some((x) => x.staff_name === 'Attn Review' && /Rate looks wrong/.test(x.rate_review_reason)), a?.rate_reviews_open);
    check('sent invoice with a back-dated rate is listed for correction',
      (a?.sent_invoices_needing_correction ?? []).some((x) => x.id === invC.id), a?.sent_invoices_needing_correction);
    check('arrears waiting are listed', (a?.arrears_pending ?? []).some((x) => x.staff_name === 'Attn Sent' && Number(x.amount) === 150), a?.arrears_pending);
    check('counts add up', a?.counts?.draft_invoices_waiting >= 1 && a?.counts?.rate_reviews_open >= 1, a?.counts);

    // Correcting the sent invoice takes it off the list.
    await req('POST', `/finance/invoices/${invC.id}/correct`, { token: finance, body: { reason: 'Back-dated raise to 520/620' } });
    r = await req('GET', '/finance/invoices/attention', { token: finance });
    check('…and once corrected, it drops off', !(r.body?.sent_invoices_needing_correction ?? []).some((x) => x.id === invC.id), r.body?.sent_invoices_needing_correction);

    // The morning note.
    r = await req('POST', '/finance/invoices/attention/notify', { token: finance });
    check('morning note sent to Finance and the RM', r.status === 201 && r.body?.finance_notified >= 1 && r.body?.rms_notified >= 1, r.body);
    const fin = (await db.query(
      `SELECT body FROM notifications WHERE user_id = $1 AND title = 'Finance — needs attention today' AND created_at >= $2`, [financeUserId, started])).rows;
    check('…Finance sees the counts', fin.length >= 1 && /draft invoice/.test(fin[0].body), fin);
    const rmn = (await db.query(
      `SELECT body FROM notifications WHERE user_id = $1 AND title = 'Rate check still waiting' AND created_at >= $2`, [rmUserId, started])).rows;
    check('…the RM is reminded by name', rmn.length >= 1 && /Attn Review/.test(rmn[0].body), rmn);

    // History.
    r = await req('GET', `/finance/invoices/${invB.id}/history`, { token: finance });
    const ev = r.body?.events ?? [];
    check('history of the rejected invoice: raised → rejected (who, why) → payroll voided',
      ev[0]?.what === 'Raised as DRAFT' && ev.some((e) => e.what === 'Rejected' && /Rate looks wrong/.test(e.detail) && e.who) &&
        ev.some((e) => /Payroll voided \(reject\)/.test(e.what)), ev);
    r = await req('GET', `/finance/invoices/${invC.id}/history`, { token: finance });
    const evc = r.body?.events ?? [];
    check('history of the corrected invoice: approved by whom, corrected with a credit note',
      evc.some((e) => /Approved/.test(e.what) && e.who) && evc.some((e) => /Corrected — credit note|Corrected/.test(e.what)), evc);
  } catch (e) {
    fail++;
    console.error(`  ERROR ${e.stack || e.message}`);
  } finally {
    const invs = (await db.query(`SELECT id FROM client_invoices WHERE client_id = ANY($1::uuid[])`, [made.customers])).rows;
    const ids = invs.map((x) => x.id);
    await db.query(`DELETE FROM invoice_corrections WHERE invoice_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM credit_notes WHERE invoice_id = ANY($1::uuid[])`, [ids]);
    for (const id of ids) {
      await db.query(`UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`, [id]);
      await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM pay_adjustments WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM placement_rate_changes WHERE placement_id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM payroll_records_voided WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM payroll_records WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM notifications WHERE created_at >= $1 AND title IN ('Finance — needs attention today','Rate check still waiting','Invoice rejected — check the rate')`, [started]).catch(() => {});
    await db.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])`, [made.placements]).catch(() => {});
    await db.query(`DELETE FROM placements WHERE id = ANY($1::uuid[])`, [made.placements]);
    await db.query(`DELETE FROM staff_applicants WHERE id = ANY($1::uuid[])`, [made.staff]);
    await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customers]);
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
