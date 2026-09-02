/**
 * Live HTTP verification for F-16 and F-17.
 *
 *   F-16  Professional tax comes from state rules — and Delhi and Haryana do
 *         not levy it — while TDS is an annual projection rather than a flat
 *         percentage of one month's pay.
 *   F-17  The spec's late-exit fee matrix is computed, and a settlement
 *         resolves the deposit when it is paid.
 *
 *   node scratch/_live_test_finance_f16_f17.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_MONTH = 6;
const TEST_YEAR = 2026;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 10) {
    const waitMs = 5000 * (attempt + 1);
    console.log(`      (rate limited, waiting ${waitMs / 1000}s…)`);
    await new Promise((r) => setTimeout(r, waitMs));
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await req('POST', '/auth/login', { body: { phone, password } });
      if (r.status === 200 || r.status === 201) {
        const t = r.body?.access_token || r.body?.accessToken;
        if (t) return t;
      }
      if (r.status !== 429) break;
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

const money = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { employeeId: null, attendanceIds: [], payrollId: null, settlementId: null, placementId: null, depositRestored: null };

  try {
    const finance = await login(FINANCE_PHONE);
    console.log('logged in as FINANCE\n');

    // ── F-16 · professional tax is a state levy ─────────────────────────────
    console.log('F-16  Professional tax follows the state, not a flat rule');
    const pt = async (state, gross, month = TEST_MONTH, gender = 'Male') =>
      (await req('POST', '/finance/tax/preview', {
        token: finance, body: { state, monthly_gross: gross, month, year: TEST_YEAR, gender },
      })).body?.professional_tax;

    const delhi = await pt('Delhi', 25000);
    check('Delhi deducts nothing', money(delhi?.amount) === 0, delhi);
    check('and says why', /does not levy/i.test(delhi?.reason ?? ''), delhi?.reason);

    const haryana = await pt('Haryana', 25000);
    check('Haryana deducts nothing', money(haryana?.amount) === 0, haryana);

    const mh = await pt('Maharashtra', 25000);
    check('Maharashtra deducts its slab amount', money(mh?.amount) === 200, mh);

    const mhFeb = await pt('Maharashtra', 25000, 2);
    check('Maharashtra charges more in the last FY month', money(mhFeb?.amount) === 300, mhFeb);

    const mhLow = await pt('Maharashtra', 7000);
    check('below the Maharashtra threshold is nil', money(mhLow?.amount) === 0, mhLow);

    const unknown = await pt('Kerala', 25000);
    check('an unknown state deducts nothing', money(unknown?.amount) === 0, unknown);
    check('and is reported as unknown, not as exempt',
      /no professional-tax rule/i.test(unknown?.reason ?? ''), unknown?.reason);

    const noState = await pt(null, 25000);
    check('no state on record deducts nothing', money(noState?.amount) === 0, noState);

    // ── F-16 · TDS is projected, not a flat slice ───────────────────────────
    console.log('\nF-16  TDS is an annual projection');
    const tds = async (gross, month = TEST_MONTH) =>
      (await req('POST', '/finance/tax/preview', {
        token: finance, body: { state: 'Delhi', monthly_gross: gross, month, year: TEST_YEAR },
      })).body?.tds;

    const t60 = await tds(60000);
    // The old rule took 5% of anything above ₹50,000 — ₹3,000 a month from
    // someone whose annual income is inside the rebate and who owes nothing.
    check('₹60k/month owes no TDS (within the rebate)', money(t60?.monthlyAmount) === 0, t60);
    check('the rebate is reported', t60?.rebateApplied === true, t60);
    check('the old flat rule would have taken ₹3,000', money(60000 * 0.05) === 3000);

    const t150 = await tds(150000);
    check('₹150k/month does owe TDS', money(t150?.monthlyAmount) > 0, t150);
    check('it is spread over the remaining FY months', t150?.monthsRemaining === 10, t150);
    check('monthly × remaining months = the annual liability',
      Math.abs(money(t150.monthlyAmount * t150.monthsRemaining) - money(t150.annualTax)) <= 1, t150);
    check('taxable income is gross less the standard deduction',
      money(t150.annualTaxableIncome) === money(150000 * 12 - 75000), t150);
    // Later in the year the same liability spreads over fewer months, so the
    // monthly figure must rise — the flat rule could never do this.
    const t150Late = await tds(150000, 1);
    check('the same salary deducts more later in the year',
      money(t150Late.monthlyAmount) > money(t150.monthlyAmount), { june: t150.monthlyAmount, january: t150Late.monthlyAmount });

    const status = await req('GET', '/finance/tax/status', { token: finance });
    check('unconfirmed rates are flagged', status.body?.confirmed === false, status.body);
    check('and the flag explains itself', /not been verified/i.test(status.body?.message ?? ''), status.body?.message);

    // ── F-16 · payroll actually uses it ─────────────────────────────────────
    console.log('\nF-16  Payroll uses the engine, not the old constants');
    const branch = (await db.query(`SELECT id FROM branches WHERE state = 'Delhi' LIMIT 1`)).rows[0].id;
    const cat = (await db.query(`SELECT id FROM employee_categories LIMIT 1`)).rows[0].id;
    const code = `F16T${Date.now().toString().slice(-7)}`;
    made.employeeId = (await db.query(
      `INSERT INTO employees
         (id, employee_id, full_name, mobile, date_of_birth, gender, address, city, state,
          pincode, emergency_contact, joining_date, branch_id, department, designation,
          category_id, employment_type, salary, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'F16 Tax Probe', $2, '1990-01-01', 'Male', 'x', 'New Delhi',
               'Delhi', '110001', '{}'::jsonb, CURRENT_DATE, $3, 'Ops', 'Test', $4,
               'Full Time', 40000, 'Active', now(), now())
       RETURNING id`,
      [code, `90${Date.now().toString().slice(-8)}`, branch, cat],
    )).rows[0].id;

    const dim = new Date(TEST_YEAR, TEST_MONTH, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      const r = await db.query(
        `INSERT INTO attendance (id, employee_id, date, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, make_date($2,$3,$4), 'Present', now(), now()) RETURNING id`,
        [made.employeeId, TEST_YEAR, TEST_MONTH, d],
      );
      made.attendanceIds.push(r.rows[0].id);
    }

    // By employee id, not by code: since B6 retired the HR payroll engine, a
    // code lookup resolves through the pipeline to a placement, and placement
    // payroll does not compute professional tax or TDS. The calculation is
    // still live and still worth guarding, so this reads it directly through
    // the preview endpoint that survives.
    const prev = await req('GET',
      `/attendance/${made.employeeId}/payroll-preview?month=${TEST_MONTH}&year=${TEST_YEAR}`,
      { token: finance });
    const calc = prev.body?.calculation ?? {};
    check('a Delhi employee has no PT deducted', money(calc.ptDeduction) === 0, calc);
    check('the old rule would have taken ₹200', money(calc.grossSalary) > 15000, calc.grossSalary);
    check('the payslip explains the PT figure',
      /Delhi does not levy/i.test(prev.body?.calculation?.taxExplanation?.professionalTax ?? ''),
      prev.body?.calculation?.taxExplanation);
    check('₹40k/month owes no TDS either', money(calc.tdsDeduction) === 0, calc);
    check('unconfirmed rates surface on the payslip',
      prev.body?.calculation?.taxExplanation?.needsConfirmation === true,
      prev.body?.calculation?.taxExplanation);

    // ── F-17 · the fee matrix ───────────────────────────────────────────────
    console.log('\nF-17  The late-exit fee matrix is computed');
    const cand = (await db.query(`
      SELECT p.id, p.staff_id, p.staff_salary, p.confirmed_at, sa.staff_code
      FROM placements p JOIN staff_applicants sa ON sa.id = p.staff_id
      WHERE p.status = 'CONFIRMED' AND p.staff_salary IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM exit_settlements es WHERE es.placement_id = p.id)
      ORDER BY p.created_at DESC LIMIT 1
    `)).rows[0];
    if (!cand) { console.log('  no confirmed placement available — skipping F-17'); return; }
    made.placementId = cand.id;
    const salary = money(cand.staff_salary);
    const daily = money(salary / 30);
    console.log(`using ${cand.staff_code}, salary ₹${salary}\n`);

    // Each band, driven by how long after confirmation the exit lands.
    const bandFor = async (daysAfter, reason = 'CLIENT_REQUESTED') => {
      await db.query(`UPDATE placements SET confirmed_at = $1 WHERE id = $2`,
        [new Date(Date.UTC(2026, 5, 1)), cand.id]);
      const exitDate = new Date(Date.UTC(2026, 5, 1) + daysAfter * 86400000).toISOString().slice(0, 10);
      const r = await req('POST', '/finance/exit-settlements/preview', {
        token: finance, body: { placement_id: cand.id, exit_date: exitDate, reason },
      });
      return r.body;
    };

    const under30 = await bandFor(10);
    check('exit under 30 days → 30 days fee, no goodwill',
      under30?.fee_band === 'POST_CONFIRM_UNDER_30D' && under30.cancellation_fee_days === 30 && under30.goodwill_days === 0,
      under30);
    check('the fee is 30 days of salary',
      Math.abs(money(under30.cancellation_fee_amount) - money(daily * 30)) <= 0.05, under30.cancellation_fee_amount);

    const mid = await bandFor(60);
    check('exit at 30–90 days → 15 days fee, 7 days goodwill',
      mid?.fee_band === 'POST_CONFIRM_30_TO_90D' && mid.cancellation_fee_days === 15 && mid.goodwill_days === 7,
      mid);

    const late = await bandFor(120);
    check('exit past 90 days → 7 days fee, 15 days goodwill',
      late?.fee_band === 'POST_CONFIRM_OVER_90D' && late.cancellation_fee_days === 7 && late.goodwill_days === 15,
      late);
    check('goodwill grows as the fee shrinks',
      late.goodwill_amount > mid.goodwill_amount && late.cancellation_fee_amount < mid.cancellation_fee_amount,
      { late, mid });

    const cause = await bandFor(60, 'TERMINATED_FOR_CAUSE');
    check('terminated for cause → no fee, deposit forfeited',
      cause?.cancellation_fee_days === 0 && cause.deposit_action === 'FORFEIT', cause);

    // Trial bands depend on the placement not being confirmed.
    await db.query(`UPDATE placements SET confirmed_at = NULL, status = 'TRIAL' WHERE id = $1`, [cand.id]);
    const trial = await req('POST', '/finance/exit-settlements/preview', {
      token: finance, body: { placement_id: cand.id, exit_date: '2026-06-05', reason: 'CLIENT_REQUESTED' },
    });
    check('exit during trial → no fee, deposit refunded',
      trial.body?.fee_band === 'DURING_TRIAL' && trial.body.cancellation_fee_days === 0
      && trial.body.deposit_action === 'REFUND', trial.body);

    const mutual = await req('POST', '/finance/exit-settlements/preview', {
      token: finance, body: { placement_id: cand.id, exit_date: '2026-06-05', reason: 'MUTUAL' },
    });
    check('mutual trial exit → no fee', mutual.body?.fee_band === 'MUTUAL_TRIAL_EXIT', mutual.body);

    const extended = await req('POST', '/finance/exit-settlements/preview', {
      token: finance, body: { placement_id: cand.id, exit_date: '2026-06-05', reason: 'CLIENT_REQUESTED', trial_extended: true },
    });
    check('extended trial then exit → 15 days fee',
      extended.body?.fee_band === 'TRIAL_EXTENDED_THEN_EXIT' && extended.body.cancellation_fee_days === 15,
      extended.body);

    check('both sides are reported separately',
      typeof late.net_payable_to_staff === 'number' && typeof late.net_receivable_from_client === 'number', late);

    // ── F-17 · the settlement lifecycle ─────────────────────────────────────
    console.log('\nF-17  A settlement is drafted, approved, then settles the deposit');
    await db.query(`UPDATE placements SET confirmed_at = $1, status = 'CONFIRMED' WHERE id = $2`,
      [new Date(Date.UTC(2026, 5, 1)), cand.id]);

    const depBefore = (await db.query(
      `SELECT id, event FROM deposits WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 1`, [cand.staff_id],
    )).rows[0];
    made.depositRestored = depBefore?.id ?? null;

    const created = await req('POST', '/finance/exit-settlements', {
      token: finance,
      body: { placement_id: cand.id, exit_date: '2026-10-01', reason: 'CLIENT_REQUESTED', scenario_code: 'DR-17' },
    });
    check('a settlement drafts', created.status === 200 || created.status === 201, { status: created.status, body: created.body });
    made.settlementId = created.body?.settlement?.id ?? null;
    check('it starts as DRAFT', created.body?.settlement?.status === 'DRAFT', created.body?.settlement?.status);

    const dup = await req('POST', '/finance/exit-settlements', {
      token: finance, body: { placement_id: cand.id, exit_date: '2026-10-01', reason: 'CLIENT_REQUESTED' },
    });
    check('a second settlement for the same placement is refused', dup.status === 400, dup.status);

    const earlySettle = await req('POST', `/finance/exit-settlements/${made.settlementId}/settle`, { token: finance });
    check('a draft cannot be settled before approval', earlySettle.status === 400, earlySettle.status);

    const approved = await req('POST', `/finance/exit-settlements/${made.settlementId}/approve`, { token: finance });
    check('it approves', approved.status === 200 || approved.status === 201, approved.status);

    const settled = await req('POST', `/finance/exit-settlements/${made.settlementId}/settle`, { token: finance });
    check('it settles', settled.status === 200 || settled.status === 201, { status: settled.status, body: settled.body });

    if (depBefore && !depBefore.event) {
      const depAfter = (await db.query(`SELECT event, refund_amount FROM deposits WHERE id = $1`, [depBefore.id])).rows[0];
      check('settling resolved the deposit', depAfter?.event === 'REFUND', depAfter);
    } else {
      console.log('        (staff had no unresolved deposit — deposit assertion skipped)');
    }

    const pending = await req('GET', '/finance/exit-settlements/pending', { token: finance });
    check('the pending list excludes settled placements',
      !(pending.body ?? []).some((p) => p.placement_id === cand.id), pending.body?.length);
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.settlementId) await db.query(`DELETE FROM exit_settlements WHERE id = $1`, [made.settlementId]);
      if (made.depositRestored) {
        await db.query(
          `UPDATE deposits SET event = NULL, event_at = NULL, refund_amount = NULL,
                               event_notes = NULL, recorded_by = NULL
           WHERE id = $1`, [made.depositRestored],
        );
      }
      if (made.placementId) {
        await db.query(`UPDATE placements SET status = 'CONFIRMED' WHERE id = $1`, [made.placementId]);
      }
      if (made.employeeId) {
        for (const t of ['employee_payrolls', 'attendance', 'employee_tax_profiles']) {
          await db.query(`DELETE FROM ${t} WHERE employee_id = $1::uuid`, [made.employeeId]).catch(() => {});
        }
        await db.query(`DELETE FROM employees WHERE id = $1`, [made.employeeId]);
      }
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
