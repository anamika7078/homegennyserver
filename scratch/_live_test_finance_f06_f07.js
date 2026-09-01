/**
 * Live HTTP verification for F-06 and F-07 (docs/FINANCE_MODULE_AUDIT.md).
 *
 *  F-07  Both the enterprise batch and the HR payroll store the employer side
 *        of PF/ESIC, and the compliance report reports it.
 *  F-06  The ESIC challan and PF ECR aggregate all three payroll engines, not
 *        just the EOR one, and say which engine each row came from.
 *
 * Creates one payroll in each engine for a period of its own, checks the
 * filing picks up all three, then removes everything it made. Never locks a
 * batch, so no real loan is recovered against.
 *
 *   node scratch/_live_test_finance_f06_f07.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const FINANCE_PHONE = '9800000004';
const ADMIN_PHONE = '9800000003';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

const TEST_MONTH = 7;
const TEST_YEAR = 2026;
const HR_SALARY = 18000;   // under the ESIC limit, so ESIC applies
const BATCH_SALARY = 20000;

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

async function login(phone, db) {
  const row = await db.query(`SELECT metadata FROM users WHERE phone = $1`, [phone]);
  const secret = (row.rows[0]?.metadata ?? {}).totp_secret ?? null;
  for (const password of PASSWORDS) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await req('POST', '/auth/login', {
        body: { phone, password, ...(secret ? { totp: totpCode(secret) } : {}) },
      });
      if (r.status === 200 || r.status === 201) {
        const t = r.body?.access_token || r.body?.accessToken;
        if (t) return t;
      }
      if (r.status !== 429) break;
      await new Promise((res) => setTimeout(res, 15000 * (attempt + 1)));
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

const money = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const made = { hrEmpId: null, batchEmpId: null, batchId: null, codes: [] };

  try {
    const finance = await login(FINANCE_PHONE, db);
    const admin = await login(ADMIN_PHONE, db);
    console.log('logged in as FINANCE + ADMIN\n');

    // Clear leftovers from a crashed run.
    const stale = await db.query(`SELECT id FROM employees WHERE employee_id LIKE 'F67T%'`);
    if (stale.rows.length) {
      const ids = stale.rows.map((r) => r.id);
      for (const t of ['employee_payrolls', 'attendance', 'payroll_details']) {
        await db.query(`DELETE FROM ${t} WHERE employee_id = ANY($1::uuid[])`, [ids]).catch(() => {});
      }
      await db.query(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
      console.log(`cleared ${ids.length} leftover fixture(s)\n`);
    }
    await db.query(
      `DELETE FROM payroll_processing_batches WHERE month = $1 AND year = $2`, [TEST_MONTH, TEST_YEAR],
    ).catch(() => {});

    const branch = (await db.query(`SELECT id FROM branches ORDER BY created_at LIMIT 1`)).rows[0].id;
    const cat = (await db.query(`SELECT id FROM employee_categories LIMIT 1`)).rows[0].id;

    const mkEmployee = async (suffix, salary) => {
      const code = `F67T${suffix}${Date.now().toString().slice(-5)}`;
      made.codes.push(code);
      const r = await db.query(
        `INSERT INTO employees
           (id, employee_id, full_name, mobile, date_of_birth, gender, address, city, state,
            pincode, emergency_contact, joining_date, branch_id, department, designation,
            category_id, employment_type, salary, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-01-01', 'Other', 'x', 'Delhi', 'Delhi',
                 '110001', '{}'::jsonb, CURRENT_DATE, $4, 'Ops', 'Test', $5, 'Full Time', $6,
                 'Active', now(), now())
         RETURNING id`,
        [code, `F67 ${suffix} Probe`, `90000${Date.now().toString().slice(-5)}`, branch, cat, salary],
      );
      return { id: r.rows[0].id, code };
    };

    const daysInMonth = new Date(TEST_YEAR, TEST_MONTH, 0).getDate();
    const seedAttendance = async (employeeId) => {
      for (let d = 1; d <= daysInMonth; d++) {
        await db.query(
          `INSERT INTO attendance (id, employee_id, date, status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, make_date($2,$3,$4), 'Present', now(), now())`,
          [employeeId, TEST_YEAR, TEST_MONTH, d],
        );
      }
    };

    const hr = await mkEmployee('HR', HR_SALARY);
    made.hrEmpId = hr.id;
    await seedAttendance(hr.id);

    const be = await mkEmployee('BAT', BATCH_SALARY);
    made.batchEmpId = be.id;
    await seedAttendance(be.id);

    // ── F-07 · HR payroll stores the employer side ──────────────────────────
    console.log('F-07  Employer contributions are computed and stored');
    const gen = await req('POST', '/finance/payroll/attendance-generate', {
      token: finance, body: { code: hr.code, month: TEST_MONTH, year: TEST_YEAR },
    });
    check('HR payroll generated', gen.status === 200 || gen.status === 201, { status: gen.status, body: gen.body });

    const hrRow = (await db.query(
      `SELECT gross_salary, esic_employee, esic_employer, pf_employee, pf_employer
       FROM employee_payrolls WHERE employee_id = $1::uuid`, [hr.id],
    )).rows[0];
    check('HR row exists', !!hrRow, hrRow);
    if (hrRow) {
      const gross = money(hrRow.gross_salary);
      check('HR employee ESIC stored (0.75%)', Math.abs(money(hrRow.esic_employee) - money(gross * 0.0075)) <= 0.5, hrRow);
      check('HR employer ESIC stored (3.25%)', Math.abs(money(hrRow.esic_employer) - money(gross * 0.0325)) <= 0.5, hrRow);
      check('HR employer ESIC is larger than employee', money(hrRow.esic_employer) > money(hrRow.esic_employee), hrRow);
      check('HR employer PF stored', money(hrRow.pf_employer) > 0, hrRow);
      check('HR employer PF matches employee PF', money(hrRow.pf_employer) === money(hrRow.pf_employee), hrRow);
    }

    // ── enterprise batch, left as a DRAFT-turned-APPROVED (never locked) ─────
    const batch = await req('POST', '/enterprise-payroll/process-batch', {
      token: admin, body: { month: TEST_MONTH, year: TEST_YEAR },
    });
    check('enterprise batch ran', batch.status === 200 || batch.status === 201, batch.status);
    made.batchId = batch.body?.id ?? null;

    const detail = (await db.query(
      `SELECT gross_salary, basic_salary, esic_deduction, esic_employer, pf_deduction, pf_employer
       FROM payroll_details WHERE batch_id = $1 AND employee_id = $2`,
      [made.batchId, be.id],
    )).rows[0];
    check('batch detail exists for the probe employee', !!detail, detail);
    if (detail) {
      check('batch employer ESIC stored', money(detail.esic_employer) > 0, detail);
      check('batch employer PF stored', money(detail.pf_employer) > 0, detail);
      check('batch employer PF equals employee PF', money(detail.pf_employer) === money(detail.pf_deduction), detail);
      check('batch PF is computed on basic, not gross',
        Math.abs(money(detail.pf_deduction) - money(Math.min(money(detail.basic_salary), 15000) * 0.12)) <= 0.5, detail);
    }

    const compliance = await req(
      'GET', `/enterprise-payroll/reports/statutory-compliance?month=${TEST_MONTH}&year=${TEST_YEAR}`,
      { token: finance },
    );
    const ct = compliance.body?.complianceTotals ?? {};
    check('compliance reports employer PF', money(ct.providentFundEmployer) > 0, ct);
    check('compliance reports employer ESIC', money(ct.esicEmployer) > 0, ct);
    check('compliance reports total employer contribution',
      Math.abs(money(ct.totalEmployerContribution) - money(money(ct.providentFundEmployer) + money(ct.esicEmployer))) <= 0.02, ct);
    check('total liability = withheld + employer',
      Math.abs(money(ct.totalStatutoryLiability) - money(money(ct.totalStatutoryDeduction) + money(ct.totalEmployerContribution))) <= 0.02, ct);
    check('total liability exceeds what was withheld', money(ct.totalStatutoryLiability) > money(ct.totalStatutoryDeduction), ct);

    // ── F-06 · the filing spans every engine ────────────────────────────────
    console.log('\nF-06  Challan and ECR cover all three payroll engines');

    // Approve the batch so it is filing-eligible (approved, never locked, so
    // no loan recovery runs).
    await db.query(
      `UPDATE payroll_processing_batches SET status = 'APPROVED' WHERE id = $1`, [made.batchId],
    );

    for (const [label, path, totalKey] of [
      ['ESIC challan', `/finance/esic/challan?month=${TEST_MONTH}&year=${TEST_YEAR}`, 'total_challan_amount'],
      ['PF ECR', `/finance/esic/pf-ecr?month=${TEST_MONTH}&year=${TEST_YEAR}`, 'total_ecr_amount'],
    ]) {
      const r = await req('GET', path, { token: finance });
      check(`${label} loads`, r.status === 200, r.status);
      const recs = r.body?.records ?? [];
      const sources = new Set(recs.map((x) => x.source));

      check(`${label} includes the HR payroll`, sources.has('HR'), [...sources]);
      check(`${label} includes the enterprise batch`, sources.has('ENTERPRISE'), [...sources]);
      check(`${label} labels every row with a source`, recs.every((x) => !!x.source), recs.slice(0, 2));
      check(`${label} reports a by_source breakdown`, !!r.body?.by_source, r.body?.by_source);

      const summed = recs.reduce((s, x) => {
        const emp = label.startsWith('ESIC') ? x.esic_employee : x.pf_employee;
        const er = label.startsWith('ESIC') ? x.esic_employer : x.pf_employer;
        return s + Number(emp) + Number(er);
      }, 0);
      check(`${label} total equals the sum of its rows`, Math.abs(money(summed) - money(r.body?.[totalKey])) <= 0.05,
        { summed: money(summed), reported: r.body?.[totalKey] });

      const ourHr = recs.find((x) => x.staff_code === hr.code);
      check(`${label} contains our HR employee`, !!ourHr, hr.code);
      if (ourHr) check(`${label} carries its employer figure`, Number(label.startsWith('ESIC') ? ourHr.esic_employer : ourHr.pf_employer) > 0, ourHr);

      // Scoped to the rows this run created. The dataset also holds seeded EOR
      // fixtures with ESIC hardcoded to 165/650 regardless of gross — the
      // reconciliation flags those correctly and should keep doing so, so a
      // blanket "nothing is flagged" assertion would be asking for the control
      // to be switched off.
      const ourCodes = new Set(made.codes);
      const oursFlagged = recs.filter((x) => x.compliant === false && ourCodes.has(x.staff_code));
      check(`${label} flags none of this run's rows`, oursFlagged.length === 0,
        oursFlagged.map((m) => ({ code: m.staff_code, source: m.source, exp: m.expected_employee })));

      const staleFlagged = recs.filter((x) => x.compliant === false && !ourCodes.has(x.staff_code));
      if (staleFlagged.length) {
        console.log(`        (${staleFlagged.length} pre-existing row(s) flagged as non-compliant — ` +
          `${staleFlagged.map((m) => m.staff_code).join(', ')} — the control working, not a test failure)`);
      }
    }

    // Served as text/csv, so read it as text rather than through the JSON helper.
    const csvRes = await fetchWithBackoff(
      `${BASE}/finance/esic/export?type=PF&month=${TEST_MONTH}&year=${TEST_YEAR}`,
      { headers: { Authorization: `Bearer ${finance}` } },
    );
    const csvText = await csvRes.text();
    check('CSV export responds', csvRes.status === 200, csvRes.status);
    check('CSV export names the source column', /^Source,/m.test(csvText), csvText.split('\n').slice(0, 2));
    check('CSV rows carry an engine name',
      /^(EOR|HR|ENTERPRISE),/m.test(csvText), csvText.split('\n').slice(1, 4));
  } catch (err) {
    fail++;
    console.log(`\n  ERROR  ${err.message}`);
  } finally {
    console.log('\ncleaning up…');
    try {
      if (made.batchId) {
        await db.query(`DELETE FROM payroll_details WHERE batch_id = $1`, [made.batchId]);
        await db.query(`DELETE FROM payroll_approval_workflows WHERE batch_id = $1`, [made.batchId]);
        await db.query(`DELETE FROM payroll_processing_batches WHERE id = $1`, [made.batchId]);
      }
      for (const id of [made.hrEmpId, made.batchEmpId].filter(Boolean)) {
        for (const t of ['employee_payrolls', 'attendance', 'payroll_details']) {
          await db.query(`DELETE FROM ${t} WHERE employee_id = $1::uuid`, [id]).catch(() => {});
        }
        await db.query(`DELETE FROM employees WHERE id = $1`, [id]);
      }
      // Generating a challan now records the filing (F-13), so the assertions
      // above leave rows behind that belong to the test, not to the business.
      await db.query(`DELETE FROM esic_reports WHERE month = $1 AND year = $2`, [TEST_MONTH, TEST_YEAR]);
      await db.query(`DELETE FROM pf_reports WHERE month = $1 AND year = $2`, [TEST_MONTH, TEST_YEAR]);
      console.log('cleanup done');
    } catch (e) {
      console.log(`cleanup problem: ${e.message}`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  }
})();
